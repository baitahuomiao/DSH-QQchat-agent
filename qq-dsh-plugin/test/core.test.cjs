/**
 * 纯逻辑单测：node test/core.test.cjs
 *
 * 只测 src/ 里不碰网络、不碰文件系统的函数。跑通说明判定逻辑没退化。
 */
"use strict";

const assert = require("node:assert");
const path = require("node:path");

const core = require("../src/core.cjs");
const config = require("../src/config.cjs");
const { sanitizeForSpeech, splitSentences, applyLexicon, toFileUrl } = require("../src/tts.cjs");
const { parseBingRss, decodeXml } = require("../src/search.cjs");

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failures.push({ name, error });
  }
}

// —— 配置 ——

test("normalize 会补全缺失字段", () => {
  const cfg = config.normalize({});
  assert.strictEqual(cfg.reply.maxChars, 300);
  assert.strictEqual(cfg.onebot.wsUrl, "ws://127.0.0.1:3001");
  assert.strictEqual(cfg.bilibili.approved, false);
  assert.deepStrictEqual(cfg.voice.lexicon, {});
});

test("normalize 钳制越界数值", () => {
  const cfg = config.normalize({ reply: { maxChars: 99999, typingCps: -3 }, voice: { speed: 99, chance: 5 } });
  assert.ok(cfg.reply.maxChars <= 2000);
  assert.ok(cfg.reply.typingCps >= 1);
  assert.strictEqual(cfg.voice.speed, 15);
  assert.strictEqual(cfg.voice.chance, 1);
});

test("normalize 把主人塞进管理员和私聊白名单", () => {
  const cfg = config.normalize({ master: { uin: "12345" } });
  assert.ok(cfg.admin.uins.includes("12345"));
  assert.ok(cfg.reply.privateWhitelist.includes("12345"));
});

test("normalize 清洗读音表", () => {
  const cfg = config.normalize({ voice: { lexicon: { 鲸鱼娘: "京鱼娘", "": "x", 同名: "同名" } } });
  assert.deepStrictEqual(cfg.voice.lexicon, { 鲸鱼娘: "京鱼娘" });
});

test("merge 只覆盖给出的字段", () => {
  const base = config.normalize({});
  const merged = config.merge(base, { reply: { maxChars: 120 } });
  assert.strictEqual(merged.reply.maxChars, 120);
  assert.strictEqual(merged.reply.typingCps, base.reply.typingCps);
  assert.strictEqual(merged.persona.name, base.persona.name);
});

// —— shouldReply ——

function makeCfg(overrides) {
  return config.normalize(overrides || {});
}

function msg(overrides) {
  return Object.assign(
    { messageType: "private", userId: "200", selfId: "100", text: "在吗", atMe: false, sessionKey: "private:200" },
    overrides,
  );
}

test("关闭时不回", () => {
  const out = core.shouldReply(msg(), makeCfg({ enabled: false }), { rng: () => 0 });
  assert.strictEqual(out.reply, false);
  assert.strictEqual(out.reason, "disabled");
});

test("自己发的不回", () => {
  const cfg = makeCfg({ onebot: { selfId: "100" } });
  const out = core.shouldReply(msg({ userId: "100" }), cfg, { rng: () => 0 });
  assert.strictEqual(out.reply, false);
  assert.strictEqual(out.reason, "self");
});

test("私聊白名单外的人不回", () => {
  const cfg = makeCfg({ reply: { privateWhitelistOnly: true, privateWhitelist: ["999"] } });
  const out = core.shouldReply(msg(), cfg, { rng: () => 0 });
  assert.strictEqual(out.reply, false);
  assert.strictEqual(out.reason, "private-not-allowed");
});

test("私聊白名单内的人会回", () => {
  const cfg = makeCfg({ reply: { privateWhitelistOnly: true, privateWhitelist: ["200"] } });
  const out = core.shouldReply(msg(), cfg, { rng: () => 0 });
  assert.strictEqual(out.reply, true);
  assert.strictEqual(out.reason, "allowed");
});

test("主人永远优先（即便不在白名单里）", () => {
  const cfg = makeCfg({ master: { uin: "200" }, reply: { privateWhitelistOnly: true } });
  const out = core.shouldReply(msg(), cfg, { rng: () => 0.99, lastReplyAt: 0 });
  assert.strictEqual(out.reply, true);
  assert.strictEqual(out.reason, "master");
});

test("群聊 at 模式：没 at 就不回", () => {
  const cfg = makeCfg({ reply: { groupWhitelist: ["777"] } });
  const out = core.shouldReply(
    msg({ messageType: "group", groupId: "777", sessionKey: "group:777", atMe: false }),
    cfg,
    { rng: () => 0 },
  );
  assert.strictEqual(out.reply, false);
  assert.strictEqual(out.reason, "not-mentioned");
});

test("群聊 at 模式：at 了就回", () => {
  const cfg = makeCfg({ reply: { groupWhitelist: ["777"] } });
  const out = core.shouldReply(
    msg({ messageType: "group", groupId: "777", sessionKey: "group:777", atMe: true, text: "" }),
    cfg,
    { rng: () => 0 },
  );
  assert.strictEqual(out.reply, true);
});

test("群聊不在白名单不回", () => {
  const cfg = makeCfg({ reply: { groupWhitelist: ["111"] } });
  const out = core.shouldReply(
    msg({ messageType: "group", groupId: "777", sessionKey: "group:777", atMe: true }),
    cfg,
    { rng: () => 0 },
  );
  assert.strictEqual(out.reply, false);
  assert.strictEqual(out.reason, "group-not-allowed");
});

test("群聊 mode=off 不回", () => {
  const cfg = makeCfg({ reply: { groupMode: "off", groupWhitelist: ["777"] } });
  const out = core.shouldReply(
    msg({ messageType: "group", groupId: "777", sessionKey: "group:777", atMe: true }),
    cfg,
    { rng: () => 0 },
  );
  assert.strictEqual(out.reply, false);
  assert.strictEqual(out.reason, "group-mode-off");
});

test("关键词模式下命中关键词才回", () => {
  const cfg = makeCfg({ reply: { groupMode: "keyword", groupWhitelist: ["777"], groupKeywords: ["鲸鱼娘"] } });
  const session = { messageType: "group", groupId: "777", sessionKey: "group:777", atMe: false };
  assert.strictEqual(core.shouldReply(msg(Object.assign({ text: "随便说说" }, session)), cfg, { rng: () => 0 }).reply, false);
  assert.strictEqual(core.shouldReply(msg(Object.assign({ text: "鲸鱼娘在吗" }, session)), cfg, { rng: () => 0 }).reply, true);
});

test("冷却期内不回", () => {
  const cfg = makeCfg({ reply: { privateWhitelistOnly: false, cooldownSec: 10 } });
  const out = core.shouldReply(msg(), cfg, { rng: () => 0, now: 5000, lastReplyAt: 4000 });
  assert.strictEqual(out.reply, false);
  assert.strictEqual(out.reason, "cooldown");
});

test("回复概率为 0 时不回", () => {
  const cfg = makeCfg({ reply: { privateWhitelistOnly: false, replyChance: 0 } });
  const out = core.shouldReply(msg(), cfg, { rng: () => 0.5 });
  assert.strictEqual(out.reply, false);
  assert.strictEqual(out.reason, "chance");
});

// —— 文本切分与打字停顿 ——

test("短文本不切", () => {
  assert.deepStrictEqual(core.splitSegments("你好呀", { maxChars: 300, splitSegments: true }), ["你好呀"]);
});

test("长文本按句切且不超过上限", () => {
  const text = "第一句话说点什么。第二句话也说点什么。第三句话还要说点什么。";
  const out = core.splitSegments(text, { maxChars: 20, splitSegments: true });
  assert.ok(out.length > 1);
  for (const row of out) assert.ok(row.length <= 24, "段太长：" + row + "（" + row.length + "）");
});

test("关掉分段就原样返回", () => {
  const text = "一句话。两句话。三句话。";
  assert.deepStrictEqual(core.splitSegments(text, { maxChars: 8, splitSegments: false }), [text]);
});

test("空文本切出空数组", () => {
  assert.deepStrictEqual(core.splitSegments("", { maxChars: 300 }), []);
  assert.deepStrictEqual(core.splitSegments("   \n  ", { maxChars: 300 }), []);
});

test("打字停顿落在区间里", () => {
  const delay = core.typingDelay("一二三四五六七八九十", { typingCps: 10, minDelayMs: 100, maxDelayMs: 5000 });
  assert.ok(delay >= 100 && delay <= 5000, "停顿越界：" + delay);
});

// —— 免打扰 ——

test("免打扰时段判断", () => {
  const cfg = makeCfg({ active: { quietStartHour: 2, quietEndHour: 8 } });
  const at = (hour) => new Date(2026, 0, 1, hour, 30, 0).getTime();
  assert.strictEqual(core.inQuietHours(cfg, at(3)), true);
  assert.strictEqual(core.inQuietHours(cfg, at(10)), false);
});

test("跨午夜的免打扰", () => {
  const cfg = makeCfg({ active: { quietStartHour: 23, quietEndHour: 6 } });
  const at = (hour) => new Date(2026, 0, 1, hour, 0, 0).getTime();
  assert.strictEqual(core.inQuietHours(cfg, at(23)), true);
  assert.strictEqual(core.inQuietHours(cfg, at(2)), true);
  assert.strictEqual(core.inQuietHours(cfg, at(12)), false);
});

// —— 主动发言 ——

test("主动发言间隔落在配置区间", () => {
  const cfg = makeCfg({ active: { minGapMinutes: 40, maxGapMinutes: 150 } });
  for (const seed of [1, 7, 99, 12345]) {
    const plan = core.planNextProactive(cfg, 1000000, core.makeRng(seed));
    const gap = plan.gapMinutes;
    assert.ok(gap >= 40 && gap <= 150, "间隔越界：" + gap);
  }
});

test("主人权重最高：绝大多数目标都是主人", () => {
  const cfg = makeCfg({ master: { uin: "200" }, active: { masterWeight: 0.9, otherWeight: 0.02 } });
  const candidates = ["private:200", "private:300", "group:777"];
  const rng = core.makeRng(42);
  let master = 0;
  for (let i = 0; i < 200; i += 1) {
    const picked = core.pickProactiveTarget(candidates, cfg, rng);
    if (picked === "private:200") master += 1;
  }
  assert.ok(master > 120, "主人只被选中 " + master + " 次");
});

test("没有候选时返回 null", () => {
  assert.strictEqual(core.pickProactiveTarget([], makeCfg({}), core.makeRng(1)), null);
});

test("每小时上限生效", () => {
  const cfg = makeCfg({ active: { maxPerHour: 2 } });
  const now = 10000000;
  const stamps = [now - 1000, now - 2000, now - 3000];
  const out = core.withinProactiveBudget(stamps, cfg, now);
  assert.strictEqual(out.allowed, false);
  assert.strictEqual(out.maxPerHour, 2);
});

// —— 提示词 ——

test("提示词包含人设与输出要求", () => {
  const cfg = makeCfg({ master: { uin: "200", alias: "主人" } });
  const prompt = core.buildSystemPrompt(cfg, {
    kind: "private",
    userId: "200",
    nickname: "小明",
    videoNotes: ["《某个视频》｜UP 某人｜讲了一只猫"],
    searchNotes: ["结果显示今天下雨"],
  });
  assert.ok(prompt.includes(cfg.persona.prompt), "没带上人设");
  assert.ok(prompt.includes("输出要求"), "没带输出要求");
  assert.ok(prompt.includes("某个视频"), "没带上视频笔记");
  assert.ok(prompt.includes("今天下雨"), "没带上搜索资料");
});

test("三种场景的提示词各不相同", () => {
  const cfg = makeCfg({ master: { uin: "200" } });
  const ctx = { userId: "200", nickname: "小明", groupId: "777", groupName: "测试群" };
  const a = core.buildSystemPrompt(cfg, Object.assign({ kind: "private" }, ctx));
  const b = core.buildSystemPrompt(cfg, Object.assign({ kind: "group" }, ctx));
  const c = core.buildSystemPrompt(cfg, Object.assign({ kind: "proactive" }, ctx));
  assert.notStrictEqual(a, b);
  assert.ok(c.length > 0);
});

// —— 搜索判定 ——

test("问到时效性内容时会搜", () => {
  const cfg = makeCfg({ search: { mode: "auto" } });
  assert.strictEqual(core.needSearch("现在几点了", cfg, () => 0.99), true);
  assert.strictEqual(core.needSearch("今天有什么新闻", cfg, () => 0.99), true);
});

test("关闭搜索时永远不搜", () => {
  const cfg = makeCfg({ search: { mode: "off" } });
  assert.strictEqual(core.needSearch("今天有什么新闻", cfg, () => 0), false);
});

test("always 模式每条都搜", () => {
  const cfg = makeCfg({ search: { mode: "always" } });
  assert.strictEqual(core.needSearch("嗯", cfg, () => 0.99), true);
});

// —— 语音判定 ——

test("关键词要求发语音", () => {
  const cfg = makeCfg({ voice: { mode: "auto", chance: 0 } });
  assert.strictEqual(core.shouldUseVoice("好的呀", cfg, "你发个语音", () => 0.99), true);
  assert.strictEqual(core.shouldUseVoice("好的呀", cfg, "随便聊聊", () => 0.99), false);
});

test("语音关闭时不发", () => {
  const cfg = makeCfg({ voice: { enabled: false } });
  assert.strictEqual(core.shouldUseVoice("好的呀", cfg, "你发个语音", () => 0), false);
});

// —— 指令解析 ——

test("解析指令", () => {
  assert.deepStrictEqual(core.parseCommand(".status"), { name: "status", args: [] });
  assert.deepStrictEqual(core.parseCommand(".say 你好 世界"), { name: "say", args: ["你好", "世界"] });
  assert.strictEqual(core.parseCommand("普通消息"), null);
  assert.strictEqual(core.parseCommand(""), null);
});

// —— 视频书架 ——

test("视频过期的判定", () => {
  const now = Date.now();
  const fresh = core.shelfAge({ at: now - 10 * 60 * 1000 }, 2, now);
  assert.strictEqual(fresh.expired, false);
  assert.ok(fresh.remainingMinutes > 100);

  const old = core.shelfAge({ at: now - 3 * 3600 * 1000 }, 2, now);
  assert.strictEqual(old.expired, true);
});

test("视频笔记摘要格式", () => {
  const notes = core.summarizeVideoNotes(
    [{ title: "标题甲", author: "UP甲", note: "讲了一件事" }, { title: "标题乙", author: "UP乙", note: "讲了另一件事" }],
    5,
  );
  assert.strictEqual(notes.length, 2);
  assert.ok(notes[0].includes("标题甲"));
  assert.ok(notes[0].includes("讲了一件事"));
});

test("视频笔记不重复标题和 UP 名", () => {
  // bilibili.describeVideo 的输出本身就是「《标题》，UP 主 xx，时长…」，
  // 直接拼进摘要会变成「《标题》｜UP xx｜《标题》，UP 主 xx，时长…」。
  const note = "《标题甲》，UP 主 UP甲，时长 3:21，播放 12 万";
  const notes = core.summarizeVideoNotes([{ title: "标题甲", author: "UP甲", note }], 3);
  assert.strictEqual((notes[0].match(/标题甲/g) || []).length, 1, "标题只应出现一次：" + notes[0]);
  assert.strictEqual((notes[0].match(/UP甲/g) || []).length, 1, "UP 名只应出现一次：" + notes[0]);
  assert.ok(notes[0].includes("时长 3:21"));
});

// —— TTS 文本处理 ——

test("朗读前洗掉 Markdown", () => {
  const out = sanitizeForSpeech("**加粗** `代码` [链接](https://x.com) https://y.com");
  assert.ok(!out.includes("*"));
  assert.ok(!out.includes("https://"));
  assert.ok(out.includes("加粗"));
  assert.ok(out.includes("链接"));
});

test("读音替换", () => {
  assert.strictEqual(applyLexicon("B站很好玩", { B站: "哔哩哔哩" }), "哔哩哔哩很好玩");
  assert.strictEqual(applyLexicon("没有要换的", {}), "没有要换的");
});

test("长文本切句不超过上限", () => {
  const text = "第一句。第二句！第三句？".repeat(10);
  const parts = splitSentences(text, 30);
  assert.ok(parts.length > 1);
  for (const row of parts) assert.ok(row.length <= 32, "切句太长：" + row.length);
});

test("file url 转对了", () => {
  const url = toFileUrl("C:\\Users\\x\\a.mp3");
  assert.strictEqual(url, "file:///C:/Users/x/a.mp3");
});

// —— 搜索解析 ——

test("XML 实体还原", () => {
  assert.strictEqual(decodeXml("a &amp; b &lt;c&gt; &#65;"), "a & b <c> A");
});

test("Bing RSS 解析出条目", () => {
  const xml = `<?xml version="1.0"?><rss><channel>
    <item><title>标题一</title><link>https://a.com/1</link><description>摘要一</description></item>
    <item><title>标题二</title><link>https://a.com/2</link><description>摘要二</description></item>
  </channel></rss>`;
  const rows = parseBingRss(xml, 5);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].title, "标题一");
  assert.strictEqual(rows[0].url, "https://a.com/1");
});

test("解析空 RSS 不炸", () => {
  assert.deepStrictEqual(parseBingRss("<rss></rss>", 5), []);
  assert.deepStrictEqual(parseBingRss("", 5), []);
});

// —— 人格预设 ——

test("预设完整且都能用", () => {
  const presets = require("../src/presets.cjs");
  const list = presets.presetList();
  assert.ok(list.length >= 4);
  for (const row of list) {
    assert.ok(row.id && row.name && row.prompt);
    assert.strictEqual(presets.findPreset(row.id).name, row.name);
  }
  assert.strictEqual(presets.findPreset("不存在的id"), null);
});

// —— 报告 ——

const total = passed + failures.length;
if (failures.length > 0) {
  for (const row of failures) {
    console.error("✗ " + row.name);
    console.error("  " + (row.error && row.error.message ? row.error.message : String(row.error)));
  }
  console.error("\n" + failures.length + " / " + total + " 个测试失败");
  process.exit(1);
}
console.log("✓ " + passed + " / " + total + " 个测试全部通过");
