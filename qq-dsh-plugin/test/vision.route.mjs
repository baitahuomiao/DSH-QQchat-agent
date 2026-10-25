/**
 * 看识图路由到底是什么。
 *
 * 背景：默认聊天路由（abc / deepseek-v41-flash）是纯文本模型，
 * 图片进去只会变成一句占位文字，「识图」等于没开。
 * 插件为此加了独立的 vision.provider / vision.model，
 * 并让 resolveRoute 在有图时优先挑声明了 image 模态的模型。
 *
 * 这个脚本同时验证「新宿主代码是否真的生效」：
 * 老版本 /state 没有 route.vision 字段。
 *
 * 用法：node test/vision.route.mjs [provider] [model]
 *   不带参数 = 只看现状。
 */
import { readFileSync } from "node:fs";
import { createHash, createHmac } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = "http://127.0.0.1:19387";
const AUTHORITY = "127.0.0.1:19387";

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

const state = await call("/api/qq-agent/state");
if (state.status !== 200) {
  console.log("/state ->", state.status, state.body);
  process.exit(1);
}

const route = state.body.route || {};
console.log("=== 聊天路由 ===");
console.log("  provider:", route.provider);
console.log("  model   :", route.model);

if (!route.vision) {
  console.log("\n⚠ 没有 route.vision —— 宿主进程跑的还是旧模块。");
  console.log("  这不是代码问题：热挂载读不到新的宿主代码（dshmarket 的");
  console.log("  createRequire().resolve 缓存 + Node 的 ESM URL 缓存，两道都不可失效）。");
  console.log("  装进去的产物本身是对的，先确认：node test/installed.check.mjs");
  console.log("  然后重启 DSH，再跑一次本脚本。");
  process.exit(1);
}

console.log("\n=== 识图路由 ===");
console.log("  provider  :", route.vision.provider);
console.log("  model     :", route.vision.model);
console.log("  能看图吗  :", route.vision.seesImages ? "能" : "不能（图片会被忽略）");
if (route.vision.error) console.log("  错误      :", route.vision.error);

const wanted = process.argv.slice(2);
if (wanted.length > 0) {
  const [provider, model] = wanted;
  console.log("\n=== 改配置 → " + provider + " / " + (model || "(自动)") + " ===");
  const saved = await call("/api/qq-agent/config", {
    method: "POST",
    body: JSON.stringify({ config: { vision: { provider: provider === "-" ? "" : provider, model: model === "-" ? "" : model || "" } } }),
  });
  console.log("  保存 ->", saved.status, JSON.stringify(saved.body && saved.body.vision).slice(0, 200));
  const next = saved.body && saved.body.state ? saved.body : null;
  const after = next || (await call("/api/qq-agent/state")).body;
  const vision = (after.route && after.route.vision) || {};
  console.log("  现在识图:", vision.provider + " / " + vision.model, "能看图:", vision.seesImages ? "能" : "不能");
  if (!vision.seesImages) {
    console.log("\n⚠ 这条路由也看不了图。可看图的组合：deepseek-official / deepseek-flash");
  }
}
