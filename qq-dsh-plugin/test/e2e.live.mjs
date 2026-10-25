/**
 * 端到端测试：连真实 NapCat（ws://127.0.0.1:3001），用桩 LLM 跑一遍完整回复链路。
 *
 * 验证：OneBot 连接 → 收消息 → 拼提示词 → （桩）推理 → 切段 → 打字延迟 → 真发出去。
 * 不碰真实模型，所以不会烧 token，也不会因为模型不可用而失败。
 *
 * 用法：node test/e2e.live.mjs [--send]   （不带 --send 就只连不发）
 *
 * 数据目录指到临时目录，不碰真实的 `~/.dsh/qq-agent`。
 */
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandboxDir = mkdtempSync(join(tmpdir(), "dsh-qq-agent-e2e-"));
process.env.DSH_QQ_AGENT_DATA = sandboxDir;

const require = createRequire(import.meta.url);

const config = require("../src/config.cjs");
const { Memory } = require("../src/memory.cjs");
const { OneBotClient } = require("../src/onebot.cjs");
const { Engine } = require("../src/engine.cjs");

const SEND = process.argv.includes("--send");

const cfg = config.load();
cfg.reply.minDelayMs = 0;
cfg.reply.maxDelayMs = 0;
cfg.reply.typingCps = 10000;
cfg.voice.enabled = false;
cfg.search.mode = "off";
cfg.active.enabled = false;
cfg.bilibili.enabled = true;

let seenSystem = "";
let seenUser = "";
let seenHistory = 0;

const llm = {
  ready: () => true,
  async generate(options) {
    seenSystem = options.system || "";
    seenUser = options.userText || "";
    seenHistory = (options.history || []).length;
    console.log("\n--- 提示词（前 600 字）---");
    console.log(seenSystem.slice(0, 600));
    console.log("--- 用户消息 ---");
    console.log(seenUser);
    console.log("--- 历史条数:", seenHistory, "图片:", (options.images || []).length);
    return { text: "收到啦，我是桩模型，这条是测试回复。", finish: "stop" };
  },
};

const web = { search: async () => [] };
const attachments = { saveImage: async () => { throw new Error("no attachment service in test"); } };

const memory = new Memory({ memoryTurns: cfg.reply.memoryTurns, retentionHours: cfg.bilibili.retentionHours });
const onebot = new OneBotClient({ wsUrl: cfg.onebot.wsUrl, token: cfg.onebot.token, reconnectMs: 3000 });

const engine = new Engine({
  cfg,
  memory,
  onebot,
  log: {
    info: (m) => console.log("[info]", m),
    warn: (m) => console.log("[warn]", m),
    error: (m) => console.log("[error]", m),
  },
  llm,
  web,
  attachments,
  onChange() {},
});

onebot.on("status", (status) => console.log("[status]", JSON.stringify(status)));

engine.start();

// 等连上
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("6 秒内没连上 OneBot")), 6000);
  onebot.once("ready", () => {
    clearTimeout(timer);
    resolve();
  });
  onebot.once("disconnect", (reason) => {
    clearTimeout(timer);
    reject(new Error("连接断开：" + reason));
  });
});

console.log("\n已连接：", onebot.nickname, "(" + onebot.selfId + ")");

const groups = await onebot.getGroupList();
console.log("群数量：", groups.length);
console.log("前三个：", groups.slice(0, 3).map((g) => g.group_name + "(" + g.group_id + ")").join(" / "));

if (SEND) {
  const selfUin = String(onebot.selfId);
  console.log("\n给 " + selfUin + " 发一条私聊，看引擎会不会自动回……");

  // 真发一条出去，让 QQ 客户端真的收到（验证 sendText 链路）
  await onebot.sendText({ kind: "private", userId: selfUin }, "【联通测试】引擎已就绪，这条是插件直接发出的。");
  console.log("已发送联通测试文本");

  // —— 回复主流程：用一个虚构账号，并把发送拦下来，避免打扰真人 ——
  const fakeUser = "10001";
  cfg.reply.privateWhitelist = [fakeUser];
  cfg.reply.privateWhitelistOnly = true;

  const captured = [];
  const realSend = onebot.sendSegments.bind(onebot);
  onebot.sendSegments = async (target, segments) => {
    captured.push({ target, segments });
    return { status: "ok", retcode: 0, data: { message_id: 1 } };
  };

  const fakeEvent = {
    post_type: "message",
    message_type: "private",
    self_id: Number(selfUin),
    user_id: Number(fakeUser),
    message_id: Date.now(),
    time: Math.floor(Date.now() / 1000),
    raw_message: "今天有什么新闻吗？",
    sender: { nickname: "测试路人" },
    message: [{ type: "text", data: { text: "今天有什么新闻吗？" } }],
  };

  await engine.handleEvent(fakeEvent);
  console.log("handleEvent 完成，replyCount =", engine.replyCount);
  console.log("捕获到", captured.length, "次发送：");
  for (const row of captured) console.log("  →", row.target.kind + ":" + (row.target.userId || row.target.groupId), JSON.stringify(row.segments));

  // 第二条：验证记忆真的累加了
  await engine.handleEvent(Object.assign({}, fakeEvent, { message_id: Date.now() + 1, raw_message: "再多说点" }));
  console.log("第二轮后历史条数：", memory.history("private:" + fakeUser).length);

  // 群聊：验证 @ 触发
  const groupId = groups[0] && String(groups[0].group_id);
  if (groupId) {
    cfg.reply.groupWhitelist = [groupId];
    cfg.reply.groupMode = "at";
    captured.length = 0;
    await engine.handleEvent({
      post_type: "message",
      message_type: "group",
      self_id: Number(selfUin),
      user_id: Number(fakeUser),
      group_id: Number(groupId),
      message_id: Date.now() + 2,
      time: Math.floor(Date.now() / 1000),
      raw_message: "[CQ:at,qq=" + selfUin + "] 你好",
      sender: { nickname: "测试路人", card: "测试路人" },
      message: [
        { type: "at", data: { qq: selfUin } },
        { type: "text", data: { text: " 你好" } },
      ],
    });
    console.log("群聊 @ 触发，捕获发送：", captured.length, "次");
    for (const row of captured) console.log("  →", row.target.kind + ":" + row.target.groupId, JSON.stringify(row.segments));
  }

  onebot.sendSegments = realSend;

  // 等一小会儿让异步发送落地
  await new Promise((r) => setTimeout(r, 800));
} else {
  console.log("\n（没带 --send，只验证连接）");
}

const snap = engine.snapshot();
console.log("\n--- snapshot ---");
console.log(
  JSON.stringify(
    {
      started: snap.started,
      paused: snap.paused,
      nickname: snap.nickname,
      selfId: snap.selfId,
      connection: snap.connection,
      replyCount: snap.replyCount,
      sessions: snap.sessions,
      shelfSize: snap.shelfSize,
      nextProactiveAt: snap.nextProactiveAt,
    },
    null,
    2,
  ),
);
console.log("日志条数：", snap.logs.length);
for (const row of snap.logs.slice(-8)) console.log("  ", row.level, row.text.slice(0, 100));

engine.stop();
await new Promise((r) => setTimeout(r, 300));
console.log("\nOK");
try {
  rmSync(sandboxDir, { recursive: true, force: true });
} catch (error) {
  console.log("[cleanup] 删除沙箱目录失败：", error.message);
}
process.exit(0);
