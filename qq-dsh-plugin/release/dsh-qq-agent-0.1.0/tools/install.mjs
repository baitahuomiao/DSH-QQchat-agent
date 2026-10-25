/**
 * dsh-qq-agent 安装器（给别人用的那份）。
 *
 * 为什么要有这个脚本：DSH 桌面版的 profile 由 Electron 独占，CLI 的
 * `dsh plugin --profile desktop add ...` 会被拒绝，所以只能手工三步——
 * 复制插件目录、在 profile 的 package.json 里登记、跑一次 pnpm。
 * 这个脚本把三步一次做完，并且不写死任何路径。
 *
 * 用法：
 *   node tools/install.mjs                 自动找 DSH、自动挑 profile
 *   node tools/install.mjs --profile web   指定 profile 名字
 *   node tools/install.mjs --dry-run       只报告将要做什么，不动任何文件
 *   node tools/install.mjs --uninstall     卸载
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PKG_NAME = "dsh-qq-agent";
const HERE = dirname(fileURLToPath(import.meta.url));
/** 插件包根目录：release 里是包根（tools 的上一级） */
const SRC_ROOT = resolve(HERE, "..");

const argv = process.argv.slice(2);
const flag = (name) => argv.includes("--" + name);
const valueOf = (name) => {
  const index = argv.indexOf("--" + name);
  return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[index + 1] : "";
};

const DRY = flag("dry-run");
const UNINSTALL = flag("uninstall");

function say(text = "") {
  console.log(text);
}
function step(text) {
  say("");
  say("— " + text);
}
function ok(text) {
  say("  [ok] " + text);
}
function warn(text) {
  say("  [!!] " + text);
}
function fail(text) {
  say("  [xx] " + text);
}

function die(text, hint) {
  fail(text);
  if (hint) say("       " + hint);
  process.exit(1);
}

/* ---------------------------------------------------------------- 找 DSH */

/**
 * DSH 的数据目录。桌面版默认 `~/.dsh`，也可以用 DSH_HOME 环境变量换地方。
 */
function dshHome() {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}

/**
 * 找出所有可用的 profile。
 *
 * 一个 profile 就是一个带 `dsh.profile.bundles` 的目录，名字随意
 * （官方是 desktop / web）。桌面版是 desktop，所以优先它。
 */
function listProfiles(home) {
  const profilesDir = join(home, "profiles");
  if (!existsSync(profilesDir)) return [];
  const found = [];
  for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const pkgPath = join(profilesDir, entry.name, "package.json");
    if (!existsSync(pkgPath)) continue;
    let pkg = null;
    try {
      pkg = readJson(pkgPath);
    } catch {
      continue;
    }
    if (!pkg || typeof pkg !== "object") continue;
    found.push({
      name: entry.name,
      dir: join(profilesDir, entry.name),
      pkgPath,
      pkg,
      hasBundles: Boolean(pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles)),
    });
  }
  found.sort((a, b) => {
    const rank = (row) => (row.name === "desktop" ? 0 : row.name === "web" ? 1 : 2);
    return rank(a) - rank(b) || a.name.localeCompare(b.name);
  });
  return found;
}

/**
 * DSH 自带的 node / pnpm 在 `~/.dsh/dsh-runtimes/<runtime>/dependencies/` 下。
 * 找到了就用它，找不到再退回 PATH 上的同名命令。
 */
function findRuntimeTool(home, tool, relPath) {
  const runtimesDir = join(home, "dsh-runtimes");
  if (!existsSync(runtimesDir)) return "";
  let names = [];
  try {
    names = readdirSync(runtimesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return "";
  }
  for (const name of names) {
    const candidate = join(runtimesDir, name, "dependencies", relPath);
    if (existsSync(candidate)) return candidate;
  }
  return "";
}

function onPath(command) {
  try {
    return execFileSync(process.platform === "win32" ? "where" : "which", [command], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .split(/\r?\n/)[0];
  } catch {
    return "";
  }
}

/* ------------------------------------------------------- 读 / 改 profile */

function toFileSpec(dir) {
  return "file:" + dir.replace(/\\/g, "/");
}

function readJsonText(text) {
  // 去掉 BOM：Windows 上用记事本/PowerShell 改过文件很容易留下 BOM，
  // 而 JSON.parse 遇到它直接报错，表现成「profile 明明在却找不到」。
  return JSON.parse(text.replace(/^\uFEFF/, ""));
}

function readJson(file) {
  return readJsonText(readFileSync(file, "utf8"));
}

function writeJson(file, data) {
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

/* ------------------------------------------------------------ 装 / 卸包 */

/**
 * 只留最近两份备份。
 *
 * 反复安装时每次都会把上一份挪成 .bak-<时间戳>，不清理的话
 * plugins/ 下很快堆出一堆几十兆的旧副本。
 */
function pruneBackups(dir, prefix) {
  const parent = dirname(dir);
  const base = prefix.split("/").pop();
  let names = [];
  try {
    names = readdirSync(parent)
      .filter((name) => name.startsWith(base + ".bak-"))
      .sort();
  } catch {
    return;
  }
  for (const name of names.slice(0, Math.max(0, names.length - 2))) {
    try {
      rmSync(join(parent, name), { recursive: true, force: true });
    } catch {
      /* 删不掉就算了，不影响安装 */
    }
  }
}

/** 把插件包复制到 `<home>/plugins/dsh-qq-agent`，跳过开发用的目录。 */
function copyPlugin(home) {
  const target = join(home, "plugins", PKG_NAME);
  const skip = new Set(["node_modules", ".git", "test", "release", "build", "data", ".tmp"]);
  if (DRY) {
    ok("将复制 " + SRC_ROOT + " → " + target);
    return target;
  }
  mkdirSync(dirname(target), { recursive: true });
  if (existsSync(target)) {
    const backup = target + ".bak-" + Date.now();
    try {
      renameSync(target, backup);
      ok("旧版本已备份到 " + backup);
    } catch {
      rmSync(target, { recursive: true, force: true });
    }
  }
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(SRC_ROOT, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    cpSync(join(SRC_ROOT, entry.name), join(target, entry.name), { recursive: true, force: true });
  }
  pruneBackups(target, "plugins/" + PKG_NAME);
  ok("插件已放到 " + target);
  return target;
}

/** 只留最近两份 package.json 备份。 */
function pruneProfileBackups(pkgPath) {
  const dir = dirname(pkgPath);
  const base = pkgPath.split(/[\\/]/).pop();
  let names = [];
  try {
    names = readdirSync(dir)
      .filter((name) => name.startsWith(base + ".bak-"))
      .sort();
  } catch {
    return;
  }
  for (const name of names.slice(0, Math.max(0, names.length - 2))) {
    try {
      rmSync(join(dir, name), { force: true });
    } catch {
      /* 删不掉就算了 */
    }
  }
}

/** 在 profile 的 package.json 里登记依赖与 bundle 顺序。 */
function patchProfile(profile, pluginDir) {
  const pkg = profile.pkg;
  pkg.dependencies = pkg.dependencies && typeof pkg.dependencies === "object" ? pkg.dependencies : {};
  pkg.dependencies[PKG_NAME] = toFileSpec(pluginDir);

  if (!pkg.dsh || typeof pkg.dsh !== "object") pkg.dsh = {};
  if (!pkg.dsh.profile || typeof pkg.dsh.profile !== "object") pkg.dsh.profile = {};
  if (!Array.isArray(pkg.dsh.profile.bundles)) pkg.dsh.profile.bundles = [];
  if (!pkg.dsh.profile.bundles.includes(PKG_NAME)) pkg.dsh.profile.bundles.push(PKG_NAME);

  if (DRY) {
    ok("将写入 " + profile.pkgPath + " 的 dependencies 与 dsh.profile.bundles");
    return;
  }
  const backup = profile.pkgPath + ".bak-" + Date.now();
  cpSync(profile.pkgPath, backup);
  writeJson(profile.pkgPath, pkg);
  pruneProfileBackups(profile.pkgPath);
  ok("已登记到 profile（备份：" + backup + "）");
}

/**
 * 造一个能跑 pnpm 的函数，找不到 pnpm 就返回 null。
 *
 * 优先用 DSH 自带的运行时（`dsh-runtimes` 下那个 profile 自带的 pnpm），
 * 这样用户机器上没装 Node/pnpm 也能装插件。
 */
function makePnpmRunner(home, profile) {
  const node = findRuntimeTool(home, "node", join("node", "bin", "node.exe")) || onPath("node") || process.execPath;
  const pnpmCjs = findRuntimeTool(home, "pnpm", join("pnpm", "bin", "pnpm.cjs"));
  const pnpmExe = pnpmCjs ? "" : onPath("pnpm");
  if (!pnpmCjs && !pnpmExe) return null;
  return {
    label: pnpmCjs || pnpmExe,
    /**
     * 跑一次 pnpm。
     *
     * 两个固定开关的原因：
     *   CI=1            —— 不弹交互提示，装到一半别卡住等回车。
     *   --no-frozen-lockfile —— CI 模式下 pnpm 默认按 frozen-lockfile 校验，
     *                     而我们改过 package.json（加/删本插件），lock 必然
     *                     对不上，不加这个开关会直接 ERR_PNPM_OUTDATED_LOCKFILE。
     */
    run(args) {
      const finalArgs = args.includes("--no-frozen-lockfile") ? args : args.concat("--no-frozen-lockfile");
      const [command, argv] = pnpmCjs ? [node, [pnpmCjs, ...finalArgs]] : [pnpmExe, finalArgs];
      try {
        return execFileSync(command, argv, {
          cwd: profile.dir,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, CI: "1" },
        });
      } catch (error) {
        // execFileSync 只把 exit code 塞进 message，真正的原因在 stderr 里。
        const stderr = String(error.stderr || "").trim();
        const detail = stderr.split(/\r?\n/).filter(Boolean).slice(-3).join(" / ");
        throw new Error(detail || String(error.message || error).split("\n")[0]);
      }
    },
  };
}

/**
 * 让 pnpm 把包链接进 profile 的 node_modules。
 *
 * 顺序：先正常 install（新依赖会顺带装上），不行再 update（pnpm 对已存在的
 * `file:` 依赖只在版本变化时才重抄，update 能强制刷新），都不行就退到
 * 目录联接——模块解析只需要 node_modules 下有个同名目录，联接够用。
 */
function linkIntoProfile(home, profile, pluginDir) {
  const installed = join(profile.dir, "node_modules", PKG_NAME);
  if (DRY) {
    ok("将执行 pnpm install 把 " + PKG_NAME + " 装进 profile");
    return installed;
  }

  const pnpm = makePnpmRunner(home, profile);

  if (pnpm) {
    ok("用 pnpm：" + pnpm.label);
    for (const args of [["install", "--prefer-offline"], ["update", PKG_NAME]]) {
      try {
        const out = pnpm.run(args);
        const tail = out.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] || "";
        ok("pnpm " + args.join(" ") + (tail ? " → " + tail : ""));
      } catch (error) {
        warn("pnpm " + args.join(" ") + " 失败：" + String(error.message || error).split("\n")[0]);
      }
      if (existsSync(join(installed, "package.json"))) {
        ok("已装进 profile 的 node_modules");
        return installed;
      }
    }
  } else {
    warn("没找到 pnpm，改用目录联接");
  }

  // 兜底：直接把插件目录联到 node_modules 下
  try {
    mkdirSync(dirname(installed), { recursive: true });
    if (existsSync(installed)) rmSync(installed, { recursive: true, force: true });
    symlinkSync(pluginDir, installed, "junction");
    ok("已建立目录联接：" + installed);
  } catch (error) {
    fail("建立目录联接失败：" + String(error.message || error).split("\n")[0]);
    say("       请手工在 " + dirname(installed) + " 下建一个名为 " + PKG_NAME + " 的链接。");
  }
  return installed;
}

/* ------------------------------------------------------------- 收尾校验 */

function verify(home, profile, installed) {
  step("校验");
  if (DRY) {
    ok("（dry-run，跳过）");
    return;
  }
  const entry = join(installed, "package.json");
  if (!existsSync(entry)) {
    die("插件没出现在 " + installed, "重跑本脚本，或用 DSH 的插件市场装上它。");
  }
  ok("package.json 在 node_modules 里");

  const need = ["lib/index.js", "lib/client.js", "src/engine.cjs", "cordis.patch.yml"];
  for (const rel of ["lib", "src"]) {
    const dir = join(installed, rel);
    if (existsSync(dir) && statSync(dir).isDirectory()) ok(rel + "/ 已安装");
  }
  let missing = 0;
  for (const rel of need) {
    if (!existsSync(join(installed, rel))) {
      fail("缺 " + rel);
      missing += 1;
    }
  }
  if (missing > 0) {
    die("安装不完整。", "确认插件包里的 package.json 的 files 字段包含 lib 与 src。");
  }
  ok("入口文件齐全");

  // 让真正的解析器确认 DSH 能加载它
  try {
    const localRequire = createRequire(join(profile.dir, "package.json"));
    const resolved = localRequire.resolve(PKG_NAME);
    ok("profile 能解析到 " + resolved);
  } catch (error) {
    warn("profile 解析不到 " + PKG_NAME + "：" + String(error.message || error).split("\n")[0]);
  }

  // 宿主入口能 import 起来吗（不启动引擎，只验证模块图）
  try {
    const url = pathToFileURL(join(installed, "lib", "index.js")).href;
    const out = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", `const m = await import(${JSON.stringify(url)}); console.log(Object.keys(m).join(","));`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    ok("宿主入口可加载，导出：" + out);
  } catch (error) {
    warn("宿主入口加载失败（不影响安装，可能是 peer 依赖尚未就绪）");
    const detail = String(error.stderr || error.message || error).trim().split(/\r?\n/).slice(0, 3);
    for (const line of detail) say("       " + line);
  }
}

function printNextSteps(home, profile, uninstalled) {
  step(uninstalled ? "卸载完成" : "安装完成");
  if (uninstalled) {
    say("  插件已从 profile 里移除。重启 DSH 后左栏的 QQ 面板就不会再出现。");
    say("  用户数据（人设、记忆、看过的视频）还在：" + join(home, "qq-agent"));
    say("  想彻底清掉就删这个目录。");
    return;
  }
  say("  接下来必做两件事：");
  say("");
  say("  1. 重启 DeepSeek Harness（关掉窗口再打开）。宿主插件只在启动时加载。");
  say("  2. 重启后，左栏应该出现一个 QQ 图标，点进去按提示填：");
  say("       · 主人 QQ 号");
  say("       · OneBot 的 WebSocket 地址（NapCat 默认 ws://127.0.0.1:3001）");
  say("       · 要授权的群号（可以先点「拉取群列表」再勾）");
  say("");
  say("  配置文件在：" + join(home, "qq-agent", "config.json"));
  say("  装的是哪个 profile：" + profile.name + "（" + profile.dir + "）");
}

/* ------------------------------------------------------------------ 主流程 */

function main() {
  step("查找 DSH");
  const home = dshHome();
  if (!existsSync(home)) {
    die("找不到 DSH 数据目录：" + home, "先运行一次 DeepSeek Harness 再装；装在别处就设 DSH_HOME 环境变量。");
  }
  ok("DSH 数据目录：" + home);

  const profiles = listProfiles(home);
  if (profiles.length === 0) {
    die("在 " + join(home, "profiles") + " 下没找到 profile", "先在 DSH 里建一个 profile 并至少启动一次。");
  }
  ok("发现 profile：" + profiles.map((row) => row.name).join(", "));

  const wanted = valueOf("profile");
  let profile = null;
  if (wanted) {
    profile = profiles.find((row) => row.name === wanted) || null;
    if (!profile) die("没有名为 " + wanted + " 的 profile", "可选：" + profiles.map((r) => r.name).join(", "));
  } else {
    profile = profiles.find((row) => row.hasBundles) || profiles[0];
  }
  ok("使用 profile：" + profile.name);

  if (UNINSTALL) {
    step("卸载");
    const pkg = readJson(profile.pkgPath);
    if (pkg.dependencies && pkg.dependencies[PKG_NAME]) delete pkg.dependencies[PKG_NAME];
    const bundles = pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles;
    if (Array.isArray(bundles)) pkg.dsh.profile.bundles = bundles.filter((name) => name !== PKG_NAME);
    if (!DRY) {
      cpSync(profile.pkgPath, profile.pkgPath + ".bak-" + Date.now());
      writeJson(profile.pkgPath, pkg);
      pruneProfileBackups(profile.pkgPath);

      // 先在 node_modules 层面解开，再删 plugins 下的插件本体。
      // 顺序很重要：pnpm 装的那份是 node_modules/.pnpm 下的真实副本
      // （node_modules/dsh-qq-agent 只是指向它的联接），只删联接管不到副本。
      const pnpm = makePnpmRunner(home, profile);
      if (pnpm) {
        try {
          pnpm.run(["install", "--prefer-offline"]);
          ok("已用 pnpm 清理 profile 的 node_modules");
        } catch (error) {
          warn("pnpm 清理失败，改为手工删除：" + String(error.message || error).split("\n")[0]);
        }
      }

      // pnpm 会把不再被引用的包留在 .pnpm 的虚拟仓库里（只是摘掉顶层联接），
      // 所以这里再手工摘一遍，别在用户磁盘上留几十兆垃圾。
      const installed = join(profile.dir, "node_modules", PKG_NAME);
      if (existsSync(installed)) rmSync(installed, { recursive: true, force: true });
      const virtualStore = join(profile.dir, "node_modules", ".pnpm");
      if (existsSync(virtualStore)) {
        for (const entry of readdirSync(virtualStore, { withFileTypes: true })) {
          if (!entry.name.startsWith(PKG_NAME + "@")) continue;
          try {
            rmSync(join(virtualStore, entry.name), { recursive: true, force: true });
          } catch {
            /* 删不掉就算了 */
          }
        }
      }

      const pluginDir = join(home, "plugins", PKG_NAME);
      if (existsSync(pluginDir)) rmSync(pluginDir, { recursive: true, force: true });
      // 连历次安装留下的 .bak-* 一起清掉，别在用户磁盘上留垃圾。
      const pluginsDir = join(home, "plugins");
      if (existsSync(pluginsDir)) {
        for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
          if (!entry.name.startsWith(PKG_NAME + ".bak-")) continue;
          try {
            rmSync(join(pluginsDir, entry.name), { recursive: true, force: true });
          } catch {
            /* 删不掉就算了 */
          }
        }
      }
    }
    ok("已从 profile 的 package.json、node_modules 与 plugins 里移除");
    printNextSteps(home, profile, true);
    return;
  }

  step("复制插件");
  const pluginDir = copyPlugin(home);

  step("登记到 profile");
  patchProfile(profile, pluginDir);

  step("装进 node_modules");
  const installed = linkIntoProfile(home, profile, pluginDir);

  verify(home, profile, installed);
  printNextSteps(home, profile, false);
}

main();
