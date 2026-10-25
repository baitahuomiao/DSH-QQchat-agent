/**
 * 验证模型桥接：engine 那套简单参数要被翻译成合法的 DSH GenerateOptions。
 *
 * 抓的都是真实约束：
 *  - 消息必须用 createUserMessage / createAssistantMessage 造（裸对象缺 durable id 会被适配器拒绝）；
 *  - 不能传 purpose（枚举只有 compaction / session-title）；
 *  - system 走 GenerateOptions.system，不进 messages；
 *  - 流里的 reasoning-delta 要能攒成 reasoning。
 *
 * 用假 ctx 跑，不连真模型、不烧 token。
 *
 * 用法：node test/llm.bridge.mjs
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const { collectStream, createLlmBridge, createWebBridge, resolveRoute } = await import("../lib/index.js");

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? "  ✓ " : "  ✗ ") + name + (detail ? "  " + detail : ""));
  if (!ok) failures += 1;
}

// —— 假 ctx ——
let captured = null;
const fakeChunks = [
  { type: "block-start", index: 0, blockType: "text" },
  { type: "reasoning-delta", index: 9, text: "先想一想。" },
  { type: "text-delta", index: 0, text: "我在" },
  { type: "text-delta", index: 0, text: "呢。" },
  { type: "block-end", index: 0, block: { type: "text", text: "我在呢。" } },
  { type: "usage", usage: { inputTokens: 42, outputTokens: 7 } },
  { type: "finish", reason: { kind: "stop" } },
];

function makeCtx(overrides) {
  const llm = {
    listProviders: () => [{ id: "deepseek", name: "DeepSeek" }],
    listModels: async () => [
      { provider: "deepseek", id: "deepseek-chat", name: "chat", inputModalities: ["text"] },
      { provider: "deepseek", id: "deepseek-vl", name: "vl", inputModalities: ["text", "image"] },
    ],
    async *stream(options) {
      captured = options;
      for (const chunk of fakeChunks) yield chunk;
    },
  };
  const services = { llm, ...overrides };
  return {
    get(name) {
      return services[name];
    },
  };
}

const cfg = {
  llm: { provider: "", model: "", temperature: 1.1, maxTokens: 700 },
  vision: { enabled: true },
};

// —— 1. collectStream ——
console.log("\n=== 1. collectStream 认 chunk ===");
{
  const stream = collectStream();
  for (const chunk of fakeChunks) stream.push(chunk);
  check("finish.kind", stream.finish.kind === "stop", "-> " + stream.finish.kind);
  check("usage", stream.usage && stream.usage.inputTokens === 42, JSON.stringify(stream.usage));
  check("reasoning 单独累加", stream.reasoning.trim() === "先想一想。", JSON.stringify(stream.reasoning));
  const text = stream.order
    .filter((i) => stream.parts.get(i).type === "text")
    .map((i) => stream.parts.get(i).text)
    .join("");
  check("文本按 index 拼好", text === "我在呢。", JSON.stringify(text));
}

// —— 2. resolveRoute 留空时退第一个 ——
console.log("\n=== 2. resolveRoute ===");
{
  // 缓存按 provider 分桶：识图要在多条路由之间挑模型，只存一条会把上一条挤掉
  const cache = {};
  const route = await resolveRoute(makeCtx({}), cfg, cache);
  check("provider 留空取第一个", route.provider === "deepseek", route.provider);
  check("model 留空取第一个", route.model === "deepseek-chat", route.model);
  check(
    "缓存起来了",
    cache.byProvider instanceof Map && cache.byProvider.has("deepseek"),
    "keys=" + [...(cache.byProvider || new Map()).keys()].join(","),
  );

  const route2 = await resolveRoute(makeCtx({}), { llm: { provider: "不存在的", model: "也不存在" } }, {});
  check("配了不存在的 provider 也不炸", route2.provider === "deepseek", route2.provider);
  check("配了不存在的 model 退回第一个", route2.model === "deepseek-chat", route2.model);

  let threw = "";
  try {
    await resolveRoute(makeCtx({ llm: null }), cfg, {});
  } catch (error) {
    threw = error.message;
  }
  check("没有 llm 服务时报中文错", threw.includes("模型服务不可用"), threw);
}

// —— 3. generate 的请求形状 ——
console.log("\n=== 3. generate → GenerateOptions ===");
{
  const ctx = makeCtx({});
  const bridge = createLlmBridge(ctx, () => cfg);
  const result = await bridge.generate({
    system: "你是鲸鱼娘。",
    history: [
      { role: "user", text: "在吗" },
      { role: "assistant", text: "在呀" },
      { role: "user", text: "" }, // 空文本应被跳过
    ],
    userText: "今天天气怎么样",
    images: [],
    temperature: 0.9,
    maxTokens: 500,
  });

  check("返回 text", result.text === "我在呢。", JSON.stringify(result.text));
  check("返回 reasoning", result.reasoning === "先想一想。", JSON.stringify(result.reasoning));
  check("返回 usage", result.usage && result.usage.input === 42 && result.usage.output === 7, JSON.stringify(result.usage));
  check("返回 provider/model", result.provider === "deepseek" && result.model === "deepseek-chat");

  check("请求里没有 purpose", !("purpose" in captured), Object.keys(captured).join(","));
  check("system 走顶层", captured.system === "你是鲸鱼娘。", JSON.stringify(captured.system));
  check("temperature/maxTokens 透传", captured.temperature === 0.9 && captured.maxTokens === 500);
  check("messages 数量 = 2 历史 + 1 当前", captured.messages.length === 3, "-> " + captured.messages.length);

  const [first, second, last] = captured.messages;
  check("user 消息有 durable id", typeof first.id === "string" && first.id.length > 0, String(first.id));
  check("assistant 消息有 durable id", typeof second.id === "string" && second.id.length > 0, String(second.id));
  check("assistant 带 model source", second.source && second.source.kind === "model" && second.source.model === "deepseek-chat", JSON.stringify(second.source));
  check("历史顺序没乱", first.role === "user" && second.role === "assistant" && last.role === "user");
  check("当前消息是最后一条", last.content[last.content.length - 1].text === "今天天气怎么样");
  check("system 没混进 messages", !captured.messages.some((m) => m.role === "system"));
}

// —— 4. 失败路径 ——
console.log("\n=== 4. 模型报错时抛中文 ===");
{
  const ctx = makeCtx({
    llm: {
      listProviders: () => [{ id: "deepseek", name: "DeepSeek" }],
      listModels: async () => [{ provider: "deepseek", id: "deepseek-chat" }],
      async *stream() {
        yield { type: "finish", reason: { kind: "error", failure: { code: "AUTH", message: "凭据无效" } } };
      },
    },
  });
  const bridge = createLlmBridge(ctx, () => cfg);
  let threw = "";
  try {
    await bridge.generate({ userText: "喂", history: [], images: [] });
  } catch (error) {
    threw = error.message;
  }
  check("抛出带原因的中文错误", threw.includes("模型请求失败") && threw.includes("凭据无效"), threw);
}

// —— 6. 带图时换视觉路由 ——
console.log("\n=== 6. 带图自动切到能看图的模型 ===");
{
  const imageRef = { attachmentId: "att-1", mediaType: "image/png", bytes: 100, width: 4, height: 4 };

  // 默认路由是纯文本的 deepseek-chat，但有图时应该自动挑 deepseek-vl
  const ctx = makeCtx({});
  const bridge = createLlmBridge(ctx, () => cfg);
  const withImage = await bridge.generate({ userText: "看看这张图", history: [], images: [{ ref: imageRef }] });
  check("带图时挑中能看图的模型", withImage.model === "deepseek-vl", withImage.model);

  const blocks = captured.messages[captured.messages.length - 1].content;
  check("图片块排在文字前面", blocks[0].type === "image" && blocks[blocks.length - 1].type === "text", blocks.map((b) => b.type).join(","));
  check("图片块带 attachment", blocks[0].attachment && blocks[0].attachment.attachmentId === "att-1", JSON.stringify(blocks[0].attachment));

  // 没图时仍然用默认的纯文本模型
  await bridge.generate({ userText: "只聊天", history: [], images: [] });
  check("没图时回到默认模型", captured.messages[captured.messages.length - 1].content.every((b) => b.type === "text"));

  // 显式指定识图路由时要听配置的
  const cfg2 = { llm: { provider: "", model: "", temperature: 1, maxTokens: 500 }, vision: { enabled: true, provider: "deepseek", model: "deepseek-vl" } };
  const forced = await createLlmBridge(makeCtx({}), () => cfg2).generate({ userText: "看图", history: [], images: [{ ref: imageRef }] });
  check("识图路由可显式指定", forced.model === "deepseek-vl", forced.model);

  // describe() 要把识图路由一起报出来，面板才能提示「能不能看图」
  const described = await bridge.describe();
  check("describe 报出识图路由", described.vision && described.vision.model === "deepseek-vl", JSON.stringify(described.vision));
  check("describe 标明能看图", described.vision && described.vision.seesImages === true);
}

// —— 6b. 聊天路由是纯文本时，识图要跨到别的 provider 找 ——
// 真实场景：用户聊天走 abc/deepseek-v41-flash（只有 text），
// 而 deepseek-official 下的 deepseek-flash 才能看图。
// 只在聊天 provider 里找「能看图的模型」永远找不到，识图就等于没开。
console.log("\n=== 6b. 聊天路由看不了图时跨 provider 兜底 ===");
{
  const imageRef = { attachmentId: "att-2", mediaType: "image/png", bytes: 10, width: 2, height: 2 };
  const providers = [
    { id: "abc", name: "deep seek" },
    { id: "deepseek-official", name: "DeepSeek" },
  ];
  const modelsByProvider = {
    abc: [{ provider: "abc", id: "deepseek-v41-flash", name: "V4.1", inputModalities: ["text"] }],
    "deepseek-official": [
      { provider: "deepseek-official", id: "deepseek-flash", name: "Flash", inputModalities: ["text", "image"] },
      { provider: "deepseek-official", id: "deepseek-v4-pro", name: "Pro", inputModalities: ["text"] },
    ],
  };
  const llm = {
    listProviders: () => providers,
    listModels: async (provider) => modelsByProvider[provider] || [],
    async *stream(options) {
      captured = options;
      for (const chunk of fakeChunks) yield chunk;
    },
  };
  const ctx = { get: (name) => (name === "llm" ? llm : undefined) };
  // 聊天路由固定在 abc，识图没单独配
  const textOnly = { llm: { provider: "abc", model: "deepseek-v41-flash", temperature: 1, maxTokens: 400 }, vision: { enabled: true, provider: "", model: "" } };

  const result = await createLlmBridge(ctx, () => textOnly).generate({ userText: "这是什么", history: [], images: [{ ref: imageRef }] });
  check("跨到能看图的 provider", result.provider === "deepseek-official" && result.model === "deepseek-flash", result.provider + " / " + result.model);

  const described = await createLlmBridge(ctx, () => textOnly).describe();
  check("describe 的聊天路由仍是 abc", described.provider === "abc" && described.model === "deepseek-v41-flash", described.provider + " / " + described.model);
  check("describe 的识图路由跨到 deepseek-official", described.vision && described.vision.provider === "deepseek-official", JSON.stringify(described.vision && described.vision.provider));
  check("describe 标出两条路由不一样", described.vision && described.vision.differs === true);

  // 一条能看图的都没有时，如实报 false，而不是假装能看
  const noneSee = {
    listProviders: () => [{ id: "only-text", name: "Text" }],
    listModels: async () => [{ provider: "only-text", id: "t1", name: "t1", inputModalities: ["text"] }],
    async *stream(options) {
      captured = options;
      for (const chunk of fakeChunks) yield chunk;
    },
  };
  const ctxNone = { get: (name) => (name === "llm" ? noneSee : undefined) };
  const described2 = await createLlmBridge(ctxNone, () => textOnly).describe();
  check("没有视觉模型时不谎报", described2.vision && described2.vision.seesImages === false, JSON.stringify(described2.vision && described2.vision.seesImages));
}

// —— 5. web 桥接 ——
console.log("\n=== 5. web.search 拍平 ===");
{
  const ctx = makeCtx({
    web: {
      async search() {
        return { sources: [{ url: "https://a.example/1", title: "标题甲", snippet: "片段甲" }], truncated: false };
      },
    },
  });
  const rows = await createWebBridge(ctx).search("随便问问", { maxResults: 3 });
  check("ct.wx.search 的 sources 拍平成数组", rows.length === 1 && rows[0].title === "标题甲", JSON.stringify(rows));

  const empty = await createWebBridge(makeCtx({})).search("没有 web 服务");
  check("没有 web 服务时回落 Bing RSS（不抛错）", Array.isArray(empty), "-> " + empty.length + " 条");
}

// —— 7. 推理模型把预算花在 reasoning 上时，加倍重试一次 ——
// 真实踩到过：deepseek-flash 识图，maxTokens=200 全用成 reasoning_tokens(200)，
// 正文为空、finish=max-tokens。看起来像「模型返回了空内容」，加倍就能出话。
console.log("\n=== 7. 预算被推理吃光时重试 ===");
{
  const attempts = [];
  const ctx = makeCtx({
    llm: {
      listProviders: () => [{ id: "deepseek", name: "DeepSeek" }],
      listModels: async () => [{ provider: "deepseek", id: "deepseek-flash", inputModalities: ["text", "image"] }],
      async *stream(options) {
        attempts.push(options.maxTokens);
        if (attempts.length === 1) {
          // 第一轮：reasoning 吃满，没有正文
          yield { type: "reasoning-delta", index: 9, text: "想啊想啊想" };
          yield { type: "usage", usage: { inputTokens: 100, outputTokens: 20 } };
          yield { type: "finish", reason: { kind: "max-tokens" } };
          return;
        }
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "text-delta", index: 0, text: "图里是台手机。" };
        yield { type: "block-end", index: 0, block: { type: "text", text: "图里是台手机。" } };
        yield { type: "finish", reason: { kind: "stop" } };
      },
    },
  });
  const bridge = createLlmBridge(ctx, () => cfg, {});
  const out = await bridge.generate({ userText: "这图里是什么", maxTokens: 200 });
  check("重试了一次", attempts.length === 2, "attempts=" + attempts.join(","));
  check("第二次预算加倍", attempts[1] > attempts[0], attempts.join(" -> "));
  check("拿到了正文", out.text === "图里是台手机。", JSON.stringify(out.text));
  check("标记了 retried", out.retried === true, String(out.retried));
  check("reasoning 保留", out.reasoning.includes("想啊想啊想"), JSON.stringify(out.reasoning));
}

// —— 8. 不是预算问题就不要瞎重试 ——
console.log("\n=== 8. 没有 reasoning 时不算预算问题 ===");
{
  let count = 0;
  const ctx = makeCtx({
    llm: {
      listProviders: () => [{ id: "deepseek", name: "DeepSeek" }],
      listModels: async () => [{ provider: "deepseek", id: "deepseek-chat", inputModalities: ["text"] }],
      async *stream() {
        count += 1;
        yield { type: "finish", reason: { kind: "max-tokens" } };
      },
    },
  });
  const out = await createLlmBridge(ctx, () => cfg, {}).generate({ userText: "你好", maxTokens: 200 });
  check("只调了一次", count === 1, "calls=" + count);
  check("正文为空但没抛错", out.text === "", JSON.stringify(out.text));
}

console.log("\n" + (failures === 0 ? "OK：全部通过" : "FAIL：" + failures + " 项没通过"));
process.exit(failures === 0 ? 0 : 1);
