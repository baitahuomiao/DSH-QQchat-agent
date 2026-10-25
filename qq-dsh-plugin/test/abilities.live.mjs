/**
 * 能力测试：B 站刷视频 + 视频书架过期 + 语音合成 + 真发一条语音到 QQ。
 *
 * 用法：node test/abilities.live.mjs [--send]
 *
 * 数据目录指到临时目录，不碰真实的 `~/.dsh/qq-agent`（这个测试会往书架里写视频）。
 */
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandboxDir = mkdtempSync(join(tmpdir(), "dsh-qq-agent-abilities-"));
process.env.DSH_QQ_AGENT_DATA = sandboxDir;

const require = createRequire(import.meta.url);

const config = require("../src/config.cjs");
const { Memory } = require("../src/memory.cjs");
const { OneBotClient } = require("../src/onebot.cjs");
const { Engine } = require("../src/engine.cjs");
const bilibili = require("../src/bilibili.cjs");
const tts = require("../src/tts.cjs");
const core = require("../src/core.cjs");

const SEND = process.argv.includes("--send");
const log = {
  info: (m) => console.log("[info]", m),
  warn: (m) => console.log("[warn]", m),
  error: (m) => console.log("[error]", m),
};

// —— 1. B 站接口 ——
console.log("\n=== 1. B 站接口 ===");
const popular = await bilibili.popular(1, 5);
console.log("热门前 5 条：");
for (const video of popular) {
  console.log("  " + video.bvid, "｜" + video.title.slice(0, 40), "｜UP:" + video.author, "｜" + video.duration);
}
if (popular[0]) {
  const detail = await bilibili.view(popular[0].bvid);
  console.log("详情：", JSON.stringify({ bvid: detail.bvid, title: detail.title.slice(0, 30), tags: (detail.tags || []).slice(0, 4) }));
  console.log("模板描述：", bilibili.describeVideo(popular[0]).slice(0, 160));
  const related = await bilibili.related(popular[0].bvid);
  console.log("相关推荐：", related.length, "条");
}

// —— 2. 书架与过期 ——
console.log("\n=== 2. 视频书架（含 2 小时过期）===");
const cfg = config.load();
cfg.bilibili.retentionHours = 2;
const memory = new Memory({ memoryTurns: 20, retentionHours: 2 });
memory.clearShelf();

const shelfMemory = new Memory({ memoryTurns: 20, retentionHours: 2 });
for (const video of popular.slice(0, 3)) {
  shelfMemory.addVideo({
    bvid: video.bvid,
    title: video.title,
    author: video.author,
    note: bilibili.describeVideo(video),
    at: Date.now(),
  });
}
// 手工塞一条 3 小时前的，验证会被清掉
shelfMemory.shelf.push({
  bvid: "BVold1234567",
  title: "三小时前看的老视频",
  author: "旧UP",
  note: "这条应该过期",
  at: Date.now() - 3 * 3600 * 1000,
});
const before = shelfMemory.recentVideos(20).length;
const pruned = shelfMemory.pruneShelf();
const after = shelfMemory.recentVideos(20).length;
console.log(`清过期：${before} → ${after}（清掉 ${pruned} 条）`);
for (const row of shelfMemory.recentVideos(5)) {
  const age = core.shelfAge(row, 2, Date.now());
  console.log("  " + row.bvid, "｜" + row.title.slice(0, 30), "｜已存", age.ageMinutes, "分钟，还剩", age.remainingMinutes, "分钟");
}
console.log("该不该聊：", core.summarizeVideoNotes(shelfMemory.recentVideos(5), 3));

// —— 3. Engine.browseBilibili（需要批准）——
console.log("\n=== 3. browseBilibili 的批准门 ===");
const onebot = new OneBotClient({ wsUrl: cfg.onebot.wsUrl, token: cfg.onebot.token, reconnectMs: 3000 });
const engineMemory = new Memory({ memoryTurns: 20, retentionHours: 2 });
const engine = new Engine({
  cfg: config.normalize(Object.assign({}, cfg, { bilibili: Object.assign({}, cfg.bilibili, { approved: false, batchSize: 2 }) })),
  memory: engineMemory,
  onebot,
  log,
  llm: { ready: () => true, generate: async () => ({ text: "嗯嗯" }) },
  web: { search: async () => [] },
  attachments: { saveImage: async () => ({}) },
  onChange() {},
});

try {
  await engine.browseBilibili("auto");
  console.log("!!! 未批准居然刷成功了，是 bug");
} catch (error) {
  console.log("未批准时正确拒绝：", error.message);
}

engine.cfg.bilibili.approved = true;
const browse = await engine.browseBilibili("master");
console.log("主人批准后刷到", browse.videos.length, "条：");
for (const row of browse.videos) {
  console.log("  " + row.bvid, "｜" + row.title.slice(0, 34));
  console.log("    记：" + String(row.note).slice(0, 90));
}

// —— 4. 语音合成 ——
console.log("\n=== 4. 语音合成 ===");
const sample = "主人好呀，我是" + cfg.persona.name + "，这条是插件合成的语音。";
const started = Date.now();
const file = await tts.synthesizeToFile(sample, { lang: cfg.voice.lang, speed: cfg.voice.speed });
const { statSync } = require("node:fs");
console.log("合成耗时", Date.now() - started, "ms；文件", file);
console.log("大小", statSync(file).size, "字节；file URL:", tts.toFileUrl(file));

const withLexicon = await tts.synthesizeToFile("我去B站看看", {
  lang: "zh",
  speed: 5,
  lexicon: { B站: "哔哩哔哩", DSH: "滴艾斯艾尺" },
});
console.log("带读音替换合成：", withLexicon, "|", statSync(withLexicon).size, "字节");
console.log("applyLexicon 结果：", tts.applyLexicon("我去B站看看 DSH 怎么样", { B站: "哔哩哔哩", DSH: "滴艾斯艾尺" }));

// —— 5. 真发一条语音 ——
if (SEND) {
  console.log("\n=== 5. 发语音到 QQ ===");
  await engine.start();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("6 秒内没连上")), 6000);
    onebot.once("ready", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  console.log("已连接：", onebot.nickname);
  const selfUin = String(onebot.selfId);
  await onebot.sendRecord({ kind: "private", userId: selfUin }, tts.toFileUrl(file));
  console.log("语音已发到", selfUin, "（去看 QQ 有没有收到）");
  await new Promise((r) => setTimeout(r, 1200));
  engine.stop();
} else {
  console.log("\n（没带 --send，跳过真发语音）");
}

console.log("\nOK");
try {
  rmSync(sandboxDir, { recursive: true, force: true });
} catch (error) {
  console.log("[cleanup] 删除沙箱目录失败：", error.message);
}
process.exit(0);
