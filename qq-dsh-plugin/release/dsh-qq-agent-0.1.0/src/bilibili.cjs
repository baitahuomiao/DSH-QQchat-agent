/**
 * B 站刷视频。
 *
 * 只用公开 web 接口（匿名可调）：
 *  - /x/web-interface/popular          热门
 *  - /x/web-interface/view?bvid=       详情
 *  - /x/web-interface/search/type      搜索
 *  - /x/web-interface/archive/related  相关推荐
 *
 * 「刷」的含义：连续翻几页热门，跳过最近已经刷过的，挑 batchSize 条，
 * 为每条生成一句内容描述（note），写进 memory 的视频书架。
 */
"use strict";

const { fetchLoose, UA } = require("./net.cjs");

const API = "https://api.bilibili.com";
const REFERER = "https://www.bilibili.com/";

function headers() {
  return {
    "User-Agent": UA,
    Referer: REFERER,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    Origin: "https://www.bilibili.com",
  };
}

async function apiGet(pathname, query) {
  const url = API + pathname + (query ? "?" + new URLSearchParams(query).toString() : "");
  const response = await fetchLoose(url, { headers: headers(), timeoutMs: 20000 });
  if (!response.ok) throw new Error("B 站接口 HTTP " + response.status);
  const payload = response.json();
  if (!payload || payload.code !== 0) {
    throw new Error("B 站接口返回错误 code=" + (payload && payload.code) + " " + ((payload && payload.message) || ""));
  }
  return payload.data;
}

function toVideo(raw) {
  if (!raw) return null;
  const bvid = String(raw.bvid || "").trim();
  if (!bvid) return null;
  // 搜索接口的 title 带 <em class="keyword"> 高亮标签，要去掉。
  const title = String(raw.title || "").replace(/<[^>]+>/g, "");
  return {
    bvid,
    title,
    author: String((raw.owner && raw.owner.name) || raw.author || ""),
    desc: String(raw.desc || "").trim(),
    cover: String(raw.pic || "").replace(/^\/\//, "https://"),
    duration: Number(raw.duration) || 0,
    stat: raw.stat
      ? {
          view: raw.stat.view,
          like: raw.stat.like,
          danmaku: raw.stat.danmaku,
          reply: raw.stat.reply,
        }
      : null,
    tags: Array.isArray(raw.tag_list) ? raw.tag_list.map((t) => (typeof t === "string" ? t : t && t.tag_name)).filter(Boolean) : [],
    url: "https://www.bilibili.com/video/" + bvid,
  };
}

/** 热门列表（可翻页）。 */
async function popular(page, pageSize) {
  const data = await apiGet("/x/web-interface/popular", { ps: pageSize || 20, pn: page || 1 });
  const list = (data && data.list) || [];
  return list.map(toVideo).filter(Boolean);
}

/** 单个视频详情。 */
async function view(bvid) {
  const data = await apiGet("/x/web-interface/view", { bvid: String(bvid || "") });
  return toVideo(data);
}

/** 搜索视频。 */
async function search(keyword, page) {
  const data = await apiGet("/x/web-interface/search/type", {
    search_type: "video",
    keyword: String(keyword || ""),
    page: page || 1,
  });
  const list = (data && data.result) || [];
  return list
    .filter((item) => item && item.type === "video")
    .map((item) => {
      const video = toVideo(item);
      if (video) video.url = "https://www.bilibili.com/video/" + video.bvid;
      return video;
    })
    .filter(Boolean);
}

/** 某视频的相关推荐。 */
async function related(bvid) {
  const data = await apiGet("/x/web-interface/archive/related", { bvid: String(bvid || "") });
  const list = Array.isArray(data) ? data : (data && data.list) || [];
  return list.map(toVideo).filter(Boolean);
}

/**
 * 刷一轮：翻几页热门，跳过 recentVideos 里已有的，凑够 count 条。
 * @param {{count?:number, pageSize?:number, maxPages?:number, seen?:(bvid:string)=>boolean}} options
 */
async function browse(options) {
  const opts = options || {};
  const count = Math.max(1, Number(opts.count) || 3);
  const pageSize = Math.max(count, Number(opts.pageSize) || 20);
  const maxPages = Math.max(1, Number(opts.maxPages) || 3);
  const seen = typeof opts.seen === "function" ? opts.seen : () => false;

  const picked = [];
  const skipped = [];
  for (let page = 1; page <= maxPages && picked.length < count; page += 1) {
    let rows;
    try {
      rows = await popular(page, pageSize);
    } catch (error) {
      if (picked.length > 0) break;
      throw error;
    }
    for (const video of rows) {
      if (seen(video.bvid)) {
        skipped.push(video.bvid);
        continue;
      }
      if (picked.some((v) => v.bvid === video.bvid)) continue;
      picked.push(video);
      if (picked.length >= count) break;
    }
  }
  return { videos: picked, skipped };
}

/** 秒数 → "12:34" 形式。 */
function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return minutes + ":" + String(rest).padStart(2, "0");
}

/** 生成一句给模型看的内容描述（不依赖模型，纯模板）。 */
function describeVideo(video) {
  if (!video) return "";
  const bits = [];
  bits.push("《" + (video.title || "无标题") + "》");
  if (video.author) bits.push("UP 主 " + video.author);
  if (video.duration) bits.push("时长 " + formatDuration(video.duration));
  if (video.stat && video.stat.view) bits.push("播放 " + compactNumber(video.stat.view));
  if (video.desc) bits.push("简介：" + truncate(video.desc.replace(/\s+/g, " "), 120));
  if (video.tags && video.tags.length) bits.push("标签：" + video.tags.slice(0, 5).join("、"));
  return bits.join("，");
}

function truncate(text, max) {
  const value = String(text || "");
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 1)) + "…";
}

function compactNumber(value) {
  const num = Number(value) || 0;
  if (num >= 100000000) return (num / 100000000).toFixed(1).replace(/\.0$/, "") + " 亿";
  if (num >= 10000) return (num / 10000).toFixed(1).replace(/\.0$/, "") + " 万";
  return String(num);
}

module.exports = {
  browse,
  popular,
  view,
  search,
  related,
  describeVideo,
  formatDuration,
  compactNumber,
  truncate,
};
