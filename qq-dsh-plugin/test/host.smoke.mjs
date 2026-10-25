/**
 * 宿主入口冒烟测试：用假 ctx 把 apply() 跑起来，确认路由注册与 engine 生命周期没问题。
 * 不需要真的 DSH 进程。
 *
 * 数据目录指向临时目录，避免把用户真实的 `~/.dsh/qq-agent/config.json` 改掉
 * （这个测试会调保存配置，早先的版本直接把真实人设写成了「冒烟测试」）。
 */
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandboxDir = mkdtempSync(join(tmpdir(), "dsh-qq-agent-smoke-"));
process.env.DSH_QQ_AGENT_DATA = sandboxDir;

const require = createRequire(import.meta.url);

const routes = [];
const disposers = [];
const effects = [];

const ctx = {
  logger: {
    info: (...args) => console.log("[info]", ...args),
    warn: (...args) => console.log("[warn]", ...args),
    error: (...args) => console.log("[error]", ...args),
  },
  get(name) {
    if (name === "connection") return ctx.connection;
    return undefined;
  },
  effect(factory, label) {
    effects.push(label);
    const disposer = factory();
    if (typeof disposer === "function") disposers.push(disposer);
  },
  connection: {
    fetch: {
      register(route) {
        routes.push(route);
        return () => {
          const index = routes.indexOf(route);
          if (index >= 0) routes.splice(index, 1);
        };
      },
    },
  },
};

const mod = await import("../lib/index.js");
console.log("exports:", Object.keys(mod).join(","), "| inject:", JSON.stringify(mod.inject));

mod.apply(ctx);

console.log("effects:", effects.join(" | "));
console.log(
  "routes:",
  routes.map((r) => r.methods.join("+") + " " + r.path).join(" | "),
);

// 逐个打一遍 GET 路由，验证响应形状（不进网络的分支）
for (const route of routes) {
  if (!route.methods.includes("GET")) continue;
  if (route.path.endsWith("/tts")) continue; // 这条会真的出网合成，跳过
  const request = new Request("http://127.0.0.1/api" + route.path.replace("/api", "") + "", { method: "GET" });
  const response = await route.fetch(request);
  const body = await response.json();
  console.log(route.path, "->", response.status, "ok=" + body.ok, "keys=" + Object.keys(body).join(","));
  if (body.state) {
    console.log(
      "  state: started=" + body.state.started,
      "paused=" + body.state.paused,
      "sessions=" + body.state.sessions,
      "shelf=" + body.state.shelfSize,
      "logs=" + (body.state.logs || []).length,
    );
  }
  if (body.config) console.log("  config.persona=" + body.config.persona.name, "master=" + (body.config.master.uin || "(未设置)"));
  if (body.presets) console.log("  presets=" + body.presets.map((p) => p.name).join("/"));
  console.log("  route:", JSON.stringify(body.route), "routeError:", JSON.stringify(body.routeError));
}

// POST action
const actionRoute = routes.find((r) => r.path.endsWith("/action"));
if (actionRoute) {
  const response = await actionRoute.fetch(
    new Request("http://127.0.0.1/api/qq-agent/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "status" }),
    }),
  );
  const body = await response.json();
  console.log("action status ->", response.status, "result:", JSON.stringify(body.result));
}

// POST config：改一个人设再读回来
const configRoute = routes.find((r) => r.path.endsWith("/config"));
if (configRoute) {
  const response = await configRoute.fetch(
    new Request("http://127.0.0.1/api/qq-agent/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config: { persona: { name: "冒烟测试" } } }),
    }),
  );
  const body = await response.json();
  console.log("config save ->", response.status, "persona.name =", body.config.persona.name);
}

// 清理：把 engine 停掉，并删掉本次用的沙箱数据目录
for (const dispose of disposers.reverse()) {
  try {
    if (typeof dispose === "function") await dispose();
  } catch (error) {
    console.log("[cleanup]", error.message);
  }
}
console.log("routes after dispose:", routes.length);
try {
  rmSync(sandboxDir, { recursive: true, force: true });
} catch (error) {
  console.log("[cleanup] 删除沙箱目录失败：", error.message);
}
console.log("沙箱数据目录：", sandboxDir, "（已清理）");
process.exit(0);
