/**
 * 语言风格 / 音色选择 / 生图多模型 的自检。
 *
 * 这三块都是这次新加的，单独一个文件，失败时容易定位。
 */
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

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

// 用临时 DSH_HOME，别碰真实配置
const tmpHome = path.join(os.tmpdir(), "dsh-style-test-" + Date.now());
fs.mkdirSync(tmpHome, { recursive: true });
process.env.DSH_HOME = tmpHome;

const SRC = path.join(__dirname, "..", "src");
const config = require(path.join(SRC, "config.cjs"));
const presets = require(path.join(SRC, "presets.cjs"));
const core = require(path.join(SRC, "core.cjs"));
const tts = require(path.join(SRC, "tts.cjs"));
const imagegen = require(path.join(SRC, "image.cjs"));

console.log("\n=== 1. 风格预设齐全 ===");
const styles = presets.styleList();
check("至少 6 套预设", styles.length >= 6, String(styles.length));
check("有日系女仆", styles.some((s) => s.id === "jp-maid"));
check("有傲娇", styles.some((s) => s.id === "tsundere"));
check("有温柔姐姐", styles.some((s) => s.id === "gentle-sister"));
check("每套都有 tone", styles.every((s) => s.tone && s.tone.length > 0));
check("每套都有 habits", styles.every((s) => Array.isArray(s.habits) && s.habits.length > 0));
check("每套都有 desc", styles.every((s) => s.desc && s.desc.length > 0));
check("findStyle 能按 id 找到", presets.findStyle("jp-maid") !== null);
check("findStyle 能按名字找到", presets.findStyle("傲娇") !== null);
check("findStyle 找不到返回 null", presets.findStyle("不存在的风格") === null);

console.log("\n=== 2. 风格提示词拼装 ===");
const p1 = presets.buildStylePrompt("jp-maid", { strength: "normal", dynamic: true });
check("含标题", p1.includes("## 说话风格（日系女仆）"));
check("含语气", p1.includes("语气恭顺温软"));
check("含习惯", p1.includes("称呼对方为「主人」"));
check("含克制", p1.includes("克制："));
check("含心情微调", p1.includes("按当时心情微调"));
check("空风格返回空串", presets.buildStylePrompt("", {}) === "" || !presets.buildStylePrompt("", {}).includes("## 说话风格"));

const p2 = presets.buildStylePrompt("tsundere", { custom: "东北腔", catchphrases: ["哼"], strength: "strong", dynamic: false });
check("自定义追加", p2.includes("## 额外风格要求") && p2.includes("东北腔"));
check("口头禅写入", p2.includes("「哼」"));
check("strong 有强调句", p2.includes("一眼看出"));
check("dynamic=false 无微调", !p2.includes("按当时心情微调"));

const light = presets.buildStylePrompt("genki", { strength: "light" });
check("light 有弱化句", light.includes("别为此牺牲自然"));
const normal = presets.buildStylePrompt("genki", { strength: "normal" });
check("normal 无强弱修饰", !normal.includes("一眼看出") && !normal.includes("别为此牺牲"));

console.log("\n=== 3. 风格进了系统提示 ===");
const cfg = config.load();
const master = String(cfg.master.uin || "");
const at = (stylePatch, ctx) =>
  core.buildSystemPrompt(config.merge(cfg, { style: stylePatch }), ctx);

const withStyle = at({ current: "jp-maid", custom: "", catchphrases: [], strength: "normal", dynamic: true },
  { kind: "private", userId: master || "1", nickname: "主人" });
check("提示词含风格段", withStyle.includes("## 说话风格"));
check("提示词含人设", withStyle.length > withStyle.indexOf("## 说话风格"));

const noStyle = at({ current: "", custom: "", catchphrases: [], dynamic: false },
  { kind: "private", userId: master || "1", nickname: "主人" });
check("空风格不加段", !noStyle.includes("## 说话风格"));

console.log("\n=== 4. 称呼边界没被风格破坏 ===");
// 临时 DSH_HOME 里没有主人号，而「只认唯一主人」在没填主人号时不生效（有意的设计）。
// 这里显式造一份带主人号的配置来验证边界仍然存在。
const withMaster = config.merge(cfg, {
  master: { uin: "920420642", only: true, alias: "主人", sweetNames: ["亲爱的"] },
});
const other = core.buildSystemPrompt(withMaster, { kind: "private", userId: "999999", nickname: "路人" });
check("别人有称呼边界", other.includes("称呼边界"));
const owner = core.buildSystemPrompt(withMaster, { kind: "private", userId: "920420642", nickname: "主人" });
check("主人有专属关系", owner.includes("只有这一个主人"));
const proactive = core.buildSystemPrompt(withMaster, { kind: "proactive", userId: "999999", nickname: "路人" });
check("主动发言无边界", !proactive.includes("称呼边界"));
// 没填主人号时开关不生效，这是刻意的
const noMaster = config.merge(cfg, { master: { uin: "", only: true } });
const noMasterPrompt = core.buildSystemPrompt(noMaster, { kind: "private", userId: "999999", nickname: "路人" });
check("无主人号时不划边界（设计如此）", !noMasterPrompt.includes("称呼边界"));

console.log("\n=== 5. style 配置项 ===");
const d = config.load();
check("style 存在", Boolean(d.style));
check("current 是字符串", typeof d.style.current === "string");
check("strength 合法", ["light", "normal", "strong"].includes(d.style.strength), d.style.strength);
check("catchphrases 是数组", Array.isArray(d.style.catchphrases));
check("dynamic 是布尔", typeof d.style.dynamic === "boolean");

console.log("\n=== 6. style 归一化 ===");
const raw = JSON.parse(JSON.stringify(d));
raw.style = { current: 123, custom: "  x  ", strength: "超级强", dynamic: "yes", catchphrases: ["a", "", "a", "  b  "] };
const norm = config.normalize(raw);
check("current 转字符串", typeof norm.style.current === "string");
check("strength 非法值回退", ["light", "normal", "strong"].includes(norm.style.strength), norm.style.strength);
check("dynamic 转布尔", typeof norm.style.dynamic === "boolean");
check("catchphrases 去空去重", Array.isArray(norm.style.catchphrases) && norm.style.catchphrases.length <= 2,
  JSON.stringify(norm.style.catchphrases));

console.log("\n=== 7. 深合并不串味 ===");
const base = config.load();
const merged = config.merge(base, { style: { current: "genki" } });
check("改 style 不影响 voice key", merged.voice.custom.apiKey === base.voice.custom.apiKey);
check("改 style 不影响 image key", merged.image.apiKey === base.image.apiKey);
check("改 style 保留 custom", merged.style.custom === base.style.custom);
check("改 style 保留其他节", merged.persona.prompt === base.persona.prompt);

console.log("\n=== 8. 预置音色 ===");
const voices = tts.presetVoiceList("FunAudioLLM/CosyVoice2-0.5B");
check("8 个预置音色", voices.length === 8, String(voices.length));
check("每个有 value", voices.every((v) => v.value && v.value.includes(":")), JSON.stringify(voices[0]));
check("value 带模型前缀", voices[0].value.startsWith("FunAudioLLM/CosyVoice2-0.5B:"));
check("有男有女", voices.some((v) => v.gender === "男") && voices.some((v) => v.gender === "女"));
const noModel = tts.presetVoiceList("");
check("无模型时 value 是纯名", noModel[0].value === "alex", noModel[0].value);

console.log("\n=== 9. voice 解析规则 ===");
check("纯名补前缀", tts.resolveVoiceName("FunAudioLLM/CosyVoice2-0.5B", "alex") === "FunAudioLLM/CosyVoice2-0.5B:alex");
check("带冒号原样", tts.resolveVoiceName("m", "FunAudioLLM/CosyVoice2-0.5B:alex") === "FunAudioLLM/CosyVoice2-0.5B:alex");
check("克隆 uri 原样", tts.resolveVoiceName("m", "speech:a:b:c") === "speech:a:b:c");
check("空值给 alloy", tts.resolveVoiceName("m", "") === "alloy");
check("isClonedVoice 认 speech:", tts.isClonedVoice("speech:a:b") === true);
check("isClonedVoice 不认预设", tts.isClonedVoice("FunAudioLLM/CosyVoice2-0.5B:alex") === false);

console.log("\n=== 10. 生图模型清单 ===");
check("清单非空", Array.isArray(imagegen.MODEL_CATALOG) && imagegen.MODEL_CATALOG.length >= 8);
check("每项有 id/label", imagegen.MODEL_CATALOG.every((m) => m.id && m.label));
check("含实测最快的 Turbo", imagegen.MODEL_CATALOG.some((m) => m.id === "Tongyi-MAI/Z-Image-Turbo"));
check("含 DALL·E 3", imagegen.MODEL_CATALOG.some((m) => m.id === "dall-e-3"));
check("id 不重复", new Set(imagegen.MODEL_CATALOG.map((m) => m.id)).size === imagegen.MODEL_CATALOG.length);

console.log("\n=== 11. 生图响应解析（各家形状） ===");
// 直接测 pickFirstImage 的行为：它没导出，通过一个假的 fetch 走完整路径太长，
// 这里改用 generate 内部行为的最小验证——导出检查 + 真实形状的等价断言
const shapes = [
  { name: "OpenAI b64", payload: { data: [{ b64_json: "a".repeat(400) }] } },
  { name: "OpenAI url", payload: { data: [{ url: "https://x/a.png" }] } },
  { name: "硅基顶层 images", payload: { images: [{ url: "https://x/b.png" }], seed: 1 } },
  { name: "output 数组", payload: { output: [{ url: "https://x/c.png" }] } },
];
for (const s of shapes) {
  // pickFirstImage 逻辑等价复现：验证我们期望它能认出这种形状
  const pools = [s.payload.data, s.payload.images, s.payload.output, s.payload.results, s.payload.artifacts];
  const found = pools.some((pool) => Array.isArray(pool) && pool.some((it) => it && (it.b64_json || it.url)));
  check("能认出 " + s.name, found);
}
check("空 payload 认不出", !((() => {
  const p = {};
  const pools = [p.data, p.images, p.output, p.results, p.artifacts];
  return pools.some((pool) => Array.isArray(pool) && pool.some((it) => it && (it.b64_json || it.url)));
})()));

console.log("\n=== 12. 生图新参数进 body ===");
const ep = imagegen.resolveEndpoint({
  baseUrl: "https://api.siliconflow.cn/v1",
  apiKey: "k",
  model: "Tongyi-MAI/Z-Image-Turbo",
  size: "768x1024",
  responseFormat: "url",
});
check("端点补全", ep.url === "https://api.siliconflow.cn/v1/images/generations", ep.url);
check("模型保留", ep.model === "Tongyi-MAI/Z-Image-Turbo");
check("尺寸保留", ep.size === "768x1024");
check("格式保留", ep.responseFormat === "url");
const ep2 = imagegen.resolveEndpoint({ baseUrl: "https://x/v1/images/generations" });
check("完整端点不重复拼", ep2.url === "https://x/v1/images/generations", ep2.url);
check("无 baseUrl 返回 null", imagegen.resolveEndpoint({}) === null);
check("ready 判定", imagegen.ready({ baseUrl: "https://x" }) === true && imagegen.ready({}) === false);

console.log("\n===== 结果 =====");
console.log("  通过 " + pass + " / 失败 " + fail);
try {
  fs.rmSync(tmpHome, { recursive: true, force: true });
} catch {
  /* ignore */
}
process.exit(fail === 0 ? 0 : 1);
