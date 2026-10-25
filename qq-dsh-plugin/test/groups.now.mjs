// 触发一次 refreshGroups 并把群列表打出来。
// cookie 规则见 test/route.check.mjs：**HMAC 签的是 base64url 后的 body 字符串**，
// 不是原始 JSON —— 这里对不上的话就是 401。
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOST = "127.0.0.1:19387";
const BASE = "http://" + HOST;

const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");

function readSecret() {
  const path = join(process.env.DSH_HOME || join(homedir(), ".dsh"), ".credentials.yaml");
  const text = readFileSync(path, "utf8");
  const at = text.indexOf("client-connection/browser-session");
  if (at < 0) throw new Error("凭据里没有 client-connection/browser-session 记录");
  const match = text.slice(at, at + 600).match(/secret:\s*([A-Za-z0-9_-]{20,})/);
  if (!match) throw new Error("没在凭据记录里找到 secret");
  const secret = Buffer.from(match[1].replaceAll("-", "+").replaceAll("_", "/"), "base64");
  if (secret.byteLength !== 32) throw new Error("secret 长度不对：" + secret.byteLength);
  return secret;
}

const secret = readSecret();
const now = Date.now();
const payload = { version: 1, authority: HOST, issuedAt: now, expiresAt: now + 3600_000 };
const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
const sig = b64url(createHmac("sha256", secret).update(body).digest());
const cookie = "dsh-auth-" + b64url(createHash("sha256").update(HOST).digest()) + "=v1." + body + "." + sig;

async function call(path, init) {
  const response = await fetch(BASE + path, {
    ...init,
    headers: {
      accept: "application/json",
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
    /* 非 JSON 原样 */
  }
  return { status: response.status, body: parsed };
}

const action = await call("/api/qq-agent/action", {
  method: "POST",
  body: JSON.stringify({ action: "refreshGroups" }),
});
console.log("POST /action refreshGroups ->", action.status);
if (action.status !== 200) {
  console.log(String(JSON.stringify(action.body)).slice(0, 300));
  process.exit(1);
}
console.log("message:", action.body.result && action.body.result.message);

const state = await call("/api/qq-agent/state");
const data = state.body || {};
const groups = data.groups || [];
console.log("群数量:", groups.length);
for (const g of groups) {
  console.log("  ", g.group_id, "|", g.group_name, "|", g.member_count, "人");
}

const st = data.state || {};
console.log(
  "QQ 连接:",
  st.connection && st.connection.connected ? "已连上 " + st.nickname + " " + st.selfId : "未连上",
);
console.log("会话数:", st.sessions, "| 已回复:", st.replyCount, "| 书架:", st.shelfSize);
