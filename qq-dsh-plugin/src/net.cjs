/**
 * 网络小工具：本机走 MITM 代理时 node 的 fetch 会因为不信任系统根证书而失败。
 * `fetchLoose` 先走标准 fetch，遇到证书类错误再用 node:https 关掉校验重试一次。
 */
"use strict";

const HTTPS = require("node:https");
const HTTP = require("node:http");
const { URL } = require("node:url");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const TLS_HINTS = [
  "certificate",
  "CERT_",
  "UNABLE_TO_VERIFY",
  "self-signed",
  "self signed",
  "ERR_TLS",
  "unable to get local issuer",
];

function looksLikeTlsError(error) {
  const text = String((error && (error.message || error.code)) || "") + " " + String((error && error.cause && (error.cause.code || error.cause.message)) || "");
  return TLS_HINTS.some((hint) => text.toLowerCase().includes(hint.toLowerCase()));
}

/** 低层请求：返回 { status, headers, body: Buffer }。 */
function rawRequest(url, options) {
  const opts = options || {};
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const isHttps = target.protocol === "https:";
    const mod = isHttps ? HTTPS : HTTP;
    const req = mod.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: target.pathname + target.search,
        method: opts.method || "GET",
        headers: opts.headers || {},
        rejectUnauthorized: false,
        timeout: opts.timeoutMs || 20000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("请求超时")));
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/**
 * 带兜底的 fetch，返回 { status, headers, ok, buffer(), text(), json() }。
 * @param {string} url
 * @param {{method?:string, headers?:Record<string,string>, body?:any, timeoutMs?:number, signal?:AbortSignal}} [options]
 */
async function fetchLoose(url, options) {
  const opts = options || {};
  const headers = Object.assign({ "User-Agent": UA }, opts.headers || {});
  const timeoutMs = opts.timeoutMs || 20000;

  let body = opts.body;
  if (body !== undefined && body !== null && typeof body !== "string" && !Buffer.isBuffer(body)) {
    body = JSON.stringify(body);
    if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";
  }

  const signal = opts.signal || AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(url, { method: opts.method || "GET", headers, body, signal });
    const buffer = Buffer.from(await response.arrayBuffer());
    return wrap(response.status, response.headers, buffer);
  } catch (error) {
    if (!looksLikeTlsError(error) || typeof signal.aborted === "boolean" && signal.aborted) throw error;
    const response = await rawRequest(url, { method: opts.method || "GET", headers, body, timeoutMs });
    return wrap(response.status, response.headers, response.body);
  }
}

function wrap(status, headers, buffer) {
  const headerGet = (name) => {
    if (!headers) return undefined;
    if (typeof headers.get === "function") return headers.get(name) || undefined;
    const key = Object.keys(headers).find((k) => k.toLowerCase() === String(name).toLowerCase());
    return key ? headers[key] : undefined;
  };
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: headerGet },
    buffer: () => buffer,
    text: () => buffer.toString("utf8"),
    json: () => JSON.parse(buffer.toString("utf8")),
  };
}

module.exports = { fetchLoose, rawRequest, looksLikeTlsError, UA };
