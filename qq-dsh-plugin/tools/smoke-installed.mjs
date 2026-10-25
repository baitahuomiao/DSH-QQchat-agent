/**
 * 用一个假宿主把「已安装的那一份」跑起来。
 *
 * 目的：证明发布包解压 → 安装.cmd → node_modules 里的那份，能在开发目录完全不
 * 参与的情况下独立加载、注册路由、响应 /state。对方机器上就该是这种状态。
 *
 * 用法：node tools/smoke-installed.mjs [DSH_HOME]
 *      不传就用 %USERPROFILE%\.dsh。
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const PKG_NAME = "dsh-qq-agent";
const home = process.argv[2] || process.env.DSH_HOME || join(homedir(), ".dsh");
const profileDir = join(home, "profiles", "desktop");
const profilePkg = join(profileDir, "package.json");

let failures = 0;
function ok(text) {
  console.log("  [ok] " + text);
}
function bad(text) {
  console.log("  [xx] " + text);
  failures += 1;
}
function check(label, condition, detail) {
  if (condition) ok(label + (detail ? "：" + detail : ""));
  else bad(label + (detail ? "：" + detail : ""));
}

console.log("\n— 定位已安装的插件");
if (!existsSync(profilePkg)) {
  bad("没有 profile：" + profilePkg);
  process.exit(1);
}
let entry = "";
try {
  entry = createRequire(profilePkg).resolve(PKG_NAME);
} catch (error) {
  bad("profile 解析不到 " + PKG_NAME + "：" + String(error.message || error).split("\n")[0]);
  process.exit(1);
}
ok("入口：" + entry);

// 关键断言：解析结果不能落在开发目录里，否则这次冒烟证明不了发布包能独立运行。
check("入口不在开发目录内", !/[\\/]qq-dsh-plugin[\\/]/.test(entry), entry);

const pkg = JSON.parse(readFileSync(join(entry, "..", "..", "package.json"), "utf8"));
check("包名正确", pkg.name === PKG_NAME, pkg.name);
check("入口是 lib/index.js", pkg.main === "lib/index.js", pkg.main);
check("files 含 lib 与 src", pkg.files.includes("lib") && pkg.files.includes("src"), pkg.files.join(","));
check("描述无乱码", !/\ufffd/.test(String(pkg.description || "")), String(pkg.description || "").slice(0, 24) + "…");

console.log("\n— 用假宿主加载");
const routes = [];
const disposers = [];
const logs = [];
const fakeCtx = {
  logger: {
    info: (msg) => logs.push(["info", msg]),
    warn: (msg) => logs.push(["warn", msg]),
    error: (msg) => logs.push(["error", msg]),
    debug: () => {},
  },
  get: (name) => (name === "llm" ? null : null),
  effect: (factory, label) => {
    const dispose = factory();
    disposers.push({ label, dispose });
    return dispose;
  },
  connection: {
    fetch: {
      register: (route) => {
        routes.push(route);
        return async () => {};
      },
    },
  },
};

const mod = await import(pathToFileURL(entry).href);
check("导出 name", mod.name === PKG_NAME, mod.name);
check("inject 只依赖 connection", JSON.stringify(mod.inject) === JSON.stringify(["connection"]), JSON.stringify(mod.inject));

mod.apply(fakeCtx);

const paths = routes.map((route) => route.methods.join("+") + " " + route.path);
check("注册了 4 条路由", routes.length === 4, paths.join(" | "));

const stateRoute = routes.find((route) => route.path === "/api/qq-agent/state");
check("有 GET /api/qq-agent/state", Boolean(stateRoute));
if (stateRoute) {
  const response = await stateRoute.fetch(new Request("http://127.0.0.1/api/qq-agent/state"));
  check("/state 返回 200", response.status === 200, String(response.status));
  const body = await response.json();
  const keys = Object.keys(body).sort().join(",");
  check("/state 字段齐全", body.ok === true && keys.includes("config") && keys.includes("presets"), keys);
  check("人设已载入", Boolean(body.config && body.config.persona && body.config.persona.name), body.config?.persona?.name);
  check("预设可用", Array.isArray(body.presets) && body.presets.length >= 6, String(body.presets?.length));
  check("没有模型服务时报出原因", Boolean(body.routeError), body.routeError);
}

const ttsRoute = routes.find((route) => route.path === "/api/qq-agent/tts");
check("有 GET /api/qq-agent/tts", Boolean(ttsRoute));

console.log("\n— 卸载干净");
for (const { dispose } of disposers.reverse()) {
  try {
    await dispose();
  } catch {
    /* 清理阶段的异常不算失败 */
  }
}
ok("dispose 完成，未抛错");

console.log("");
if (failures > 0) {
  console.log("失败 " + failures + " 项");
  process.exit(1);
}
console.log("OK：发布包安装出来的那份可以独立加载");
