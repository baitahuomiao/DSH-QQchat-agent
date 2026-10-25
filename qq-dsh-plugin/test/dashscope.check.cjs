/**
 * 阿里百炼（DashScope）语音适配的自检。
 *
 * 百炼的协议和 OpenAI 那套完全不同：
 *  - 合成走 multimodal-generation，返回 JSON 含 OSS url 或 base64
 *  - 复刻走 customization + input.action
 *  - 音色名不加模型前缀，且绑定 target_model
 * 这些形状一旦写错，线上只会表现成「语音不出声」，所以这里把请求体钉死。
 */
"use strict";

const path = require("node:path");

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

const tts = require(path.join(__dirname, "..", "src", "tts.cjs"));
const config = require(path.join(__dirname, "..", "src", "config.cjs"));

// —— mock fetch，把请求体拦下来检查 ——
const calls = [];
const realFetch = globalThis.fetch;
let handler = null;
globalThis.fetch = async (url, init) => {
  let body = null;
  try {
    body = init && typeof init.body === "string" ? JSON.parse(init.body) : null;
  } catch {
    body = null;
  }
  calls.push({ url: String(url), body, headers: (init && init.headers) || {} });
  if (!handler) throw new Error("mock 没有设置 handler");
  return handler(String(url), init);
};

const CUSTOM = {
  apiKind: "dashscope",
  baseUrl: "https://dashscope.aliyuncs.com",
  apiKey: "sk-test-key",
  model: "qwen3-tts-flash",
  voice: "Cherry",
  timeoutMs: 20000,
};

const fakeAudio = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(2048, 1)]);

function jsonResponse(obj) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(obj),
    arrayBuffer: async () => fakeAudio.buffer.slice(fakeAudio.byteOffset, fakeAudio.byteOffset + fakeAudio.byteLength),
  };
}

(async () => {
  console.log("\n=== 1. 接口识别与地址归一 ===");
  check("dashscope 被识别", tts.isDashScope({ apiKind: "dashscope" }) === true);
  check("bailian 别名", tts.isDashScope({ apiKind: "bailian" }) === true);
  check("aliyun 别名", tts.isDashScope({ apiKind: "aliyun" }) === true);
  check("openai 不误判", tts.isDashScope({ apiKind: "openai" }) === false);
  check("空值不误判", tts.isDashScope({}) === false);

  check("剥掉 /api/v1", tts.dashscopeRoot("https://dashscope.aliyuncs.com/api/v1") === "https://dashscope.aliyuncs.com");
  check("剥掉 compatible-mode", tts.dashscopeRoot("https://dashscope.aliyuncs.com/compatible-mode/v1") === "https://dashscope.aliyuncs.com");
  check("业务空间域名保留", tts.dashscopeRoot("https://llm-x.cn-beijing.maas.aliyuncs.com") === "https://llm-x.cn-beijing.maas.aliyuncs.com");
  check("业务空间域名剥路径", tts.dashscopeRoot("https://llm-x.cn-beijing.maas.aliyuncs.com/api/v1") === "https://llm-x.cn-beijing.maas.aliyuncs.com");
  check("剥到具体接口", tts.dashscopeRoot("https://a.com/api/v1/services/aigc/multimodal-generation/generation") === "https://a.com");

  console.log("\n=== 2. 语种映射 ===");
  check("zh", tts.dashscopeLanguage("zh") === "Chinese");
  check("ja", tts.dashscopeLanguage("ja") === "Japanese");
  check("日语", tts.dashscopeLanguage("日语") === "Japanese");
  check("en", tts.dashscopeLanguage("en") === "English");
  check("未知回退 Auto", tts.dashscopeLanguage("klingon") === "Auto");

  console.log("\n=== 3. 音色命名 ===");
  check("百炼不加前缀", tts.resolveVoiceName("qwen3-tts-flash", "Cherry", "dashscope") === "Cherry");
  check("克隆 id 原样", tts.resolveVoiceName("m", "qwen3-tts-flash-whale-x", "dashscope") === "qwen3-tts-flash-whale-x");
  const dsVoices = tts.presetVoiceList("qwen3-tts-flash", "dashscope");
  check("百炼音色表非空", dsVoices.length === 8, String(dsVoices.length));
  check("value 是纯名", dsVoices.every((v) => !v.value.includes(":")), JSON.stringify(dsVoices[0]));
  check("含 Cherry", dsVoices.some((v) => v.id === "Cherry"));
  check("有男有女", dsVoices.some((v) => v.gender === "男") && dsVoices.some((v) => v.gender === "女"));
  const sfVoices = tts.presetVoiceList("FunAudioLLM/CosyVoice2-0.5B", "openai");
  check("硅基仍带前缀", sfVoices[0].value.includes(":"), sfVoices[0].value);

  console.log("\n=== 4. 合成请求体 ===");
  calls.length = 0;
  handler = async () => jsonResponse({ status_code: 200, output: { audio: { data: fakeAudio.toString("base64") } } });
  try {
    const bytes = await tts.synthesizeDashScope("主人，你好。", { custom: CUSTOM, model: "qwen3-tts-flash", lang: "zh" });
    check("返回音频", bytes.length > 1000, String(bytes.length));
  } catch (error) {
    check("返回音频", false, error.message);
  }
  const c1 = calls[0] || { body: { input: {} }, headers: {}, url: "" };
  // 复刻音色只能走 SpeechSynthesizer，multimodal 会返回 url error
  check("URL 是 SpeechSynthesizer", c1.url === "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer", c1.url);
  check("model 透传", c1.body.model === "qwen3-tts-flash", c1.body.model);
  check("text 透传", c1.body.input.text === "主人，你好。", c1.body.input.text);
  check("voice 无前缀", c1.body.input.voice === "Cherry", c1.body.input.voice);
  check("language_type", c1.body.input.language_type === "Chinese", c1.body.input.language_type);
  check("format 默认 mp3", c1.body.input.format === "mp3", c1.body.input.format);
  check("Bearer 鉴权", String(c1.headers.authorization) === "Bearer sk-test-key", String(c1.headers.authorization));

  console.log("\n=== 4b. useMultimodal 开关 ===");
  calls.length = 0;
  handler = async () => jsonResponse({ status_code: 200, output: { audio: { data: fakeAudio.toString("base64") } } });
  try {
    await tts.synthesizeDashScope("测试", { custom: { ...CUSTOM, useMultimodal: true }, model: "qwen3-tts-flash" });
    check(
      "useMultimodal=true 走 multimodal",
      calls[0].url === "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
      calls[0].url,
    );
  } catch (error) {
    check("useMultimodal=true 走 multimodal", false, error.message);
  }

  console.log("\n=== 5. url 形式返回会去下载 ===");
  calls.length = 0;
  let downloaded = false;
  handler = async (url) => {
    if (url.includes("SpeechSynthesizer")) {
      return jsonResponse({ status_code: 200, output: { audio: { url: "https://oss.example/a.wav" } } });
    }
    downloaded = true;
    return jsonResponse({});
  };
  try {
    const bytes = await tts.synthesizeDashScope("测试", { custom: CUSTOM, model: "qwen3-tts-flash" });
    check("跟随 url 下载", downloaded && bytes.length > 1000, String(bytes.length));
  } catch (error) {
    check("跟随 url 下载", false, error.message);
  }

  console.log("\n=== 6. 业务错误不能当成功 ===");
  calls.length = 0;
  handler = async () => jsonResponse({ code: "InvalidParameter", message: "voice 不合法" });
  try {
    await tts.synthesizeDashScope("x", { custom: CUSTOM, model: "m" });
    check("code 非空抛错", false, "没有抛");
  } catch (error) {
    check("code 非空抛错", error.message.includes("InvalidParameter"), error.message);
  }

  calls.length = 0;
  handler = async () => jsonResponse({ status_code: 400, message: "参数错误" });
  try {
    await tts.synthesizeDashScope("x", { custom: CUSTOM, model: "m" });
    check("status_code 非 200 抛错", false, "没有抛");
  } catch (error) {
    check("status_code 非 200 抛错", error.message.includes("400"), error.message);
  }

  calls.length = 0;
  handler = async () => jsonResponse({ status_code: 200, output: {} });
  try {
    await tts.synthesizeDashScope("x", { custom: CUSTOM, model: "m" });
    check("没有 audio 抛错", false, "没有抛");
  } catch (error) {
    check("没有 audio 抛错", error.message.includes("没有返回音频"), error.message);
  }

  console.log("\n=== 7. 复刻请求体 ===");
  calls.length = 0;
  handler = async () => jsonResponse({ output: { voice_id: "qwen3-tts-flash-whale-abc" } });
  try {
    const r = await tts.cloneVoiceDashScope(fakeAudio, {
      custom: CUSTOM, model: "qwen3-tts-flash", name: "whale", language: "ja", mediaType: "audio/mpeg",
    });
    check("返回 voice_id", r.uri === "qwen3-tts-flash-whale-abc", r.uri);
    check("返回 name", r.name === "whale", r.name);
  } catch (error) {
    check("返回 voice_id", false, error.message);
  }
  const c7 = calls[0] || { body: { input: {} }, url: "" };
  check("URL 是 customization", c7.url === "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization", c7.url);
  check("model 固定 voice-enrollment", c7.body.model === "voice-enrollment", c7.body.model);
  check("action=create_voice", c7.body.input.action === "create_voice", c7.body.input.action);
  check("target_model 透传", c7.body.input.target_model === "qwen3-tts-flash", c7.body.input.target_model);
  check("prefix 合法", /^[A-Za-z0-9]{1,10}$/.test(c7.body.input.prefix), c7.body.input.prefix);
  check("audio 是 data URI", String(c7.body.input.audio).startsWith("data:audio/mpeg;base64,"));
  check("language_hints", JSON.stringify(c7.body.input.language_hints) === '["ja"]', JSON.stringify(c7.body.input.language_hints));

  console.log("\n=== 8. prefix 清洗 ===");
  calls.length = 0;
  handler = async () => jsonResponse({ output: { voice_id: "x" } });
  await tts.cloneVoiceDashScope(fakeAudio, { custom: CUSTOM, model: "m", name: "鲸鱼-娘_test_abcdefghij" });
  const prefix = (calls[0] && calls[0].body.input.prefix) || "";
  check("只剩字母数字", /^[A-Za-z0-9]+$/.test(prefix), prefix);
  check("不超过 10 字符", prefix.length <= 10, String(prefix.length));

  console.log("\n=== 9. 列表与删除 ===");
  calls.length = 0;
  handler = async () => jsonResponse({ output: { voice_list: [{ voice_id: "a-1", status: "OK", gmt_create: "2026-01-01" }] } });
  const list = await tts.listVoicesDashScope({ custom: CUSTOM });
  check("列表长度", list.length === 1, String(list.length));
  check("uri 取 voice_id", list[0].uri === "a-1", list[0].uri);
  check("action=list_voice", calls[0].body.input.action === "list_voice", calls[0].body.input.action);

  calls.length = 0;
  handler = async () => jsonResponse({ output: {} });
  await tts.deleteVoiceDashScope("a-1", { custom: CUSTOM });
  check("action=delete_voice", calls[0].body.input.action === "delete_voice", calls[0].body.input.action);
  check("voice_id 透传", calls[0].body.input.voice_id === "a-1", calls[0].body.input.voice_id);

  console.log("\n=== 10. 配置与错误处理 ===");
  const norm = config.normalize({ voice: { custom: { apiKind: "dashscope" } } });
  check("apiKind 收 dashscope", norm.voice.custom.apiKind === "dashscope", norm.voice.custom.apiKind);
  const bad = config.normalize({ voice: { custom: { apiKind: "乱写" } } });
  check("非法 apiKind 回退 openai", bad.voice.custom.apiKind === "openai", bad.voice.custom.apiKind);

  try {
    await tts.synthesizeDashScope("x", { custom: { apiKind: "dashscope", baseUrl: "https://x.com" }, model: "m" });
    check("缺 key 抛错", false, "没有抛");
  } catch (error) {
    check("缺 key 抛错", error.message.includes("API Key"), error.message);
  }
  // opts.model 为空时会回退到 custom.model，这是有意的；两边都空才该报错
  calls.length = 0;
  handler = async () => jsonResponse({ status_code: 200, output: { audio: { data: fakeAudio.toString("base64") } } });
  try {
    await tts.synthesizeDashScope("x", { custom: CUSTOM, model: "" });
    check("model 空时回退 custom.model", calls[0] && calls[0].body.model === "qwen3-tts-flash", calls[0] && calls[0].body.model);
  } catch (error) {
    check("model 空时回退 custom.model", false, error.message);
  }

  try {
    await tts.synthesizeDashScope("x", { custom: { ...CUSTOM, model: "" }, model: "" });
    check("缺 model 抛错", false, "没有抛");
  } catch (error) {
    check("缺 model 抛错", error.message.includes("模型"), error.message);
  }

  console.log("\n=== 11. 线上实测过的酒狐配置能复现 ===");
  // 这条音色是 2026-10-24 用 E:\素材\10月24日\酒狐.mp3 真实克隆出来的，
  // target_model=qwen-audio-3.1-tts-flash。端点写错时百炼返回 url error，
  // 所以这里把「模型名 + 复刻音色 + 端点」三者的对应关系钉死。
  calls.length = 0;
  handler = async () => jsonResponse({ status_code: 200, output: { audio: { url: "https://oss.example/j.mp3" } } });
  const JIUHU = {
    apiKind: "dashscope",
    baseUrl: "https://dashscope.aliyuncs.com",
    apiKey: "sk-test-key",
    model: "qwen-audio-3.1-tts-flash",
    voice: "qwen-audio-3.1-tts-flash-jiuhu-1d96d11ddb67444c8d41366f4ffe94ac",
    format: "mp3",
    timeoutMs: 60000,
  };
  try {
    const bytes = await tts.synthesizeDashScope("主人，我是酒狐。", { custom: JIUHU, model: JIUHU.model, lang: "zh" });
    check("酒狐音色能合成", bytes.length > 1000, String(bytes.length));
  } catch (error) {
    check("酒狐音色能合成", false, error.message);
  }
  const cj = calls[0] || { body: { input: {} }, url: "" };
  check("走 SpeechSynthesizer", cj.url.endsWith("/audio/tts/SpeechSynthesizer"), cj.url);
  check("voice_id 原样传", cj.body.input.voice === JIUHU.voice, cj.body.input.voice);
  check("输出 mp3", cj.body.input.format === "mp3", cj.body.input.format);
  check("采样率 24000", cj.body.input.sample_rate === 24000, String(cj.body.input.sample_rate));

  // 复刻音色的 id 必须带 target_model 前缀，跨模型复用会失败
  check("音色 id 带模型前缀", JIUHU.voice.startsWith(JIUHU.model + "-"), JIUHU.voice);
  check("isClonedVoice 认它", tts.isClonedVoice(JIUHU.voice) === true);

  console.log("\n=== 12. 从 voice_id 反解模型和名字 ===");
  // voice_id 形如 {target_model}-{prefix}-{16位以上hex}，面板要靠它显示可读名字
  check("解析 model", tts.dashscopeVoiceModel(JIUHU.voice) === "qwen-audio-3.1-tts-flash", tts.dashscopeVoiceModel(JIUHU.voice));
  check("解析 prefix", tts.dashscopeVoicePrefix(JIUHU.voice) === "jiuhu", tts.dashscopeVoicePrefix(JIUHU.voice));
  const cosy = "cosyvoice-v3.5-plus-bailian-5623167c12cc450aa89f7ae965f02ccb";
  check("解析 cosyvoice 模型", tts.dashscopeVoiceModel(cosy) === "cosyvoice-v3.5-plus", tts.dashscopeVoiceModel(cosy));
  check("解析 cosyvoice prefix", tts.dashscopeVoicePrefix(cosy) === "bailian", tts.dashscopeVoicePrefix(cosy));
  check("乱写不崩", tts.dashscopeVoicePrefix("abc") === "" && tts.dashscopeVoiceModel("abc") === "");

  // 列表返回的 name 必须是可读的，不能是一串哈希
  calls.length = 0;
  handler = async () =>
    jsonResponse({
      output: { voice_list: [{ voice_id: JIUHU.voice, status: "OK", gmt_create: "2026-10-24" }] },
    });
  const liveList = await tts.listVoicesDashScope({ custom: JIUHU });
  check("列表 name 是 jiuhu", liveList[0].name === "jiuhu", liveList[0].name);
  check("列表 model 可读", liveList[0].model === "qwen-audio-3.1-tts-flash", liveList[0].model);

  console.log("\n=== 13. voice 被清空时自动回落到克隆音色 ===");
  // 面板曾把 voice 写空过，导致建好的音色「消失」。这里保证：
  // voice 空 + cloned.uri 有值 → 合成时自动用 cloned.uri
  const withoutVoice = { ...JIUHU, voice: "", cloned: { uri: JIUHU.voice, name: "酒狐" } };
  const eff = tts.resolveEffectiveVoice(withoutVoice);
  check("空 voice 回落 cloned.uri", eff.voice === JIUHU.voice, eff.voice);
  check("不修改原对象", withoutVoice.voice === "", withoutVoice.voice);

  const keep = { ...JIUHU, cloned: { uri: "other-voice-id" } };
  check("voice 有值时不覆盖", tts.resolveEffectiveVoice(keep).voice === JIUHU.voice, tts.resolveEffectiveVoice(keep).voice);
  check("都没有时保持空", tts.resolveEffectiveVoice({ voice: "", cloned: {} }).voice === "");

  calls.length = 0;
  handler = async () => jsonResponse({ status_code: 200, output: { audio: { url: "https://oss.example/k.mp3" } } });
  try {
    await tts.synthesizeCustom("主人，我是酒狐。", { custom: withoutVoice, model: JIUHU.model, lang: "zh" });
    check("空 voice 仍能合成", (calls[0] && calls[0].body.input.voice) === JIUHU.voice, calls[0] && calls[0].body.input.voice);
  } catch (error) {
    check("空 voice 仍能合成", false, error.message);
  }

  globalThis.fetch = realFetch;
  console.log("\n===== 结果 =====");
  console.log("  通过 " + pass + " / 失败 " + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
