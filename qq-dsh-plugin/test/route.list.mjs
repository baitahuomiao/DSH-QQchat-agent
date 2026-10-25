/**
 * 看宿主当前有哪些模型路由可选，以及默认选中的是谁。
 * 用法：node test/route.list.mjs
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

const response = await fetch(BASE + "/api/qq-agent/state", { headers: { cookie: cookie(), accept: "application/json" } });
const body = await response.json();
if (response.status !== 200) {
  console.log("状态码", response.status, JSON.stringify(body).slice(0, 300));
  process.exit(1);
}
console.log("routeError:", body.routeError);
console.log("选中路由 :", JSON.stringify(body.route && { provider: body.route.provider, model: body.route.model }));
console.log("providers:", JSON.stringify(body.route && body.route.providers));
console.log("models   :", JSON.stringify(body.route && body.route.models));
console.log("配置     :", JSON.stringify(body.config.llm));
console.log("连接     :", JSON.stringify(body.state.connection));
console.log("群数量   :", body.groups.length, "好友:", body.friends.length);
