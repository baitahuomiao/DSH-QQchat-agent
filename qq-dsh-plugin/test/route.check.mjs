/**
 * 在真实 DSH 进程里验证面板路由是否已注册。
 *
 * DSH Web 的所有 /api/* 都要浏览器 session cookie，直接 curl 会 401。这里按
 * `@deepseek-ai/dsh-client-connection` 的规则自己签一个：secret 存在
 * `~/.dsh/.credentials.yaml` 的 `client-connection/browser-session` 记录里，
 * cookie 名是 `dsh-auth-<sha256(authority) 的 base64url>`，
 * 值是 `v1.<base64url(payload)>.<base64url(hmacSha256(secret, body))>`。
 *
 * 用法：node test/route.check.mjs [baseUrl]
 */
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = process.argv[2] || "http://127.0.0.1:19387";
const COOKIE_PREFIX = "dsh-auth-";
const SECRET_BYTES = 32;

const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");

function readSecret() {
  const path = join(process.env.DSH_HOME || join(homedir(), ".dsh"), ".credentials.yaml");
  const text = readFileSync(path, "utf8");
  // 只取这一个记录，避免为了一个字段写完整 YAML 解析器：定位 key 后在后续窗口里找 secret。
  const at = text.indexOf("client-connection/browser-session");
  if (at < 0) throw new Error("凭据里没有 client-connection/browser-session 记录：" + path);
  const match = text.slice(at, at + 600).match(/secret:\s*([A-Za-z0-9_-]{20,})/);
  if (!match) throw new Error("没在凭据记录里找到 secret");
  const secret = Buffer.from(match[1].replaceAll("-", "+").replaceAll("_", "/"), "base64");
  if (secret.byteLength !== SECRET_BYTES) throw new Error("secret 长度不对：" + secret.byteLength);
  return secret;
}

function mintCookie(secret, authority) {
  const name = COOKIE_PREFIX + b64url(createHash("sha256").update(authority).digest());
  const now = Date.now();
  const payload = { version: 1, authority, issuedAt: now, expiresAt: now + 3600_000 };
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = b64url(createHmac("sha256", secret).update(body).digest());
  return { name, value: "v1." + body + "." + sig };
}

const authority = new URL(BASE).host;
const secret = readSecret();
const cookie = mintCookie(secret, authority);
console.log("baseUrl  :", BASE);
console.log("authority:", authority);
console.log("cookie   :", cookie.name, "= v1.<...>（已签名）");

async function call(path, init) {
  const response = await fetch(BASE + path, {
    ...init,
    headers: {
      accept: "application/json",
      cookie: cookie.name + "=" + cookie.value,
      ...(init && init.headers),
    },
  });
  const text = await response.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* 非 JSON 就原样留着 */
  }
  return { status: response.status, body };
}

// 先确认签名可用：/api/usage-float 是另一个插件已知会注册的路由
const control = await call("/api/usage-float");
console.log("\n对照 /api/usage-float ->", control.status, "（200/500 都说明鉴权通过了）");

const state = await call("/api/qq-agent/state");
console.log("/api/qq-agent/state ->", state.status);
if (state.status === 200 && state.body && state.body.ok) {
  const st = state.body.state || {};
  console.log("  started :", st.started, "| 已连上 OneBot：", st.connection && st.connection.connected);
  console.log("  账号    :", st.nickname || "(未连接)", st.selfId || "");
  console.log("  人设    :", (state.body.config && state.body.config.persona && state.body.config.persona.name) || "?");
  console.log("  主人    :", (state.body.config && state.body.config.master && state.body.config.master.uin) || "(未设置)");
  console.log("  模型路由:", JSON.stringify(state.body.route), state.body.routeError || "");
  console.log("  QQ 群   :", (state.body.groups || []).length, "个");
  console.log("  视频书架:", (st.shelf || []).length, "条");
  console.log("  键      :", Object.keys(state.body).join(","));
} else {
  console.log("  响应:", JSON.stringify(state.body).slice(0, 400));
}

if (state.status === 200) {
  const tts = await fetch(BASE + "/api/qq-agent/tts?text=" + encodeURIComponent("路由验证") , {
    headers: { cookie: cookie.name + "=" + cookie.value },
  });
  const buf = Buffer.from(await tts.arrayBuffer());
  console.log("/api/qq-agent/tts   ->", tts.status, tts.headers.get("content-type"), buf.length, "字节");
}
