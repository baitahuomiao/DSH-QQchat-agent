/**
 * 表情包仓库。
 *
 * 两种来源：
 *  1. 别人在聊天里发的图片 → 有概率自动存下来（sticker.autoSave）
 *  2. 面板里手动导入 → 直接落盘并登记
 *
 * 存的是原图字节 + 一个 index.json 索引。索引里记 tags（模型/用户给的标签）
 * 和 usedAt（上次使用时间），发的时候按标签相关性 + 冷门优先挑。
 *
 * 为什么不入库到 memory：memory 只留文本轮次，图片字节必须单独放，
 * 否则每轮对话都要把几 MB 的图从磁盘读一遍。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MAX_STICKERS = 400;

function nowMs() {
  return Date.now();
}

class StickerBook {
  /**
   * @param {{dir:string, logger?:object}} options
   */
  constructor(options) {
    const opts = options || {};
    this.dir = path.join(String(opts.dir || "."), "stickers");
    this.indexPath = path.join(this.dir, "index.json");
    this.logger = opts.logger || console;
    this.items = [];
    this.load();
  }

  ensureDir() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch (error) {
      this.warn("无法创建表情包目录：" + messageOf(error));
    }
  }

  warn(text) {
    try {
      if (this.logger && typeof this.logger.warn === "function") this.logger.warn("[dsh-qq-agent] " + text);
    } catch {
      /* ignore */
    }
  }

  load() {
    this.ensureDir();
    try {
      const raw = JSON.parse(fs.readFileSync(this.indexPath, "utf8"));
      this.items = Array.isArray(raw && raw.items) ? raw.items.filter(isValidItem) : [];
    } catch (error) {
      if (error && error.code !== "ENOENT") this.warn("表情包索引损坏，按空处理：" + messageOf(error));
      this.items = [];
    }
    return this.items;
  }

  save() {
    this.ensureDir();
    const payload = { version: 1, items: this.items };
    const tmp = this.indexPath + ".tmp";
    try {
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
      fs.renameSync(tmp, this.indexPath);
    } catch (error) {
      this.warn("表情包索引写入失败：" + messageOf(error));
    }
  }

  size() {
    // 和 list() 保持一致：坏条目不参与计数（提示词里报的数字要和面板对得上）
    return this.items.filter((item) => this.filePath(item)).length;
  }

  list() {
    // 面板直接吃这个结果，坏条目在这里挡掉，别让 UI 拿到怪路径
    return this.items.filter((item) => this.filePath(item)).map((item) => ({ ...item }));
  }

  /**
   * 存一张表情。同一份内容（sha1 相同）不重复入库。
   * @param {{data:Buffer|Uint8Array, mediaType?:string, tags?:string[], source?:string}} input
   * @returns {object|null} 新条目；重复或失败返回 null
   */
  add(input) {
    const data = toBuffer(input && input.data);
    if (!data || data.length < 64) return null;

    const digest = crypto.createHash("sha1").update(data).digest("hex");
    if (this.items.some((item) => item.id === digest)) return null;
    if (this.items.length >= MAX_STICKERS) {
      // 满了就丢最久没用的
      this.items.sort((a, b) => (a.usedAt || a.addedAt || 0) - (b.usedAt || b.addedAt || 0));
      const dropped = this.items.shift();
      if (dropped) removeQuietly(path.join(this.dir, dropped.file));
    }

    const mediaType = String((input && input.mediaType) || "image/gif");
    const ext = extForMediaType(mediaType);
    const file = digest.slice(0, 16) + ext;
    try {
      fs.writeFileSync(path.join(this.dir, file), data);
    } catch (error) {
      this.warn("表情包写入失败：" + messageOf(error));
      return null;
    }

    const item = {
      id: digest,
      file,
      mediaType,
      bytes: data.length,
      tags: normalizeTags(input && input.tags),
      source: String((input && input.source) || "manual"),
      addedAt: nowMs(),
      usedAt: 0,
      usedCount: 0,
    };
    this.items.push(item);
    this.save();
    return { ...item };
  }

  /** 按 tag 覆盖（面板里编辑标签用）。 */
  setTags(id, tags) {
    const item = this.items.find((row) => row.id === String(id || ""));
    if (!item) return null;
    item.tags = normalizeTags(tags);
    this.save();
    return { ...item };
  }

  remove(id) {
    const key = String(id || "");
    const index = this.items.findIndex((row) => row.id === key);
    if (index < 0) return false;
    const [item] = this.items.splice(index, 1);
    if (item) removeQuietly(path.join(this.dir, item.file));
    this.save();
    return true;
  }

  filePath(item) {
    const name = String((item && item.file) || "");
    // 只认纯文件名：file 来自 index.json，可以被手工改坏，不能让它跳出 stickers/
    if (!name || /[\\/]/.test(name) || name === "." || name === "..") return "";
    return path.join(this.dir, name);
  }

  /**
   * 挑一张表情。
   *
   * 策略：优先标签命中；没有命中就随机一张，并且偏向「很久没发过」的，
   * 避免翻来覆去总是同一个。
   * @param {{tags?:string[], rng?:Function, excludeIds?:string[]}} [options]
   */
  pick(options) {
    const opts = options || {};
    // 索引可能被手工改坏，挑之前先剔掉 file 不合法的条目
    const usable = this.items.filter((item) => this.filePath(item));
    if (usable.length === 0) return null;
    const rng = typeof opts.rng === "function" ? opts.rng : Math.random;
    const exclude = new Set(Array.isArray(opts.excludeIds) ? opts.excludeIds : []);
    const pool = usable.filter((item) => !exclude.has(item.id));
    const candidates = pool.length > 0 ? pool : usable;

    const wantTags = normalizeTags(opts.tags);
    if (wantTags.length > 0) {
      const hits = candidates.filter((item) =>
        item.tags.some((tag) => wantTags.some((want) => tag.includes(want) || want.includes(tag))),
      );
      if (hits.length > 0) return this.touch(hits[Math.floor(rng() * hits.length)]);
    }

    // 冷门优先：按 usedAt 升序排，取前一半里随机
    const sorted = candidates.slice().sort((a, b) => (a.usedAt || 0) - (b.usedAt || 0));
    const head = sorted.slice(0, Math.max(1, Math.ceil(sorted.length / 2)));
    return this.touch(head[Math.floor(rng() * head.length)]);
  }

  touch(item) {
    if (!item) return null;
    item.usedAt = nowMs();
    item.usedCount = Number(item.usedCount || 0) + 1;
    this.save();
    return { ...item };
  }
}

function toBuffer(data) {
  if (!data) return null;
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data));
  return null;
}

function extForMediaType(mediaType) {
  const text = String(mediaType || "").toLowerCase();
  if (text.includes("png")) return ".png";
  if (text.includes("webp")) return ".webp";
  if (text.includes("jpeg") || text.includes("jpg")) return ".jpg";
  if (text.includes("gif")) return ".gif";
  return ".gif";
}

function normalizeTags(value) {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\s,，;；、]+/) : [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const text = String(item == null ? "" : item).trim().slice(0, 16);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= 12) break;
  }
  return out;
}

function isValidItem(item) {
  return Boolean(item && typeof item.id === "string" && typeof item.file === "string" && !/[\\/]/.test(item.file));
}

function removeQuietly(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    /* 已经不在了 */
  }
}

function messageOf(error) {
  return error && error.message ? error.message : String(error);
}

module.exports = { StickerBook, normalizeTags, MAX_STICKERS };
