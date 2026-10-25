/**
 * 把工作区里的源码同步到已安装的插件。
 *
 * 两个坑，都在这里绕过去：
 *
 * 1. pnpm 对 `file:` 依赖只在「版本变化」时才重新复制。源码小改它认为无事发生，
 *    一律回 `Already up to date`。而它复制过来的 lib/*.js 是硬链接（同 inode），
 *    改 lib/ 下已有文件能立刻同步，**新增文件不会**。
 *    → 办法：删掉 node_modules 里的包目录，再 `pnpm update`（会重新复制整包）。
 *
 * 2. 宿主的热挂载（/dsh-market/toggle）不会重新加载宿主代码。
 *    Node 的 ESM 缓存按 URL 存、且没有失效手段，而热挂载每次 import 的都是同一个
 *    `file:///.../lib/index.js`。第一次挂载后再怎么「卸载重挂」，拿到的都是旧实例：
 *    插件看着活着，跑的却是上一次的代码，排查起来极费劲。
 *    → 办法：入口文件名带内容哈希（lib/index.<hash>.js），
 *      代码一变 URL 就变，Node 只能重新读文件。package.json 的 main/exports
 *      随之指过去，旧的那份顺手删掉。
 *
 * 用法：node tools/sync.mjs            构建 + 同步
 *      node tools/sync.mjs --no-build  跳过客户端构建
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const HOME = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || "", ".dsh");
const PLUGIN_DIR = join(HOME, "plugins", "dsh-qq-agent");
const PROFILE_DIR = join(HOME, "profiles", "desktop");
const INSTALLED = join(PROFILE_DIR, "node_modules", "dsh-qq-agent");
const PNPM = join("E:", "deepseek", "resources", "runtime", "pnpm", "bin", "pnpm.cjs");

const skipBuild = process.argv.includes("--no-build");

function step(text) {
  console.log("\n— " + text);
}

function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * 把 lib/index.js 复制成 lib/index.<hash>.js，并让 package.json 指过去。
 * 哈希只取源码内容，所以代码没改时文件名不变、缓存照旧命中，不会白读。
 */
function stampEntry(dir) {
  const source = join(dir, "lib", "index.js");
  if (!existsSync(source)) throw new Error("找不到 " + source);
  const hash = createHash("sha256").update(readFileSync(source)).digest("hex").slice(0, 8);
  const entry = "index." + hash + ".js";
  cpSync(source, join(dir, "lib", entry));

  // 顺手清掉上一轮的入口副本
  for (const name of readdirSync(join(dir, "lib"))) {
    if (/^index\.[0-9a-f]{8}\.js$/.test(name) && name !== entry) unlinkSync(join(dir, "lib", name));
  }

  const pkgPath = join(dir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.main = "lib/" + entry;
  pkg.exports = { ...pkg.exports, ".": "./lib/" + entry };
  pkg.files = ["lib/index.js", "lib/" + entry, "lib/client.js", "src", "cordis.patch.yml", "README.md"];
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  return entry;
}

if (!skipBuild) {
  step("构建客户端");
  const out = run(process.execPath, [join(ROOT, "build", "build.mjs")], ROOT).trim().split("\n");
  console.log("  " + out.slice(-3).join(" | ").trim());
}

step("语法检查");
for (const file of ["lib/index.js", "lib/client.js", "src/ui.js"]) {
  run(process.execPath, ["--check", join(ROOT, file)], ROOT);
}
console.log("  入口与客户端语法正常");

step("生成带哈希的宿主入口");
const entry = stampEntry(ROOT);
console.log("  lib/" + entry);

step("复制到 " + PLUGIN_DIR);
for (const name of ["src", "lib", "README.md", "package.json", "cordis.patch.yml"]) {
  const from = join(ROOT, name);
  if (!existsSync(from)) continue;
  cpSync(from, join(PLUGIN_DIR, name), { recursive: true, force: true });
}
// 目标目录里的旧入口副本也要清掉，否则 pnpm 会把一堆废弃文件也复制过去
for (const name of readdirSync(join(PLUGIN_DIR, "lib"))) {
  if (/^index\.[0-9a-f]{8}\.js$/.test(name) && name !== entry) unlinkSync(join(PLUGIN_DIR, "lib", name));
}
console.log("  已复制 src / lib / README / package.json / cordis.patch.yml");

step("让 pnpm 重新复制整包（删掉再 update，原因见文件头）");
if (existsSync(INSTALLED)) rmSync(INSTALLED, { recursive: true, force: true });
const out = run(process.execPath, [PNPM, "update", "dsh-qq-agent"], PROFILE_DIR);
console.log("  " + out.trim().split("\n").filter((line) => line.trim()).slice(-1)[0]);

step("核对安装结果");
const required = ["lib/" + entry, "lib/client.js", "src/engine.cjs", "src/ui.js"];
let missing = 0;
for (const rel of required) {
  const ok = existsSync(join(INSTALLED, rel));
  console.log("  " + (ok ? "✓ " : "✗ ") + rel);
  if (!ok) missing += 1;
}

if (missing > 0) {
  console.log("\n有文件没同步过去，检查 package.json 的 files 字段是否漏了这一项。");
  process.exit(1);
}

console.log("\n同步完成。");
console.log("");
console.log("注意：宿主代码（lib/index.js、src/*.cjs）的改动**只能靠重启 DSH 生效**。");
console.log("  热挂载（/dsh-market/toggle）读不到新的宿主模块 —— 有两道按 URL 的缓存，");
console.log("  都在宿主进程内且无法失效：");
console.log("    1. dshmarket 用 createRequire().resolve(包名) 取入口，结果缓存在 Module._pathCache；");
console.log("    2. Node 的 ESM 缓存按 URL 存，没有失效手段。");
console.log("  所以「卸载再重挂」只会重建插件实例，跑的还是第一次 import 的那份代码。");
console.log("  （client.js 不一样：客户端改完刷新页面就行。）");
console.log("");
console.log("确认装进去的是新代码：node test/installed.check.mjs");
console.log("重启后再跑：node test/vision.route.mjs");
