/**
 * 临时把 llm.provider 切到某个 provider，看它的模型清单（含 inputModalities），
 * 看完自动恢复原配置。用来确认「识图」该挂在哪条路由上。
 *
 * 用法：node test/provider.probe.mjs deepseek-official
 */
import { readFileSync } from "node:fs";
import { createHash, createHmac } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = "http://127.0.0.1:19387";
const AUTHORITY = "127.0.0.1:19387";
const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function cookie() {
  const text = readFileSync(join(process.env.DSH_HOME || join(homedir(), ".dsh"), ".credentials.yaml"), "utf8");
  const at = text.indexOf("client-connection/browser-session:");
  const secret = Buffer.from(/secret:\s*([A-Za-z0-9_-]+)/.exec(text.slice(at))[1].replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const name = "dsh-auth-" + b64url(createHash("sha256").update(AUTHORITY).digest());
  const issuedAt = Date.now();
  const body = b64url(JSON.stringify({ version: 1, authority: AUTHORITY, issuedAt, expiresAt: issuedAt + 3600_000 }));
  return name + "=v1." + body + "." + b64url(createHmac("sha256", secret).update(body).digest());
}

const headers = { accept: "application/json", origin: BASE, cookie: cookie(), "content-type": "application/json" };
const get = async (path) => (await fetch(BASE + path, { headers })).json();
const post = async (path, payload) =>
  (
    await fetch(BASE + path, { method: "POST", headers, body: JSON.stringify(payload) })
  ).json();

const target = process.argv[2];
if (!target) {
  const state = await get("/api/qq-agent/state");
  console.log("可用 provider：");
  for (const row of state.route?.providers || []) console.log("  -", row.id, "(" + row.name + ")");
  process.exit(0);
}

const before = await get("/api/qq-agent/state");
const originalProvider = before.config.llm.provider;
const originalModel = before.config.llm.model;
console.log("原配置：provider=" + JSON.stringify(originalProvider) + " model=" + JSON.stringify(originalModel));

try {
  const saved = await post("/api/qq-agent/config", { config: { llm: { provider: target, model: "" } } });
  console.log("\n切到 " + target + " => routeError: " + JSON.stringify(saved.routeError));
  console.log("选中：" + JSON.stringify(saved.route && { provider: saved.route.provider, model: saved.route.model }));
  console.log("模型清单：");
  for (const row of saved.route?.models || []) {
    console.log("  - " + row.id + "  modalities=" + JSON.stringify(row.inputModalities));
  }
} finally {
  const restored = await post("/api/qq-agent/config", { config: { llm: { provider: originalProvider, model: originalModel } } });
  console.log("\n已恢复：provider=" + JSON.stringify(restored.config.llm.provider) + " model=" + JSON.stringify(restored.config.llm.model));
}
