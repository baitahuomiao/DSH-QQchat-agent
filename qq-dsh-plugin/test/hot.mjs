/**
 * 不重启就让宿主加载插件。
 *
 * 背景：插件装进 profile 后，只有下次进程启动时 bundle 层才会把它组进组合树；
 * 当前这个宿主进程是装之前启动的，所以 /api/qq-agent/* 一直是 404。
 * 而 dshmarket 有一条「热挂载」通道（/dsh-market/toggle → hotMount），
 * 它用 cordis-plugin-include 往活着的组合树里插一个临时子树，
 * 效果等价于重启，但不用杀进程（也就不必中断这个会话）。
 *
 * 鉴权：走 DSH 自签 cookie（与 route.check.mjs 同一套规则），
 * 外加 market 自己要求的 same-origin（Origin 必须与 Host 完全一致）。
 *
 * 用法：node test/hot.mjs
 */
import { readFileSync } from "node:fs";
import { createHash, createHmac } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = "http://127.0.0.1:19387";
const AUTHORITY = "127.0.0.1:19387";
const PLUGIN = "dsh-qq-agent";

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function readSecret() {
  const path = join(process.env.DSH_HOME || join(homedir(), ".dsh"), ".credentials.yaml");
  const text = readFileSync(path, "utf8");
  const at = text.indexOf("client-connection/browser-session:");
  const match = /secret:\s*([A-Za-z0-9_-]+)/.exec(text.slice(at));
  if (match === null) throw new Error("凭证里没找到 client-connection/browser-session 的 secret");
  return Buffer.from(match[1].replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function authCookie() {
  const secret = readSecret();
  const name = "dsh-auth-" + b64url(createHash("sha256").update(AUTHORITY).digest());
  const issuedAt = Date.now();
  const body = b64url(JSON.stringify({ version: 1, authority: AUTHORITY, issuedAt, expiresAt: issuedAt + 3600_000 }));
  const mac = b64url(createHmac("sha256", secret).update(body).digest());
  return name + "=v1." + body + "." + mac;
}

const cookie = authCookie();

async function call(path, init) {
  const response = await fetch(BASE + path, {
    ...init,
    headers: {
      accept: "application/json",
      origin: BASE,
      cookie,
      ...(init && init.body ? { "content-type": "application/json" } : {}),
      ...((init && init.headers) || {}),
    },
  });
  const text = await response.text();
  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* 保留原文 */
  }
  return { status: response.status, body: parsed };
}

// —— 1. 先看现在是什么状况 ——
console.log("=== 1. 现状 ===");
const before = await call("/api/qq-agent/state");
console.log("  /api/qq-agent/state ->", before.status, typeof before.body === "string" ? before.body : "ok");

// 已经在跑：说明用的是旧宿主代码，要重挂一次才会读到新 lib/index.js。
// 这一步会把 QQ 连接断一下再连回来。
const wasLive = before.status === 200;
if (before.status !== 404 && before.status !== 200) {
  console.log("\n非 404/200（" + before.status + "），先别动，检查鉴权或宿主状态。");
  process.exit(1);
}

// —— 2. 让 market 热挂载 ——
// 注意：这条路**改不了宿主代码**。dshmarket 用 createRequire().resolve(包名) 取入口，
// 结果缓存在 Module._pathCache；Node 的 ESM 缓存又按 URL 存。两道都在进程内且不可失效。
// 所以它只在「包已装好但还没被加载」时有用（例如刚装完、还没重启）。
console.log(wasLive ? "\n=== 2. 已在运行，先卸载再重挂（只重建实例，不重读模块） ===" : "\n=== 2. 请求 dshmarket 热挂载 ===");
if (wasLive) {
  const off = await call("/dsh-market/toggle", {
    method: "POST",
    body: JSON.stringify({ name: PLUGIN, enabled: false }),
  });
  console.log("  卸载 ->", off.status, JSON.stringify(off.body).slice(0, 300));
  // 等组合树把旧的子树拆干净，否则重挂会撞 id
  await new Promise((resolve) => setTimeout(resolve, 1200));
}

const toggle = await call("/dsh-market/toggle", {
  method: "POST",
  body: JSON.stringify({ name: PLUGIN, enabled: true }),
});
console.log("  /dsh-market/toggle ->", toggle.status, JSON.stringify(toggle.body).slice(0, 400));

// —— 3. 再探一次 ——
console.log("\n=== 3. 复查 ===");
for (let attempt = 1; attempt <= 10; attempt += 1) {
  const now = await call("/api/qq-agent/state");
  console.log("  第 " + attempt + " 次 /state ->", now.status);
  if (now.status === 200) {
    const body = now.body;
    console.log("\n插件已挂载：");
    console.log("  人设   :", body.config?.persona?.name);
    console.log("  主人   :", body.config?.master?.uin || "(未设置)");
    console.log("  模型路由:", body.route ? body.route.provider + " / " + body.route.model : "(不可用) " + body.routeError);
    console.log("  QQ 连接:", JSON.stringify(body.state?.connection));
    console.log("  已装预设:", (body.presets || []).map((p) => p.name).join(" / "));
    if (!body.route || !body.route.vision) {
      console.log("\n注：这次的 /state 里还没有 route.vision。");
      console.log("  若你这轮改的是宿主代码，这是预期的 —— 热挂载读不到新模块，需要重启 DSH。");
      console.log("  先确认装进去的产物是新的：node test/installed.check.mjs");
    }
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 800));
}

console.log("\n热挂载没成功 —— 需要手动重启 DSH。");
process.exit(1);
