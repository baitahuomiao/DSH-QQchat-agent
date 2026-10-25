/** 真实网络验证：B 站周榜 / 主页 / 热门 三个数据源能不能取到数据。 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const bilibili = require("../src/bilibili.cjs");

async function probe(name, fn) {
  const startedAt = Date.now();
  try {
    const rows = await fn();
    const ms = Date.now() - startedAt;
    if (!Array.isArray(rows) || rows.length === 0) {
      console.log("  FAIL " + name + "：无数据（" + ms + "ms）");
      return 0;
    }
    const sample = rows[0];
    console.log("  ok   " + name + "：" + rows.length + " 条，" + ms + "ms");
    console.log("        首条《" + String(sample.title || "").slice(0, 40) + "》 by " + (sample.author || "?"));
    if (!sample.bvid) {
      console.log("        WARN 缺 bvid");
    }
    return rows.length;
  } catch (error) {
    console.log("  FAIL " + name + "：" + (error && error.message ? error.message : String(error)));
    return 0;
  }
}

(async () => {
  console.log("\n== B 站数据源实测 ==");
  const w = await probe("周榜 weekly()", () => bilibili.weekly(1));
  const wl = await probe("周榜最新 weeklyLatest()", async () => (await bilibili.weeklyLatest()).videos);
  const h = await probe("主页 homepage()", () => bilibili.homepage(12));
  const p = await probe("热门 popular()", () => bilibili.popular(1, 10));

  console.log("\n== browse() 各 source ==");
  for (const source of ["popular", "weekly", "homepage", "mix"]) {
    try {
      const out = await bilibili.browse({ count: 2, pageSize: 10, source, seen: () => false });
      console.log("  " + source.padEnd(9) + " -> " + out.videos.length + " 条 (source 报 " + out.source + ")" +
        (out.errors && out.errors.length ? "  错误:" + out.errors.join(";") : ""));
    } catch (error) {
      console.log("  " + source.padEnd(9) + " -> FAIL " + (error && error.message ? error.message : String(error)));
    }
  }

  console.log("\n== 去重（seen 全 true 时应挑不到） ==");
  try {
    const out = await bilibili.browse({ count: 2, pageSize: 10, source: "popular", seen: () => true });
    console.log("  取到 " + out.videos.length + " 条，跳过 " + out.skipped.length + " 条");
  } catch (error) {
    console.log("  FAIL " + (error && error.message ? error.message : String(error)));
  }

  const total = w + wl + h + p;
  console.log("\n网络可达性：" + (total > 0 ? "有数据" : "全部失败（可能没网/被墙）"));
})();
