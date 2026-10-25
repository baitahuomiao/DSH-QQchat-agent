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

/**
 * wbi 签名。
 *
 * 周榜（popular/series/*）和首页推荐在 2023 年后都要求 wbi 签名，裸请求一律回 -352。
 * 流程：先 GET /x/web-interface/nav 拿 img_url / sub_url，取出两个 key，
 * 按固定的 MIXIN 表重排出 mixin key，再把参数按字典序拼接后跟 key 一起 md5 → w_rid。
 *
 * nav 匿名访问本来就是 -101（未登录），但 wbi_img 照样会给，所以不需要账号。
 */
const WBI_MIXIN = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39,
  12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63,
  57, 62, 11, 36, 20, 34, 44, 52,
];

// wbi key 每天轮换，缓存到当天结束；失败时清空重取。
let wbiCache = { at: 0, imgKey: "", subKey: "" };

async function getWbiKeys() {
  const today = new Date().toISOString().slice(0, 10);
  if (wbiCache.imgKey && wbiCache.subKey && wbiCache.day === today) return wbiCache;

  const response = await fetchLoose(API + "/x/web-interface/nav", { headers: headers(), timeoutMs: 15000 });
  if (!response.ok) throw new Error("拿 wbi key 失败 HTTP " + response.status);
  const payload = response.json();
  const img = payload && payload.data && payload.data.wbi_img;
  if (!img || !img.img_url || !img.sub_url) throw new Error("nav 没有返回 wbi_img");
  const imgKey = String(img.img_url).split("/").pop().split(".")[0];
  const subKey = String(img.sub_url).split("/").pop().split(".")[0];
  if (!imgKey || !subKey) throw new Error("wbi key 解析失败");
  wbiCache = { at: Date.now(), day: today, imgKey, subKey };
  return wbiCache;
}

function mixinKeyOf(imgKey, subKey) {
  const raw = imgKey + subKey;
  let out = "";
  for (const index of WBI_MIXIN) out += raw[index] || "";
  return out.slice(0, 32);
}

function md5Hex(input) {
  return require("node:crypto").createHash("md5").update(input).digest("hex");
}

/** 给参数加上 wts 与 w_rid，返回已编码的 query string。 */
async function signedQuery(params) {
  const keys = await getWbiKeys();
  const mixin = mixinKeyOf(keys.imgKey, keys.subKey);
  const wts = Math.floor(Date.now() / 1000);
  const all = Object.assign({}, params, { wts });
  const query = Object.keys(all)
    .sort()
    .map((key) => {
      const value = String(all[key] == null ? "" : all[key]).replace(/[!'()*]/g, "");
      return encodeURIComponent(key) + "=" + encodeURIComponent(value);
    })
    .join("&");
  return query + "&w_rid=" + md5Hex(query + mixin);
}

/** 走 wbi 签名的 GET。签名过期（-352/-403）时清缓存重试一次。 */
async function wbiGet(pathname, params) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const query = await signedQuery(params || {});
    const url = API + pathname + "?" + query;
    let payload;
    try {
      const response = await fetchLoose(url, { headers: headers(), timeoutMs: 20000 });
      if (!response.ok) throw new Error("B 站接口 HTTP " + response.status);
      payload = response.json();
    } catch (error) {
      lastError = error;
      wbiCache = { at: 0, imgKey: "", subKey: "" };
      continue;
    }
    if (payload && payload.code === 0) return payload.data;
    const code = payload && payload.code;
    lastError = new Error("B 站接口返回错误 code=" + code + " " + ((payload && payload.message) || ""));
    // 风控/签名失效才重试，别的错误直接抛
    if (code !== -352 && code !== -403) throw lastError;
    wbiCache = { at: 0, imgKey: "", subKey: "" };
  }
  throw lastError || new Error("B 站 wbi 接口失败");
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

/**
 * 每周必看（周榜）。
 *
 * 接口返回的是某一期，带 videos 列表；这里拍平成视频数组。
 * 该接口要 wbi 签名，裸请求回 -352。
 *
 * 期号传老期（比如第 1 期是 2019 年的）B 站会拒绝，这时自动换成最新一期，
 * 免得调用方拿到一个空结果。
 */
async function weekly(number, options) {
  const opts = options || {};
  const wanted = Number(number) || 1;
  let data;
  try {
    data = await wbiGet("/x/web-interface/popular/series/one", { number: wanted });
  } catch (error) {
    if (opts.noFallback || wanted !== 1) throw error;
    // 第 1 期基本已经不可访问，直接找最新一期
    const series = await weeklySeries();
    if (series.length === 0) throw error;
    const newest = series.reduce((best, row) => (row.number > best.number ? row : best), series[0]);
    data = await wbiGet("/x/web-interface/popular/series/one", { number: newest.number });
  }
  if (!data) return [];
  const list = (data && data.list) || (data && data.videos) || [];
  const out = list.map(toVideo).filter(Boolean);
  if (out.length > 0) return out;
  const subject = data.subject || data;
  return (subject && Array.isArray(subject.list) ? subject.list : []).map(toVideo).filter(Boolean);
}

/** 周榜的期数列表（拿最新一期用）。同样要 wbi 签名。 */
async function weeklySeries() {
  const data = await wbiGet("/x/web-interface/popular/series/list", {});
  const list = (data && data.list) || [];
  return list
    .map((row) => ({
      number: Number(row.number) || 0,
      subject: String(row.subject || ""),
      name: String(row.name || ""),
    }))
    .filter((row) => row.number > 0);
}

/** 最新一期周榜。 */
async function weeklyLatest() {
  const series = await weeklySeries();
  if (series.length > 0) {
    const newest = series.reduce((best, row) => (row.number > best.number ? row : best), series[0]);
    return { number: newest.number, name: newest.name || newest.subject, videos: await weekly(newest.number) };
  }
  return { number: 1, name: "", videos: await weekly(1) };
}

/**
 * 首页推荐（主页信息流）。
 *
 * /x/web-interface/wbi/index/top/feed/rcmd 要 wbi 签名；失败时退回热门，
 * 别让「刷」整个挂掉。
 */
async function homepage(pageSize) {
  try {
    const data = await wbiGet("/x/web-interface/wbi/index/top/feed/rcmd", {
      ps: pageSize || 12,
      fresh_type: 4,
      feed_version: "V8",
    });
    const list = (data && data.item) || (data && data.list) || [];
    const out = list.map(toVideo).filter(Boolean);
    if (out.length > 0) return out;
  } catch {
    /* 落到热门兜底 */
  }
  return popular(1, pageSize || 12);
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
 * 刷一轮：按数据源取视频，跳过 recentVideos 里已有的，凑够 count 条。
 *
 * source:
 *  - popular  热门（默认，可翻页）
 *  - weekly   每周必看 / 周榜
 *  - homepage 主页推荐信息流
 *  - mix      三者混合，各出一部分（更像真人乱逛）
 *
 * @param {{count?:number, pageSize?:number, maxPages?:number, source?:string,
 *          seen?:(bvid:string)=>boolean}} options
 */
async function browse(options) {
  const opts = options || {};
  const count = Math.max(1, Number(opts.count) || 3);
  const pageSize = Math.max(count, Number(opts.pageSize) || 20);
  const maxPages = Math.max(1, Number(opts.maxPages) || 3);
  const source = String(opts.source || "popular").toLowerCase();
  const seen = typeof opts.seen === "function" ? opts.seen : () => false;

  // 先按数据源收集候选池
  const pool = [];
  const errors = [];
  const take = (rows) => {
    for (const video of Array.isArray(rows) ? rows : []) {
      if (video && video.bvid) pool.push(video);
    }
  };

  if (source === "weekly") {
    try {
      take((await weeklyLatest()).videos);
    } catch (error) {
      errors.push("周榜：" + messageOf(error));
    }
  } else if (source === "homepage") {
    try {
      take(await homepage(pageSize));
    } catch (error) {
      errors.push("主页：" + messageOf(error));
    }
  } else if (source === "mix") {
    // 混合：主页偏多、周榜一点、热门兜底
    try {
      take(await homepage(pageSize));
    } catch (error) {
      errors.push("主页：" + messageOf(error));
    }
    if (pool.length < count) {
      try {
        take((await weeklyLatest()).videos);
      } catch (error) {
        errors.push("周榜：" + messageOf(error));
      }
    }
    if (pool.length < count) {
      for (let page = 1; page <= maxPages && pool.length < count * 2; page += 1) {
        try {
          take(await popular(page, pageSize));
        } catch (error) {
          errors.push("热门：" + messageOf(error));
          break;
        }
      }
    }
  } else {
    for (let page = 1; page <= maxPages && pool.length < count * 2; page += 1) {
      try {
        take(await popular(page, pageSize));
      } catch (error) {
        errors.push("热门：" + messageOf(error));
        break;
      }
    }
  }

  if (pool.length === 0) {
    throw new Error(errors.length > 0 ? "B 站取数据失败：" + errors.join("；") : "B 站没有返回视频");
  }

  // 再从中挑没看过的
  const picked = [];
  const skipped = [];
  for (const video of pool) {
    if (seen(video.bvid)) {
      skipped.push(video.bvid);
      continue;
    }
    if (picked.some((v) => v.bvid === video.bvid)) continue;
    picked.push(video);
    if (picked.length >= count) break;
  }
  return { videos: picked, skipped, source, errors };
}

function messageOf(error) {
  return error && error.message ? error.message : String(error);
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
  weekly,
  weeklySeries,
  weeklyLatest,
  homepage,
  view,
  search,
  related,
  describeVideo,
  formatDuration,
  compactNumber,
  truncate,
};
