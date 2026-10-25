/**
 * 生成 lib/client.js —— DSH 浏览器端加载的那个模块。
 *
 * 这里没有打包器也没有 TypeScript。DSH 期望的客户端模块格式本身就是一小段
 * CommonJS 壳：
 *
 *     window.__ModuleLoader__.load({ id, factory: (require) => { ... return module.exports } })
 *
 * 所以这个构建就是字符串拼接。几条要紧的规矩：
 *   - ui.js 的 module scope 里除了 require("react") 不能有别的东西，因为整个
 *     文件会被塞进 factory 内部；
 *   - ui.js 末尾的 module.exports 必须删掉，否则会覆盖 factory 的 module 对象，
 *     把 apply/inject 契约冲掉；
 *   - 相对路径 require 一律不许有，构建期没有模块解析能力。
 *
 * 用法：node build/build.mjs
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

function indent(text, spaces) {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? pad + line : line))
    .join("\n");
}

/** 去掉只在 node 里才有意义的片段。 */
function stripForBrowser(source) {
  let out = source;
  out = out.replace(/^[ \t]*"use strict";[ \t]*$/m, "");
  out = out.replace(/^[ \t]*\/\* BUILD_TAIL \*\/[ \t]*$/m, "");
  out = out.replace(/^[ \t]*module\.exports = \{[^\n]*\}[ \t]*;[ \t]*$/m, "");
  return out.trimEnd();
}

const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const packageName = packageJson.name;
const ui = await readFile(join(root, "src/ui.js"), "utf8");

// 构建前自检：这几样东西缺了，客户端加载会静默失败，不如在这里直接炸。
const needles = [
  ["function register(api)", "register(api) 定义"],
  ["registerInto(\n    \"main\",", "main slot 注册"],
  ["sidebar.panellist", "侧栏入口注册"],
  ["const PANEL_CSS =", "样式表"],
];
const stripped = stripForBrowser(ui);
for (const [needle, label] of needles) {
  if (!stripped.includes(needle)) throw new Error("src/ui.js 缺少 " + label + "（找不到：" + needle + "）");
}
if (/module\.exports\s*=/.test(stripped.split("\n").slice(-3).join("\n"))) {
  throw new Error("src/ui.js 末尾的 module.exports 没有被剥干净");
}

const banner = [
  "/**",
  " * " + packageName + " — 自动生成的客户端模块，不要手改。",
  " * 真正的源码是 src/ui.js。重新生成：node build/build.mjs",
  " */",
].join("\n");

// 写成行数组，缩进才不会被模板字符串的转义吃掉。
const lines = [
  banner,
  "window.__ModuleLoader__.load({",
  `\tid: ${JSON.stringify(packageName)},`,
  "\tfactory: (require) => {",
  "\t\tvar module = { exports: {} };",
  "\t\tvar exports = module.exports;",
  '\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
  "",
  "\t\t// --- src/ui.js（内联：面板） ---",
  indent(stripped, 2),
  "",
  "\t\t// --- 模块契约：DSH 从这里取 apply / inject ---",
  '\t\tconst inject = ["slots"];',
  "\t\tfunction apply(ctx) {",
  "\t\t\treturn register({",
  "\t\t\t\tslots: ctx.slots,",
  '\t\t\t\tlayout: typeof ctx.get === "function" ? ctx.get("layout") : undefined,',
  "\t\t\t\tdocument: document",
  "\t\t\t});",
  "\t\t}",
  "\t\texports.apply = apply;",
  "\t\texports.inject = inject;",
  "\t\texports.QqAgentPage = QqAgentPage;",
  "\t\texports.QqAgentPanelIcon = QqAgentPanelIcon;",
  "\t\treturn module.exports;",
  "\t}",
  "});",
  "",
];

const bundle = lines.join("\n");
const outFile = join(root, "lib/client.js");
await mkdir(dirname(outFile), { recursive: true });
await writeFile(outFile, bundle, "utf8");

console.log("已生成 " + outFile);
console.log("  行数：" + bundle.split("\n").length);
console.log("  体积：" + (Buffer.byteLength(bundle) / 1024).toFixed(1) + " KiB");
console.log("  id：  " + packageName);
