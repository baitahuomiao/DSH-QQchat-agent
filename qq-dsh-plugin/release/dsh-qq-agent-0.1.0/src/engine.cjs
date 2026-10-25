/**
 * 引擎：把 OneBot、记忆、模型、联网、B 站、语音串起来。
 *
 * 所有外部能力都由 deps 注入（llm / web / attachments），这样这个文件本身不 import
 * 任何 DSH 的 ESM 包，宿主 lib/index.js 负责把 DSH 的服务包成普通函数传进来。
 */
"use strict";

const core = require("./core.cjs");
const tts = require("./tts.cjs");
const bilibili = require("./bilibili.cjs");

const LOG_LIMIT = 200;

function nowMs() {
  return Date.now();
}

/**
 * 打字停顿。
 *
 * 这里刻意 **不** unref 定时器：发送流程还在等它，unref 会让 Node 在事件循环
 * 空闲时直接退出，正在发的后续分段就丢了。停顿都是毫秒级，拖着进程没关系。
 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

class Engine {
  /**
   * @param {object} deps
   * @param {object} deps.cfg 已归一化的配置（会被 reload 替换）
   * @param {import('./memory.cjs').Memory} deps.memory
   * @param {import('./onebot.cjs').OneBotClient} deps.onebot
   * @param {object} deps.log 带 info/warn/error 的日志器（可选）
   * @param {object} deps.llm { generate(options) => Promise<{text, reasoning, finish, usage}> | null, ready():boolean }
   * @param {object} deps.web { search(query, options) => Promise<Array<{title,url,snippet}>> }
   * @param {object} deps.attachments { saveImage({data,mediaType,name}) => Promise<ref> }
   * @param {Function} deps.onChange 状态变化回调（给 GUI 推送）
   */
  constructor(deps) {
    this.deps = deps || {};
    this.cfg = this.deps.cfg;
    this.memory = this.deps.memory;
    this.onebot = this.deps.onebot;
    this.logger = this.deps.log || console;

    this.logs = [];
    this.started = false;
    this.paused = false;
    this.lastReplyAt = new Map();
    this.replyCount = 0;
    this.proactiveCount = 0;
    this.errorCount = 0;
    this.proactiveHistory = [];
    this.groupNames = new Map();
    this.nextProactiveAt = 0;
    this.proactiveTimer = null;
    this.pendingApproval = null;
    this.lastBrowseAt = 0;
    this.lastBrowseResult = null;
    this.busy = new Set();

    this.boundMessage = (event) => {
      this.handleEvent(event).catch((error) => this.fail("处理消息失败", error));
    };
    this.boundNotice = (event) => this.handleNotice(event);
    this.boundReady = () => {
      this.refreshGroups().catch(() => {});
      this.log("info", "已连接到 OneBot：" + (this.onebot.nickname || this.onebot.selfId || "未知账号"));
    };
  }

  // —— 生命周期 ——

  start() {
    if (this.started) return;
    this.started = true;
    this.onebot.on("message", this.boundMessage);
    this.onebot.on("notice", this.boundNotice);
    this.onebot.on("ready", this.boundReady);
    this.onebot.on("disconnect", (reason) => this.log("warn", "OneBot 连接断开：" + reason));
    this.onebot.connect();
    this.scheduleProactive();
    this.log("info", "QQ 智能助手已启动（人设：" + this.cfg.persona.name + "）");
  }

  stop() {
    if (!this.started) return;
    this.started = false;
    this.onebot.off("message", this.boundMessage);
    this.onebot.off("notice", this.boundNotice);
    this.onebot.off("ready", this.boundReady);
    this.clearProactive();
    this.onebot.disconnect();
    this.log("info", "QQ 智能助手已停止");
  }

  /** 配置热更新。 */
  reload(cfg) {
    this.cfg = cfg;
    this.memory.configure({
      memoryTurns: cfg.reply.memoryTurns,
      retentionHours: cfg.bilibili.retentionHours,
    });
    this.onebot.reconfigure({
      wsUrl: cfg.onebot.wsUrl,
      token: cfg.onebot.token,
      reconnectMs: cfg.onebot.reconnectMs,
    });
    this.clearProactive();
    this.scheduleProactive();
    this.emitChange();
  }

  // —— 日志 ——

  log(level, text) {
    const entry = { at: nowMs(), level: level || "info", text: String(text || "") };
    this.logs.push(entry);
    while (this.logs.length > LOG_LIMIT) this.logs.shift();
    const method = level === "error" ? "error" : level === "warn" ? "warn" : "info";
    try {
      if (this.logger && typeof this.logger[method] === "function") this.logger[method]("[dsh-qq-agent] " + text);
    } catch {
      /* ignore */
    }
    this.emitChange();
  }

  fail(prefix, error) {
    this.errorCount += 1;
    const detail = error && error.message ? error.message : String(error);
    this.log("error", prefix + "：" + detail);
  }

  emitChange() {
    if (typeof this.deps.onChange === "function") {
      try {
        this.deps.onChange(this.snapshot());
      } catch {
        /* ignore */
      }
    }
  }

  snapshot() {
    const shelf = this.memory.recentVideos(60);
    const sessions = [];
    for (const [sessionKey, rows] of this.memory.sessions) {
      let at = 0;
      for (const row of rows) if (row.at > at) at = row.at;
      sessions.push({
        sessionKey,
        label: this.labelFor(sessionKey),
        count: rows.length,
        at: at || this.memory.lastActiveAt(sessionKey) || 0,
      });
    }
    sessions.sort((a, b) => b.at - a.at);
    return {
      started: this.started,
      paused: this.paused,
      enabled: this.cfg.enabled,
      persona: this.cfg.persona.name,
      selfId: this.onebot.selfId,
      nickname: this.onebot.nickname,
      connection: this.onebot.status(),
      replyCount: this.replyCount,
      proactiveCount: this.proactiveCount,
      errorCount: this.errorCount,
      nextProactiveAt: this.nextProactiveAt,
      pendingApproval: this.pendingApproval,
      bilibiliApproved: this.cfg.bilibili.approved,
      lastBrowseAt: this.lastBrowseAt,
      lastBrowse: this.lastBrowseResult,
      shelf,
      shelfSize: shelf.length,
      sessions: sessions.length,
      sessionList: sessions,
      logs: this.logs.slice(-60),
    };
  }

  // —— 群名缓存（给提示词用） ——

  async refreshGroups() {
    try {
      const list = await this.onebot.getGroupList();
      this.groupNames = new Map(
        (Array.isArray(list) ? list : []).map((group) => [
          String(group.group_id || ""),
          String(group.group_name || ""),
        ]),
      );
    } catch {
      /* 拿不到群列表不影响聊天 */
    }
  }

  // —— 收到消息 ——

  async handleEvent(event) {
    const message = require("./onebot.cjs").readEvent(event);
    if (!message) return;

    this.memory.touch(message.sessionKey);

    const command = core.parseCommand(message.text);
    if (command && this.isAdmin(message.userId)) {
      await this.handleCommand(command, message);
      return;
    }

    const decision = core.shouldReply(message, this.cfg, {
      lastReplyAt: this.lastReplyAt.get(message.sessionKey) || 0,
      now: nowMs(),
    });
    if (!decision.reply) {
      if (decision.reason !== "not-mentioned" && decision.reason !== "cooldown") {
        this.log("info", "跳过消息（" + decision.reason + "）：" + (message.nickname || message.userId));
      }
      return;
    }

    // 同一会话排队，避免两条消息同时触发两次回复
    if (this.busy.has(message.sessionKey)) return;
    this.busy.add(message.sessionKey);
    try {
      await this.respond(message, { kind: message.messageType });
    } finally {
      this.busy.delete(message.sessionKey);
    }
  }

  isAdmin(uin) {
    const id = String(uin || "");
    if (!id) return false;
    if (this.cfg.master.uin && id === String(this.cfg.master.uin)) return true;
    return (this.cfg.admin.uins || []).includes(id);
  }

  isMaster(uin) {
    return Boolean(this.cfg.master.uin) && String(uin || "") === String(this.cfg.master.uin);
  }

  // —— 回复主流程 ——

  /**
   * 生成并发送一条回复。
   * @param {object} message readEvent 的结果（主动发言时用伪消息）
   * @param {{kind?:string, reason?:string, extraSystem?:string, forceNoSearch?:boolean}} [options]
   */
  async respond(message, options) {
    const opts = options || {};
    const cfg = this.cfg;
    const startedAt = nowMs();

    let images = [];
    if (cfg.vision.enabled && Array.isArray(message.images) && message.images.length > 0) {
      images = await this.collectImages(message);
    }

    const searchNotes = [];
    if (!opts.forceNoSearch && core.needSearch(message.text, cfg)) {
      const results = await this.search(message.text);
      for (const row of results) {
        searchNotes.push(row.title + "：" + (row.snippet || "") + "（" + row.url + "）");
      }
      if (results.length > 0) this.log("info", "联网搜索 " + results.length + " 条：" + message.text.slice(0, 40));
    }

    const videoNotes = cfg.bilibili.keepNotes
      ? core.summarizeVideoNotes(this.memory.recentVideos(6), 6)
      : [];

    const system = core.buildSystemPrompt(cfg, {
      kind: opts.kind === "proactive" ? "proactive" : message.messageType,
      userId: message.userId,
      nickname: message.nickname,
      groupId: message.groupId,
      groupName: this.groupNames.get(String(message.groupId || "")) || "",
      videoNotes,
      searchNotes,
    });

    const history = this.memory.history(message.sessionKey);
    const userText = this.buildUserText(message, opts);

    if (!this.deps.llm || typeof this.deps.llm.generate !== "function") {
      this.log("warn", "没有可用的模型接口，跳过回复");
      return null;
    }

    let result;
    try {
      result = await this.deps.llm.generate({
        system,
        history,
        userText,
        images,
        temperature: cfg.llm.temperature,
        maxTokens: cfg.llm.maxTokens,
        provider: cfg.llm.provider,
        model: cfg.llm.model,
        signal: opts.signal,
      });
    } catch (error) {
      this.fail("模型调用失败", error);
      return null;
    }

    if (!result || !result.text) {
      this.log("warn", "模型返回了空内容" + (result && result.finish ? "（" + result.finish + "）" : ""));
      return null;
    }

    const segments = core.splitSegments(result.text, {
      maxChars: cfg.reply.maxChars,
      splitSegments: cfg.reply.splitSegments,
    });
    if (segments.length === 0) return null;

    // 记忆里存原始完整回复
    this.memory.push(message.sessionKey, { role: "user", name: message.nickname, text: userText });
    this.memory.push(message.sessionKey, { role: "assistant", text: segments.join("\n") });
    this.memory.touch(message.sessionKey);

    const useVoice = core.shouldUseVoice(segments.join(""), cfg, message.text);
    if (useVoice) {
      const sent = await this.sendVoice(message.replyTarget, segments, opts);
      if (sent) return this.finishReply(message, segments, startedAt, true);
    }

    await this.sendSegments(message.replyTarget, segments);
    return this.finishReply(message, segments, startedAt, false);
  }

  finishReply(message, segments, startedAt, asVoice) {
    this.replyCount += 1;
    this.lastReplyAt.set(message.sessionKey, nowMs());
    const preview = segments.join(" / ").slice(0, 60);
    this.log(
      "info",
      "回复 " + (message.nickname || message.userId) + (asVoice ? "（语音）" : "") + "：" + preview + " [" + (nowMs() - startedAt) + "ms]",
    );
    this.emitChange();
    return { segments, asVoice };
  }

  buildUserText(message, opts) {
    const bits = [];
    if (opts.kind === "proactive") {
      bits.push("（现在没有新消息，是你主动开口。可以就下面的线索自然地说点什么。）");
      if (message.text) bits.push(message.text);
      return bits.join("\n");
    }
    const name = message.nickname || message.userId;
    if (message.messageType === "group") {
      bits.push("[" + name + " 在群里说]");
    } else {
      bits.push("[" + name + " 说]");
    }
    let text = String(message.text || "").trim();
    // 去掉 @机器人 的部分，别让模型以为要回答 @xxx
    text = text.replace(new RegExp("@\\d+", "g"), "").trim();
    if (text) bits.push(text);
    if (Array.isArray(message.images) && message.images.length > 0) {
      bits.push("（对方发了 " + message.images.length + " 张图片）");
    }
    return bits.join("\n");
  }

  async collectImages(message) {
    const out = [];
    const maxBytes = this.cfg.vision.maxBytes;
    let downloaded = [];
    try {
      downloaded = await this.onebot.downloadImages(message.images, maxBytes);
    } catch (error) {
      this.fail("下载图片失败", error);
      return out;
    }
    for (const item of downloaded) {
      try {
        if (this.deps.attachments && typeof this.deps.attachments.saveImage === "function") {
          const ref = await this.deps.attachments.saveImage({
            data: new Uint8Array(item.data),
            mediaType: item.mediaType,
            name: item.name,
          });
          out.push({ ref, mediaType: item.mediaType });
        } else {
          out.push({ data: item.data, mediaType: item.mediaType });
        }
      } catch (error) {
        this.fail("保存图片失败", error);
      }
    }
    if (out.length > 0) this.log("info", "识别 " + out.length + " 张图片");
    return out;
  }

  async search(query) {
    if (!this.deps.web || typeof this.deps.web.search !== "function") return [];
    try {
      const rows = await this.deps.web.search(String(query || "").slice(0, 120), {
        maxResults: this.cfg.search.maxResults,
      });
      return Array.isArray(rows) ? rows.slice(0, this.cfg.search.maxResults) : [];
    } catch (error) {
      this.fail("联网搜索失败", error);
      return [];
    }
  }

  // —— 发送 ——

  async sendSegments(target, segments) {
    for (let i = 0; i < segments.length; i += 1) {
      const text = segments[i];
      const delay = core.typingDelay(text, this.cfg.reply);
      if (i > 0 || delay > 0) await sleep(i === 0 ? Math.min(delay, 400) : delay);
      try {
        await this.onebot.sendText(target, text);
      } catch (error) {
        this.fail("发送消息失败", error);
        return false;
      }
    }
    return true;
  }

  async sendVoice(target, segments, opts) {
    const cfg = this.cfg;
    const text = segments.join(" ");
    let files;
    try {
      files = await tts.synthesizeLong(text, {
        lang: cfg.voice.lang,
        speed: cfg.voice.speed,
        maxChars: cfg.voice.maxChars,
        lexicon: cfg.voice.lexicon,
      });
    } catch (error) {
      this.fail("语音合成失败，改用文字", error);
      return false;
    }
    const list = Array.isArray(files) ? files : [files];
    for (const file of list) {
      const delay = core.typingDelay("x".repeat(20), cfg.reply);
      await sleep(delay);
      try {
        await this.onebot.sendRecord(target, tts.toFileUrl(file));
      } catch (error) {
        this.fail("发送语音失败，改用文字", error);
        return false;
      }
    }
    return true;
  }

  // —— 通知事件（戳一戳等） ——

  handleNotice(event) {
    if (!event) return;
    if (event.notice_type === "notify" && event.sub_type === "poke") {
      const targetId = String(event.target_id || "");
      if (targetId && targetId === String(this.onebot.selfId)) {
        const userId = String(event.user_id || "");
        const target =
          event.group_id && String(event.group_id) !== "0"
            ? { kind: "group", groupId: String(event.group_id) }
            : { kind: "private", userId };
        this.onebot
          .sendSegments(target, [{ type: "text", data: { text: this.isMaster(userId) ? "唔…戳我干嘛呀" : "别戳啦" } }])
          .catch(() => {});
      }
    }
  }

  // —— 主动发言 ——

  clearProactive() {
    if (this.proactiveTimer) {
      clearTimeout(this.proactiveTimer);
      this.proactiveTimer = null;
    }
  }

  scheduleProactive() {
    this.clearProactive();
    if (!this.started || !this.cfg.active.enabled) {
      this.nextProactiveAt = 0;
      return;
    }
    const plan = core.planNextProactive(this.cfg, nowMs());
    this.nextProactiveAt = plan.at;
    const wait = Math.max(30000, plan.at - nowMs());
    this.proactiveTimer = setTimeout(() => {
      this.proactiveTimer = null;
      this.runProactive().catch((error) => this.fail("主动发言失败", error));
    }, wait);
    if (this.proactiveTimer && typeof this.proactiveTimer.unref === "function") this.proactiveTimer.unref();
    this.emitChange();
  }

  /** 候选会话：主人私聊永远在列表里，其余取最近活跃过的。 */
  proactiveCandidates() {
    const list = [];
    const masterUin = this.cfg.master.uin;
    if (masterUin) list.push("private:" + masterUin);
    for (const row of this.memory.recentSessions(12)) {
      if (!list.includes(row.sessionKey) && this.isProactiveAllowed(row.sessionKey)) list.push(row.sessionKey);
    }
    return list.filter((key) => this.isProactiveAllowed(key));
  }

  isProactiveAllowed(sessionKey) {
    const [kind, id] = String(sessionKey || "").split(":");
    if (kind === "private") {
      if (!this.cfg.reply.privateEnabled) return false;
      if (this.cfg.reply.privateWhitelistOnly) {
        return (this.cfg.reply.privateWhitelist || []).includes(id) || this.isMaster(id);
      }
      return true;
    }
    if (kind === "group") {
      if (!this.cfg.reply.groupsEnabled || this.cfg.reply.groupMode === "off") return false;
      const whitelist = this.cfg.reply.groupWhitelist || [];
      return whitelist.length === 0 || whitelist.includes(id);
    }
    return false;
  }

  async runProactive() {
    const cfg = this.cfg;
    try {
      if (!cfg.enabled || this.paused || !cfg.active.enabled) return;
      if (!this.onebot.connected) return;
      if (core.inQuietHours(cfg, nowMs())) {
        this.log("info", "免打扰时段，跳过主动发言");
        return;
      }
      const budget = core.withinProactiveBudget(this.proactiveHistory, cfg);
      this.proactiveHistory = this.proactiveHistory.filter((at) => at > nowMs() - 3600 * 1000);
      if (!budget.allowed) {
        this.log("info", "本小时主动发言已达上限（" + budget.maxPerHour + "）");
        return;
      }

      const candidates = this.proactiveCandidates();
      if (candidates.length === 0) return;
      const sessionKey = core.pickProactiveTarget(candidates, cfg);
      if (!sessionKey) return;

      // 顺便刷一会儿 B 站（需主人批准）
      let browseHint = "";
      if (cfg.bilibili.enabled && cfg.bilibili.approved && Math.random() < cfg.active.browseChance) {
        try {
          const result = await this.browseBilibili("auto");
          if (result && result.videos && result.videos.length > 0) {
            browseHint =
              "你刚在 B 站刷到：" + core.summarizeVideoNotes(result.videos, 3).join("；") + "。可以顺口聊一句。";
          }
        } catch (error) {
          this.fail("主动发言前刷 B 站失败", error);
        }
      }

      const target = this.sessionTarget(sessionKey);
      if (!target) return;
      const pseudo = {
        sessionKey,
        messageType: target.kind,
        userId: target.kind === "private" ? target.userId : "",
        nickname: await this.displayName(sessionKey),
        groupId: target.kind === "group" ? target.groupId : "",
        replyTarget: target,
        text: browseHint,
        images: [],
        selfId: this.onebot.selfId,
      };

      this.log("info", "主动发言 → " + sessionKey + (browseHint ? "（带 B 站内容）" : ""));
      const result = await this.respond(pseudo, { kind: "proactive" });
      if (result) {
        this.proactiveCount += 1;
        this.proactiveHistory.push(nowMs());
      }
    } finally {
      this.scheduleProactive();
    }
  }

  sessionTarget(sessionKey) {
    const [kind, id] = String(sessionKey || "").split(":");
    if (kind === "private" && id) return { kind: "private", userId: id };
    if (kind === "group" && id) return { kind: "group", groupId: id };
    return null;
  }

  async displayName(sessionKey) {
    const [kind, id] = String(sessionKey || "").split(":");
    if (kind === "group") {
      if (!this.groupNames.has(id)) await this.refreshGroups();
      return this.groupNames.get(id) || ("群 " + id);
    }
    if (this.isMaster(id)) return this.cfg.master.alias || "主人";
    return "好友 " + id;
  }

  /** 同步版：只读已有缓存，拿不到名字就退回号码。给 snapshot 用。 */
  labelFor(sessionKey) {
    const [kind, id] = String(sessionKey || "").split(":");
    if (kind === "group") return this.groupNames.get(id) || ("群 " + id);
    if (this.isMaster(id)) return this.cfg.master.alias || "主人";
    return "好友 " + id;
  }

  // —— B 站 ——

  /**
   * 刷一轮 B 站。需要 cfg.bilibili.approved 为真（除非 requester 是主人且 force）。
   * @param {string} requester "auto" | "master" | "panel"
   */
  async browseBilibili(requester) {
    const cfg = this.cfg;
    if (!cfg.bilibili.enabled) throw new Error("B 站功能未启用");
    if (!cfg.bilibili.approved && requester !== "master" && requester !== "panel") {
      throw new Error("还没得到主人批准，不能刷 B 站");
    }
    const result = await bilibili.browse({
      count: cfg.bilibili.batchSize,
      pageSize: Math.max(cfg.bilibili.feedSize, cfg.bilibili.batchSize),
      seen: (bvid) => this.memory.seenBvid(bvid),
    });

    const saved = [];
    for (const video of result.videos) {
      let note = bilibili.describeVideo(video);
      if (cfg.bilibili.aiNotes && this.deps.llm && typeof this.deps.llm.generate === "function") {
        try {
          const summary = await this.deps.llm.generate({
            system: "你是一个帮人记录视频内容的小助手。用一句中文说清这个视频在讲什么，不超过 40 字，不要客套话。",
            history: [],
            userText:
              "标题：" + video.title + "\nUP主：" + video.author + "\n简介：" + (video.desc || "无") + "\n标签：" +
              (video.tags || []).join("、"),
            temperature: 0.3,
            maxTokens: 120,
            provider: cfg.llm.provider,
            model: cfg.llm.model,
          });
          if (summary && summary.text) note = summary.text.replace(/\s+/g, " ").trim().slice(0, 60);
        } catch {
          /* 摘要失败就用模板描述 */
        }
      }
      const row = this.memory.addVideo(Object.assign({}, video, { note }));
      if (row) saved.push(row);
    }

    this.lastBrowseAt = nowMs();
    this.lastBrowseResult = {
      at: this.lastBrowseAt,
      count: saved.length,
      videos: saved.map((row) => ({ bvid: row.bvid, title: row.title, note: row.note })),
    };
    this.log("info", "刷了 B 站 " + saved.length + " 条视频：" + saved.map((v) => "《" + v.title + "》").join("、"));
    this.emitChange();
    return { videos: saved, skipped: result.skipped };
  }

  // —— 管理员指令 ——

  async handleCommand(command, message) {
    const name = command.name;
    const args = command.args || [];
    const target = message.replyTarget;
    const reply = (text) => this.onebot.sendText(target, text).catch(() => {});
    this.log("info", "执行指令 ." + name + " " + args.join(" "));

    switch (name) {
      case "help":
      case "帮助":
        await reply(
          [
            "可用指令：",
            ".status 查看状态",
            ".pause / .resume 暂停 / 恢复自动回复",
            ".persona <文本> 改人设",
            ".say <文本> 让我发一句话",
            ".voice on|off 语音开关",
            ".search auto|always|off 联网模式",
            ".bili 批准并刷一次 B 站",
            ".bili off 撤销 B 站权限",
            ".videos 看两小时内的视频",
            ".memory 看记忆条数",
            ".reset 清空当前会话记忆",
            ".reload 重载配置",
          ].join("\n"),
        );
        return;

      case "status":
      case "状态": {
        const st = this.onebot.status();
        const lines = [
          "运行中：" + (this.started && !this.paused ? "是" : "否"),
          "账号：" + (st.nickname || "未连接") + (st.selfId ? "（" + st.selfId + "）" : ""),
          "连接：" + (st.connected ? "已连接" : "断开（" + (st.lastError || "未知") + "）"),
          "人设：" + this.cfg.persona.name,
          "模型：" + (this.cfg.llm.provider || "默认") + " / " + (this.cfg.llm.model || "默认"),
          "已回复：" + this.replyCount + " 条，主动发言：" + this.proactiveCount + " 次",
          "视频暂存：" + this.memory.recentVideos(60).length + " 条（保留 " + this.cfg.bilibili.retentionHours + " 小时）",
          "B 站权限：" + (this.cfg.bilibili.approved ? "已批准" : "未批准"),
          "联网模式：" + this.cfg.search.mode,
        ];
        await reply(lines.join("\n"));
        return;
      }

      case "pause":
      case "暂停":
        this.paused = true;
        await reply("好，我先歇会儿。发 .resume 叫我。");
        this.emitChange();
        return;

      case "resume":
      case "恢复":
        this.paused = false;
        await reply("我回来了。");
        this.emitChange();
        return;

      case "persona":
      case "人设": {
        const text = args.join(" ").trim();
        if (!text) {
          await reply("当前人设名：" + this.cfg.persona.name + "\n" + this.cfg.persona.prompt.slice(0, 300));
          return;
        }
        this.cfg.persona.prompt = text;
        if (typeof this.deps.onConfigChange === "function") this.deps.onConfigChange({ persona: { prompt: text } });
        await reply("人设已更新。");
        return;
      }

      case "say":
      case "说":
        if (args.length === 0) return;
        await this.onebot.sendText(target, args.join(" "));
        return;

      case "voice":
      case "语音": {
        const mode = (args[0] || "").toLowerCase();
        const next = mode === "on" ? "auto" : mode === "off" ? "off" : this.cfg.voice.mode === "off" ? "auto" : "off";
        this.cfg.voice.mode = next;
        this.cfg.voice.enabled = next !== "off";
        if (typeof this.deps.onConfigChange === "function") {
          this.deps.onConfigChange({ voice: { mode: next, enabled: next !== "off" } });
        }
        await reply("语音回复：" + (next === "off" ? "关" : "开"));
        return;
      }

      case "search":
      case "联网": {
        const mode = (args[0] || "").toLowerCase();
        const next = ["auto", "always", "off"].includes(mode) ? mode : this.cfg.search.mode === "off" ? "auto" : "off";
        this.cfg.search.mode = next;
        if (typeof this.deps.onConfigChange === "function") this.deps.onConfigChange({ search: { mode: next } });
        await reply("联网模式：" + next);
        return;
      }

      case "bili":
      case "b站":
      case "刷b站": {
        if ((args[0] || "").toLowerCase() === "off") {
          this.cfg.bilibili.approved = false;
          if (typeof this.deps.onConfigChange === "function") this.deps.onConfigChange({ bilibili: { approved: false } });
          await reply("B 站权限已撤销。");
          return;
        }
        const granted = this.isMaster(message.userId);
        if (!this.cfg.bilibili.approved) {
          if (!granted) {
            this.pendingApproval = { at: nowMs(), by: message.userId };
            await reply("刷 B 站需要主人批准哦，我已经记下这次请求了。");
            this.emitChange();
            return;
          }
          this.cfg.bilibili.approved = true;
          if (typeof this.deps.onConfigChange === "function") this.deps.onConfigChange({ bilibili: { approved: true } });
        }
        await reply("那我去逛逛 B 站～");
        try {
          const result = await this.browseBilibili(granted ? "master" : "auto");
          const list = result.videos.map((v) => "《" + v.title + "》" + (v.note ? "：" + v.note : ""));
          await reply(list.length > 0 ? "刷到了：\n" + list.join("\n") : "首页都刷过了，没新的。");
        } catch (error) {
          await reply("刷失败了：" + (error && error.message ? error.message : "未知错误"));
        }
        return;
      }

      case "videos":
      case "视频": {
        const rows = this.memory.recentVideos(10);
        if (rows.length === 0) {
          await reply("两小时内还没刷到过视频。");
          return;
        }
        const lines = rows.map((row) => {
          const age = core.shelfAge(row, this.cfg.bilibili.retentionHours);
          return "《" + row.title + "》" + (row.note ? "：" + row.note : "") + "（还剩 " + Math.round(age.remainingMinutes) + " 分钟）";
        });
        await reply(lines.join("\n"));
        return;
      }

      case "memory":
      case "记忆":
        await reply("当前会话记忆 " + this.memory.history(message.sessionKey).length + " 条，总会话 " + this.memory.sessions.size + " 个。");
        return;

      case "reset":
      case "清空":
        this.memory.clearSession(message.sessionKey);
        await reply("这个会话的记忆清掉了。");
        return;

      case "reload":
      case "重载":
        if (typeof this.deps.reloadConfig === "function") {
          await this.deps.reloadConfig();
          await reply("配置已重载。");
        } else {
          await reply("这个环境不支持重载。");
        }
        return;

      default:
        await reply("不认识这条指令，发 .help 看看。");
    }
  }
}

module.exports = { Engine, LOG_LIMIT };
