/**
 * 契约自检：客户端面板读的字段/调的接口，宿主是否真的提供。
 * 这类错配不会报错，只会让面板显示空白或按钮点了没反应，所以单独查一遍。
 *
 * 用法：node test/contract.check.mjs
 */
import fs from "node:fs";

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? "  ✓ " : "  ✗ ") + name + (detail ? "  " + detail : ""));
  if (!ok) failures += 1;
}

const ui = fs.readFileSync(new URL("../src/ui.js", import.meta.url), "utf8");
const idx = fs.readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
const engine = fs.readFileSync(new URL("../src/engine.cjs", import.meta.url), "utf8");
const config = fs.readFileSync(new URL("../src/config.cjs", import.meta.url), "utf8");

// —— 1. 面板发的 action 都要在宿主 switch 里有 case ——
const caseNames = [...idx.matchAll(/case "([a-zA-Z]+)":/g)].map((m) => m[1]);
const uiActions = [...new Set([...ui.matchAll(/act\("([a-zA-Z]+)"/g)].map((m) => m[1]))];
console.log("\n=== 1. 面板动作 vs 宿主 switch ===");
console.log("  宿主支持:", caseNames.length, "个");
console.log("  面板调用:", uiActions.length, "个 —", uiActions.join(","));
const missingAction = uiActions.filter((a) => !caseNames.includes(a));
check("面板调的动作都有实现", missingAction.length === 0, missingAction.join(",") || "(无缺口)");

// —— 2. 面板读的 state 字段都要在 snapshot 里 ——
const snapAt = engine.indexOf("snapshot() {");
const snapBody = engine.slice(snapAt, snapAt + 3000);
const snapEnd = snapBody.indexOf("\n  }");
// snapshot 里既有 `key: value` 也有 `key,`（简写），两种都要认
const snapKeys = [
  ...new Set([
    ...snapBody.slice(0, snapEnd).matchAll(/^\s+([a-zA-Z]+):/gm),
    ...snapBody.slice(0, snapEnd).matchAll(/^\s+([a-zA-Z]+),$/gm),
  ].map((m) => m[1])),
];
const stFields = [...new Set([...ui.matchAll(/\bst\.([a-zA-Z]+)/g)].map((m) => m[1]))];
console.log("\n=== 2. 面板读的 state 字段 ===");
console.log("  snapshot 提供:", snapKeys.length, "个 —", snapKeys.join(","));
const missingState = stFields.filter((f) => !snapKeys.includes(f));
check("面板读的 state 字段都有", missingState.length === 0, missingState.join(",") || "(无缺口)");

// —— 3. 面板读的 config 节都要在 DEFAULTS 里 ——
// 按大括号配对截出 DEFAULTS 对象体。以前用固定 6000 字符窗口，
// DEFAULTS 长到超过窗口就会把末尾几节漏掉（style 就这么被误报成缺失）。
const defaultsAt = config.indexOf("const DEFAULTS = {");
if (defaultsAt < 0) throw new Error("src/config.cjs 里找不到 const DEFAULTS = {");
let depth = 0;
let defaultsEnd = defaultsAt;
let started = false;
for (let i = defaultsAt; i < config.length; i++) {
  if (config[i] === "{") {
    depth++;
    started = true;
  } else if (config[i] === "}") {
    depth--;
    if (started && depth === 0) {
      defaultsEnd = i + 1;
      break;
    }
  }
}
const defaultsBody = config.slice(defaultsAt, defaultsEnd);
const cfgKeys = [...new Set([...defaultsBody.matchAll(/^\s{2}([a-zA-Z]+):/gm)].map((m) => m[1]))];
const uiCfgRefs = [...new Set([...ui.matchAll(/\bdraft\.([a-zA-Z]+)\b/g)].map((m) => m[1]))];
console.log("\n=== 3. 面板读的 config 节 ===");
console.log("  DEFAULTS 提供:", cfgKeys.length, "节 —", cfgKeys.join(","));
const missingCfg = uiCfgRefs.filter((f) => !cfgKeys.includes(f));
check("面板读的 config 节都有", missingCfg.length === 0, missingCfg.join(",") || "(无缺口)");

// —— 4. 五个接口常量必须与宿主路径一致 ——
console.log("\n=== 4. 接口路径 ===");
const hostPaths = [...idx.matchAll(/const ROUTE_[A-Z]+ = "([^"]+)"/g)].map((m) => m[1]);
const uiPaths = [...ui.matchAll(/const ROUTE_[A-Z]+ = "([^"]+)"/g)].map((m) => m[1]);
check("路径集合一致", hostPaths.every((p) => uiPaths.includes(p)) && uiPaths.every((p) => hostPaths.includes(p)), hostPaths.join(" | "));

// —— 5. 面板出现的 audio 元素要能命中 /tts 路由 ——
check("面板用 /tts 播语音", ui.includes('ROUTE_TTS') && ui.includes("audio"), "");
check("面板轮询用 /state", ui.includes("ROUTE_STATE") && /setInterval\(/.test(ui), "");

// —— 6. 识图路由这条链路两侧都要接上 ——
// 任何一环漏了都不会报错：面板只是看不见，或者图片悄悄降级成占位文字。
console.log("\n=== 6. 识图路由 ===");
check("config 有 vision.provider/model 默认值", /vision:\s*\{[^}]*provider:\s*""[^}]*model:\s*""/.test(config));
check("config.normalize 收口 vision.provider/model", /cfg\.vision\.provider\s*=/.test(config) && /cfg\.vision\.model\s*=/.test(config));
check("宿主导出 resolveVisionRoute", /function resolveVisionRoute/.test(idx) && /resolveVisionRoute[,\s}]/.test(idx));
check("带图时走 resolveVisionRoute", /hasImages[\s\S]{0,300}resolveVisionRoute/.test(idx));
check("describe 提供 route.vision", /out\.vision\s*=/.test(idx));
check("buildState 把 vision 带出去", /route\.vision\s*=\s*info\.vision/.test(idx));
check("面板读 route.vision", /route\.vision/.test(ui));
check("面板能改 vision.provider/model", /draft\.vision\.provider/.test(ui) && /draft\.vision\.model/.test(ui));
// 模型列表必须按 provider 分桶，单槽缓存会让第二条路由读到上一条的模型
check("模型缓存按 provider 分桶", /cache\.byProvider/.test(idx) && !/cache\.provider\s*=/.test(idx));

console.log("\n" + (failures === 0 ? "OK：契约一致" : "FAIL：" + failures + " 处错配"));
process.exit(failures === 0 ? 0 : 1);
