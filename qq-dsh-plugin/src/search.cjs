/**
 * 联网搜索的兜底实现。
 *
 * 主路径是 DSH 自己的 `ctx.web.search`（有凭据、有配额、结果规范），
 * 但这个插件要能在 DSH 的 web provider 缺失时也活着，所以这里再带一条
 * 零 key 的 Bing RSS 通道。两条路返回同一种形状：
 *
 *   [{ title, url, snippet }]
 *
 * Bing 的 `format=rss` 端点不需要 cookie、不需要 key，返回一份普通 RSS XML，
 * 用正则抠 <item> 就够了——引第三方 XML 解析库不值当。
 */
"use strict";

const { fetchLoose, UA } = require("./net.cjs");

const ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** 还原 XML 里最常见的几个实体，并压掉标签。 */
function decodeXml(text) {
  return String(text || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, name) => {
      if (name.charAt(0) === "#") {
        const hex = name.charAt(1) === "x" || name.charAt(1) === "X";
        const code = Number.parseInt(hex ? name.slice(2) : name.slice(1), hex ? 16 : 10);
        return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
      }
      const hit = ENTITIES[name.toLowerCase()];
      return hit === undefined ? whole : hit;
    })
    .replace(/\s+/g, " ")
    .trim();
}

function pickTag(block, tag) {
  const re = new RegExp("<" + tag + ">([\\s\\S]*?)</" + tag + ">", "i");
  const hit = re.exec(block);
  return hit ? decodeXml(hit[1]) : "";
}

/** 解析 Bing RSS 的 XML，返回搜索结果数组。 */
function parseBingRss(xml, maxResults) {
  const limit = Math.max(1, Math.min(10, Number(maxResults) || 4));
  const out = [];
  const items = String(xml || "").match(/<item>[\s\S]*?<\/item>/gi) || [];
  for (const block of items) {
    const url = pickTag(block, "link");
    if (!url || !/^https?:\/\//i.test(url)) continue;
    out.push({
      title: pickTag(block, "title") || url,
      url,
      snippet: pickTag(block, "description"),
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 用 Bing RSS 搜一次。网络失败时返回空数组而不是抛错——搜索是锦上添花，
 * 不该让整条回复挂掉。
 *
 * @param {string} query
 * @param {{maxResults?:number, timeoutMs?:number}} [options]
 * @returns {Promise<Array<{title:string,url:string,snippet:string}>>}
 */
async function bingRss(query, options) {
  const opts = options || {};
  const text = String(query || "").trim();
  if (!text) return [];
  const url = "https://www.bing.com/search?" + new URLSearchParams({ q: text, format: "rss" }).toString();
  try {
    const response = await fetchLoose(url, {
      headers: {
        "User-Agent": UA,
        Accept: "application/rss+xml, application/xml, text/xml, */*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
      timeoutMs: Math.max(6000, Number(opts.timeoutMs) || 12000),
    });
    if (!response.ok) return [];
    return parseBingRss(response.text(), opts.maxResults);
  } catch {
    return [];
  }
}

module.exports = { bingRss, parseBingRss, decodeXml };
