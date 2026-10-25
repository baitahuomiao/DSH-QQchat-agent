/**
 * 文生图。
 *
 * 走 OpenAI 兼容的 `/v1/images/generations`，这样能同时吃下
 * DALL·E、硅基流动、智谱、各类自建网关。不同家的差异用几个开关兜：
 *  - response_format: b64_json（默认）还是 url
 *  - size / model 名字
 *
 * 生成结果落盘成文件，交给 OneBot 以 image 段发送。
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const OUTPUT_DIR = path.join(os.tmpdir(), "dsh-qq-agent-image");

/**
 * 常见图像模型清单，供面板下拉选择。
 *
 * 标注了实测速度的是在这个账号上真的跑过的（硅基流动）。
 * 不在清单里的模型可以直接在手填框里写，不影响使用。
 */
const MODEL_CATALOG = [
  { id: "Tongyi-MAI/Z-Image-Turbo", label: "Z-Image-Turbo · 快（实测 4 秒）" },
  { id: "Tongyi-MAI/Z-Image", label: "Z-Image · 质量好但慢（实测 17 秒）" },
  { id: "Qwen/Qwen-Image", label: "Qwen-Image · 中文理解强（实测 12 秒）" },
  { id: "Qwen/Qwen-Image-Edit", label: "Qwen-Image-Edit · 图片编辑" },
  { id: "Qwen/Qwen-Image-Edit-2509", label: "Qwen-Image-Edit-2509 · 编辑新版" },
  { id: "Kwai-Kolors/Kolors", label: "Kolors · 可灵（实测 7 秒）" },
  { id: "dall-e-3", label: "DALL·E 3（OpenAI）" },
  { id: "dall-e-2", label: "DALL·E 2（OpenAI）" },
  { id: "Qwen-Image-2.1", label: "Qwen-Image-2.1（校园网关）" },
  { id: "cogview-3", label: "CogView-3（智谱）" },
  { id: "flux-schnell", label: "FLUX schnell（fal / 硅基）" },
  { id: "stable-diffusion-3-5-large", label: "SD 3.5 Large（Stability）" },
];

function messageOf(error) {
  return error && error.message ? error.message : String(error);
}

/** 把配置拼成可用的端点；留空则返回 null 表示未启用。 */
function resolveEndpoint(image) {
  const cfg = image || {};
  const baseUrl = String(cfg.baseUrl || "").trim().replace(/\/+$/, "");
  if (!baseUrl) return null;
  // 允许用户直接填完整端点，也允许只填到 /v1
  const url = /\/images\/generations$/.test(baseUrl) ? baseUrl : baseUrl + "/images/generations";
  return {
    url,
    apiKey: String(cfg.apiKey || "").trim(),
    model: String(cfg.model || "").trim() || "dall-e-3",
    size: String(cfg.size || "").trim() || "1024x1024",
    responseFormat: String(cfg.responseFormat || "").trim() || "b64_json",
  };
}

function ready(image) {
  return resolveEndpoint(image) !== null;
}

/**
 * 生成一张图，返回本地文件绝对路径。
 * @param {string} prompt
 * @param {object} image 配置
 * @param {{timeoutMs?:number}} [options]
 */
async function generate(prompt, image, options) {
  const endpoint = resolveEndpoint(image);
  if (!endpoint) throw new Error("生图未配置：请填写 baseUrl 与 API Key");
  const text = String(prompt || "").trim();
  if (!text) throw new Error("没有可用的绘图描述");

  const headers = { "content-type": "application/json" };
  if (endpoint.apiKey) headers.authorization = "Bearer " + endpoint.apiKey;

  const body = {
    model: endpoint.model,
    prompt: text,
    n: 1,
    size: endpoint.size,
    // 硅基流动用 image_size / batch_size，不认 n/size 里的某些组合；
    // 两个都带上，各家认哪个用哪个，多余的会被忽略
    image_size: endpoint.size,
    batch_size: 1,
  };
  if (endpoint.responseFormat === "url" || endpoint.responseFormat === "b64_json") {
    body.response_format = endpoint.responseFormat;
  }
  // 负面提示词（硅基流动、Kolors 等支持）
  const negative = String((image && image.negativePrompt) || "").trim();
  if (negative) body.negative_prompt = negative;
  // 采样步数（部分模型支持，留空则不传）
  const steps = Number(image && image.steps);
  if (Number.isFinite(steps) && steps > 0) body.num_inference_steps = Math.round(steps);
  // 随机种子，0/不填表示随机
  const seed = Number(image && image.seed);
  if (Number.isFinite(seed) && seed > 0) body.seed = Math.round(seed);

  const timeoutMs = Math.max(20000, Number((options && options.timeoutMs) || 0) || 120000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(endpoint.url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    throw new Error("生图请求失败：" + messageOf(error));
  }
  clearTimeout(timer);

  const raw = await response.text();
  if (!response.ok) {
    throw new Error("生图接口 HTTP " + response.status + "：" + raw.slice(0, 200));
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error("生图接口返回了非 JSON 内容：" + raw.slice(0, 120));
  }

  const first = pickFirstImage(payload);
  if (!first) throw new Error("生图接口没有返回图片：" + describeShape(payload));

  let bytes = null;
  if (first.b64_json) {
    bytes = Buffer.from(String(first.b64_json), "base64");
  } else if (first.url) {
    bytes = await downloadImage(String(first.url));
  }
  if (!bytes || bytes.length < 256) throw new Error("生图返回的图片数据为空");

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const digest = crypto.createHash("sha1").update(bytes).digest("hex").slice(0, 16);
  const file = path.join(OUTPUT_DIR, "img-" + digest + ".png");
  fs.writeFileSync(file, bytes);
  return file;
}

/**
 * 从各家五花八门的响应里挑出第一张图。
 *
 * 已知两种形状：
 *  - OpenAI / 多数网关：{ data: [{ b64_json }] } 或 { data: [{ url }] }
 *  - 硅基流动：{ images: [{ url }], seed, timings }
 * 有些网关还会把图放在 { output: [...] } 或直接 { url }。
 */
function pickFirstImage(payload) {
  if (!payload || typeof payload !== "object") return null;
  const pools = [payload.data, payload.images, payload.output, payload.results, payload.artifacts];
  for (const pool of pools) {
    if (Array.isArray(pool) && pool.length > 0) {
      const hit = pool.find((it) => it && (it.b64_json || it.url || it.image_url || it.base64));
      if (hit) {
        return {
          b64_json: hit.b64_json || hit.base64 || (hit.image_base64 ? hit.image_base64 : ""),
          url: hit.url || hit.image_url || "",
        };
      }
    }
  }
  // 兜底：顶层就是单张图
  if (payload.b64_json || payload.url) return { b64_json: payload.b64_json || "", url: payload.url || "" };
  return null;
}

/** 出错时把响应形状说出来，方便判断是哪家格式没接上。 */
function describeShape(payload) {
  if (!payload || typeof payload !== "object") return "响应不是对象";
  const keys = Object.keys(payload);
  const extra = keys
    .filter((k) => Array.isArray(payload[k]))
    .map((k) => k + "[" + payload[k].length + "]")
    .join(" ");
  return "顶层字段 " + keys.join(",") + (extra ? "；数组：" + extra : "");
}

async function downloadImage(url) {
  if (!/^https?:\/\//i.test(url)) throw new Error("图片地址不合法");
  const response = await fetch(url);
  if (!response.ok) throw new Error("下载生成的图片失败 HTTP " + response.status);
  const buffer = Buffer.from(await response.arrayBuffer());
  return buffer;
}

/** 转成 OneBot 能吃的 file:// URL。 */
function toFileUrl(filePath) {
  const normalized = path.resolve(filePath).replace(/\\/g, "/");
  return "file:///" + normalized.replace(/^\/+/, "");
}

/** 清理旧输出，避免 temp 里堆几百张图。 */
function prune(maxAgeHours) {
  const cutoff = Date.now() - (Number(maxAgeHours) || 24) * 3600 * 1000;
  try {
    for (const name of fs.readdirSync(OUTPUT_DIR)) {
      const full = path.join(OUTPUT_DIR, name);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* 目录不存在 */
  }
}

module.exports = { generate, ready, resolveEndpoint, toFileUrl, prune, OUTPUT_DIR, MODEL_CATALOG };
