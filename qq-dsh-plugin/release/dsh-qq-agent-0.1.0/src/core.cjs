/**
 * 纯逻辑：该不该回、怎么切段、提示词怎么拼、主动发言怎么排期。
 *
 * 这一层不碰网络、不碰 DSH、不碰 fs，方便单测（见 test/core.test.cjs）。
 */
"use strict";

/** 简易可复现随机数（测试里注入固定 seed 就能断言）。 */
function makeRng(seed) {
  if (typeof seed === "function") return seed;
  let state = (Number(seed) || Date.now()) >>> 0;
  return function rng() {
    // xorshift32
    state ^= state << 13;
    state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
  };
}

function includesAny(text, list) {
  const value = String(text || "").toLowerCase();
  for (const item of Array.isArray(list) ? list : []) {
    const needle = String(item || "").trim().toLowerCase();
    if (needle && value.includes(needle)) return true;
  }
  return false;
}

/**
 * 决定是否回复一条消息。
 * @param {object} message readEvent() 的结果
 * @param {object} cfg 归一化后的配置
 * @param {{rng?:Function, lastReplyAt?:number, now?:number}} [runtime]
 * @returns {{reply:boolean, reason:string, target?:object}}
 */
function shouldReply(message, cfg, runtime) {
  const rt = runtime || {};
  const rng = makeRng(rt.rng);
  const nowMs = Number(rt.now) || Date.now();

  if (!message) return { reply: false, reason: "no-message" };
  if (!cfg || cfg.enabled === false) return { reply: false, reason: "disabled" };
  if (message.selfId && message.userId === message.selfId) return { reply: false, reason: "self" };

  const isMaster = cfg.master && cfg.master.uin && message.userId === String(cfg.master.uin);

  if (message.messageType === "group") {
    if (!cfg.reply.groupsEnabled) return { reply: false, reason: "groups-disabled" };
    if (cfg.reply.groupMode === "off") return { reply: false, reason: "group-mode-off" };
    const whitelist = cfg.reply.groupWhitelist || [];
    if (whitelist.length > 0 && !whitelist.includes(String(message.groupId))) {
      return { reply: false, reason: "group-not-allowed" };
    }
  } else if (message.messageType === "private") {
    if (!cfg.reply.privateEnabled) return { reply: false, reason: "private-disabled" };
    const whitelist = cfg.reply.privateWhitelist || [];
    if (cfg.reply.privateWhitelistOnly && !whitelist.includes(String(message.userId)) && !isMaster) {
      return { reply: false, reason: "private-not-allowed" };
    }
  } else {
    return { reply: false, reason: "unsupported-type" };
  }

  // 冷却：同一会话太频繁就不回，避免刷屏
  const last = Number(rt.lastReplyAt) || 0;
  if (cfg.reply.cooldownSec > 0 && last > 0 && nowMs - last < cfg.reply.cooldownSec * 1000) {
    return { reply: false, reason: "cooldown" };
  }

  // 空消息（只有图片、或者只是 @ 了一下，也算有内容）
  const hasImage = Array.isArray(message.images) && message.images.length > 0;
  if (!String(message.text || "").trim() && !hasImage && !message.atMe) {
    return { reply: false, reason: "empty" };
  }

  // 群聊：只有 @ 到、命中关键词、或者模式是 all 才回
  if (message.messageType === "group") {
    const mode = cfg.reply.groupMode;
    const keywordHit = includesAny(message.text, cfg.reply.groupKeywords);
    if (message.atMe || keywordHit) {
      // @ 或关键词是"点名"，直接回
    } else if (mode === "all") {
      // 全回
    } else {
      return { reply: false, reason: "not-mentioned" };
    }
  }

  // 主人永远有豁免权，其余人过概率
  if (!isMaster && cfg.reply.replyChance < 1) {
    if (rng() > cfg.reply.replyChance) return { reply: false, reason: "chance" };
  }

  return { reply: true, reason: isMaster ? "master" : "allowed", target: message.replyTarget };
}

/** 把模型输出按空行/换行切成若干条 QQ 消息。 */
function splitSegments(rawText, options) {
  const opts = options || {};
  const maxChars = Math.max(20, Number(opts.maxChars) || 300);
  const split = opts.splitSegments !== false;
  let text = String(rawText == null ? "" : rawText).trim();
  if (!text) return [];

  // 模型偶尔会带 markdown 代码块或自我标注，先粗修
  text = text
    .replace(/^```[a-zA-Z]*\s*/g, "")
    .replace(/```$/g, "")
    .replace(/^["'「『]|["'」』]$/g, "")
    .trim();

  if (!split) {
    return text.length > maxChars ? [text.slice(0, maxChars)] : [text];
  }

  let pieces = text
    .split(/\n{2,}|\r\n\r\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (pieces.length <= 1) {
    pieces = text
      .split(/\n/)
      .map((part) => part.trim())
      .filter(Boolean);
  }

  // 单块太长就按句子折行
  const out = [];
  for (const piece of pieces) {
    if (piece.length <= maxChars) {
      out.push(piece);
      continue;
    }
    let buffer = "";
    for (const sentence of piece.split(/(?<=[。！？!?…；;])/)) {
      if (!sentence) continue;
      if ((buffer + sentence).length > maxChars && buffer) {
        out.push(buffer);
        buffer = "";
      }
      if (sentence.length > maxChars) {
        for (let i = 0; i < sentence.length; i += maxChars) out.push(sentence.slice(i, i + maxChars));
      } else {
        buffer += sentence;
      }
    }
    if (buffer) out.push(buffer);
  }
  return out.filter(Boolean).slice(0, 6);
}

/** 模拟"正在输入"的停顿：按字数与 cps 估算。 */
function typingDelay(text, options) {
  const opts = options || {};
  const cps = Math.max(1, Number(opts.typingCps) || 18);
  const min = Math.max(0, Number(opts.minDelayMs) || 0);
  const max = Math.max(min, Number(opts.maxDelayMs) || min);
  const estimated = (String(text || "").length / cps) * 1000;
  return Math.round(Math.min(max, Math.max(min, estimated)));
}

/** 当前是否处于免打扰时段。 */
function inQuietHours(cfg, nowMs) {
  const active = (cfg && cfg.active) || {};
  const hour = new Date(Number(nowMs) || Date.now()).getHours();
  const start = Number(active.quietStartHour);
  const end = Number(active.quietEndHour);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return false;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end; // 跨午夜
}

/**
 * 主动发言的排期：算出下一条主动消息应该在多久之后发。
 * 主人权重最高 → 越可能被选中、间隔越短。
 */
function planNextProactive(cfg, nowMs, rngLike) {
  const rng = makeRng(rngLike);
  const active = (cfg && cfg.active) || {};
  const minGap = Math.max(1, Number(active.minGapMinutes) || 40);
  const maxGap = Math.max(minGap, Number(active.maxGapMinutes) || 150);
  const gapMinutes = minGap + rng() * (maxGap - minGap);
  return { at: (Number(nowMs) || Date.now()) + Math.round(gapMinutes * 60000), gapMinutes };
}

/**
 * 从候选会话里挑一个主动发言对象。主人权重压倒性优先，但仍保留小概率轮到别人。
 * @param {string[]} candidates sessionKey 列表（"private:123" / "group:456"）
 * @param {object} cfg
 * @param {Function} rng
 */
function pickProactiveTarget(candidates, cfg, rngLike) {
  const rng = makeRng(rngLike);
  const list = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
  if (list.length === 0) return null;
  const active = (cfg && cfg.active) || {};
  const masterUin = cfg && cfg.master && cfg.master.uin ? String(cfg.master.uin) : "";
  const masterWeight = Number(active.masterWeight);
  const otherWeight = Number(active.otherWeight);
  const weighted = list.map((sessionKey) => {
    const isMaster = masterUin && sessionKey === "private:" + masterUin;
    return { sessionKey, weight: isMaster ? Math.max(0, masterWeight) : Math.max(0, otherWeight) };
  });
  const total = weighted.reduce((sum, row) => sum + row.weight, 0);
  if (total <= 0) return list[0];
  let roll = rng() * total;
  for (const row of weighted) {
    roll -= row.weight;
    if (roll <= 0) return row.sessionKey;
  }
  return weighted[weighted.length - 1].sessionKey;
}

/** 主动发言的频率闸门：每小时上限。 */
function withinProactiveBudget(timestamps, cfg, nowMs) {
  const active = (cfg && cfg.active) || {};
  const maxPerHour = Math.max(1, Number(active.maxPerHour) || 3);
  const cutoff = (Number(nowMs) || Date.now()) - 3600 * 1000;
  const recent = (Array.isArray(timestamps) ? timestamps : []).filter((at) => at >= cutoff);
  return { allowed: recent.length < maxPerHour, usedInHour: recent.length, maxPerHour };
}

/** 拼系统提示词。 */
function buildSystemPrompt(cfg, context) {
  const ctx = context || {};
  const persona = (cfg && cfg.persona) || {};
  const master = (cfg && cfg.master) || {};
  const lines = [];

  lines.push(persona.prompt || "");
  if (persona.extra) lines.push("", persona.extra);

  lines.push("", "## 当前场景");
  if (ctx.kind === "private") {
    const isMaster = master.uin && String(ctx.userId) === String(master.uin);
    lines.push(
      isMaster
        ? "你正在和「" + (master.alias || "主人") + "」私聊。ta 就是你最重要的人。"
        : "你正在和一个 QQ 好友私聊，对方昵称：" + (ctx.nickname || ctx.userId || "未知") + "。",
    );
  } else if (ctx.kind === "group") {
    lines.push("你正在 QQ 群「" + (ctx.groupName || ctx.groupId || "未知群") + "」里聊天。");
    lines.push("群里有很多人，你现在是在回应 " + (ctx.nickname || ctx.userId || "某人") + " 的发言。");
    lines.push("群里说话要更简短随意，不要长篇大论。");
  } else if (ctx.kind === "proactive") {
    lines.push("现在是你在主动找 " + (ctx.nickname || "对方") + " 搭话，没有人在叫你。");
    lines.push("主动搭话要自然：可以聊你刚看到的东西、问一句近况、或者分享一个小想法。不要问“在吗”。");
  }

  if (master.extra && master.uin && String(ctx.userId) === String(master.uin)) {
    lines.push(master.extra);
  }

  if (ctx.videoNotes && ctx.videoNotes.length > 0) {
    lines.push("", "## 你最近刷到的 B 站视频（" + ctx.videoNotes.length + " 条，都在两小时内）");
    for (const note of ctx.videoNotes) lines.push("- " + note);
    lines.push("聊到相关话题时可以自然提起这些内容，但别生硬地背清单。");
  }

  if (ctx.searchNotes && ctx.searchNotes.length > 0) {
    lines.push("", "## 刚查到的资料");
    for (const note of ctx.searchNotes) lines.push("- " + note);
    lines.push("用这些资料回答，但要用自己的话说，别照抄。");
  }

  lines.push(
    "",
    "## 输出要求",
    "- 直接输出要发出去的 QQ 消息，不要任何解释、前缀、引号或旁白。",
    "- 不要用 Markdown（不要 **、#、- 列表、代码块）。",
    "- 想分几条发就换行，每条独立成行；一条别超过 " + ((cfg.reply && cfg.reply.maxChars) || 300) + " 字。",
    "- 文字要像真人打字，可以口语、可以短、可以只回一句。",
  );

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** 判断是否需要联网搜索。 */
function needSearch(text, cfg, rngLike) {
  const mode = (cfg && cfg.search && cfg.search.mode) || "auto";
  if (mode === "off") return false;
  if (mode === "always") return true;
  const value = String(text || "");
  if (value.length < 4) return false;
  const triggers = [
    "最新",
    "新闻",
    "现在",
    "今天",
    "昨天",
    "明天",
    "多少钱",
    "价格",
    "怎么样",
    "是什么",
    "为什么",
    "谁",
    "哪",
    "查",
    "搜",
    "版本",
    "更新",
    "发布",
    "天气",
    "比分",
    "股价",
    "汇率",
    "攻略",
    "推荐",
  ];
  if (includesAny(value, triggers)) return true;
  // 带问号且有一定长度，也倾向查一下
  if (/[?？]/.test(value) && value.length >= 8) return true;
  const rng = makeRng(rngLike);
  return rng() < 0.15;
}

/** 这条回复该不该改成语音。 */
function shouldUseVoice(text, cfg, messageText, rngLike) {
  const voice = (cfg && cfg.voice) || {};
  if (!voice.enabled) return false;
  if (voice.mode === "off") return false;
  const clean = String(text || "").trim();
  if (!clean) return false;
  if (clean.length > Math.max(10, Number(voice.maxChars) || 120)) return false;
  if (voice.mode === "keyword") return includesAny(messageText, voice.keywords);
  if (includesAny(messageText, voice.keywords)) return true;
  const rng = makeRng(rngLike);
  return rng() < Math.max(0, Math.min(1, Number(voice.chance) || 0));
}

/** 管理员指令解析。 */
function parseCommand(text) {
  const value = String(text || "").trim();
  if (!value.startsWith(".")) return null;
  const parts = value.slice(1).split(/\s+/);
  const name = (parts.shift() || "").toLowerCase();
  if (!name) return null;
  return { name, args: parts };
}

/** 把几条视频描述拼成一段给模型看的上下文。 */
function summarizeVideoNotes(videos, max) {
  const limit = Math.max(1, Number(max) || 6);
  return (Array.isArray(videos) ? videos : [])
    .slice(0, limit)
    .map((video) => {
      const title = video.title || "无标题";
      const bits = ["《" + title + "》"];
      if (video.author) bits.push("UP " + video.author);
      // note 通常由 bilibili.describeVideo 生成，开头已经带了《标题》和 "UP 主 xxx"，
      // 原样拼进来会出现「《标题》｜UP x｜《标题》，UP 主 x，时长…」这种重复。
      let note = video.note ? String(video.note) : "";
      if (note) {
        note = note.replace(/^《[^》]*》[，,]?\s*/, "");
        if (video.author) note = note.replace(/^UP\s*主?\s*[^，,]+[，,]?\s*/, "");
        note = note.trim();
      }
      if (note) bits.push(note);
      else if (video.desc) bits.push(String(video.desc).replace(/\s+/g, " ").slice(0, 80));
      return bits.join("｜");
    });
}

/** 距离过期还有多久（给面板显示用）。 */
function shelfAge(video, retentionHours, nowMs) {
  const at = Number(video && video.at) || 0;
  if (!at) return { ageMinutes: 0, remainingMinutes: 0, expired: true };
  const nowValue = Number(nowMs) || Date.now();
  const ageMinutes = Math.max(0, (nowValue - at) / 60000);
  const remainingMinutes = Math.max(0, Number(retentionHours) * 60 - ageMinutes);
  return { ageMinutes, remainingMinutes, expired: remainingMinutes <= 0 };
}

module.exports = {
  makeRng,
  includesAny,
  shouldReply,
  splitSegments,
  typingDelay,
  inQuietHours,
  planNextProactive,
  pickProactiveTarget,
  withinProactiveBudget,
  buildSystemPrompt,
  needSearch,
  shouldUseVoice,
  parseCommand,
  summarizeVideoNotes,
  shelfAge,
};
