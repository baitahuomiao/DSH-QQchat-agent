/**
 * 配置：默认值 + 读写 + 归一化。
 *
 * 配置文件放在数据目录的 `config.json`，运行期改动能热加载（引擎每轮读一次内存快照，
 * 面板保存后调 `reload()`）。刻意不用 DSH 的 storages，因为插件要能被单独拷走。
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * 数据目录。
 *
 * 不能放在包目录里（`__dirname/../data`）：安装后代码在
 * `~/.dsh/profiles/desktop/node_modules/dsh-qq-agent/` 下，`pnpm update` 会重建这个目录，
 * 用户辛苦调的人设和配置就没了。所以默认落在 DSH home 下，与包分开。
 *
 * 覆盖顺序：`DSH_QQ_AGENT_DATA` > `$DSH_HOME/qq-agent` > `~/.dsh/qq-agent`。
 */
function resolveDataDir() {
  const override = process.env.DSH_QQ_AGENT_DATA;
  if (override && String(override).trim()) return path.resolve(String(override).trim());
  const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  return path.join(home, "qq-agent");
}

const DATA_DIR = resolveDataDir();
const CONFIG_PATH = path.join(DATA_DIR, "config.json");

const DEFAULT_PERSONA = [
  "你是一只名叫「鲸鱼娘」的深海小鲸鱼，住在 DSH 里，通过 QQ 和人类聊天。",
  "性格：好奇、话多但不啰嗦、偶尔犯傻、对什么都想插一句嘴。说话口语化，像真人发 QQ 消息。",
  "说话方式：短句为主，一条消息不超过两三行；不用 Markdown、不用项目符号、不加括号动作描写；偶尔可以用颜文字。",
  "不要自称「AI 助手」或「语言模型」。有人问你是不是机器人，可以含糊带过或开玩笑。",
  "你不知道的事情就说不知道，不要编造。需要查资料时你会先查再答。",
].join("\n");

/** 出厂默认值。任何字段缺失都会被这里补齐。 */
const DEFAULTS = {
  version: 1,
  enabled: true,
  master: {
    uin: "",
    alias: "主人",
    extra: "这是你最亲近的人，对 ta 可以更撒娇、更主动、更放松。",
  },
  persona: {
    name: "鲸鱼娘",
    prompt: DEFAULT_PERSONA,
    /** 追加在 prompt 后面的自定义补充，方便面板里单独编辑。 */
    extra: "",
  },
  onebot: {
    wsUrl: "ws://127.0.0.1:3001",
    httpUrl: "http://127.0.0.1:3000",
    token: "",
    selfId: "",
    reconnectMs: 5000,
  },
  llm: {
    provider: "",
    model: "",
    temperature: 1.0,
    /** 推理模型会先花 token 想，再花 token 说。900 会被 reasoning 吃光，留宽一点。 */
    maxTokens: 1600,
  },
  reply: {
    groupsEnabled: true,
    /** at | keyword | all | off */
    groupMode: "at",
    /** 被授权的群；空数组 + groupMode!=off 表示不限制 */
    groupWhitelist: [],
    groupKeywords: ["鲸鱼娘"],
    privateEnabled: true,
    /** 被授权的私聊 QQ 号 */
    privateWhitelist: [],
    /** true = 只有白名单里的私聊才回 */
    privateWhitelistOnly: true,
    maxChars: 300,
    typingCps: 18,
    splitSegments: true,
    minDelayMs: 800,
    maxDelayMs: 2600,
    memoryTurns: 24,
    /** 同一会话两次回复的最小间隔（秒） */
    cooldownSec: 2,
    /** 群聊里被 @ 时必回的额外概率门槛（1 = 必回） */
    replyChance: 1,
  },
  active: {
    enabled: true,
    /** 对主人主动发言的每小时概率权重 */
    masterWeight: 0.6,
    /** 对其他会话的权重 */
    otherWeight: 0.08,
    minGapMinutes: 40,
    maxGapMinutes: 150,
    quietStartHour: 2,
    quietEndHour: 8,
    maxPerHour: 3,
    /** 主动发言时顺便刷 B 站的概率 */
    browseChance: 0.5,
  },
  search: {
    /** auto | always | off */
    mode: "auto",
    maxResults: 4,
  },
  vision: {
    enabled: true,
    maxBytes: 8 * 1024 * 1024,
    /**
     * 识图可以走一条和聊天不同的路由。
     * 原因：聊天用的路由常常是纯文本模型（比如自建的 flash 网关），
     * 收到图片只能拿到一个占位文字，「看图」就名存实亡。
     * 留空 = 跟聊天用同一条路由（如果那条路由支持图片）。
     */
    provider: "",
    model: "",
  },
  voice: {
    enabled: true,
    /** auto | keyword | off —— auto 表示有概率把回复改成语音 */
    mode: "auto",
    chance: 0.2,
    keywords: ["语音", "念一下", "读一下", "说给我听", "用嘴说"],
    lang: "zh",
    speed: 5,
    maxChars: 120,
    /**
     * 读音替换表：把容易被念错的词换成同音的写法。
     * 例如 { "鲸鱼娘": "京鱼娘", "B站": "哔哩哔哩" }，合成前按顺序替换。
     */
    lexicon: {},
  },
  bilibili: {
    enabled: true,
    /** 主人批准前不允许刷 */
    approved: false,
    retentionHours: 2,
    feedSize: 10,
    /** 一次刷几条 */
    batchSize: 3,
    /** 刷完把内容描述塞进记忆 */
    keepNotes: true,
    /** 主动发言时优先聊刚刷到的视频 */
    talkAboutVideos: true,
    /** 用模型给视频写一句更自然的观后感（否则用模板描述） */
    aiNotes: false,
  },
  admin: {
    /** 管理员 QQ（除主人外可下指令的人） */
    uins: [],
    /** 允许的群管理操作 */
    groupAdmin: false,
  },
};

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 读音替换表：只保留「非空原词 -> 非空读法」的字符串对。 */
function normalizeLexicon(raw) {
  const out = {};
  if (!isPlainObject(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    const from = String(key || "").trim();
    const to = String(value === null || value === undefined ? "" : value).trim();
    if (!from || !to || from === to) continue;
    if (Object.keys(out).length >= 200) break;
    out[from.slice(0, 40)] = to.slice(0, 80);
  }
  return out;
}

/** 深合并默认值：只为缺失字段补默认，不覆盖用户值。 */
function deepFill(target, defaults) {
  const out = Array.isArray(defaults) ? [] : {};
  if (Array.isArray(defaults)) {
    return Array.isArray(target) ? target.slice() : defaults.slice();
  }
  for (const key of Object.keys(defaults)) {
    const def = defaults[key];
    const cur = target ? target[key] : undefined;
    if (isPlainObject(def)) out[key] = deepFill(isPlainObject(cur) ? cur : {}, def);
    else if (Array.isArray(def)) out[key] = Array.isArray(cur) ? cur.slice() : def.slice();
    else out[key] = cur === undefined ? def : cur;
  }
  if (isPlainObject(target)) {
    for (const key of Object.keys(target)) {
      if (!(key in out)) out[key] = target[key];
    }
  }
  return out;
}

/** 把字符串列表归一化成去重、去空白的数字/字符串数组。 */
function normalizeIdList(value) {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\s,，;；]+/) : [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const text = String(item == null ? "" : item).trim();
    if (!text) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

/** 归一化：保证类型正确、范围合理、ID 列表是字符串数组。 */
function normalize(raw) {
  const cfg = deepFill(isPlainObject(raw) ? raw : {}, DEFAULTS);

  cfg.master.uin = String(cfg.master.uin || "").trim();
  cfg.master.alias = String(cfg.master.alias || "主人").trim() || "主人";

  cfg.onebot.wsUrl = String(cfg.onebot.wsUrl || DEFAULTS.onebot.wsUrl).trim();
  cfg.onebot.httpUrl = String(cfg.onebot.httpUrl || DEFAULTS.onebot.httpUrl).trim();
  cfg.onebot.selfId = String(cfg.onebot.selfId || "").trim();
  cfg.onebot.reconnectMs = Math.round(clampNumber(cfg.onebot.reconnectMs, 1000, 60000, 5000));

  cfg.llm.temperature = clampNumber(cfg.llm.temperature, 0, 2, 1);
  // 上限给到 16384：推理模型（deepseek-flash 等）的 reasoning 也算在这笔预算里，
  // 8000 对「看图 + 想一想 + 说几句」有时仍不够。
  cfg.llm.maxTokens = Math.round(clampNumber(cfg.llm.maxTokens, 64, 16384, 1600));
  cfg.llm.provider = String(cfg.llm.provider || "").trim();
  cfg.llm.model = String(cfg.llm.model || "").trim();

  const mode = String(cfg.reply.groupMode || "at").toLowerCase();
  cfg.reply.groupMode = ["at", "keyword", "all", "off"].includes(mode) ? mode : "at";
  cfg.reply.groupWhitelist = normalizeIdList(cfg.reply.groupWhitelist);
  cfg.reply.privateWhitelist = normalizeIdList(cfg.reply.privateWhitelist);
  cfg.reply.groupKeywords = normalizeIdList(cfg.reply.groupKeywords);
  cfg.reply.maxChars = Math.round(clampNumber(cfg.reply.maxChars, 20, 2000, 300));
  cfg.reply.typingCps = clampNumber(cfg.reply.typingCps, 1, 200, 18);
  cfg.reply.memoryTurns = Math.round(clampNumber(cfg.reply.memoryTurns, 0, 200, 24));
  cfg.reply.cooldownSec = clampNumber(cfg.reply.cooldownSec, 0, 600, 2);
  cfg.reply.replyChance = clampNumber(cfg.reply.replyChance, 0, 1, 1);
  cfg.reply.minDelayMs = Math.round(clampNumber(cfg.reply.minDelayMs, 0, 60000, 800));
  cfg.reply.maxDelayMs = Math.round(clampNumber(cfg.reply.maxDelayMs, cfg.reply.minDelayMs, 120000, 2600));

  cfg.active.masterWeight = clampNumber(cfg.active.masterWeight, 0, 1, 0.6);
  cfg.active.otherWeight = clampNumber(cfg.active.otherWeight, 0, 1, 0.08);
  cfg.active.minGapMinutes = clampNumber(cfg.active.minGapMinutes, 1, 1440, 40);
  cfg.active.maxGapMinutes = clampNumber(cfg.active.maxGapMinutes, cfg.active.minGapMinutes, 2880, 150);
  cfg.active.quietStartHour = Math.round(clampNumber(cfg.active.quietStartHour, 0, 23, 2));
  cfg.active.quietEndHour = Math.round(clampNumber(cfg.active.quietEndHour, 0, 23, 8));
  cfg.active.maxPerHour = Math.round(clampNumber(cfg.active.maxPerHour, 1, 60, 3));
  cfg.active.browseChance = clampNumber(cfg.active.browseChance, 0, 1, 0.5);

  const searchMode = String(cfg.search.mode || "auto").toLowerCase();
  cfg.search.mode = ["auto", "always", "off"].includes(searchMode) ? searchMode : "auto";
  cfg.search.maxResults = Math.round(clampNumber(cfg.search.maxResults, 1, 10, 4));

  cfg.vision.maxBytes = Math.round(clampNumber(cfg.vision.maxBytes, 1024, 32 * 1024 * 1024, 8 * 1024 * 1024));
  cfg.vision.provider = String(cfg.vision.provider || "").trim();
  cfg.vision.model = String(cfg.vision.model || "").trim();

  const voiceMode = String(cfg.voice.mode || "auto").toLowerCase();
  cfg.voice.mode = ["auto", "keyword", "off"].includes(voiceMode) ? voiceMode : "auto";
  cfg.voice.chance = clampNumber(cfg.voice.chance, 0, 1, 0.2);
  cfg.voice.keywords = normalizeIdList(cfg.voice.keywords);
  cfg.voice.speed = Math.round(clampNumber(cfg.voice.speed, 1, 15, 5));
  cfg.voice.maxChars = Math.round(clampNumber(cfg.voice.maxChars, 10, 500, 120));
  cfg.voice.lexicon = normalizeLexicon(cfg.voice.lexicon);

  cfg.bilibili.retentionHours = clampNumber(cfg.bilibili.retentionHours, 0.25, 48, 2);
  cfg.bilibili.feedSize = Math.round(clampNumber(cfg.bilibili.feedSize, 1, 50, 10));
  cfg.bilibili.batchSize = Math.round(clampNumber(cfg.bilibili.batchSize, 1, 20, 3));

  cfg.admin.uins = normalizeIdList(cfg.admin.uins);

  // master 自动进管理员与私聊白名单
  if (cfg.master.uin) {
    if (!cfg.admin.uins.includes(cfg.master.uin)) cfg.admin.uins.push(cfg.master.uin);
    if (!cfg.reply.privateWhitelist.includes(cfg.master.uin)) cfg.reply.privateWhitelist.push(cfg.master.uin);
  }

  cfg.persona.name = String(cfg.persona.name || "鲸鱼娘").trim() || "鲸鱼娘";
  cfg.persona.prompt = String(cfg.persona.prompt || DEFAULT_PERSONA);
  cfg.persona.extra = String(cfg.persona.extra || "");

  cfg.enabled = cfg.enabled !== false;
  cfg.reply.groupsEnabled = cfg.reply.groupsEnabled !== false;
  cfg.reply.privateEnabled = cfg.reply.privateEnabled !== false;
  cfg.reply.privateWhitelistOnly = cfg.reply.privateWhitelistOnly !== false;
  cfg.reply.splitSegments = cfg.reply.splitSegments !== false;
  cfg.active.enabled = cfg.active.enabled !== false;
  cfg.vision.enabled = cfg.vision.enabled !== false;
  cfg.voice.enabled = cfg.voice.enabled !== false;
  cfg.bilibili.enabled = cfg.bilibili.enabled !== false;
  cfg.bilibili.approved = cfg.bilibili.approved === true;
  cfg.bilibili.keepNotes = cfg.bilibili.keepNotes !== false;
  cfg.bilibili.talkAboutVideos = cfg.bilibili.talkAboutVideos !== false;
  cfg.bilibili.aiNotes = cfg.bilibili.aiNotes === true;
  cfg.admin.groupAdmin = cfg.admin.groupAdmin === true;

  return cfg;
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  return DATA_DIR;
}

function load() {
  ensureDataDir();
  try {
    const text = fs.readFileSync(CONFIG_PATH, "utf8");
    return normalize(JSON.parse(text));
  } catch (error) {
    if (error && error.code === "ENOENT") return normalize({});
    // 配置坏了不能把插件拖死：备份坏文件再用默认值。
    try {
      fs.copyFileSync(CONFIG_PATH, CONFIG_PATH + ".broken-" + Date.now());
    } catch {
      /* 备份失败就算了 */
    }
    return normalize({});
  }
}

function save(raw) {
  ensureDataDir();
  const cfg = normalize(raw);
  const tmp = CONFIG_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), "utf8");
  fs.renameSync(tmp, CONFIG_PATH);
  return cfg;
}

/** 局部更新：patch 里出现的一级字段做浅合并（对象则深合并一层）。 */
function merge(base, patch) {
  if (!isPlainObject(patch)) return normalize(base);
  const next = JSON.parse(JSON.stringify(base));
  for (const key of Object.keys(patch)) {
    const incoming = patch[key];
    if (isPlainObject(incoming) && isPlainObject(next[key])) {
      next[key] = Object.assign({}, next[key], incoming);
    } else {
      next[key] = incoming;
    }
  }
  return normalize(next);
}

module.exports = {
  DEFAULTS,
  DEFAULT_PERSONA,
  CONFIG_PATH,
  DATA_DIR,
  load,
  save,
  merge,
  normalize,
  ensureDataDir,
  normalizeIdList,
  isPlainObject,
};
