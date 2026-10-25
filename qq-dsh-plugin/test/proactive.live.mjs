/**
 * 主动发言 + 语音回复测试。
 *
 * 验证：
 *  1. planNextProactive 排期落在配置区间内；
 *  2. 到了时间点，runProactive 会挑一个会话主动说话，主人被挑中的比例明显更高；
 *  3. voice.mode=keyword 时回复走语音而不是文字。
 *
 * 用法：node test/proactive.live.mjs
 */
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 数据目录指到临时目录，避免动到真实的 `~/.dsh/qq-agent`（本测试会写视频书架）。
const sandboxDir = mkdtempSync(join(tmpdir(), "dsh-qq-agent-proactive-"));
process.env.DSH_QQ_AGENT_DATA = sandboxDir;

const require = createRequire(import.meta.url);

const config = require("../src/config.cjs");
const core = require("../src/core.cjs");
const { Memory } = require("../src/memory.cjs");
const { OneBotClient } = require("../src/onebot.cjs");
const { Engine } = require("../src/engine.cjs");
const tts = require("../src/tts.cjs");

const log = {
  info: (m) => console.log("[info]", m),
  warn: (m) => console.log("[warn]", m),
  error: (m) => console.log("[error]", m),
};

const MASTER = "920420642";
const OTHERS = ["10001", "10002", "10003"];

// —— 1. 排期区间 ——
console.log("=== 1. 主动发言排期 ===");
const baseCfg = config.load();
baseCfg.active.minGapMinutes = 40;
baseCfg.active.maxGapMinutes = 150;
const rng = core.makeRng(12345);
let minSeen = Infinity;
let maxSeen = 0;
for (let i = 0; i < 500; i += 1) {
  const plan = core.planNextProactive(baseCfg, Date.now(), rng);
  if (plan.gapMinutes < minSeen) minSeen = plan.gapMinutes;
  if (plan.gapMinutes > maxSeen) maxSeen = plan.gapMinutes;
}
console.log(`500 次排期，间隔落在 ${minSeen.toFixed(1)} ~ ${maxSeen.toFixed(1)} 分钟（配置 40~150）`);
console.log("区间正确：", minSeen >= 40 && maxSeen <= 150);

// —— 2. 主人优先级 ——
console.log("\n=== 2. 挑人时主人的权重 ===");
const candidates = ["private:" + MASTER, ...OTHERS.map((uin) => "private:" + uin)];
baseCfg.master.uin = MASTER; // 不设这个的话所有会话都不算主人，权重就一样了
baseCfg.active.masterWeight = 0.6;
baseCfg.active.otherWeight = 0.08;
const pickRng = core.makeRng(999);
let masterHits = 0;
const TIMES = 3000;
for (let i = 0; i < TIMES; i += 1) {
  const picked = core.pickProactiveTarget(candidates, baseCfg, pickRng);
  if (picked === "private:" + MASTER) masterHits += 1;
}
const rate = masterHits / TIMES;
console.log(`3000 次抽样：主人被挑中 ${masterHits} 次（${(rate * 100).toFixed(1)}%），理论约 ${((0.6 / (0.6 + 0.08 * 3)) * 100).toFixed(1)}%`);
console.log("主人显著最高：", rate > 0.5);

// —— 3. 真正跑一次主动发言 ——
console.log("\n=== 3. 跑一次 runProactive ===");
const cfg = config.normalize(
  Object.assign({}, baseCfg, {
    enabled: true,
    master: Object.assign({}, baseCfg.master, { uin: MASTER, alias: "主人" }),
    active: Object.assign({}, baseCfg.active, { enabled: true, quietStartHour: 0, quietEndHour: 0 }),
    search: { mode: "off", maxResults: 4 },
    voice: Object.assign({}, baseCfg.voice, { enabled: false }),
  }),
);

const memory = new Memory({ memoryTurns: 20, retentionHours: 2 });
// 造出四个最近活跃的会话
for (const uin of [MASTER, ...OTHERS]) {
  memory.touch("private:" + uin);
  memory.push("private:" + uin, { role: "user", name: "某人", text: "刚才聊了几句" });
  memory.push("private:" + uin, { role: "assistant", name: cfg.persona.name, text: "嗯嗯" });
}

const onebot = new OneBotClient({ wsUrl: cfg.onebot.wsUrl, token: cfg.onebot.token, reconnectMs: 3000 });
let promptedSystem = "";
let promptedUser = "";
const engine = new Engine({
  cfg,
  memory,
  onebot,
  log,
  llm: {
    ready: () => true,
    async generate(options) {
      promptedSystem = options.system || "";
      promptedUser = options.userText || "";
      return { text: "在忙吗？突然想找你说句话。", finish: "stop" };
    },
  },
  web: { search: async () => [] },
  attachments: { saveImage: async () => ({}) },
  onChange() {},
});

// 拦下发送
const captured = [];
onebot.sendSegments = async (target, segments) => {
  captured.push({ target, segments });
  return { status: "ok", retcode: 0 };
};
onebot.connected = true;
onebot.selfId = "3886139976";
onebot.nickname = "鲸鱼娘";

const targetKey = await engine.runProactive();
console.log("挑中的会话：", targetKey);
console.log("捕获发送：", captured.length, "次");
for (const row of captured) {
  console.log("  →", row.target.kind + ":" + (row.target.userId || row.target.groupId), JSON.stringify(row.segments));
}
console.log("\n--- 主动发言用的提示词 ---");
console.log(promptedSystem.slice(0, 700));
console.log("--- 用户消息 ---", promptedUser);
console.log("proactiveCount =", engine.proactiveCount);

// —— 4. 语音模式 ——
console.log("\n=== 4. 命中关键词时改发语音 ===");
cfg.voice.enabled = true;
cfg.voice.mode = "keyword";
cfg.voice.keywords = ["语音", "念一下"];
cfg.voice.maxChars = 120;
engine.reload(cfg);
// 第 3 步刚发过言，冷却里还压着同一个会话；这里要测的是语音，不是冷却，清掉。
engine.lastReplyAt.clear();

captured.length = 0;
const voiceMemory = new Memory({ memoryTurns: 20, retentionHours: 2 });
engine.memory = voiceMemory;

await engine.handleEvent({
  post_type: "message",
  message_type: "private",
  self_id: 3886139976,
  user_id: Number(MASTER),
  message_id: Date.now(),
  time: Math.floor(Date.now() / 1000),
  raw_message: "用语音念一下",
  sender: { nickname: "主人" },
  message: [{ type: "text", data: { text: "用语音念一下" } }],
});

console.log("捕获发送：", captured.length, "次");
for (const row of captured) {
  const kind = row.segments[0] && row.segments[0].type;
  console.log("  →", kind, JSON.stringify(row.segments).slice(0, 160));
  if (kind === "record") {
    const file = row.segments[0].data.file;
    const local = file.replace(/^file:\/\/\//, "").replace(/\//g, "\\");
    try {
      console.log("     语音文件大小：", statSync(local).size, "字节");
    } catch (error) {
      console.log("     读文件失败：", error.message);
    }
  }
}

console.log("\nOK");
try {
  rmSync(sandboxDir, { recursive: true, force: true });
} catch (error) {
  console.log("[cleanup] 删除沙箱目录失败：", error.message);
}
process.exit(0);
