/**
 * 验证「装进 profile 的那份产物」本身是新的。
 *
 * 为什么需要这个：热挂载（/dsh-market/toggle）**无法**让宿主读到新的宿主代码。
 * 两道缓存都按 URL 永久固定，且都在宿主进程内、没有失效手段：
 *
 *   1. dshmarket 的 hotMount 用 `createRequire(profileDir/package.json).resolve(name)`
 *      把包名解析成绝对 file:// URL（hot.js:64）。Node 的 CJS 解析结果缓存在
 *      `Module._pathCache` 里 —— 进程内第一次解析出 lib/index.js 之后，即使
 *      package.json 的 main 换成 lib/index.<hash>.js，这里照样返回旧路径。
 *   2. 就算 URL 变对了，Node 的 ESM 缓存也按 URL 存且无法失效。
 *
 * 所以「卸载再重挂」只能重建插件实例，读不到新模块。宿主代码改动必须重启进程。
 *
 * 这个脚本换一个**新进程**导入安装位置的入口，绕开上面两道缓存，
 * 至少能证明「磁盘上装的那份是对的」，把问题范围收敛到「只差重启」。
 *
 * 用法：node test/installed.check.mjs
 */
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
const PROFILE_DIR = join(HOME, "profiles", "desktop");

// 沙箱数据目录要在导入插件之前设好，否则会写到真实配置上
const sandbox = mkdtempSync(join(tmpdir(), "dsh-qq-agent-installed-"));
process.env.DSH_QQ_AGENT_DATA = sandbox;

const failures = [];
function check(ok, label) {
  console.log((ok ? "  ✓ " : "  ✗ ") + label);
  if (!ok) failures.push(label);
}

try {
  // —— 1. 安装位置的包入口是什么 ——
  console.log("=== 1. profile 里的包入口 ===");
  const profileRequire = createRequire(join(PROFILE_DIR, "package.json"));
  const entryPath = profileRequire.resolve("dsh-qq-agent");
  console.log("  解析到: " + entryPath);

  const pkgPath = join(PROFILE_DIR, "node_modules", "dsh-qq-agent", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  console.log("  main   : " + pkg.main);
  check(/^lib\/index\.[0-9a-f]{8}\.js$/.test(pkg.main || ""), "main 指向带哈希的入口（避免 ESM 缓存撞车）");
  check(entryPath.endsWith(pkg.main.replace(/\//g, "\\")), "require.resolve 解析到的就是 main 指向的文件");

  // —— 2. 源码里真的带着识图路由 ——
  console.log("\n=== 2. 产物内容 ===");
  const source = readFileSync(entryPath, "utf8");
  check(source.includes("out.vision"), "入口里有 out.vision（describe 暴露识图路由）");
  check(source.includes("needImage"), "入口里有 needImage（带图时挑能看图的模型）");
  check(source.includes("cfg.vision.provider"), "入口里读了 cfg.vision.provider");
  check(source.includes("max-tokens"), "入口里有「预算被 reasoning 吃光就加倍重试」");
  check(existsSync(join(PROFILE_DIR, "node_modules", "dsh-qq-agent", "src", "engine.cjs")), "src/engine.cjs 已随包安装");
  check(existsSync(join(PROFILE_DIR, "node_modules", "dsh-qq-agent", "src", "ui.js")), "src/ui.js 已随包安装");

  // —— 3. 用这个入口跑一遍 apply（新进程，不吃宿主缓存） ——
  console.log("\n=== 3. 新进程里跑 apply ===");
  const mod = await import(new URL("file:///" + entryPath.replace(/\\/g, "/")).href);
  check(typeof mod.apply === "function", "入口导出 apply");
  check(Array.isArray(mod.inject) && mod.inject.includes("connection"), "inject 含 connection");

  const routes = new Map();
  const effects = [];
  // 插件用 inject 声明 connection，所以走的是 ctx.connection 属性而不是 ctx.get()。
  // llm 是可选服务（插件不 inject 它），必须给一个假的，否则 route 恒为 null、
  // 识图路由那段分支根本跑不到 —— 这正是最容易「假绿」的地方。
  const fakeLlm = {
    listProviders() {
      return [
        { id: "abc", name: "deep seek" },
        { id: "deepseek-official", name: "DeepSeek" },
      ];
    },
    async listModels(provider) {
      if (provider === "abc") {
        return [{ id: "deepseek-v41-flash", name: "V4.1 Flash", inputModalities: ["text"] }];
      }
      return [
        { id: "deepseek-flash", name: "Flash", inputModalities: ["text", "image"] },
        { id: "deepseek-v4-pro", name: "Pro", inputModalities: ["text"] },
      ];
    },
    async *stream() {
      yield { type: "text-delta", index: 0, text: "" };
      yield { type: "finish", reason: { kind: "stop" } };
    },
  };
  const fakeCtx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    connection: { fetch: { register(route) { routes.set(route.path, route); return () => {}; } } },
    get(name) {
      if (name === "connection") return this.connection;
      if (name === "llm") return fakeLlm;
      return undefined;
    },
    effect(factory, label) {
      effects.push(label);
      return factory();
    },
  };

  mod.apply(fakeCtx);
  check(routes.size === 4, "注册了 4 条路由（实际 " + routes.size + "）");

  const stateRoute = routes.get("/api/qq-agent/state");
  const response = await stateRoute.fetch(new Request("http://127.0.0.1:19387/api/qq-agent/state"));
  const body = await response.json();
  check(response.status === 200, "/state 返回 200");
  check(body.route !== null && body.route !== undefined, "route 不是 null");
  check(body.route && body.route.vision !== undefined, "route.vision 存在（**热挂载永远读不到，重启后才有**）");

  if (body.route && body.route.vision) {
    const vision = body.route.vision;
    console.log("     识图路由: " + (vision.provider || "(跟聊天同一条)") + " / " + (vision.model || "(自动挑)"));
    console.log("     能看图  : " + String(vision.seesImages));
    console.log("     候选模型: " + (vision.models || []).map((row) => row.id).join(", ") || "(无)");
    check(typeof vision.seesImages === "boolean", "vision.seesImages 是布尔值");
  }

  check(body.config.vision && "provider" in body.config.vision, "config.vision 有 provider 字段");
  check(body.config.vision && "model" in body.config.vision, "config.vision 有 model 字段");
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

console.log("");
if (failures.length === 0) {
  console.log("安装产物是新的。宿主要跑到这份代码，只能重启 DSH ——");
  console.log("热挂载读不到新的宿主模块（CJS 解析缓存 + ESM 缓存双重固定 URL）。");
  console.log("重启后跑 node test/vision.route.mjs 确认 route.vision 出现。");
  process.exit(0);
}
console.log(failures.length + " 项不通过：\n  - " + failures.join("\n  - "));
process.exit(1);
