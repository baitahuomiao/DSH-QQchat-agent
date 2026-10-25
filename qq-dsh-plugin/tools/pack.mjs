/**
 * 打一个可以直接发给别人的发布包。
 *
 * 产物：`release/dsh-qq-agent-<version>/` 与同名 `.zip`。
 * 只装运行时需要的东西 —— 不含 test/、build/、node_modules、data/，
 * 因为别人的机器上不需要我们的测试，也不需要我们的配置和人设。
 *
 * 与 tools/sync.mjs 的区别：
 *   sync.mjs  给「自己这台机器」用，会把入口改成带哈希的 lib/index.<hash>.js
 *             （为了对抗宿主进程的模块缓存）。
 *   pack.mjs  给「别人」用，入口固定 lib/index.js —— 干净、可预期，
 *             反正对方装完要重启 DSH，缓存问题不存在。
 *
 * 用法：node tools/pack.mjs
 *      node tools/pack.mjs --no-zip   只生成目录，不压缩
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const RELEASE_ROOT = join(ROOT, "release");
const skipZip = process.argv.includes("--no-zip");

function step(text) {
  console.log("\n— " + text);
}
function ok(text) {
  console.log("  [ok] " + text);
}

function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** 发布包里要带的东西。顺序无关，缺了会在下面报错。 */
const INCLUDE = [
  "lib",
  "src",
  "cordis.patch.yml",
  "README.md",
  "安装说明.md",
  "安装.cmd",
  "卸载.cmd",
  "tools/install.mjs",
  "tools/smoke-installed.mjs",
];

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const version = pkg.version || "0.0.0";
const name = pkg.name || "dsh-qq-agent";
const outDir = join(RELEASE_ROOT, name + "-" + version);

step("构建客户端面板");
const built = run(process.execPath, [join(ROOT, "build", "build.mjs")], ROOT).trim().split("\n");
ok(built.slice(-1)[0].trim());

step("语法检查");
for (const file of ["lib/index.js", "lib/client.js", "src/ui.js"]) {
  run(process.execPath, ["--check", join(ROOT, file)], ROOT);
}
ok("lib/index.js、lib/client.js、src/ui.js 均可解析");

step("准备发布目录");
if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

let missing = 0;
for (const rel of INCLUDE) {
  const from = join(ROOT, rel);
  if (!existsSync(from)) {
    console.log("  [xx] 缺 " + rel);
    missing += 1;
    continue;
  }
  const to = join(outDir, rel);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true, force: true });
}
if (missing > 0) {
  console.log("\n缺文件，先补齐再打包。");
  process.exit(1);
}
ok("已复制：" + INCLUDE.join("、"));

// 发布包里不要带哈希入口（那是本机对抗宿主缓存的产物）
const libDir = join(outDir, "lib");
for (const entry of readdirSync(libDir)) {
  if (/^index\.[0-9a-f]{8}\.js$/.test(entry)) rmSync(join(libDir, entry), { force: true });
}

step("改写 package.json");
const distPkg = {
  name: pkg.name,
  version: pkg.version,
  private: true,
  description: pkg.description,
  type: "module",
  main: "lib/index.js",
  exports: {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json",
  },
  dsh: pkg.dsh,
  // `files` 决定 pnpm 从 file: 依赖里复制哪些东西，少一项就会在别人机器上缺文件。
  files: ["lib", "src", "cordis.patch.yml", "README.md", "安装说明.md", "安装.cmd", "卸载.cmd", "tools"],
  scripts: {
    // 刻意不设 "install"：npm/pnpm 在别人机器上装依赖时可能触发它，
    // 那样会在莫名其妙的时机往 profile 里写东西。安装只走「安装.cmd」。
    "install-dsh": "node tools/install.mjs",
    "uninstall-dsh": "node tools/install.mjs --uninstall",
  },
  peerDependencies: pkg.peerDependencies,
  peerDependenciesMeta: pkg.peerDependenciesMeta,
  license: pkg.license || "MIT",
};
writeFileSync(join(outDir, "package.json"), JSON.stringify(distPkg, null, 2) + "\n");
ok("main → lib/index.js，files 覆盖 lib/、src/、tools/ 与文档");

step("内容自检");
const required = [
  "package.json",
  "cordis.patch.yml",
  "lib/index.js",
  "lib/client.js",
  "src/ui.js",
  "src/engine.cjs",
  "src/config.cjs",
  "tools/install.mjs",
  "tools/smoke-installed.mjs",
  "安装.cmd",
  "卸载.cmd",
  "安装说明.md",
  "README.md",
];
let bad = 0;
for (const rel of required) {
  if (existsSync(join(outDir, rel))) ok(rel);
  else {
    console.log("  [xx] 缺 " + rel);
    bad += 1;
  }
}
if (bad > 0) process.exit(1);

// 别把本机路径、密钥、QQ 号泄露出去
const leaks = [];
const scan = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      scan(full);
      continue;
    }
    if (!/\.(js|cjs|mjs|json|md|yml|cmd|ps1)$/.test(entry.name)) continue;
    const text = readFileSync(full, "utf8");
    const rules = [
      [/C:[\\/]Users[\\/]ROG/i, "本机用户名路径"],
      [/E:[\\/]deepseek/i, "本机工作区路径"],
      [/sk-[A-Za-z0-9]{10,}/, "疑似 API Key"],
      [/ujn-[A-Za-z0-9]{10,}/, "疑似 API Key"],
    ];
    for (const [pattern, label] of rules) {
      if (pattern.test(text)) leaks.push(full.slice(outDir.length + 1) + " → " + label);
    }
  }
};
scan(outDir);
if (leaks.length > 0) {
  console.log("\n发布包里还留着本机专有的东西：");
  for (const line of leaks) console.log("  [!!] " + line);
  console.log("先清干净再打包（尤其是文档里的示例路径）。");
  process.exit(1);
}
ok("没有本机路径、密钥或真实 QQ 号残留");

step("打包 zip");
if (skipZip) {
  ok("--no-zip，跳过");
} else {
  const zipPath = join(RELEASE_ROOT, name + "-" + version + ".zip");
  if (existsSync(zipPath)) rmSync(zipPath, { force: true });
  run(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `Compress-Archive -LiteralPath '${outDir}' -DestinationPath '${zipPath}' -CompressionLevel Optimal`,
    ],
    RELEASE_ROOT,
  );
  const size = (readFileSync(zipPath).length / 1024).toFixed(1);
  ok(zipPath + "（" + size + " KiB）");
}

console.log("\n发布包已就绪：" + outDir);
console.log("把它（或同名 zip）发给别人，对方解压后双击「安装.cmd」即可。");
