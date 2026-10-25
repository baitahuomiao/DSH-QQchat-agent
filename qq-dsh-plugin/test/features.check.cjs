/**
 * 新功能的离线验证：配置归一化、自由分段、只认主人、表情包、生图端点、周榜、语音音色。
 */
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const SRC = "E:/deepseek/qq-dsh-plugin/src";
const config = require(path.join(SRC, "config.cjs"));
const core = require(path.join(SRC, "core.cjs"));
const presets = require(path.join(SRC, "presets.cjs"));
const { StickerBook } = require(path.join(SRC, "sticker.cjs"));
const imagegen = require(path.join(SRC, "image.cjs"));
const bilibili = require(path.join(SRC, "bilibili.cjs"));

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log("  ok   " + name);
  } else {
    fail += 1;
    console.log("  FAIL " + name + (detail ? "  <- " + detail : ""));
  }
}

console.log("\n== 1. 配置归一化 ==");
const base = config.DEFAULTS;
check("DEFAULTS 有 master.only", base.master.only === false);
check("DEFAULTS 有 master.sweetNames", Array.isArray(base.master.sweetNames) && base.master.sweetNames.length > 0);
check("DEFAULTS 有 reply.freeChat", !!base.reply.freeChat && base.reply.freeChat.enabled === false);
check("DEFAULTS 有 voice.custom", !!base.voice.custom && base.voice.custom.apiKind === "openai");
check("DEFAULTS 有 sticker", !!base.sticker && base.sticker.enabled === true);
check("DEFAULTS 有 image", !!base.image && base.image.mode === "keyword");
check("DEFAULTS 有 persona.saved", Array.isArray(base.persona.saved));
check("DEFAULTS 有 bilibili.source", base.bilibili.source === "popular");

// 用临时 DSH_HOME，别碰真实配置
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "qqa-cfg-"));
process.env.DSH_HOME = tmpHome;
delete require.cache[require.resolve(path.join(SRC, "config.cjs"))];
const config2 = require(path.join(SRC, "config.cjs"));
check("DATA_DIR 跟随 DSH_HOME", config2.DATA_DIR.startsWith(tmpHome), config2.DATA_DIR);

// 脏数据要能被夹回合法范围
const merged = config2.merge(
  {
    master: { only: true },
    reply: { freeChat: { enabled: true, maxSegments: 999, softMaxChars: 1, minGapMs: 900, maxGapMs: 100, thinkingChance: 5 } },
    voice: { custom: { baseUrl: "  https://x.example/v1///  ", apiKind: "weird" } },
    sticker: { sendChance: 9 },
    image: { mode: "off", responseFormat: "nope" },
    bilibili: { source: "WEEKLY" },
  },
  {},
);
const norm = merged;
check("maxSegments 夹到 10", norm.reply.freeChat.maxSegments === 10, String(norm.reply.freeChat.maxSegments));
check("softMaxChars 夹到 20", norm.reply.freeChat.softMaxChars === 20, String(norm.reply.freeChat.softMaxChars));
check("maxGapMs >= minGapMs", norm.reply.freeChat.maxGapMs >= norm.reply.freeChat.minGapMs, norm.reply.freeChat.maxGapMs + " vs " + norm.reply.freeChat.minGapMs);
check("thinkingChance 夹到 1", norm.reply.freeChat.thinkingChance === 1, String(norm.reply.freeChat.thinkingChance));
check("voice baseUrl 去掉尾部斜杠", norm.voice.custom.baseUrl === "https://x.example/v1", norm.voice.custom.baseUrl);
check("apiKind 非法值回落 openai", norm.voice.custom.apiKind === "openai", norm.voice.custom.apiKind);
check("sendChance 夹到 1", norm.sticker.sendChance === 1, String(norm.sticker.sendChance));
check("image mode=off 保留", norm.image.mode === "off", norm.image.mode);
check("responseFormat 非法值回落 b64_json", norm.image.responseFormat === "b64_json", norm.image.responseFormat);
check("bilibili source 大小写归一", norm.bilibili.source === "weekly", norm.bilibili.source);

console.log("\n== 2. 自由聊天分段 ==");
const freeCfg = config2.merge({ reply: { freeChat: { enabled: true, maxSegments: 4, softMaxChars: 40 } } }, {});
const segs = core.splitFreeSegments("第一句。第二句！第三句？第四句。第五句。", freeCfg, () => 0.5);
check("分段是数组", Array.isArray(segs), typeof segs);
check("段数不超过上限", segs.length >= 1 && segs.length <= 4, String(segs.length));
check("每段非空", segs.every((s) => String(s).trim().length > 0), JSON.stringify(segs));
const segsOne = core.splitFreeSegments("嗯。", freeCfg, () => 0.5);
check("短文本也能出段", segsOne.length >= 1, JSON.stringify(segsOne));

console.log("\n== 3. 只认唯一主人（称呼边界，不是回复拦截） ==");
const masterCfg = config2.merge({ master: { uin: "920420642", alias: "主人", only: true, sweetNames: ["亲爱的", "老公"] } }, {});
const asMaster = core.buildSystemPrompt(masterCfg, { kind: "private", userId: "920420642", nickname: "白塔火苗" });
check("主人能看到主人称呼", /主人/.test(asMaster));
const asStranger = core.buildSystemPrompt(masterCfg, { kind: "private", userId: "123456", nickname: "路人" });
check("陌生人不能说主人", /不要叫 ta「主人」/.test(asStranger) || /称呼边界/.test(asStranger), asStranger.slice(0, 200));
check("陌生人也有正常对话提示词", asStranger.length > 200, String(asStranger.length));
const asGroupOther = core.buildSystemPrompt(masterCfg, { kind: "group", groupId: "1109502463", userId: "999", nickname: "群友" });
check("群里别人也守称呼边界", /称呼边界/.test(asGroupOther) || /不要叫 ta/.test(asGroupOther));
const asProactive = core.buildSystemPrompt(masterCfg, { kind: "proactive", userId: "123456", nickname: "路人" });
check("主动搭话场景不塞称呼边界", !/称呼边界/.test(asProactive), asProactive.slice(0, 160));
const sweetCheck = config2.merge({ master: { uin: "1", sweetNames: ["亲爱的", "  ", "亲爱的", "老公"] } }, {});
check("sweetNames 去空去重", sweetCheck.master.sweetNames.length === 2, JSON.stringify(sweetCheck.master.sweetNames));

console.log("\n== 4. 表情包仓库 ==");
const sdir = fs.mkdtempSync(path.join(os.tmpdir(), "qqa-sticker-"));
const book = new StickerBook({ dir: sdir, logger: { warn() {} } });
const fakePng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQ0AAB6nAgHkKkPqAAAAAElFTkSuQmCC",
  "base64",
);
const added = book.add({ data: fakePng, mediaType: "image/png", tags: ["鲸鱼"] });
check("存入一张", Boolean(added && added.id), JSON.stringify(added));
check("落盘文件存在", fs.existsSync(path.join(sdir, "stickers", added.file)), path.join("stickers", added.file));
const dup = book.add({ data: fakePng, mediaType: "image/png", tags: ["重复"] });
check("重复内容不入库", dup === null && book.size() === 1, String(book.size()));
const fakePng2 = Buffer.from(fakePng);
fakePng2[fakePng2.length - 5] = 0x00;
const added2 = book.add({ data: fakePng2, mediaType: "image/png", tags: ["猫猫"] });
check("第二张入库", book.size() === 2, String(book.size()));
const picked = book.pick({ tags: ["鲸鱼"] }, () => 0.5);
check("按标签能挑到", Boolean(picked && picked.id), JSON.stringify(picked));
const after = book.list().find((it) => it.id === picked.id);
check("挑完 usedCount 增加", after && after.usedCount >= 1, String(after && after.usedCount));
const book2 = new StickerBook({ dir: sdir, logger: { warn() {} } });
check("重启后索引还在", book2.size() === 2, String(book2.size()));
book2.remove(added.id);
check("删除生效", book2.size() === 1, String(book2.size()));
const evil = new StickerBook({ dir: sdir, logger: { warn() {} } });
evil.items.push({ id: "x", file: "../../evil.png", tags: [], usedAt: 0, addedAt: 0 });
check("非法 file 名被过滤", evil.list().every((it) => !/[\\/]/.test(it.file)));

console.log("\n== 5. 生图端点 ==");
check("未配 baseUrl 时不 ready", imagegen.ready({ baseUrl: "" }) === false);
check("配了 baseUrl 就 ready", imagegen.ready({ baseUrl: "https://api.openai.com/v1" }) === true);
const ep = imagegen.resolveEndpoint({ baseUrl: "https://api.openai.com/v1", model: "", size: "" });
check("端点拼成 /images/generations", ep.url === "https://api.openai.com/v1/images/generations", ep.url);
check("model 有默认值", ep.model === "dall-e-3", ep.model);
const ep2 = imagegen.resolveEndpoint({ baseUrl: "https://gw.example/v1/images/generations" });
check("已是完整端点不重复拼", ep2.url === "https://gw.example/v1/images/generations", ep2.url);
check("quoteReply 默认开", config2.DEFAULTS.image.quoteReply === true);

console.log("\n== 5b. 图片引用回复（OneBot 消息段） ==");
const { OneBotClient, checkSendResult } = require(path.join(SRC, "onebot.cjs"));

function buildMessage(quoteOption) {
  // 复刻 sendSegments 里那段「插 reply 段」的逻辑，单独验拼装结果
  const list = [{ type: "image", data: { file: "file:///tmp/a.png" } }];
  const quoteId = quoteOption && quoteOption.replyTo != null ? String(quoteOption.replyTo).trim() : "";
  if (quoteId && quoteId !== "0") list.unshift({ type: "reply", data: { id: quoteId } });
  return list;
}

const withQuote = buildMessage({ replyTo: "123456" });
check("引用段在最前面", withQuote[0].type === "reply", JSON.stringify(withQuote[0]));
check("引用 id 正确", String(withQuote[0].data.id) === "123456", String(withQuote[0].data.id));
check("图片段紧随其后", withQuote[1].type === "image");
check("共两段", withQuote.length === 2, String(withQuote.length));

const noQuote = buildMessage(undefined);
check("不传 replyTo 时不加引用段", noQuote.length === 1 && noQuote[0].type === "image", JSON.stringify(noQuote));
const zeroQuote = buildMessage({ replyTo: 0 });
check("replyTo=0 时不加引用段", zeroQuote.length === 1, JSON.stringify(zeroQuote));

// NapCat 失败不抛 HTTP 错误，只回 status=failed —— 必须自己识别
const failResult = checkSendResult({ status: "failed", retcode: 1200, data: null, message: "rich media transfer failed" });
check("status=failed 判为失败", failResult.ok === false, JSON.stringify(failResult));
check("错误里带 retcode", /retcode=1200/.test(failResult.error || ""), String(failResult.error));
check("错误里带原因", /rich media transfer failed/.test(failResult.error || ""), String(failResult.error));

const failRetcode = checkSendResult({ status: "ok", retcode: 100, message: "bad" });
check("retcode!=0 判为失败", failRetcode.ok === false, JSON.stringify(failRetcode));

const okResult = checkSendResult({ status: "ok", retcode: 0, data: { message_id: 1 } });
check("retcode=0 判为成功", okResult.ok === true, JSON.stringify(okResult));

const emptyResult = checkSendResult(null);
check("空返回判为失败", emptyResult.ok === false, JSON.stringify(emptyResult));

function sendWithReply(reply, quoteOption, target) {
  const client = new OneBotClient({ wsUrl: "ws://127.0.0.1:1" });
  let captured = null;
  client.call = (action, params) => { captured = { action, params }; return Promise.resolve(reply); };
  return client
    .sendSegments(target || { kind: "private", userId: "1" }, [{ type: "image", data: { file: "x" } }], quoteOption)
    .then(() => ({ ok: true, captured }))
    .catch((error) => ({ ok: false, error: error.message, captured }));
}

console.log("\n== 6. 语音：音色与深合并 ==");
const tts = require(path.join(SRC, "tts.cjs"));
check("导出 cloneVoice", typeof tts.cloneVoice === "function");
check("导出 listVoices", typeof tts.listVoices === "function");
check("导出 deleteVoice", typeof tts.deleteVoice === "function");
check("导出 resolveVoiceName", typeof tts.resolveVoiceName === "function");
check("音色默认 fallback 开", config2.DEFAULTS.voice.custom.fallback === true);
check("音色默认 timeout 合理", config2.DEFAULTS.voice.custom.timeoutMs >= 10000);

// 硅基流动的 voice 命名规则
const VN = tts.resolveVoiceName;
check("纯名字补模型前缀", VN("FunAudioLLM/CosyVoice2-0.5B", "alex") === "FunAudioLLM/CosyVoice2-0.5B:alex", VN("FunAudioLLM/CosyVoice2-0.5B", "alex"));
check("已带前缀原样返回", VN("FunAudioLLM/CosyVoice2-0.5B", "FunAudioLLM/CosyVoice2-0.5B:alex") === "FunAudioLLM/CosyVoice2-0.5B:alex");
check("克隆 uri 原样返回", VN("FunAudioLLM/CosyVoice2-0.5B", "speech:a:b:c") === "speech:a:b:c", VN("m", "speech:a:b:c"));
check("无模型前缀时不硬拼", VN("tts-1", "alex") === "alex", VN("tts-1", "alex"));
check("空音色给默认值", VN("m", "") === "alloy");

// 深合并：这是真出过事的 —— 写二级字段时把 apiKey 冲掉了
const mergeBase = { voice: { custom: { apiKey: "sk-SECRET", baseUrl: "u", voice: "v1", cloned: { uri: "U1", name: "N1", refText: "R1" } } } };
const mergedDeep = config2.merge(mergeBase, { voice: { custom: { voice: "v2", cloned: { name: "N2" } } } });
check("深合并保留 apiKey", mergedDeep.voice.custom.apiKey === "sk-SECRET", String(mergedDeep.voice.custom.apiKey));
check("深合并保留 baseUrl", mergedDeep.voice.custom.baseUrl === "u");
check("深合并更新 voice", mergedDeep.voice.custom.voice === "v2");
check("深合并保留 cloned.uri", mergedDeep.voice.custom.cloned.uri === "U1", String(mergedDeep.voice.custom.cloned.uri));
check("深合并保留 cloned.refText", mergedDeep.voice.custom.cloned.refText === "R1");
check("深合并更新 cloned.name", mergedDeep.voice.custom.cloned.name === "N2");
const srcPatch = { voice: { custom: { cloned: { name: "X" } } } };
config2.merge({ voice: { custom: { cloned: { uri: "K" } } } }, srcPatch);
check("深合并不污染 patch 源对象", JSON.stringify(srcPatch) === '{"voice":{"custom":{"cloned":{"name":"X"}}}}', JSON.stringify(srcPatch));

console.log("\n== 7. B 站数据源函数 ==");
check("导出了 weekly", typeof bilibili.weekly === "function");
check("导出了 weeklyLatest", typeof bilibili.weeklyLatest === "function");
check("导出了 weeklySeries", typeof bilibili.weeklySeries === "function");
check("导出了 homepage", typeof bilibili.homepage === "function");
check("browse 接受 source=weekly", typeof bilibili.browse === "function");

console.log("\n== 8. 人设 ==");
const list = presets.presetList();
const dsWhale = list.find((p) => p.id === "deepseek-whale");
check("有 deepseek-whale 预设", !!dsWhale, JSON.stringify(list.map((p) => p.id)));
check("名字含鲸鱼娘", dsWhale && /鲸鱼娘/.test(dsWhale.name), dsWhale && dsWhale.name);
check("提示词非空且够长", dsWhale && dsWhale.prompt.length > 100, dsWhale && String(dsWhale.prompt.length));
check("按名字也能找到", !!presets.findPreset("DeepSeek 鲸鱼娘"));
check("老预设 whale 还在", !!list.find((p) => p.id === "whale"));

console.log("\n== 9. 提示词 ==");
const sysFree = core.buildSystemPrompt(freeCfg, { kind: "private", userId: "111", nickname: "阿" });
check("自由模式提示词提到自由", /自由聊天模式/.test(sysFree));
const sysStrict = core.buildSystemPrompt(config2.merge({ reply: { freeChat: { enabled: false } } }, {}), { kind: "private", userId: "111", nickname: "阿" });
check("非自由模式用老提示词", !/自由聊天模式/.test(sysStrict));
const sysSticker = core.buildSystemPrompt(freeCfg, { kind: "private", userId: "111", nickname: "阿", stickerCount: 5 });
check("有表情包时提示可用", /你的表情包/.test(sysSticker));
const sysDraw = core.buildSystemPrompt(freeCfg, { kind: "private", userId: "111", nickname: "阿", canDraw: true });
check("能画图时提示 [画:...]", /\[画:/.test(sysDraw));

console.log("\n== 10. 意愿判定 ==");
const imgCfg = config2.merge({ image: { enabled: true, mode: "keyword", keywords: ["画一个"] } }, {});
check("wantsImage 命中关键词", core.wantsImage("帮我画一个鲸鱼", imgCfg) === true);
check("wantsImage 未启用则 false", core.wantsImage("帮我画一个鲸鱼", config2.merge({ image: { enabled: false } }, {})) === false);
check("shouldSendSticker 概率 0 时不发", core.shouldSendSticker(config2.merge({ sticker: { sendChance: 0 } }, {}), () => 0.5) === false);
check("shouldSendSticker 概率 1 时发", core.shouldSendSticker(config2.merge({ sticker: { sendChance: 1 } }, {}), () => 0.5) === true);

console.log("\n== 11. 自由停顿 ==");
const gapCfg = config2.merge({ reply: { freeChat: { enabled: true, minGapMs: 200, maxGapMs: 400, thinkingChance: 0 } } }, {});
const g1 = core.freeChatGap(gapCfg, 1, () => 0.5);
check("停顿在范围内", g1 >= 200 && g1 <= 400, String(g1));
const thinkCfg = config2.merge({ reply: { freeChat: { enabled: true, minGapMs: 100, maxGapMs: 100, thinkingChance: 1, thinkingMinMs: 1000, thinkingMaxMs: 1000 } } }, {});
const g2 = core.freeChatGap(thinkCfg, 0, () => 0.5);
check("第一条可触发思考停顿", g2 >= 1000, String(g2));

// —— 异步收尾：真实 sendSegments 的成功/失败路径 ——
(async () => {
  console.log("\n== 12. sendSegments 端到端（mock 传输层） ==");
  const okRun = await sendWithReply({ status: "ok", retcode: 0, data: { message_id: 7 } }, { replyTo: "42" });
  check("成功路径不抛错", okRun.ok === true, JSON.stringify(okRun.error));
  check("确实带上了引用段", okRun.captured.params.message[0].type === "reply", JSON.stringify(okRun.captured.params.message[0]));

  const failRun = await sendWithReply({ status: "failed", retcode: 1200, message: "rich media transfer failed" }, undefined);
  check("失败路径会 reject", failRun.ok === false, JSON.stringify(failRun));
  check("失败错误可读", /retcode=1200/.test(failRun.error || ""), String(failRun.error));

  const groupRun = await sendWithReply({ status: "ok", retcode: 0 }, { replyTo: "9" }, { kind: "group", groupId: "1109502463" });
  check("群聊走 send_group_msg", groupRun.captured.action === "send_group_msg", groupRun.captured.action);

  const textRun = await (() => {
    const client = new OneBotClient({ wsUrl: "ws://127.0.0.1:1" });
    let captured = null;
    client.call = (action, params) => { captured = { action, params }; return Promise.resolve({ status: "ok", retcode: 0 }); };
    return client.sendText({ kind: "private", userId: "1" }, "画不出来", { replyTo: "55" }).then(() => captured);
  })();
  check("sendText 也能引用", textRun.params.message[0].type === "reply" && textRun.params.message[1].type === "text");

  console.log("\n===== 结果 =====");
  console.log("  通过 " + pass + " / 失败 " + fail);
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(sdir, { recursive: true, force: true }); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
