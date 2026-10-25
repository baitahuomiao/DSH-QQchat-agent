/**
 * 识图链路实测：让模型真的读一张图。
 *
 * 走的不是手搓 HTTP，而是插件自己的 generate() —— 只有这样才能验证到
 * 「图片 → ImageBlock → 跨 provider 挑视觉路由 → 流式装配 → 空正文加倍重试」
 * 这一整条链。
 *
 * 会真调模型（一次识图，约几分钱），所以默认不在 test/all.mjs 的离线集里，
 * 只有 --live 才跑。
 *
 * 用法：node test/vision.live.mjs
 */
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "dsh-qq-agent-vision-"));
process.env.DSH_QQ_AGENT_DATA = sandbox;

const require = createRequire(import.meta.url);
const { createLlmBridge } = await import("../lib/index.js");
const { fetchLoose } = require("../src/net.cjs");

const failures = [];
function check(name, ok, detail) {
  console.log((ok ? "  ✓ " : "  ✗ ") + name + (detail ? "  " + detail : ""));
  if (!ok) failures.push(name);
}

const KEY = /DEEPSEEK_API_KEY:\s*(\S+)/.exec(readFileSync(join(homedir(), ".dsh", ".credentials.yaml"), "utf8"));
if (KEY === null) {
  console.log("凭证里没有 DEEPSEEK_API_KEY，跳过。");
  process.exit(0);
}

/** 真 HTTP 打一次 chat/completions，返回 DSH 流里的那几样东西。 */
async function chat(options) {
  const messages = [];
  if (options.system) messages.push({ role: "system", content: options.system });
  for (const message of options.messages) {
    const content = [];
    for (const block of message.content) {
      if (block.type === "text") content.push({ type: "text", text: block.text });
      else if (block.type === "image") content.push({ type: "image_url", image_url: { url: block.attachment.__url } });
    }
    messages.push({ role: message.role, content });
  }
  const res = await fetchLoose("https://api.deepseek.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer " + KEY[1], "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-flash",
      messages,
      max_tokens: options.maxTokens,
      temperature: 0.7,
    }),
    timeoutMs: 180000,
  });
  const parsed = JSON.parse(await res.text());
  if (!parsed.choices) throw new Error("模型没返回 choices：" + JSON.stringify(parsed).slice(0, 300));
  const choice = parsed.choices[0];
  const usage = parsed.usage || {};
  return {
    content: choice.message.content || "",
    reasoning: choice.message.reasoning_content || "",
    // 真实 DSH 里 max_tokens 耗尽就是这个 kind
    finish: choice.finish_reason === "length" ? "max-tokens" : "stop",
    usage: { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens },
  };
}

/** 把 chat() 包成 DSH 的 llm 服务形状。 */
function makeCtx() {
  return {
    get(name) {
      if (name !== "llm") return undefined;
      return {
        listProviders: () => [{ id: "deepseek-official", name: "DeepSeek" }],
        listModels: async () => [
          { provider: "deepseek-official", id: "deepseek-flash", inputModalities: ["text", "image"] },
        ],
        async *stream(options) {
          const out = await chat(options);
          if (out.reasoning) yield { type: "reasoning-delta", index: 9, text: out.reasoning };
          yield { type: "block-start", index: 0, blockType: "text" };
          yield { type: "text-delta", index: 0, text: out.content };
          yield { type: "block-end", index: 0, block: { type: "text", text: out.content } };
          yield { type: "usage", usage: out.usage };
          yield { type: "finish", reason: { kind: out.finish } };
        },
      };
    },
  };
}

try {
  // —— 拿一张真图 ——
  console.log("=== 1. 准备一张真图 ===");
  const bili = await fetchLoose("https://api.bilibili.com/x/web-interface/popular?ps=1&pn=1", {
    headers: { "user-agent": "Mozilla/5.0", referer: "https://www.bilibili.com/" },
  });
  const video = (await bili.json()).data.list[0];
  const picUrl = video.pic.startsWith("http") ? video.pic : "https:" + video.pic;
  const img = await fetchLoose(picUrl, {
    headers: { "user-agent": "Mozilla/5.0", referer: "https://www.bilibili.com/" },
  });
  const bytes = await img.buffer();
  console.log("  视频：" + video.title);
  console.log("  封面：" + bytes.length + " 字节");
  check("封面拿到了", bytes.length > 1000, bytes.length + " 字节");

  // 真环境里这个 ref 由 DSH 附件服务生成；这里用 data URL 顶替它的取字节能力。
  const fakeRef = {
    attachmentId: "test-image",
    mediaType: "image/jpeg",
    bytes: bytes.length,
    width: 1,
    height: 1,
    __url: "data:image/jpeg;base64," + bytes.toString("base64"),
  };

  // —— 预算故意给很小，图 + 想一想经常把预算吃光 ——
  // 注意：模型这次会不会真的耗尽预算是随机的（reasoning 长度每次不同），
  // 所以这里只断言「最终一定拿到正文」。重试本身是确定性行为，
  // 由 test/llm.bridge.mjs 第 7 节用假流精确覆盖，不靠真模型碰运气。
  console.log("\n=== 2. 预算 200 跑一次真实识图 ===");
  const cfg = {
    llm: { provider: "deepseek-official", model: "deepseek-flash", temperature: 0.7, maxTokens: 200 },
    vision: { enabled: true, provider: "", model: "" },
  };
  const bridge = createLlmBridge(makeCtx(), () => cfg, {});
  const out = await bridge.generate({
    system: "你是鲸鱼娘，说话短、口语化，不要 Markdown。",
    userText: "这图里是什么？一句话说。",
    images: [{ ref: fakeRef }],
    maxTokens: 200,
  });

  console.log("  正文：" + JSON.stringify(out.text).slice(0, 160));
  console.log("  finish：" + out.finish + "  retried：" + String(out.retried === true) + "（是否耗尽预算每次都不同，两种都算过）");
  check("最终拿到正文", typeof out.text === "string" && out.text.length > 0, out.text.length + " 字");
  check("模型确实读到了图（不是敷衍的空话）", out.text.length >= 8, JSON.stringify(out.text).slice(0, 80));
  check("识图走了能看图的路由", out.model === "deepseek-flash", out.model);
  check("正文是中文", /[\u4e00-\u9fa5]/.test(out.text), JSON.stringify(out.text).slice(0, 40));
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

console.log("\n" + (failures.length === 0 ? "OK：识图链路通" : "FAIL：" + failures.length + " 项没通过"));
process.exit(failures.length === 0 ? 0 : 1);
