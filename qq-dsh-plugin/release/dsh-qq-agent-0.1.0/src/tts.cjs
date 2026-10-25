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

/** 调百度翻译 TTS，拿回 mp3 字节。 */
async function synthesizeMp3(text, options) {
  const opts = options || {};
  const clean = sanitizeForSpeech(applyLexicon(text, opts.lexicon));
  if (!clean) throw new Error("没有可朗读的文本");
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
  toFileUrl,
  pruneCache,
};
