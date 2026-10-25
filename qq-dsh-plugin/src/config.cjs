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
    /**
     * 额外的暧昧称呼。
     *
     * 只对 master.uin 生效，例如 ["老公", "亲爱的", "哥哥"]。
     * 别人就算自称主人也不会被这么叫。
     */
    sweetNames: ["亲爱的", "老公"],
    extra: "这是你最亲近的人，对 ta 可以更撒娇、更主动、更放松。",
    /**
     * 只认唯一主人。
     *
     * true = 主人的称呼和暧昧语气只给 master.uin 一个人。
     *   - 别人照常能聊，但不会被叫「主人」，也不许用上面的暧昧称呼
     *   - 有人冒充主人也不认
     * false = 不限制称呼（老行为）。
     * 没设 master.uin 时这个开关不生效。
     */
    only: false,
  },
  persona: {
    name: "鲸鱼娘",
    prompt: DEFAULT_PERSONA,
    /** 追加在 prompt 后面的自定义补充，方便面板里单独编辑。 */
    extra: "",
    /**
     * 用户自己存的人格库。
     *
     * 和内置 presets 分开：presets 是随插件发布的只读模板，这里是用户
     * 存下来、可改名可删的。每项 {id, name, prompt, extra, createdAt}。
     */
    saved: [],
  },
  onebot: {
    wsUrl: "ws://127.0.0.1:3001",
    httpUrl: "http://127.0.0.1:3000",
    token: "",
    // 机器人自己的 QQ 号，快速登录（-q）用它，不是主人号
    selfId: "",
    reconnectMs: 5000,
    // 开机自动拉起 NapCat 并快速登录，省掉每次手动点「一键连接」
    autoStart: true,
    // NapCat 目录，留空就自动找（E:\NapCat、C:\NapCat 等）
    shellDir: "",
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
    /**
     * 自由聊天模式。
     *
     * 打开后回复不再被「切成几条、每条多少字」硬约束：
     *  - 段数由模型自己决定（1~freeMaxSegments 条）
     *  - 段落之间停顿更像真人（有时秒回，有时停一下）
     *  - 允许一句话就回、也允许连着发好几条
     */
    freeChat: {
      enabled: false,
      /** 最多发几条，防止模型一次刷屏 */
      maxSegments: 4,
      /** 单条软上限，只在模型太失控时兜底 */
      softMaxChars: 120,
      /** 段落之间的随机停顿范围（毫秒） */
      minGapMs: 250,
      maxGapMs: 2200,
      /** 偶尔「想一下再回」的概率与时长 */
      thinkingChance: 0.25,
      thinkingMinMs: 900,
      thinkingMaxMs: 3200,
      /** 允许模型用表情包 */
      allowStickers: true,
      /** 允许模型自己决定发图 */
      allowImages: false,
    },
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
    /**
     * 自定义语音模型 API。
     *
     * 留空 baseUrl = 用内置的百度匿名接口（默认行为，不用配就能响）。
     * 填了就走你自己的模型：
     *  - apiKind=openai：POST {baseUrl}/audio/speech（OpenAI / 硅基流动 / 兼容网关）
     *  - apiKind=custom：POST {baseUrl}，body 用 bodyTemplate 里 {text}{voice}{speed} 占位
     */
    custom: {
      enabled: true,
      baseUrl: "",
      apiKey: "",
      model: "",
      /**
       * 音色。三种写法：
       *  - 纯名字（alex）：自动补成 `模型:alex`，用于系统预置音色
       *  - `模型:音色`（FunAudioLLM/CosyVoice2-0.5B:alex）：原样用
       *  - `speech:...`：克隆出来的 uri，原样用
       */
      voice: "",
      apiKind: "openai",
      format: "mp3",
      /** 音量增益 dB（硅基流动支持，-10 ~ 10，0 = 不变） */
      gain: 0,
      /** 输出采样率；0 = 用服务端默认 */
      sampleRate: 0,
      /** 合成请求超时（毫秒）。克隆音色首次合成偏慢，别设太小 */
      timeoutMs: 120000,
      /**
       * 自定义模型失败时是否退回百度匿名 TTS。
       * 云端模型难免抽风（硅基流动的 CosyVoice2 就整段挂死过），
       * 退回来说句话总比整条语音消失强。关掉就变成「失败即不发声」。
       */
      fallback: true,
      /** 克隆音色的元信息：上传后把 uri / 名字 / 参考音频文字记在这里 */
      cloned: {
        uri: "",
        name: "",
        refText: "",
        /** 创建时间 */
        createdAt: 0,
        /** 参考音频来源（本地路径，仅作记录） */
        source: "",
      },
      bodyTemplate: '{"text":"{text}","voice":"{voice}","speed":{speed}}',
    },
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
    /**
     * 数据源：popular 热门 / weekly 周榜 / homepage 主页信息流 / mix 混合
     * mix 最像真人乱逛：主页为主，掺一点周榜和热门。
     */
    source: "popular",
  },
  /** 表情包仓库 */
  sticker: {
    enabled: true,
    /** 别人发的图有概率自动存成表情包 */
    autoSave: true,
    /** 自动保存的概率 */
    autoSaveChance: 0.25,
    /** 回复时随机带表情包的概率 */
    sendChance: 0.18,
    /** 每天最多自动存几张，避免把别人的聊天图全存下来 */
    autoSaveDailyLimit: 12,
  },
  /** 文生图（OpenAI 兼容 /v1/images/generations） */
  image: {
    enabled: false,
    /** 触发方式：keyword 命中关键词才画 / off */
    mode: "keyword",
    keywords: ["画一个", "画张", "画个", "生成图片", "来张图", "画一下", "给我画"],
    baseUrl: "",
    apiKey: "",
    model: "dall-e-3",
    size: "1024x1024",
    responseFormat: "b64_json",
    /** 生成后附带的说明上限 */
    maxPromptChars: 200,
    /**
     * 生成的图以「引用回复」挂到原消息下面。
     *
     * 生图要几秒，等图画好对话可能已经往下走了；不引用的话这张图
     * 看起来就是凭空冒出来的一张。默认开。
     */
    quoteReply: true,
    /** 负面提示词（硅基流动、Kolors 等支持），留空不传 */
    negativePrompt: "",
    /** 采样步数，0 = 用模型默认 */
    steps: 0,
    /** 随机种子，0 = 每次随机 */
    seed: 0,
    /** 超时毫秒。慢模型（Z-Image、Qwen-Image）要留够 */
    timeoutMs: 120000,
  },
  admin: {
    /** 管理员 QQ（除主人外可下指令的人） */
    uins: [],
    /** 允许的群管理操作 */
    groupAdmin: false,
  },
  /**
   * 语言风格。
   *
   * 和「人设」不是一回事：人设决定她是谁（鲸鱼娘），
   * 风格决定她这一刻怎么说话（日系女仆腔、傲娇、温柔姐姐……）。
   * 换风格不用换人设，也不影响记忆。
   */
  style: {
    /** 当前风格 id，对应 presets.cjs 里的 STYLE_PRESETS；空 = 不额外约束 */
    current: "whale-default",
    /**
     * 自定义风格描述，会追加在预设之后。
     * 预设不够用时自己写，例如「说话带东北腔，爱用儿化音」。
     */
    custom: "",
    /** 风格强度：light 轻微 / normal 正常 / strong 强烈 */
    strength: "normal",
    /** 允许模型按心情自己微调语气（撒娇/吐槽/正经），每轮可能不同 */
    dynamic: true,
    /** 口头禅，会要求模型偶尔自然带出（不是每句都加） */
    catchphrases: [],
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
  // 暧昧称呼：去重、限长、最多 8 个
  cfg.master.sweetNames = normalizeIdList(cfg.master.sweetNames).slice(0, 8);

  cfg.onebot.wsUrl = String(cfg.onebot.wsUrl || DEFAULTS.onebot.wsUrl).trim();
  cfg.onebot.httpUrl = String(cfg.onebot.httpUrl || DEFAULTS.onebot.httpUrl).trim();
  cfg.onebot.selfId = String(cfg.onebot.selfId || "").trim();
  cfg.onebot.reconnectMs = Math.round(clampNumber(cfg.onebot.reconnectMs, 1000, 60000, 5000));
  // 默认开：开机直接把 NapCat 拉起来，用户不用每次点一键连接
  cfg.onebot.autoStart = cfg.onebot.autoStart !== false;
  cfg.onebot.shellDir = String(cfg.onebot.shellDir || "").trim();

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

  // —— 自由聊天 ——
  const free = cfg.reply.freeChat || {};
  free.enabled = free.enabled === true;
  free.maxSegments = Math.round(clampNumber(free.maxSegments, 1, 10, 4));
  free.softMaxChars = Math.round(clampNumber(free.softMaxChars, 20, 1000, 120));
  free.minGapMs = Math.round(clampNumber(free.minGapMs, 0, 20000, 250));
  free.maxGapMs = Math.round(clampNumber(free.maxGapMs, free.minGapMs, 60000, 2200));
  free.thinkingChance = clampNumber(free.thinkingChance, 0, 1, 0.25);
  free.thinkingMinMs = Math.round(clampNumber(free.thinkingMinMs, 0, 30000, 900));
  free.thinkingMaxMs = Math.round(clampNumber(free.thinkingMaxMs, free.thinkingMinMs, 60000, 3200));
  free.allowStickers = free.allowStickers !== false;
  free.allowImages = free.allowImages === true;
  cfg.reply.freeChat = free;

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

  // —— 自定义语音 API ——
  const vc = cfg.voice.custom || {};
  vc.enabled = vc.enabled !== false;
  vc.baseUrl = String(vc.baseUrl || "").trim().replace(/\/+$/, "");
  vc.apiKey = String(vc.apiKey || "").trim();
  vc.model = String(vc.model || "").trim();
  vc.voice = String(vc.voice || "").trim();
  const vKind = String(vc.apiKind || "openai").toLowerCase();
  vc.apiKind = ["openai", "custom", "dashscope"].includes(vKind) ? vKind : "openai";
  vc.format = String(vc.format || "mp3").trim() || "mp3";
  vc.gain = clampNumber(vc.gain, -10, 10, 0);
  vc.sampleRate = Math.round(clampNumber(vc.sampleRate, 0, 48000, 0));
  vc.timeoutMs = Math.round(clampNumber(vc.timeoutMs, 10000, 600000, 120000));
  vc.fallback = vc.fallback !== false;
  const cl = vc.cloned || {};
  vc.cloned = {
    uri: String(cl.uri || "").trim(),
    name: String(cl.name || "").trim(),
    refText: String(cl.refText || "").trim(),
    createdAt: Number(cl.createdAt) || 0,
    source: String(cl.source || "").trim(),
  };
  vc.bodyTemplate = String(vc.bodyTemplate || DEFAULTS.voice.custom.bodyTemplate);
  cfg.voice.custom = vc;

  cfg.bilibili.retentionHours = clampNumber(cfg.bilibili.retentionHours, 0.25, 48, 2);
  cfg.bilibili.feedSize = Math.round(clampNumber(cfg.bilibili.feedSize, 1, 50, 10));
  cfg.bilibili.batchSize = Math.round(clampNumber(cfg.bilibili.batchSize, 1, 20, 3));
  const bSource = String(cfg.bilibili.source || "popular").toLowerCase();
  cfg.bilibili.source = ["popular", "weekly", "homepage", "mix"].includes(bSource) ? bSource : "popular";

  // —— 表情包 ——
  cfg.sticker.autoSaveChance = clampNumber(cfg.sticker.autoSaveChance, 0, 1, 0.25);
  cfg.sticker.sendChance = clampNumber(cfg.sticker.sendChance, 0, 1, 0.18);
  cfg.sticker.autoSaveDailyLimit = Math.round(clampNumber(cfg.sticker.autoSaveDailyLimit, 0, 200, 12));

  // —— 生图 ——
  const img = cfg.image || {};
  img.mode = String(img.mode || "keyword").toLowerCase() === "off" ? "off" : "keyword";
  img.keywords = normalizeIdList(img.keywords);
  img.baseUrl = String(img.baseUrl || "").trim().replace(/\/+$/, "");
  img.apiKey = String(img.apiKey || "").trim();
  img.model = String(img.model || "dall-e-3").trim() || "dall-e-3";
  img.size = String(img.size || "1024x1024").trim() || "1024x1024";
  const rf = String(img.responseFormat || "b64_json").toLowerCase();
  img.responseFormat = ["b64_json", "url"].includes(rf) ? rf : "b64_json";
  img.maxPromptChars = Math.round(clampNumber(img.maxPromptChars, 20, 1000, 200));
  img.quoteReply = img.quoteReply !== false;
  img.negativePrompt = String(img.negativePrompt || "").trim().slice(0, 800);
  img.steps = Math.round(clampNumber(img.steps, 0, 100, 0));
  img.seed = Math.round(clampNumber(img.seed, 0, 99999999, 0));
  img.timeoutMs = Math.round(clampNumber(img.timeoutMs, 20000, 300000, 120000));
  cfg.image = img;

  // 语言风格：非法值一律回退，别让 "超级强" 这种值进提示词
  const sty = cfg.style;
  sty.current = String(sty.current || "").trim().slice(0, 64);
  sty.custom = String(sty.custom || "").trim().slice(0, 2000);
  const strength = String(sty.strength || "").toLowerCase();
  sty.strength = ["light", "normal", "strong"].includes(strength) ? strength : "normal";
  sty.dynamic = sty.dynamic !== false;
  sty.catchphrases = normalizeIdList(sty.catchphrases).map((x) => String(x).slice(0, 20)).slice(0, 12);

  cfg.admin.uins = normalizeIdList(cfg.admin.uins);

  cfg.master.only = cfg.master.only === true;

  // master 自动进管理员与私聊白名单
  if (cfg.master.uin) {
    if (!cfg.admin.uins.includes(cfg.master.uin)) cfg.admin.uins.push(cfg.master.uin);
    if (!cfg.reply.privateWhitelist.includes(cfg.master.uin)) cfg.reply.privateWhitelist.push(cfg.master.uin);
  }

  cfg.persona.name = String(cfg.persona.name || "鲸鱼娘").trim() || "鲸鱼娘";
  cfg.persona.prompt = String(cfg.persona.prompt || DEFAULT_PERSONA);
  cfg.persona.extra = String(cfg.persona.extra || "");
  cfg.persona.saved = normalizeSavedPersonas(cfg.persona.saved);

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
  cfg.sticker.enabled = cfg.sticker.enabled !== false;
  cfg.sticker.autoSave = cfg.sticker.autoSave !== false;
  cfg.image.enabled = cfg.image.enabled === true;
  cfg.admin.groupAdmin = cfg.admin.groupAdmin === true;

  return cfg;
}

/** 人格库：去重、限长、过滤坏数据。 */
function normalizeSavedPersonas(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!isPlainObject(item)) continue;
    const name = String(item.name || "").trim().slice(0, 40);
    const prompt = String(item.prompt || "").trim().slice(0, 8000);
    if (!name || !prompt) continue;
    let id = String(item.id || "").trim().slice(0, 64);
    if (!id) id = "p-" + Date.now().toString(36) + "-" + out.length;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name,
      prompt,
      extra: String(item.extra || "").trim().slice(0, 4000),
      createdAt: Number(item.createdAt) || Date.now(),
    });
    if (out.length >= 50) break;
  }
  return out;
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

/**
 * 局部更新：patch 里出现的字段做深合并。
 *
 * 之前只合并一层，导致写 `voice.custom.voice` 这种二级字段时，
 * 整个 `voice.custom` 被 patch 里的那个小对象替换掉——apiKey 就这样丢过一次。
 * 现在逐层递归，只有非对象值才覆盖。
 */
function merge(base, patch) {
  if (!isPlainObject(patch)) return normalize(base);
  const next = deepMerge(JSON.parse(JSON.stringify(base)), patch);
  return normalize(next);
}

function deepMerge(target, patch) {
  for (const key of Object.keys(patch)) {
    const incoming = patch[key];
    if (incoming === undefined) continue;
    if (isPlainObject(incoming) && isPlainObject(target[key])) {
      deepMerge(target[key], incoming);
    } else if (isPlainObject(incoming)) {
      // base 里还没有这个键，或类型不同：拷一份再深合并，避免和 patch 共享引用
      target[key] = deepMerge({}, incoming);
    } else {
      target[key] = incoming;
    }
  }
  return target;
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
