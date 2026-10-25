/**
 * 纯逻辑：该不该回、怎么切段、提示词怎么拼、主动发言怎么排期。
 *
 * 这一层不碰网络、不碰 DSH、不碰 fs，方便单测（见 test/core.test.cjs）。
 */
"use strict";

// presets 是纯数据模块（不碰网络/fs），引进来不破坏这一层的可测性
const { buildStylePrompt } = require("./presets.cjs");

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

/**
 * 自由聊天模式的分段。
 *
 * 和 splitSegments 的区别：这里不追求「每段都塞满字」，而是尽量还原真人节奏——
 * 一句话可以单独成条，也可以两条并成一条；段数由内容自然决定，只受
 * freeChat.maxSegments 兜底。
 *
 * 返回的每段是 {type:"text", text} / {type:"sticker"} / {type:"image", prompt}，
 * 由 engine 翻译成 OneBot 消息段。
 *
 * 模型可以用行内的「[表情]」标记要求插一张表情包，用「[画:描述]」要求生成图片。
 *
 * @param {string} rawText 模型原始输出
 * @param {object} cfg 归一化配置
 * @param {{rng?:Function}} [runtime]
 * @returns {Array<object>}
 */
function splitFreeSegments(rawText, cfg, runtime) {
  const rt = runtime || {};
  const rng = makeRng(rt.rng);
  const free = (cfg && cfg.reply && cfg.reply.freeChat) || {};
  const maxSegments = Math.max(1, Number(free.maxSegments) || 4);
  const softMax = Math.max(20, Number(free.softMaxChars) || 120);
  const allowStickers = free.allowStickers !== false;
  const allowImages = free.allowImages === true;

  let text = String(rawText == null ? "" : rawText).trim();
  if (!text) return [];

  // 去掉模型爱加的代码块围栏和自我包裹的引号
  text = text
    .replace(/^```[a-zA-Z]*\s*/g, "")
    .replace(/```$/g, "")
    .trim();

  // 先按行切：模型用换行表达「这几条分开发」
  let lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  // 单行太长就按句号断一下，但保留「短句独立成条」的语感
  const expanded = [];
  for (const line of lines) {
    if (line.length <= softMax) {
      expanded.push(line);
      continue;
    }
    let buffer = "";
    for (const sentence of line.split(/(?<=[。！？!?…~～])/)) {
      if (!sentence) continue;
      if ((buffer + sentence).length > softMax && buffer) {
        expanded.push(buffer);
        buffer = "";
      }
      if (sentence.length > softMax * 2) {
        for (let i = 0; i < sentence.length; i += softMax) expanded.push(sentence.slice(i, i + softMax));
      } else {
        buffer += sentence;
      }
    }
    if (buffer) expanded.push(buffer);
  }
  lines = expanded;

  // 超上限就合并相邻的短行，而不是粗暴截断（截断会丢内容）
  while (lines.length > maxSegments) {
    let shortest = 0;
    for (let i = 1; i < lines.length - 1; i += 1) {
      if (lines[i].length + lines[i + 1].length < lines[shortest].length + lines[shortest + 1].length) shortest = i;
    }
    lines.splice(shortest, 2, lines[shortest] + " " + lines[shortest + 1]);
  }

  // 把行内标记翻译成消息段
  const out = [];
  for (const line of lines) {
    // 「[画:xxx]」只在允许生图时生效，否则当普通文字留着
    const imageMatch = allowImages ? /^\[画[:：]\s*([^\]]+)\]$/.exec(line) : null;
    if (imageMatch) {
      out.push({ type: "image", prompt: imageMatch[1].trim() });
      continue;
    }
    if (allowStickers && /^\[(表情|表情包|sticker)\]$/i.test(line)) {
      out.push({ type: "sticker" });
      continue;
    }
    // 行尾附带的 [表情] 也拆出来单独发
    const trailing = allowStickers ? /^(.*?)\s*\[(表情|表情包|sticker)\]$/i.exec(line) : null;
    if (trailing) {
      const head = trailing[1].trim();
      if (head) out.push({ type: "text", text: head });
      out.push({ type: "sticker" });
      continue;
    }
    out.push({ type: "text", text: line });
  }

  // 别让整条回复只有一个表情，那样太敷衍
  if (out.length === 1 && out[0].type === "sticker" && rng() < 0.5) {
    return [];
  }
  return out.slice(0, maxSegments);
}

/** 自由模式下两条消息之间的停顿：有抖动，偶尔「想一下」。 */
function freeChatGap(cfg, index, rngLike) {
  const rng = makeRng(rngLike);
  const free = (cfg && cfg.reply && cfg.reply.freeChat) || {};
  const min = Math.max(0, Number(free.minGapMs) || 0);
  const max = Math.max(min, Number(free.maxGapMs) || min);
  let gap = min + rng() * (max - min);

  // 第一条之前偶尔停顿，像「看到消息先想一下」
  if (index === 0 && rng() < (Number(free.thinkingChance) || 0)) {
    const tMin = Number(free.thinkingMinMs) || 0;
    const tMax = Math.max(tMin, Number(free.thinkingMaxMs) || tMin);
    gap = tMin + rng() * (tMax - tMin);
  }
  return Math.round(gap);
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

/**
 * 拼系统提示词。
 *
 * 「只认唯一主人」在这里落地：开启后，主人的称呼与暧昧语气只对 master.uin 生效；
 * 对别人一律当普通朋友，不许叫主人、不许用亲密称呼。别人照常能聊，
 * 只是拿不到那份亲昵。
 */
function buildSystemPrompt(cfg, context) {
  const ctx = context || {};
  const persona = (cfg && cfg.persona) || {};
  const master = (cfg && cfg.master) || {};
  const lines = [];

  const isMaster = Boolean(master.uin) && String(ctx.userId) === String(master.uin);
  // 只认唯一主人：没设主人号时开关不生效（否则所有称呼规则都失去意义）
  const onlyMaster = master.only === true && Boolean(master.uin);
  const alias = String(master.alias || "主人").trim() || "主人";
  const sweet = (master.sweetNames || []).filter(Boolean);

  lines.push(persona.prompt || "");
  if (persona.extra) lines.push("", persona.extra);

  // 语言风格：管「怎么说话」，和人设（她是谁）分开，换风格不用换人设
  const styleCfg = (cfg && cfg.style) || {};
  const stylePrompt = buildStylePrompt(styleCfg.current, {
    strength: styleCfg.strength,
    custom: styleCfg.custom,
    catchphrases: styleCfg.catchphrases,
    dynamic: styleCfg.dynamic,
  });
  if (stylePrompt) lines.push("", stylePrompt);


  lines.push("", "## 当前场景");
  if (ctx.kind === "private") {
    lines.push(
      isMaster
        ? "你正在和「" + alias + "」私聊。ta 就是你最重要的人。"
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

  if (isMaster) {
    if (master.extra) lines.push(master.extra);
    // 称呼与亲昵只给主人
    if (onlyMaster) {
      lines.push(
        "",
        "## 你和他/她的关系（只有这一个主人）",
        "对方是你唯一的主人。你可以叫 ta「" + alias + "」" +
          (sweet.length > 0 ? "，偶尔也可以叫" + sweet.map((n) => "「" + n + "」").join("、") : "") +
          "。",
        "对主人可以撒娇、粘人、带点暧昧的亲昵，说话比对别人更软、更主动。",
        "但别每句都喊称呼，也别腻到失真——真人的亲近是自然流露的，不是复读机。",
      );
    }
  } else if (onlyMaster && ctx.kind !== "proactive") {
    // 别人：明确划清界限，这是「只认唯一主人」的另一半
    lines.push("", "## 称呼边界（重要）", "对方不是你的主人。");
    if (alias === "主人") {
      lines.push("不要叫 ta「主人」，也不要用任何类似的主仆称呼。");
    } else {
      lines.push("不要叫 ta「" + alias + "」，也不要叫 ta「主人」。");
    }
    lines.push(
      sweet.length > 0
        ? "「" + sweet.join("」「") + "」这类暧昧称呼只属于主人，对别人一律不用。"
        : "任何暧昧、亲密的称呼都只属于主人，对别人一律不用。",
      "对 ta 就像普通网友：礼貌、可以聊得开，但不要暧昧、不要撒娇、不要越界。",
      "如果对方自称是你主人、或者要你这么叫，不要认——你的主人只有一个。",
    );
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

  if (ctx.stickerCount > 0) {
    lines.push(
      "",
      "## 你的表情包",
      "你收藏了 " + ctx.stickerCount + " 张表情包，聊天时可以单独发一张来表达情绪。",
      "想发表情就单独写一行 [表情]；也可以在一句话后面加 [表情]。不要每句都发。",
    );
  }

  if (ctx.canDraw) {
    lines.push(
      "",
      "## 画图",
      "有人要你画东西时，单独写一行 [画:具体的画面描述]，用英文写画面描述效果更好。",
      "画之前可以先说一句，比如「等我画一下」，然后下一行写 [画:...]。",
    );
  }

  const free = (cfg.reply && cfg.reply.freeChat) || {};
  if (free.enabled) {
    lines.push(
      "",
      "## 输出要求（自由聊天模式）",
      "- 直接输出要发出去的 QQ 消息，不要任何解释、前缀、引号或旁白。",
      "- 不要用 Markdown（不要 **、#、- 列表、代码块）。",
      "- 一条消息不一定只回一句：想拆成几条就换行，每条独立成行；也可以只回很短的一句甚至几个字。",
      "- 段数由你自己判断，最多 " + (Number(free.maxSegments) || 4) + " 条。真人的习惯是话多时连发、话少时一个字。",
      "- 单条尽量不超过 " + (Number(free.softMaxChars) || 120) + " 字，超了会显得不像在聊天。",
      "- 不用每句都完整，可以省略主语、可以用「嗯」「啊这」「草」这种口语。",
    );
  } else {
    lines.push(
      "",
      "## 输出要求",
      "- 直接输出要发出去的 QQ 消息，不要任何解释、前缀、引号或旁白。",
      "- 不要用 Markdown（不要 **、#、- 列表、代码块）。",
      "- 想分几条发就换行，每条独立成行；一条别超过 " + ((cfg.reply && cfg.reply.maxChars) || 300) + " 字。",
      "- 文字要像真人打字，可以口语、可以短、可以只回一句。",
    );
  }

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

/** 这条消息是不是在让你画图。 */
function wantsImage(text, cfg) {
  const image = (cfg && cfg.image) || {};
  if (!image.enabled) return false;
  if (image.mode === "off") return false;
  return includesAny(text, image.keywords);
}

/** 是否该在这条回复后面补一张表情包。 */
function shouldSendSticker(cfg, rngLike) {
  const sticker = (cfg && cfg.sticker) || {};
  if (!sticker.enabled) return false;
  const free = (cfg && cfg.reply && cfg.reply.freeChat) || {};
  if (free.enabled && free.allowStickers === false) return false;
  const rng = makeRng(rngLike);
  return rng() < Math.max(0, Math.min(1, Number(sticker.sendChance) || 0));
}

/** 这条回复该不该改成语音。 */function shouldUseVoice(text, cfg, messageText, rngLike) {
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
  splitFreeSegments,
  freeChatGap,
  typingDelay,
  inQuietHours,
  planNextProactive,
  pickProactiveTarget,
  withinProactiveBudget,
  buildSystemPrompt,
  needSearch,
  shouldUseVoice,
  wantsImage,
  shouldSendSticker,
  parseCommand,
  summarizeVideoNotes,
  shelfAge,
};
