/**
 * 语音合成：把文本变成 mp3 文件，交给 OneBot 以 record 段发送。
 *
 * 本机实测结论（见 README 的「为什么用百度」）：
 *  - Windows 本地 SAPI / WinRT 语音引擎在本机缺 zh-CN 引擎数据，不可用；
 *  - Edge TTS 的 websocket 端点在本网络握手失败；
 *  - 百度翻译的 gettts 接口匿名可用，返回 mp3，长文本不截断 → 选它。
 *
 * 为了不让语音成为硬依赖，失败时抛错，由 engine 决定退化成文本。
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const { fetchLoose, UA } = require("./net.cjs");

const CACHE_DIR = path.join(os.tmpdir(), "dsh-qq-agent-voice");

/** 按「读音替换表」把容易念错的词换成同音写法。 */
function applyLexicon(text, lexicon) {
  let out = String(text || "");
  if (!lexicon || typeof lexicon !== "object") return out;
  for (const [from, to] of Object.entries(lexicon)) {
    if (!from || !to) continue;
    out = out.split(from).join(String(to));
  }
  return out;
}

/** 去掉 Markdown/颜文字这类不适合朗读的字符。 */
function sanitizeForSpeech(text) {
  return String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[*_~#>]+/g, "")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 按标点切句，保证单次请求不会过长。 */
function splitSentences(text, maxChars, lexicon) {
  const limit = Math.max(20, Number(maxChars) || 120);
  const clean = sanitizeForSpeech(applyLexicon(text, lexicon));
  if (!clean) return [];
  if (clean.length <= limit) return [clean];
  const out = [];
  let buffer = "";
  for (const piece of clean.split(/(?<=[。！？!?；;…\n])/)) {
    if (!piece) continue;
    if ((buffer + piece).length > limit && buffer) {
      out.push(buffer);
      buffer = "";
    }
    if (piece.length > limit) {
      for (let i = 0; i < piece.length; i += limit) out.push(piece.slice(i, i + limit));
    } else {
      buffer += piece;
    }
  }
  if (buffer) out.push(buffer);
  return out.filter(Boolean);
}

/**
 * 决定这次合成到底用哪个 voice。
 *
 * 正常情况直接用 custom.voice；但如果它被清空了、而克隆记录（cloned.uri）还在，
 * 就用克隆音色。这样「建好的音色」不会因为面板一次误清空就丢掉。
 *
 * 返回一个新对象，不改调用方传进来的配置。
 */
function resolveEffectiveVoice(custom) {
  const c = custom || {};
  if (String(c.voice || "").trim()) return c;
  const cloned = c.cloned || {};
  const uri = String(cloned.uri || "").trim();
  if (!uri) return c;
  return { ...c, voice: uri };
}

/**
 * 自定义 TTS 模型 API。
 *
 * 支持两种主流形态，靠 apiKind 区分：
 *  - openai：POST {baseUrl}/audio/speech，body {model, input, voice, speed}，返回音频字节
 *    （OpenAI、硅基流动、以及各类兼容网关都是这个形状）
 *  - custom：POST {baseUrl}，body 由 bodyTemplate 决定，用 {text}/{voice}/{speed} 占位
 *
 * 返回音频字节（mp3/wav 都行，OneBot 的 record 段两者都吃）。
 */
async function synthesizeCustom(text, options) {
  const opts = options || {};
  // 兜底：voice 被清空但克隆记录还在时，自动用回克隆音色。
  // 面板历史上会把 voice 写空过（文本框 onChange 无条件写回），
  // 这里保证「已经建好的音色不会因为一次误操作就失效」。
  const rawCustom = opts.custom || {};
  const custom = resolveEffectiveVoice(rawCustom);
  const baseUrl = String(custom.baseUrl || "").trim().replace(/\/+$/, "");
  if (!baseUrl) throw new Error("自定义语音未配置 baseUrl");

  const kind = String(custom.apiKind || "openai").toLowerCase();
  const model = String(custom.model || "").trim();
  const speed = Number(opts.speed) || 5;
  // 百度那边 spd 是 1-15，OpenAI 兼容那边 speed 是 0.25-4.0，量纲不同要换算
  const openaiSpeed = Math.max(0.25, Math.min(4, 0.6 + (speed / 15) * 2.2));

  // 阿里百炼（DashScope 原生协议）单独一条路：
  // 它不是 /audio/speech，而是 multimodal-generation，返回 JSON 而不是音频字节
  if (kind === "dashscope") {
    return synthesizeDashScope(text, { custom, model, speed, timeoutMs: custom.timeoutMs });
  }

  const headers = { "content-type": "application/json" };
  if (custom.apiKey) headers.authorization = "Bearer " + String(custom.apiKey).trim();

  let url;
  let body;
  if (kind === "custom") {
    url = baseUrl;
    const template = String(custom.bodyTemplate || '{"text":"{text}","voice":"{voice}","speed":{speed}}');
    const filled = template
      .replace(/\{text\}/g, JSON.stringify(text).slice(1, -1))
      .replace(/\{voice\}/g, resolveVoiceName(model, custom.voice, kind))
      .replace(/\{speed\}/g, String(openaiSpeed));
    body = filled;
  } else {
    url = /\/audio\/speech$/.test(baseUrl) ? baseUrl : baseUrl + "/audio/speech";
    const payload = {
      model: model || "tts-1",
      input: text,
      voice: resolveVoiceName(model, custom.voice, kind),
      speed: openaiSpeed,
      response_format: String(custom.format || "").trim() || "mp3",
    };
    // 硅基流动支持 gain / sample_rate，别的家多半不认，只在填了的时候带
    const gain = Number(custom.gain);
    if (Number.isFinite(gain) && gain !== 0) payload.gain = Math.max(-10, Math.min(10, gain));
    const sampleRate = Number(custom.sampleRate);
    if (Number.isFinite(sampleRate) && sampleRate > 0) payload.sample_rate = sampleRate;
    body = JSON.stringify(payload);
  }

  const controller = new AbortController();
  // 克隆音色首次合成会慢不少，60s 不够用
  const timeoutMs = Math.max(10000, Number(custom.timeoutMs) || 120000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, { method: "POST", headers, body, signal: controller.signal });
  } catch (error) {
    clearTimeout(timer);
    throw new Error("语音接口请求失败：" + (error && error.message ? error.message : String(error)));
  }
  clearTimeout(timer);

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error("语音接口 HTTP " + response.status + "：" + detail.slice(0, 160));
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 512) throw new Error("语音接口返回的音频太小（" + bytes.length + " 字节）");
  return bytes;
}

/**
 * 阿里百炼的 DashScope 原生协议适配。
 *
 * 它和 OpenAI 那套完全不同：
 *  - 合成：POST {root}/api/v1/services/aigc/multimodal-generation/generation
 *          body {model, input:{text, voice, language_type}}
 *          返回 JSON，音频在 output.audio.url（或 .data 的 base64）
 *  - 复刻：POST {root}/api/v1/services/audio/tts/customization
 *  - 音色列表/删除：同一路径，靠 input.action 区分
 *
 * 所以 baseUrl 只要填到根域（https://dashscope.aliyuncs.com），
 * 或者在业务空间专属域名里填 https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com。
 */
function dashscopeRoot(baseUrl) {
  let root = String(baseUrl || "").trim().replace(/\/+$/, "");
  // 允许用户误填到具体路径，统一剥回到根
  root = root.replace(/\/api\/v1\/.*$/, "");
  root = root.replace(/\/compatible-mode\/.*$/, "");
  root = root.replace(/\/api\/v1$/, "");
  return root;
}

/** 语种代码 → 百炼的 language_type 写法。 */
function dashscopeLanguage(lang) {
  const v = String(lang || "").trim().toLowerCase();
  const map = {
    zh: "Chinese", chinese: "Chinese", "中文": "Chinese",
    en: "English", english: "English", "英文": "English",
    ja: "Japanese", jp: "Japanese", japanese: "Japanese", "日文": "Japanese", "日语": "Japanese",
    ko: "Korean", korean: "Korean", "韩语": "Korean",
    fr: "French", de: "German", es: "Spanish", it: "Italian",
    pt: "Portuguese", ru: "Russian",
  };
  return map[v] || "Auto";
}

/**
 * 百炼有两条合成路径，用错就报 `url error, please check url`：
 *
 *  - 复刻音色（voice_id 形如 `{model}-{prefix}-{hex}`）→ 必须走
 *    `/api/v1/services/audio/tts/SpeechSynthesizer`
 *  - 系统音色（Cherry 等）→ 两条都能走，但 multimodal-generation 对
 *    复刻音色会失败，所以统一走 SpeechSynthesizer 更省心
 *
 * 所以这里默认用 SpeechSynthesizer；只有它 404 时才回退到 multimodal。
 */
function dashscopeTtsUrl(root, useMultimodal) {
  return useMultimodal
    ? root + "/api/v1/services/aigc/multimodal-generation/generation"
    : root + "/api/v1/services/audio/tts/SpeechSynthesizer";
}

async function synthesizeDashScope(text, options) {
  const opts = options || {};
  const custom = opts.custom || {};
  const root = dashscopeRoot(custom.baseUrl);
  if (!root) throw new Error("百炼未配置 baseUrl");
  if (!custom.apiKey) throw new Error("百炼缺少 API Key");

  const model = String(opts.model || custom.model || "").trim();
  if (!model) throw new Error("百炼缺少模型名");

  const voice = String(custom.voice || "Cherry").trim() || "Cherry";
  const input = { text, voice };
  // language_type 指定语种时合成质量更好，Auto 适合多语混排
  const languageType = dashscopeLanguage(opts.lang);
  if (languageType) input.language_type = languageType;
  // 输出格式：默认 mp3，和 OneBot 发送的 record 段匹配
  const format = String(custom.format || "mp3").trim() || "mp3";
  input.format = format;
  input.sample_rate = 24000;

  // 系统音色也能走 SpeechSynthesizer，所以统一走它
  const useMultimodal = custom.useMultimodal === true;
  const url = dashscopeTtsUrl(root, useMultimodal);

  const controller = new AbortController();
  const timeoutMs = Math.max(15000, Number(custom.timeoutMs) || 120000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: "Bearer " + String(custom.apiKey).trim(),
        "content-type": "application/json",
      },
      body: JSON.stringify({ model, input }),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    throw new Error("百炼请求失败：" + (error && error.message ? error.message : String(error)));
  }
  clearTimeout(timer);

  const raw = await response.text();
  if (!response.ok) throw new Error("百炼 HTTP " + response.status + "：" + raw.slice(0, 200));

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error("百炼返回了非 JSON：" + raw.slice(0, 160));
  }
  // 业务错误可能藏在 code/message 里，HTTP 却还是 200
  if (payload && payload.code && payload.code !== "" && payload.code !== "200") {
    throw new Error("百炼错误 " + payload.code + "：" + String(payload.message || "").slice(0, 160));
  }
  if (payload && payload.status_code && Number(payload.status_code) !== 200) {
    throw new Error("百炼错误 " + payload.status_code + "：" + String(payload.message || "").slice(0, 160));
  }

  const audio = payload && payload.output && payload.output.audio;
  if (!audio) throw new Error("百炼没有返回音频：" + raw.slice(0, 200));

  // 非流式一般给 url；也可能直接给 base64
  if (audio.data) {
    const bytes = Buffer.from(String(audio.data), "base64");
    if (bytes.length < 512) throw new Error("百炼返回的音频太小（" + bytes.length + " 字节）");
    return bytes;
  }
  if (audio.url) {
    const dl = await fetch(String(audio.url));
    if (!dl.ok) throw new Error("下载百炼音频失败 HTTP " + dl.status);
    const bytes = Buffer.from(await dl.arrayBuffer());
    if (bytes.length < 512) throw new Error("百炼音频太小（" + bytes.length + " 字节）");
    return bytes;
  }
  throw new Error("百炼返回里既没有 url 也没有 data");
}

/**
 * 百炼的声音复刻：用一个固定入口 + input.action 区分各种操作。
 * 创建返回 output.voice_id，直接当 voice 用。
 */
async function dashscopeCustomization(custom, input, timeoutMs) {
  const root = dashscopeRoot(custom.baseUrl);
  if (!root) throw new Error("百炼未配置 baseUrl");
  if (!custom.apiKey) throw new Error("百炼缺少 API Key");
  const url = root + "/api/v1/services/audio/tts/customization";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(15000, timeoutMs || 120000));
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: "Bearer " + String(custom.apiKey).trim(),
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "voice-enrollment", input }),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    throw new Error("百炼音色接口失败：" + (error && error.message ? error.message : String(error)));
  }
  clearTimeout(timer);

  const raw = await response.text();
  if (!response.ok) throw new Error("百炼音色接口 HTTP " + response.status + "：" + raw.slice(0, 200));
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error("百炼音色接口返回非 JSON：" + raw.slice(0, 160));
  }
  if (payload && payload.code && payload.code !== "" && payload.code !== "200") {
    throw new Error("百炼错误 " + payload.code + "：" + String(payload.message || "").slice(0, 160));
  }
  const out = (payload && payload.output) || {};
  if (out.status && out.status !== "OK" && out.status !== "DEPLOYING") {
    throw new Error("百炼音色状态异常：" + out.status);
  }
  return out;
}

/**
 * 百炼克隆音色。
 *
 * 和硅基流动不同：参考音频用 base64 data URI 传，不需要公网 URL；
 * 而且音色绑定 target_model，之后必须用同一个模型合成。
 */
async function cloneVoiceDashScope(audioBytes, options) {
  const opts = options || {};
  const custom = opts.custom || {};
  const targetModel = String(opts.model || custom.model || "").trim();
  if (!targetModel) throw new Error("百炼克隆需要指定 target_model");
  const prefix = String(opts.name || "whale").replace(/[^A-Za-z0-9]/g, "").slice(0, 10) || "whale";
  const mediaType = String(opts.mediaType || "audio/mpeg");
  const audio = "data:" + mediaType + ";base64," + Buffer.from(audioBytes).toString("base64");

  const input = {
    action: "create_voice",
    target_model: targetModel,
    prefix,
    audio,
  };
  // 参考音频是日语时告诉它，提取音色更准（填错它会自动检测，不会报错）
  const lang = String(opts.language || "").trim();
  if (lang) input.language_hints = [lang];
  if (opts.enablePreprocess === true) input.enable_preprocess = true;

  const out = await dashscopeCustomization(custom, input, 180000);
  const voiceId = out.voice_id;
  if (!voiceId) throw new Error("百炼没有返回 voice_id");
  return { uri: String(voiceId), name: prefix, model: targetModel };
}

/** 百炼音色列表。 */
async function listVoicesDashScope(options) {
  const opts = options || {};
  const custom = opts.custom || {};
  const out = await dashscopeCustomization(
    custom,
    { action: "list_voice", page_size: 50, page_index: 0 },
    30000,
  );
  const list = out.voice_list || [];
  return list.map((v) => ({
    uri: v.voice_id,
    // voice_id 形如 {target_model}-{prefix}-{hex}，把 prefix 抽出来当名字，
    // 否则面板上一排哈希看不出哪个是哪个
    name: dashscopeVoicePrefix(v.voice_id) || v.voice_id,
    model: dashscopeVoiceModel(v.voice_id),
    status: v.status,
    createdAt: v.gmt_create,
  }));
}

/** 从 voice_id 里抽出 prefix（`qwen-audio-3.1-tts-flash-jiuhu-abc123` → `jiuhu`）。 */
function dashscopeVoicePrefix(voiceId) {
  const m = /^(.+?)-([A-Za-z0-9]{1,10})-([0-9a-f]{16,})$/i.exec(String(voiceId || ""));
  return m ? m[2] : "";
}

/** 从 voice_id 里抽出它绑定的模型名。 */
function dashscopeVoiceModel(voiceId) {
  const m = /^(.+?)-([A-Za-z0-9]{1,10})-([0-9a-f]{16,})$/i.exec(String(voiceId || ""));
  return m ? m[1] : "";
}

/** 百炼删除音色。 */
async function deleteVoiceDashScope(voiceId, options) {
  const opts = options || {};
  const custom = opts.custom || {};
  await dashscopeCustomization(custom, { action: "delete_voice", voice_id: String(voiceId || "") }, 30000);
  return true;
}

/** 这个配置是不是走百炼。 */
function isDashScope(custom) {
  const kind = String((custom && custom.apiKind) || "").toLowerCase();
  return kind === "dashscope" || kind === "bailian" || kind === "aliyun";
}

/**
 * 硅基流动 CosyVoice2 的系统预置音色。
 *
 * 这些不用上传音频就能用；克隆音色在 CosyVoice2 故障时用不了，
 * 但预置音色至少能让语音出人声。
 *
 * gender/desc 只用于面板展示，不参与请求。
 */
const PRESET_VOICES = [
  { id: "alex", name: "Alex", gender: "男", desc: "沉稳男声，中性偏冷" },
  { id: "benjamin", name: "Benjamin", gender: "男", desc: "低沉男声，语速偏慢" },
  { id: "charles", name: "Charles", gender: "男", desc: "清亮男声，偏年轻" },
  { id: "david", name: "David", gender: "男", desc: "磁性男声，播报感" },
  { id: "anna", name: "Anna", gender: "女", desc: "温柔女声，偏成熟" },
  { id: "bella", name: "Bella", gender: "女", desc: "甜美女声，偏少女" },
  { id: "claire", name: "Claire", gender: "女", desc: "清澈女声，标准普通话" },
  { id: "diana", name: "Diana", gender: "女", desc: "知性女声，偏低音" },
];

/**
 * 阿里百炼 Qwen-TTS 的常用系统音色。
 *
 * 名字直接当 voice 用，不加任何前缀。
 */
const DASHSCOPE_VOICES = [
  { id: "Cherry", name: "Cherry", gender: "女", desc: "温柔亲和，默认推荐" },
  { id: "Serena", name: "Serena", gender: "女", desc: "知性成熟" },
  { id: "Ethan", name: "Ethan", gender: "男", desc: "阳光男声" },
  { id: "Chelsie", name: "Chelsie", gender: "女", desc: "清甜少女" },
  { id: "Dylan", name: "Dylan", gender: "男", desc: "北京话男声" },
  { id: "Jada", name: "Jada", gender: "女", desc: "上海话女声" },
  { id: "Sunny", name: "Sunny", gender: "女", desc: "四川话女声" },
  { id: "Nofish", name: "Nofish", gender: "男", desc: "活泼男声" },
];

/**
 * 供面板渲染的音色列表（含当前模型前缀，方便直接选中）。
 *
 * @param {string} model 模型名
 * @param {string} [apiKind] 接口类型；走百炼时返回百炼的音色表
 */
function presetVoiceList(model, apiKind) {
  const m = String(model || "").trim();
  const kind = String(apiKind || "").toLowerCase();
  // 百炼的音色名是独立的（Cherry 等），不加模型前缀，否则会被当成无效音色
  if (kind === "dashscope" || kind === "bailian" || kind === "aliyun") {
    return DASHSCOPE_VOICES.map((v) => ({ ...v, value: v.id }));
  }
  return PRESET_VOICES.map((v) => ({
    ...v,
    /** 填进配置的完整值 */
    value: m && m.includes("/") ? m + ":" + v.id : v.id,
  }));
}

/**
 * 算出请求里该用的 voice 值。
 *
 * 硅基流动的规则有点绕：
 *  - 系统预置音色要带模型前缀，写成 `FunAudioLLM/CosyVoice2-0.5B:alex`
 *  - 克隆出来的音色直接用返回的 uri（本身就是 `speech:名字:id:哈希`），不能加前缀
 *  - 纯名字就当系统预置音色，自动补前缀，省得用户手动拼
 */
function resolveVoiceName(model, voice, apiKind) {
  const name = String(voice || "").trim();
  if (!name) return "alloy";
  // 百炼的音色名（Cherry、克隆出来的 voice_id）都不加模型前缀
  const kind = String(apiKind || "").toLowerCase();
  if (kind === "dashscope" || kind === "bailian" || kind === "aliyun") return name;
  if (name.includes(":")) return name; // 已是完整 uri 或带前缀
  if (model && model.includes("/")) return model + ":" + name;
  return name;
}

/** 这个 voice 值看起来是不是克隆出来的（speech: 开头，或百炼的 voice_id）。 */
function isClonedVoice(voice) {
  const v = String(voice || "").trim();
  // 硅基流动的克隆音色是 speech:xxx；百炼的是 {target_model}-{prefix}-{标识}
  return v.startsWith("speech:") || /-tts-(flash|plus)-|^cosyvoice|\bvoice-/i.test(v);
}

/**
 * 用一段参考音频创建「克隆音色」（硅基流动 /uploads/audio/voice）。
 *
 * 返回的 uri 之后直接当 voice 用。参考音频要求：
 *  - 单一人声、吐字清晰、无背景噪音
 *  - 时长 < 30 秒（8~10 秒最佳）
 *  - mp3 / wav / pcm / opus
 *
 * text 是这段音频的**文字内容**，必填——服务端用它做对齐，
 * 填错了克隆出来的音色会跑调。
 *
 * @param {Buffer} audioBytes 参考音频字节
 * @param {{baseUrl?:string, apiKey?:string, model?:string, name?:string,
 *          text?:string, filename?:string, mediaType?:string}} options
 * @returns {Promise<{uri:string, name:string, model:string}>}
 */
async function cloneVoice(audioBytes, options) {
  const opts = options || {};
  const baseUrl = String(opts.baseUrl || "").trim().replace(/\/+$/, "");
  if (!baseUrl) throw new Error("未配置语音 baseUrl，无法上传音色");
  if (!opts.apiKey) throw new Error("未配置语音 API Key，无法上传音色");
  const data = toBuffer(audioBytes);
  if (!data || data.length < 1024) throw new Error("参考音频太小或读不到");

  // 百炼走自己的复刻接口（base64 传音频，音色绑定 target_model）
  if (isDashScope(opts)) {
    return cloneVoiceDashScope(data, {
      custom: opts,
      model: opts.model,
      name: opts.name,
      mediaType: opts.mediaType,
      language: opts.language,
      enablePreprocess: opts.enablePreprocess,
    });
  }

  const model = String(opts.model || "").trim() || "FunAudioLLM/CosyVoice2-0.5B";
  const name = String(opts.name || "").trim() || "cloned-" + Date.now().toString(36);
  const refText = String(opts.text || "").trim();
  if (!refText) throw new Error("需要参考音频的文字内容（服务端用它做对齐）");

  // baseUrl 可能已经带 /audio/speech，退回 /v1 再拼 /uploads/audio/voice
  const root = baseUrl.replace(/\/audio\/speech$/, "").replace(/\/+$/, "");
  const url = /\/uploads\/audio\/voice$/.test(root) ? root : root + "/uploads/audio/voice";

  const form = new FormData();
  form.append("file", new Blob([data], { type: String(opts.mediaType || "audio/mpeg") }), String(opts.filename || "reference.mp3"));
  form.append("model", model);
  form.append("customName", name);
  form.append("text", refText);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180000);
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { authorization: "Bearer " + String(opts.apiKey).trim() },
      body: form,
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    throw new Error("上传音色失败：" + (error && error.message ? error.message : String(error)));
  }
  clearTimeout(timer);

  const raw = await response.text();
  if (!response.ok) throw new Error("上传音色 HTTP " + response.status + "：" + raw.slice(0, 200));
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error("上传音色返回了非 JSON：" + raw.slice(0, 160));
  }
  const uri = payload && payload.uri;
  if (!uri) throw new Error("上传音色没有返回 uri：" + raw.slice(0, 160));
  return { uri: String(uri), name, model };
}

/** 列出已上传的自定义音色。 */
async function listVoices(options) {
  const opts = options || {};
  if (isDashScope(opts)) return listVoicesDashScope({ custom: opts });
  const baseUrl = String(opts.baseUrl || "").trim().replace(/\/+$/, "");
  if (!baseUrl || !opts.apiKey) throw new Error("未配置语音 baseUrl 或 API Key");
  const root = baseUrl.replace(/\/audio\/speech$/, "").replace(/\/+$/, "");
  const url = /\/audio\/voice\/list$/.test(root) ? root : root + "/audio/voice/list";
  const response = await fetch(url, { headers: { authorization: "Bearer " + String(opts.apiKey).trim() } });
  const raw = await response.text();
  if (!response.ok) throw new Error("获取音色列表 HTTP " + response.status + "：" + raw.slice(0, 160));
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error("音色列表返回了非 JSON：" + raw.slice(0, 160));
  }
  const list = (payload && (payload.data || payload.result || payload.voice_list)) || [];
  return Array.isArray(list) ? list : [];
}

/** 删除一个自定义音色。 */
async function deleteVoice(uri, options) {
  const opts = options || {};
  if (isDashScope(opts)) return deleteVoiceDashScope(uri, { custom: opts });
  const baseUrl = String(opts.baseUrl || "").trim().replace(/\/+$/, "");
  if (!baseUrl || !opts.apiKey) throw new Error("未配置语音 baseUrl 或 API Key");
  const root = baseUrl.replace(/\/audio\/speech$/, "").replace(/\/+$/, "");
  const url = /\/audio\/voice\/deletions$/.test(root) ? root : root + "/audio/voice/deletions";
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: "Bearer " + String(opts.apiKey).trim(), "content-type": "application/json" },
    body: JSON.stringify({ uri: String(uri || "") }),
  });
  if (!response.ok) {
    const raw = await response.text().catch(() => "");
    throw new Error("删除音色 HTTP " + response.status + "：" + raw.slice(0, 160));
  }
  return true;
}

function toBuffer(data) {
  if (!data) return null;
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data));
  return null;
}

/** 走自定义 API，落盘并返回路径。 */async function synthesizeCustomToFile(text, options) {
  const opts = options || {};
  const digest = crypto
    .createHash("sha1")
    .update("custom|" + JSON.stringify(opts.custom || {}) + "|" + String(text || ""))
    .digest("hex")
    .slice(0, 16);
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, "tts-custom-" + digest + ".mp3");
  try {
    if (fs.statSync(file).size > 512) return file;
  } catch {
    /* 没缓存 */
  }
  const bytes = await synthesizeCustom(text, opts);
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, file);
  return file;
}

/** 调百度翻译 TTS，拿回 mp3 字节。 */
async function synthesizeMp3(text, options) {
  const opts = options || {};
  const clean = sanitizeForSpeech(applyLexicon(text, opts.lexicon));
  if (!clean) throw new Error("没有可朗读的文本");

  // 配了自定义 API 就优先用它
  const custom = opts.custom || {};
  if (String(custom.baseUrl || "").trim() && custom.enabled !== false) {
    try {
      return await synthesizeCustom(clean, opts);
    } catch (error) {
      // 自定义模型挂了（服务端超时、限额、音色失效……）不该让整条语音报废，
      // 退回百度先出个声，同时把原因记下来供面板显示。
      const reason = error && error.message ? error.message : String(error);
      lastCustomError = reason;
      if (custom.fallback === false) throw error;
      opts.onFallback ? opts.onFallback(reason) : null;
    }
  }

  return fetchBaiduMp3(clean, opts);
}

/** 上一次自定义语音失败的原因（面板展示用，进程内保留一条）。 */
let lastCustomError = "";
function getLastCustomError() {
  return lastCustomError;
}

/** 百度匿名 TTS。 */
async function fetchBaiduMp3(clean, options) {
  const opts = options || {};
  const speed = Math.min(15, Math.max(1, Number(opts.speed) || 5));
  const lang = String(opts.lang || "zh");
  const query = new URLSearchParams({ lan: lang, text: clean, spd: String(speed), source: "web" });
  const url = "https://fanyi.baidu.com/gettts?" + query.toString();
  const response = await fetchLoose(url, {
    headers: {
      "User-Agent": UA,
      Referer: "https://fanyi.baidu.com/",
      Accept: "*/*",
    },
    timeoutMs: Math.max(15000, clean.length * 120),
  });
  if (!response.ok) throw new Error("语音合成失败 HTTP " + response.status);
  const bytes = response.buffer();
  const contentType = String(response.headers.get("content-type") || "");
  if (!/audio|mpeg|octet-stream/i.test(contentType) || bytes.length < 512) {
    throw new Error("语音合成返回了非音频内容（" + contentType + "，" + bytes.length + " 字节）");
  }
  return bytes;
}

/**
 * 合成并落盘，返回绝对路径。
 * 同名文本会复用缓存文件（同一句话不重复请求）。
 */
async function synthesizeToFile(text, options) {
  const opts = options || {};
  const digest = crypto
    .createHash("sha1")
    .update(
      String(opts.lang || "zh") + "|" + String(opts.speed || 5) + "|" +
      JSON.stringify(opts.lexicon || {}) + "|" + String(text || ""),
    )
    .digest("hex")
    .slice(0, 16);
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, "tts-" + digest + ".mp3");
  try {
    const stat = fs.statSync(file);
    if (stat.size > 512) return file;
  } catch {
    /* 缓存不存在，继续合成 */
  }
  const bytes = await synthesizeMp3(text, opts);
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, file);
  return file;
}

/** 多段文本合成一个文件（简单拼接 mp3 帧会爆，所以这里退化为只用第一段）。 */
async function synthesizeLong(text, options) {
  const opts = options || {};
  const parts = splitSentences(text, opts.maxChars || 120, opts.lexicon);
  if (parts.length === 0) throw new Error("没有可朗读的文本");
  if (parts.length === 1) return synthesizeToFile(parts[0], opts);
  // 多段：每段单独合成，返回文件列表，由调用方决定发几条。
  const files = [];
  for (const part of parts) {
    files.push(await synthesizeToFile(part, opts));
  }
  return files;
}

/** 转成 OneBot 能吃下的 file:// URL。 */
function toFileUrl(filePath) {
  const normalized = path.resolve(filePath).replace(/\\/g, "/");
  return "file:///" + normalized.replace(/^\/+/, "");
}

/** 清理缓存目录里超过 maxAgeHours 的文件。 */
function pruneCache(maxAgeHours) {
  const cutoff = Date.now() - (Number(maxAgeHours) || 24) * 3600 * 1000;
  try {
    for (const name of fs.readdirSync(CACHE_DIR)) {
      const full = path.join(CACHE_DIR, name);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* 目录不存在就算了 */
  }
}

module.exports = {
  CACHE_DIR,
  applyLexicon,
  sanitizeForSpeech,
  splitSentences,
  synthesizeMp3,
  synthesizeToFile,
  synthesizeLong,
  synthesizeCustom,
  synthesizeCustomToFile,
  cloneVoice,
  listVoices,
  deleteVoice,
  resolveVoiceName,
  isClonedVoice,
  isDashScope,
  resolveEffectiveVoice,
  PRESET_VOICES,
  DASHSCOPE_VOICES,
  presetVoiceList,
  synthesizeDashScope,
  cloneVoiceDashScope,
  listVoicesDashScope,
  deleteVoiceDashScope,
  dashscopeVoicePrefix,
  dashscopeVoiceModel,
  dashscopeRoot,
  dashscopeLanguage,
  getLastCustomError,
  fetchBaiduMp3,
  toFileUrl,
  pruneCache,
};
