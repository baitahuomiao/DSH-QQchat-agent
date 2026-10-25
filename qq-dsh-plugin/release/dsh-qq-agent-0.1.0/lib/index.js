/**
 * dsh-qq-agent 宿主入口。
 *
 * 职责：
 *  1. 把 DSH 的服务（llm / web / attachments）包成 engine 认识的普通函数；
 *  2. 注册面板用的 HTTP 路由（走 ctx.connection.fetch，自带同源鉴权）；
 *  3. 管住 Engine 的生命周期（插件卸载时断开 OneBot）。
 *
 * 所有业务逻辑都在 src/*.cjs 里，那些文件不 import 任何 DSH 包，能单独测。
 */
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

const config = require("../src/config.cjs");
const { Memory } = require("../src/memory.cjs");
const { OneBotClient } = require("../src/onebot.cjs");
const { Engine } = require("../src/engine.cjs");
const presets = require("../src/presets.cjs");
const bilibili = require("../src/bilibili.cjs");
const tts = require("../src/tts.cjs");
const { bingRss } = require("../src/search.cjs");

export const name = "dsh-qq-agent";

/** 只有 connection 是硬依赖：没有它面板就没有后端，插件也没必要加载。 */
export const inject = ["connection"];

const ROUTE_STATE = "/api/qq-agent/state";
const ROUTE_CONFIG = "/api/qq-agent/config";
const ROUTE_ACTION = "/api/qq-agent/action";
const ROUTE_TTS = "/api/qq-agent/tts";

// —— 小工具 ——

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function messageOf(error) {
  if (!error) return "未知错误";
  return error.message ? String(error.message) : String(error);
}

function readBody(request) {
  return request
    .text()
    .then((text) => (text ? JSON.parse(text) : {}))
    .catch(() => ({}));
}

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}

/**
 * 插件可能被软链到别处加载，从插件目录直接 import `@deepseek-ai/dsh-llm`
 * 未必能解析到，所以退几步从 DSH 自己的 profile 目录里找。
 *
 * 不写死 profile 名字：别的机器上可能是 `desktop` / `web` / 自定义名字，
 * 有多个就都试一遍。列表按目录名排序，保证同一台机器上每次顺序一致。
 */
function resolveBases() {
  const bases = [import.meta.url];
  const profilesDir = join(dshHome(), "profiles");
  for (const name of ["desktop", "web"]) {
    bases.push(pathToFileURL(join(profilesDir, name, "package.json")).href);
  }
  try {
    for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const base = pathToFileURL(join(profilesDir, entry.name, "package.json")).href;
      if (!bases.includes(base)) bases.push(base);
    }
  } catch {
    /* profiles 目录不存在就只用手上这几条 */
  }
  bases.push(pathToFileURL(join(profilesDir, "node_modules", "package.json")).href);
  return bases;
}

let cachedBases = null;
function resolveBasesOnce() {
  if (cachedBases === null) cachedBases = resolveBases();
  return cachedBases;
}

/**
 * 真的去 `dsh` 自己的 node_modules 里把 dsh-llm 找出来。
 *
 * 从前面的 profile package.json 逐级往上走，所以用户把 DSH 装在
 * 任何盘符、任何 profile 名字下都能命中。
 */
function scanForDshLlm() {
  const errors = [];
  const roots = [];
  const home = process.env.DSH_HOME;
  if (home) roots.push(home);
  roots.push(join(homedir(), ".dsh"));

  const candidates = [];
  for (const root of roots) {
    const profilesDir = join(root, "profiles");
    candidates.push(join(root, "node_modules"));
    candidates.push(join(profilesDir, "node_modules"));
    try {
      for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === "node_modules") continue;
        if (entry.name.startsWith(".")) continue;
        candidates.push(join(profilesDir, entry.name, "node_modules"));
      }
    } catch {
      /* 没有这个 profile 目录，跳过 */
    }
  }

  for (const modulesDir of candidates) {
    const target = join(modulesDir, "@deepseek-ai", "dsh-llm");
    try {
      if (!existsSync(target)) continue;
      const localRequire = createRequire(join(target, "package.json"));
      return localRequire(target);
    } catch (error) {
      errors.push(messageOf(error));
    }
  }
  return { module: null, errors };
}

function loadDshLlm() {
  const errors = [];
  for (const base of resolveBasesOnce()) {
    try {
      const localRequire = createRequire(base);
      const resolved = localRequire.resolve("@deepseek-ai/dsh-llm");
      return localRequire(resolved);
    } catch (error) {
      errors.push(messageOf(error));
    }
  }
  try {
    return require("@deepseek-ai/dsh-llm");
  } catch (error) {
    errors.push(messageOf(error));
  }
  const scanned = scanForDshLlm();
  if (scanned.module) return scanned.module;
  errors.push(...scanned.errors);
  throw new Error("找不到 @deepseek-ai/dsh-llm：" + errors.join(" | "));
}

/**
 * 逐个 chunk 累积助手流。
 *
 * 不用 BlockAssembler 是刻意的：这样插件不依赖 dsh-llm 的内部装配类，
 * 只依赖公开的 chunk 形状（text-delta / reasoning-delta / block-end / finish）。
 */
function collectStream(chunks) {
  const parts = new Map();
  const order = [];
  let finish = { kind: "stop" };
  let usage;
  let reasoning = "";

  const ensure = (index, type) => {
    let part = parts.get(index);
    if (!part) {
      part = { type, text: "" };
      parts.set(index, part);
      order.push(index);
    }
    return part;
  };

  const push = (chunk) => {
    if (!chunk || typeof chunk !== "object") return;
    switch (chunk.type) {
      case "block-start":
        if (!parts.has(chunk.index)) {
          parts.set(chunk.index, { type: chunk.blockType, text: "" });
          order.push(chunk.index);
        }
        return;
      case "text-delta":
        ensure(chunk.index, "text").text += chunk.text || "";
        return;
      case "reasoning-delta":
        ensure(chunk.index, "reasoning").text += chunk.text || "";
        reasoning += chunk.text || "";
        return;
      case "block-end": {
        const block = chunk.block;
        if (!block) return;
        const part = ensure(chunk.index, block.type);
        if (block.type === "text" || block.type === "reasoning") part.text = block.text || "";
        part.closed = true;
        return;
      }
      case "usage":
        usage = chunk.usage;
        return;
      case "finish":
        finish = { kind: chunk.reason && chunk.reason.kind ? chunk.reason.kind : String(chunk.reason || "stop") };
        if (chunk.reason && chunk.reason.failure) finish.failure = chunk.reason.failure;
        return;
      default:
        return;
    }
  };

  return { push, parts, order, get finish() { return finish; }, get usage() { return usage; }, get reasoning() { return reasoning; } };
}

/** 把 DSH 的 ImageAttachmentRef / 原始字节统一成 ImageBlock。 */
async function toImageBlocks(ctx, images) {
  const blocks = [];
  const attachments = ctx.get("attachments");
  for (const item of Array.isArray(images) ? images : []) {
    if (!item) continue;
    try {
      let ref = item.ref;
      if (!ref && item.data) {
        if (!attachments || typeof attachments.saveImage !== "function") continue;
        ref = await attachments.saveImage({
          data: new Uint8Array(item.data),
          mediaType: item.mediaType || "image/jpeg",
          name: item.name || "qq-image",
        });
      }
      if (ref) blocks.push({ type: "image", attachment: ref });
    } catch {
      /* 单张图失败就当没有 */
    }
  }
  return blocks;
}

/** 判断某个模型是否声明了图片输入能力。 */
function isVisionModel(modelId, models) {
  const hit = (models || []).find((row) => row && row.id === modelId);
  return Boolean(hit && Array.isArray(hit.inputModalities) && hit.inputModalities.includes("image"));
}

/**
 * 取某个 provider 的模型清单，按 provider 缓存。
 * 缓存必须按 provider 分桶：识图要在多条路由之间挑，只留一条会把上一条挤掉。
 */
async function modelsOf(ctx, provider, cache) {
  if (!cache.byProvider) cache.byProvider = new Map();
  if (cache.byProvider.has(provider)) return cache.byProvider.get(provider);
  const llm = ctx.get("llm");
  let models = [];
  try {
    const list = typeof llm.listModels === "function" ? await llm.listModels(provider) : [];
    models = Array.isArray(list) ? list.filter((row) => row && row.id) : [];
  } catch {
    models = [];
  }
  cache.byProvider.set(provider, models);
  return models;
}

/**
 * 找一条**能看图**的路由。
 *
 * 只在「配置的那条路由」里找是不够的：用户的聊天路由常常是纯文本模型
 * （输入模态只有 text），此时带图请求会拿到一段占位文字，等于识图没开。
 * 所以这里按顺序试：识图专用 provider → 聊天 provider → 其余所有 provider，
 * 谁先声明了 image 输入就用谁。
 */
async function resolveVisionRoute(ctx, cfg, cache, providers) {
  const tried = [];
  const order = [];
  const push = (id) => {
    const name = String(id || "").trim();
    if (name && !order.includes(name)) order.push(name);
  };
  push(cfg.vision.provider);
  push(cfg.llm.provider);
  for (const row of providers) push(row && row.id);
  if (order.length === 0) for (const row of providers) push(row && row.id);

  for (const provider of order) {
    if (!providers.some((row) => row && row.id === provider)) continue;
    const models = await modelsOf(ctx, provider, cache);
    tried.push(provider + "(" + models.length + ")");
    // 用户指定了识图模型就尊重它，哪怕它的模态声明看起来不支持图
    const wanted = String((provider === cfg.vision.provider && cfg.vision.model) || "").trim();
    if (wanted && models.some((row) => row.id === wanted)) {
      return { provider, model: wanted, models, seesImages: isVisionModel(wanted, models) };
    }
    const hit = models.find((row) => isVisionModel(row.id, models));
    if (hit) return { provider, model: hit.id, models, seesImages: true };
  }

  // 一条能看图的都没有：退回聊天路由，让面板如实显示「看不了图」而不是报错
  const fallback = await resolveRoute(ctx, cfg, cache);
  return {
    provider: fallback.provider,
    model: fallback.model,
    models: fallback.models,
    seesImages: isVisionModel(fallback.model, fallback.models),
    tried,
  };
}

/**
 * 解析这次该用哪个 provider / model。
 * 配置留空时退到 DSH 当前可用列表的第一个，避免用户必须先手填模型名。
 *
 * @param cfg 当前配置
 * @param cache 按 provider 缓存模型清单
 * @param want 可选覆盖 `{ provider, model }`
 * @param needImage true 时优先挑一个声明了 image 模态的模型
 */
async function resolveRoute(ctx, cfg, cache, want, needImage) {
  const llm = ctx.get("llm");
  if (!llm || typeof llm.stream !== "function") {
    throw new Error("DSH 的模型服务不可用（ctx.llm 未加载）");
  }
  let providers = [];
  try {
    providers = typeof llm.listProviders === "function" ? llm.listProviders() : [];
  } catch {
    providers = [];
  }
  if (!Array.isArray(providers) || providers.length === 0) {
    throw new Error("没有可用的模型路由，请先在 DSH 里配置模型");
  }

  const override = want || {};
  const wantedProvider = String(override.provider || cfg.llm.provider || "").trim();
  const provider =
    wantedProvider && providers.some((row) => row && row.id === wantedProvider) ? wantedProvider : providers[0].id;

  const models = await modelsOf(ctx, provider, cache);

  const seesImages = (row) => isVisionModel(row && row.id, models);

  let model = String(override.model || cfg.llm.model || "").trim();
  if (model && models.length > 0 && !models.some((row) => row && row.id === model)) model = "";
  if (!model) {
    // 要图就优先挑能看图的，别把图片丢给纯文本模型
    const first = (needImage ? models.find(seesImages) : null) || models.find((row) => row && row.id) || null;
    model = first ? first.id : "";
  }
  if (!model) throw new Error("provider " + provider + " 下没有可用模型");

  return { provider, model, models, providers };
}

let dshLlmModule = null;
function dshLlm() {
  if (!dshLlmModule) dshLlmModule = loadDshLlm();
  return dshLlmModule;
}

/** engine 期望的 llm.generate；这里翻译成 DSH 的 llm.stream。 */
function createLlmBridge(ctx, getCfg) {
  const cache = { provider: "", models: null };

  return {
    ready() {
      const llm = ctx.get("llm");
      return Boolean(llm && typeof llm.stream === "function");
    },

    async describe() {
      const cfg = getCfg();
      const route = await resolveRoute(ctx, cfg, cache);
      const out = { provider: route.provider, model: route.model, models: route.models, providers: route.providers };
      // 识图那条路由单独报给面板，方便用户确认「看图到底走的哪个模型」
      try {
        const vision = await resolveVisionRoute(ctx, cfg, cache, route.providers);
        out.vision = {
          provider: vision.provider,
          model: vision.model,
          models: vision.models,
          seesImages: vision.seesImages === true,
          // 别的路由能看图、而聊天路由看不了，是一件用户该知道的事
          differs: vision.provider !== route.provider || vision.model !== route.model,
          tried: vision.tried || [],
        };
      } catch (error) {
        out.vision = { provider: "", model: "", models: [], seesImages: false, differs: false, tried: [], error: messageOf(error) };
      }
      return out;
    },

    async generate(options) {
      const opts = options || {};
      const cfg = getCfg();

      // 先把图片落成 attachment，这样才知道这次是不是「带图」，
      // 带图就得换一条能看图的模型（纯文本路由只会收到占位文字）。
      const imageBlocks = await toImageBlocks(ctx, opts.images);
      const hasImages = imageBlocks.length > 0;
      let route;
      if (hasImages) {
        const chat = await resolveRoute(ctx, cfg, cache);
        route = await resolveVisionRoute(ctx, cfg, cache, chat.providers);
      } else {
        route = await resolveRoute(ctx, cfg, cache);
      }

      let createUserMessage;
      let createAssistantMessage;
      try {
        ({ createUserMessage, createAssistantMessage } = dshLlm());
      } catch {
        createUserMessage = null;
      }

      const messages = [];
      const history = Array.isArray(opts.history) ? opts.history : [];
      for (const row of history) {
        const text = String((row && row.text) || "").trim();
        if (!text) continue;
        if (row.role === "assistant") {
          messages.push(
            createAssistantMessage
              ? createAssistantMessage({ content: [{ type: "text", text }], source: { provider: route.provider, model: route.model } })
              : { role: "assistant", content: [{ type: "text", text }], source: { kind: "model", provider: route.provider, model: route.model } },
          );
        } else {
          messages.push(
            createUserMessage
              ? createUserMessage({ content: [{ type: "text", text }], source: { kind: "dsh-qq-agent" } })
              : { role: "user", content: [{ type: "text", text }], source: { kind: "dsh-qq-agent" } },
          );
        }
      }

      const content = [];
      for (const block of imageBlocks) content.push(block);
      content.push({ type: "text", text: String(opts.userText || "") });
      messages.push(
        createUserMessage
          ? createUserMessage({ content, source: { kind: "dsh-qq-agent" } })
          : { role: "user", content, source: { kind: "dsh-qq-agent" } },
      );

      const requestOptions = {
        provider: route.provider,
        model: route.model,
        messages,
        temperature: typeof opts.temperature === "number" ? opts.temperature : cfg.llm.temperature,
        maxTokens: typeof opts.maxTokens === "number" ? opts.maxTokens : cfg.llm.maxTokens,
      };
      const system = String(opts.system || "").trim();
      if (system) requestOptions.system = system;
      if (opts.signal) requestOptions.signal = opts.signal;

      const llm = ctx.get("llm");
      const stream = collectStream();
      for await (const chunk of llm.stream(requestOptions)) stream.push(chunk);

      const finish = stream.finish;
      const text = stream.order
        .filter((index) => stream.parts.get(index).type === "text")
        .map((index) => stream.parts.get(index).text)
        .join("")
        .trim();

      if ((finish.kind === "error" || finish.kind === "aborted") && !text) {
        const failure = finish.failure || {};
        throw new Error("模型请求失败：" + (failure.message || failure.code || finish.kind));
      }

      // 推理模型（deepseek-flash 之类）会先把 maxTokens 花在 reasoning 上。
      // 预算耗尽时 finish 是 max-tokens 且正文为空 —— 看起来像「模型返回了空内容」，
      // 其实是预算不够，加倍重试一次就能出话。只重试一次，别把账单顶起来。
      if (finish.kind === "max-tokens" && !text && stream.reasoning.trim()) {
        const retryOptions = {
          ...requestOptions,
          maxTokens: Math.min(16384, Math.round(requestOptions.maxTokens * 2) + 512),
        };
        const retry = collectStream();
        for await (const chunk of llm.stream(retryOptions)) retry.push(chunk);
        const retryText = retry.order
          .filter((index) => retry.parts.get(index).type === "text")
          .map((index) => retry.parts.get(index).text)
          .join("")
          .trim();
        if (retryText) {
          return {
            text: retryText,
            reasoning: retry.reasoning.trim() || stream.reasoning.trim(),
            finish: retry.finish.kind,
            usage: retry.usage ? { input: retry.usage.inputTokens, output: retry.usage.outputTokens } : undefined,
            provider: route.provider,
            model: route.model,
            retried: true,
          };
        }
      }

      return {
        text,
        reasoning: stream.reasoning.trim(),
        finish: finish.kind,
        usage: stream.usage ? { input: stream.usage.inputTokens, output: stream.usage.outputTokens } : undefined,
        provider: route.provider,
        model: route.model,
      };
    },
  };
}

/** engine 期望的 web.search：返回拍平的 [{title,url,snippet}]。 */
function createWebBridge(ctx) {
  return {
    async search(query, options) {
      const q = String(query || "").trim();
      if (!q) return [];
      const maxResults = Math.max(1, Math.min(10, (options && options.maxResults) || 4));
      const web = ctx.get("web");
      if (web && typeof web.search === "function") {
        try {
          const result = await web.search({ query: q, maxResults });
          const sources = Array.isArray(result && result.sources) ? result.sources : [];
          if (sources.length > 0) {
            return sources.slice(0, maxResults).map((row) => ({
              title: String((row && row.title) || (row && row.url) || ""),
              url: String((row && row.url) || ""),
              snippet: String((row && row.snippet) || ""),
            }));
          }
        } catch {
          /* 退回自抓 */
        }
      }
      try {
        const rows = await bingRss(q, { maxResults });
        return Array.isArray(rows) ? rows.slice(0, maxResults) : [];
      } catch {
        return [];
      }
    },
  };
}

// —— 主流程 ——

export function apply(ctx) {
  const logger = ctx.logger || console;
  const dataDir = config.DATA_DIR;
  if (!existsSync(dataDir)) {
    try {
      mkdirSync(dataDir, { recursive: true });
    } catch (error) {
      logger.warn?.("[dsh-qq-agent] 无法创建数据目录：" + messageOf(error));
    }
  }

  let cfg = config.load();
  const memory = new Memory({
    memoryTurns: cfg.reply.memoryTurns,
    retentionHours: cfg.bilibili.retentionHours,
  });
  const onebot = new OneBotClient({
    wsUrl: cfg.onebot.wsUrl,
    token: cfg.onebot.token,
    reconnectMs: cfg.onebot.reconnectMs,
  });

  const state = { groups: [], friends: [] };

  const llm = createLlmBridge(ctx, () => cfg);
  const web = createWebBridge(ctx);
  const attachments = {
    async saveImage(input) {
      const service = ctx.get("attachments");
      if (!service || typeof service.saveImage !== "function") {
        throw new Error("DSH 附件服务不可用，无法保存图片");
      }
      return service.saveImage(input);
    },
  };

  const engine = new Engine({
    cfg,
    memory,
    onebot,
    log: logger,
    llm,
    web,
    attachments,
    onChange() {},
    onConfigChange(patch) {
      config.save(config.merge(config.load(), patch));
      cfg = config.load();
      engine.reload(cfg);
    },
    async reloadConfig() {
      cfg = config.load();
      engine.reload(cfg);
    },
  });

  ctx.effect(() => {
    if (cfg.enabled) {
      try {
        engine.start();
      } catch (error) {
        logger.warn?.("[dsh-qq-agent] 启动失败：" + messageOf(error));
      }
    }
    return () => {
      try {
        engine.stop();
      } catch {
        /* ignore */
      }
    };
  }, "dsh-qq-agent: engine lifecycle");

  async function buildState() {
    let route = null;
    let routeError = "";
    try {
      const info = await llm.describe();
      route = { provider: info.provider, model: info.model, models: info.models, providers: info.providers };
      // 识图路由要一并带给面板：用户需要看到「图片到底会不会被忽略」
      if (info.vision) route.vision = info.vision;
    } catch (error) {
      routeError = messageOf(error);
    }
    return {
      ok: true,
      state: engine.snapshot(),
      config: cfg,
      presets: presets.presetList(),
      route,
      routeError,
      groups: state.groups,
      friends: state.friends,
    };
  }

  async function handleConfig(request) {
    const body = await readBody(request);
    const patch = body && typeof body === "object" ? body.config || body : {};
    config.save(config.merge(config.load(), patch));
    cfg = config.load();
    engine.reload(cfg);
    return jsonResponse(await buildState());
  }

  async function handleAction(request) {
    const body = await readBody(request);
    const action = String((body && body.action) || "").trim();
    const payload = (body && body.payload) || {};
    const result = { ok: true, action, message: "" };

    switch (action) {
      case "start":
        if (!engine.started) engine.start();
        result.message = "已启动";
        break;

      case "stop":
        if (engine.started) engine.stop();
        result.message = "已停止";
        break;

      case "pause":
        engine.paused = true;
        engine.emitChange();
        result.message = "已暂停自动回复";
        break;

      case "resume":
        engine.paused = false;
        engine.emitChange();
        result.message = "已恢复自动回复";
        break;

      case "reload":
        cfg = config.load();
        engine.reload(cfg);
        result.message = "配置已重载";
        break;

      case "refreshGroups": {
        try {
          const list = await onebot.getGroupList();
          state.groups = (Array.isArray(list) ? list : []).map((row) => ({
            group_id: String(row.group_id || ""),
            group_name: String(row.group_name || ""),
            member_count: Number(row.member_count || 0),
          }));
          result.message = "群列表已刷新（" + state.groups.length + " 个）";
        } catch (error) {
          result.ok = false;
          result.message = "拿不到群列表：" + messageOf(error);
        }
        break;
      }

      case "refreshFriends": {
        try {
          const list = await onebot.getFriendList();
          state.friends = (Array.isArray(list) ? list : []).map((row) => ({
            user_id: String(row.user_id || ""),
            nickname: String(row.nickname || row.remark || ""),
          }));
          result.message = "好友列表已刷新（" + state.friends.length + " 个）";
        } catch (error) {
          result.ok = false;
          result.message = "拿不到好友列表：" + messageOf(error);
        }
        break;
      }

      case "browse": {
        try {
          const out = await engine.browseBilibili(payload.force === false ? "auto" : "panel");
          result.message = "刷到 " + out.videos.length + " 条视频";
          result.videos = out.videos.map((row) => ({
            bvid: row.bvid,
            title: row.title,
            author: row.author,
            note: row.note,
            at: row.at,
          }));
        } catch (error) {
          result.ok = false;
          result.message = messageOf(error);
        }
        break;
      }

      case "approveBilibili":
        config.save(config.merge(config.load(), { bilibili: { approved: true } }));
        cfg = config.load();
        engine.reload(cfg);
        result.message = "已批准 B 站权限";
        break;

      case "revokeBilibili":
        config.save(config.merge(config.load(), { bilibili: { approved: false } }));
        cfg = config.load();
        engine.reload(cfg);
        result.message = "已撤销 B 站权限";
        break;

      case "clearShelf":
        memory.clearShelf();
        engine.emitChange();
        result.message = "视频暂存已清空";
        break;

      case "clearSession": {
        const key = String(payload.sessionKey || "");
        if (key) memory.clearSession(key);
        else memory.sessions.clear();
        engine.emitChange();
        result.message = "会话记忆已清空";
        break;
      }

      case "shelf":
        result.videos = memory.recentVideos(60);
        result.message = "共 " + result.videos.length + " 条";
        break;

      case "search": {
        const q = String(payload.query || "").trim();
        if (!q) {
          result.ok = false;
          result.message = "查询词为空";
          break;
        }
        const rows = await web.search(q, { maxResults: cfg.search.maxResults });
        result.results = rows;
        result.message = "搜到 " + rows.length + " 条";
        break;
      }

      case "testVoice": {
        const text = String(payload.text || "你好呀，我是鲸鱼娘。").trim();
        try {
          const file = await tts.synthesizeToFile(text, { lang: cfg.voice.lang, speed: cfg.voice.speed });
          result.file = file;
          result.url = tts.toFileUrl(file);
          result.message = "合成成功";
        } catch (error) {
          result.ok = false;
          result.message = messageOf(error);
        }
        break;
      }

      case "sendVoice": {
        const text = String(payload.text || "").trim();
        const uin = String(payload.uin || cfg.master.uin || "").trim();
        if (!text || !uin) {
          result.ok = false;
          result.message = "需要文本和 QQ 号";
          break;
        }
        try {
          const file = await tts.synthesizeToFile(text, { lang: cfg.voice.lang, speed: cfg.voice.speed });
          await onebot.sendRecord({ kind: "private", userId: uin }, tts.toFileUrl(file));
          result.message = "语音已发送";
        } catch (error) {
          result.ok = false;
          result.message = messageOf(error);
        }
        break;
      }

      case "sendText": {
        const text = String(payload.text || "").trim();
        const uin = String(payload.uin || cfg.master.uin || "").trim();
        if (!text || !uin) {
          result.ok = false;
          result.message = "需要文本和 QQ 号";
          break;
        }
        try {
          await onebot.sendText({ kind: "private", userId: uin }, text);
          result.message = "消息已发送";
        } catch (error) {
          result.ok = false;
          result.message = messageOf(error);
        }
        break;
      }

      case "popular": {
        try {
          const rows = await bilibili.popular(Number(payload.page || 1), Number(payload.pageSize || cfg.bilibili.feedSize));
          result.videos = rows;
          result.message = "拿到 " + rows.length + " 条热门";
        } catch (error) {
          result.ok = false;
          result.message = messageOf(error);
        }
        break;
      }

      case "savePersona": {
        const name = String(payload.name || "").trim();
        const prompt = String(payload.prompt || "").trim();
        const patch = { persona: {} };
        if (name) patch.persona.name = name;
        if (prompt) patch.persona.prompt = prompt;
        config.save(config.merge(config.load(), patch));
        cfg = config.load();
        engine.reload(cfg);
        result.message = "人设已保存";
        break;
      }

      case "usePreset": {
        const preset = presets.findPreset(payload.id);
        if (!preset) {
          result.ok = false;
          result.message = "没有这个人设预设";
          break;
        }
        config.save(config.merge(config.load(), { persona: { name: preset.name, prompt: preset.prompt } }));
        cfg = config.load();
        engine.reload(cfg);
        result.message = "已切换到「" + preset.name + "」";
        break;
      }

      default:
        result.ok = false;
        result.message = "未知操作：" + (action || "(空)");
    }

    const snapshot = await buildState();
    return jsonResponse(Object.assign({}, snapshot, { result }));
  }

  const guard = (label, handler) => (request) =>
    handler(request).catch((error) => {
      logger.warn?.("[dsh-qq-agent] " + label + " failed: " + messageOf(error));
      return jsonResponse({ ok: false, error: messageOf(error) }, 500);
    });

  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: ROUTE_STATE,
        methods: ["GET"],
        requestBody: "buffered",
        fetch: guard("state", () => buildState().then((body) => jsonResponse(body))),
      }),
    "dsh-qq-agent: GET " + ROUTE_STATE,
  );

  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: ROUTE_CONFIG,
        methods: ["POST"],
        requestBody: "buffered",
        fetch: guard("config", handleConfig),
      }),
    "dsh-qq-agent: POST " + ROUTE_CONFIG,
  );

  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: ROUTE_ACTION,
        methods: ["POST"],
        requestBody: "buffered",
        fetch: guard("action", handleAction),
      }),
    "dsh-qq-agent: POST " + ROUTE_ACTION,
  );

  // 面板里的「试听」按钮直接把这个地址塞给 <audio>，所以这里返回 audio/mpeg 本体。
  async function handleTts(request) {
    const url = new URL(request.url);
    const text = String(url.searchParams.get("text") || "").trim() || "你好呀，我是" + cfg.persona.name + "。";
    const speed = Number(url.searchParams.get("speed") || 0) || cfg.voice.speed;
    const bytes = await tts.synthesizeMp3(text.slice(0, 400), {
      lang: cfg.voice.lang,
      speed,
      lexicon: cfg.voice.lexicon,
    });
    return new Response(bytes, {
      status: 200,
      headers: {
        "content-type": "audio/mpeg",
        "content-length": String(bytes.length),
        "cache-control": "no-store",
      },
    });
  }

  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: ROUTE_TTS,
        methods: ["GET"],
        requestBody: "buffered",
        fetch: guard("tts", handleTts),
      }),
    "dsh-qq-agent: GET " + ROUTE_TTS,
  );

  logger.info?.("[dsh-qq-agent] 已加载，人设：" + cfg.persona.name);
}

/**
 * 给测试用的内部入口。
 *
 * 桥接逻辑（engine 的简单参数 → DSH 的 GenerateOptions）只在 apply 的闭包里跑，
 * 不导出就没法在不起 DSH 的情况下验证「消息真的用 createUserMessage 造」「不传 purpose」
 * 这些硬约束。正常加载不会用到这些导出。
 */
export { collectStream, createLlmBridge, createWebBridge, resolveRoute, resolveVisionRoute };
