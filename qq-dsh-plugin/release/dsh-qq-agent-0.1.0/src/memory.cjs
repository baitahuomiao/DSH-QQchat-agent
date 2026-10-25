/**
 * 记忆：会话历史 + B 站视频暂存。
 *
 * 两层：
 *  1. 会话消息环形缓冲（按 sessionKey 分开，条数由 config.reply.memoryTurns 控制）；
 *  2. 视频书架：刷过的 B 站视频描述，带 TTL（默认 2 小时），过期自动清。
 *
 * 全部是内存结构 + 落盘 JSON，进程重启后视频书架会重新加载（TTL 依然生效）。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

// 与 config.cjs 用同一个数据目录（`~/.dsh/qq-agent`），不写在包内——
// 装到 node_modules 后包目录会被 pnpm update 重建。
const { DATA_DIR } = require("./config.cjs");
const SHELF_PATH = path.join(DATA_DIR, "videos.json");

function now() {
  return Date.now();
}

class Memory {
  /**
   * @param {{memoryTurns?:number, retentionHours?:number}} [options]
   */
  constructor(options) {
    const opts = options || {};
    this.memoryTurns = Number(opts.memoryTurns) || 24;
    this.retentionHours = Number(opts.retentionHours) || 2;
    /** @type {Map<string, Array<{role:string, name?:string, text:string, at:number}>>} */
    this.sessions = new Map();
    /** @type {Array<{bvid:string, title:string, author:string, desc:string, url:string, cover?:string, tags?:string[], duration?:number, stat?:object, note:string, at:number}>} */
    this.shelf = [];
    this.lastActive = new Map();
    this.loadShelf();
  }

  configure(options) {
    const opts = options || {};
    if (opts.memoryTurns !== undefined) this.memoryTurns = Math.max(0, Number(opts.memoryTurns) || 0);
    if (opts.retentionHours !== undefined) this.retentionHours = Math.max(0.1, Number(opts.retentionHours) || 2);
  }

  // —— 会话历史 ——

  push(sessionKey, entry) {
    if (this.memoryTurns <= 0) return;
    const list = this.sessions.get(sessionKey) || [];
    list.push(Object.assign({ at: now() }, entry));
    const limit = this.memoryTurns * 2; // user/assistant 各算一轮
    while (list.length > limit) list.shift();
    this.sessions.set(sessionKey, list);
  }

  history(sessionKey) {
    return (this.sessions.get(sessionKey) || []).slice();
  }

  clearSession(sessionKey) {
    if (sessionKey) this.sessions.delete(sessionKey);
    else this.sessions.clear();
  }

  touch(sessionKey) {
    this.lastActive.set(sessionKey, now());
  }

  lastActiveAt(sessionKey) {
    return this.lastActive.get(sessionKey) || 0;
  }

  /** 列出最近活跃的会话，供主动发言挑对象。 */
  recentSessions(limit) {
    const rows = Array.from(this.lastActive.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, Math.max(1, Number(limit) || 10));
    return rows.map(([sessionKey, at]) => ({ sessionKey, at }));
  }

  // —— 视频书架 ——

  loadShelf() {
    try {
      const text = fs.readFileSync(SHELF_PATH, "utf8");
      const rows = JSON.parse(text);
      if (Array.isArray(rows)) this.shelf = rows.filter((row) => row && row.bvid && row.at);
    } catch {
      this.shelf = [];
    }
    this.pruneShelf();
  }

  persistShelf() {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = SHELF_PATH + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this.shelf, null, 2), "utf8");
      fs.renameSync(tmp, SHELF_PATH);
    } catch {
      /* 落盘失败不影响运行 */
    }
  }

  /** 清掉超过保留期的条目，返回被清掉的条数。 */
  pruneShelf() {
    const cutoff = now() - this.retentionHours * 3600 * 1000;
    const before = this.shelf.length;
    this.shelf = this.shelf.filter((row) => row.at >= cutoff);
    return before - this.shelf.length;
  }

  /** 记录一条看过的视频（同 bvid 会覆盖成最新一条）。 */
  addVideo(video) {
    this.pruneShelf();
    const bvid = String((video && video.bvid) || "").trim();
    if (!bvid) return null;
    const row = {
      bvid,
      title: String(video.title || ""),
      author: String(video.author || ""),
      desc: String(video.desc || ""),
      url: String(video.url || "https://www.bilibili.com/video/" + bvid),
      cover: String(video.cover || ""),
      tags: Array.isArray(video.tags) ? video.tags.slice(0, 8) : [],
      duration: Number(video.duration) || 0,
      stat: video.stat || null,
      note: String(video.note || ""),
      at: now(),
    };
    this.shelf = this.shelf.filter((item) => item.bvid !== bvid);
    this.shelf.unshift(row);
    if (this.shelf.length > 60) this.shelf.length = 60;
    this.persistShelf();
    return row;
  }

  /** 当前还在保留期内的视频。 */
  recentVideos(limit) {
    this.pruneShelf();
    return this.shelf.slice(0, Math.max(1, Number(limit) || 10));
  }

  seenBvid(bvid) {
    this.pruneShelf();
    return this.shelf.some((row) => row.bvid === bvid);
  }

  clearShelf() {
    this.shelf = [];
    this.persistShelf();
  }
}

module.exports = { Memory, SHELF_PATH };
