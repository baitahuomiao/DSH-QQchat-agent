/**
 * 客户端渲染自检：真正执行 tab 组件，抓「引用了未定义变量」这类白屏 bug。
 *
 * 背景：client.smoke.mjs 只验证 slot 注册契约，不渲染组件，
 * 所以 `state.voices` 这种未定义引用一路通过测试，到浏览器才白屏。
 * 这里把组件从 bundle 里提出来实跑，能提前发现。
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";

const BUNDLE = "E:/deepseek/qq-dsh-plugin/lib/client.js";
const code = readFileSync(BUNDLE, "utf8");

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log("  ok   " + name);
  } else {
    fail += 1;
    console.log("  FAIL " + name + (detail ? "  <- " + detail : ""));
  }
}

/** 从 bundle 里按名字截出函数源码（配对大括号）。 */
function extract(name) {
  const i = code.indexOf("function " + name);
  if (i < 0) return null;
  let depth = 0;
  let j = i;
  let started = false;
  for (; j < code.length; j++) {
    if (code[j] === "{") {
      depth++;
      started = true;
    } else if (code[j] === "}") {
      depth--;
      if (started && depth === 0) {
        j++;
        break;
      }
    }
  }
  return code.slice(i, j);
}

// 组件依赖的基础件，按需提取
const NEED = [
  "Field", "TextField", "NumberField", "TextArea", "SelectField", "TagsField",
  "Toggle", "Card", "Stat", "VideoList", "StickerList", "StickerUploader",
  "visionHint",
  "OverviewTab", "PersonaTab", "ConnectTab", "ReplyTab", "AbilityTab",
  "BilibiliTab", "MemoryTab", "LogsTab",
];

const parts = [];
const found = [];
for (const name of NEED) {
  const src = extract(name);
  if (src) {
    parts.push(src);
    found.push(name);
  }
}
console.log("提取到 " + found.length + " 个组件/工具函数");

const sandbox = {
  h(type, props, ...kids) {
    if (typeof type === "function") return type({ ...(props || {}), children: kids });
    return { t: typeof type === "string" ? type : (type && type.name) || "?", p: props, k: kids };
  },
  useState: (v) => [typeof v === "function" ? v() : v, () => {}],
  useEffect: () => {},
  useMemo: (f) => f(),
  useCallback: (f) => f,
  useRef: (v) => ({ current: v }),
  console: { log() {}, warn() {}, error() {} },
  JSON, Math, Object, Array, String, Number, Boolean, Date,
  encodeURIComponent, decodeURIComponent, parseInt, parseFloat, isNaN, NaN, undefined,
  fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
  Audio: function () { return { play() {}, pause() {} }; },
  URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
  Event: function () {},
};
vm.createContext(sandbox);
vm.runInContext(parts.join("\n\n") + "\n; this.__exports = {" + found.map((n) => n + ":" + n).join(",") + "};", sandbox);
const X = sandbox.__exports;

/** 造一份结构完整的 draft，避免组件里某字段缺失导致误报。 */
function mkDraft() {
  return {
    enabled: true,
    master: { uin: "920420642", alias: "主人", sweetNames: ["亲爱的"], extra: "", only: true },
    persona: { name: "鲸鱼娘", prompt: "你是鲸鱼娘", extra: "", saved: [] },
    onebot: { wsUrl: "ws://127.0.0.1:3001", httpUrl: "http://127.0.0.1:3000", token: "", selfId: "", reconnectMs: 5000 },
    llm: { provider: "p", model: "m", temperature: 1, maxTokens: 1600 },
    reply: {
      groupsEnabled: true, groupMode: "at", groupWhitelist: [], groupKeywords: [],
      privateEnabled: true, privateWhitelist: [], privateWhitelistOnly: false,
      maxChars: 300, typingCps: 13, splitSegments: true, minDelayMs: 800,
      maxDelayMs: 2600, memoryTurns: 120, cooldownSec: 2, replyChance: 0.65,
      freeChat: {
        enabled: true, maxSegments: 4, softMaxChars: 120, minGapMs: 250,
        maxGapMs: 2200, thinkingChance: 0.25, thinkingMinMs: 900, thinkingMaxMs: 3200,
        allowStickers: true, allowImages: true,
      },
    },
    active: {
      enabled: true, masterWeight: 0.65, otherWeight: 0.08, minGapMinutes: 5,
      maxGapMinutes: 55, quietStartHour: 2, quietEndHour: 8, maxPerHour: 10, browseChance: 0.3,
    },
    search: { mode: "auto", maxResults: 4 },
    vision: { enabled: true, maxBytes: 12582912, provider: "p", model: "m" },
    voice: {
      enabled: true, mode: "auto", chance: 0.2, keywords: [], lang: "zh", speed: 5,
      maxChars: 120, lexicon: {},
      custom: {
        enabled: true, baseUrl: "https://api.siliconflow.cn/v1", apiKey: "sk-x",
        model: "FunAudioLLM/CosyVoice2-0.5B", voice: "speech:a:b:c",
        apiKind: "openai", format: "mp3", gain: 0, sampleRate: 0,
        timeoutMs: 20000, fallback: true,
        cloned: { uri: "speech:a:b:c", name: "whale-x", refText: "こんにちは", createdAt: 1, source: "E:/a.mp3" },
        bodyTemplate: "{}",
      },
    },
    bilibili: {
      enabled: true, approved: false, retentionHours: 2, feedSize: 10,
      batchSize: 3, keepNotes: true, talkAboutVideos: true, aiNotes: false, source: "mix",
    },
    sticker: { enabled: true, autoSave: true, autoSaveChance: 0.25, sendChance: 0.18, autoSaveDailyLimit: 12 },
    image: {
      enabled: true, mode: "keyword", keywords: ["画一个"], baseUrl: "https://x/v1",
      apiKey: "k", model: "m", size: "1024x1024", responseFormat: "b64_json",
      maxPromptChars: 200, quoteReply: true,
      negativePrompt: "", steps: 0, seed: 0, timeoutMs: 120000,
    },
    admin: { uins: [], groupAdmin: false },
    style: { current: "whale-default", custom: "", strength: "normal", dynamic: true, catchphrases: [] },
  };
}

function mkData(over = {}) {
  return Object.assign({
    ok: true,
    running: true,
    paused: false,
    connection: { connected: true, selfId: "3886139976", nickname: "鲸鱼娘" },
    config: mkDraft(),
    presets: [{ id: "deepseek-whale", name: "DeepSeek 鲸鱼娘", prompt: "x" }],
    route: { provider: "p", model: "m" },
    routeError: "",
    groups: [],
    friends: [],
    stickers: [],
    stickerDir: "C:/x/stickers",
    voices: [],
    // 面板读这两份清单（风格预设、图像模型），缺了会渲染成空列表
    styles: [
      { id: "whale-default", name: "鲸鱼娘本色", desc: "官方默认" },
      { id: "jp-maid", name: "日系女仆", desc: "礼貌恭顺" },
    ],
    presetVoices: [
      { id: "alex", name: "Alex", gender: "男", desc: "沉稳男声", value: "FunAudioLLM/CosyVoice2-0.5B:alex" },
      { id: "bella", name: "Bella", gender: "女", desc: "甜美女声", value: "FunAudioLLM/CosyVoice2-0.5B:bella" },
    ],
    imageModels: [
      { id: "Tongyi-MAI/Z-Image-Turbo", label: "Z-Image-Turbo · 快" },
      { id: "dall-e-3", label: "DALL·E 3（OpenAI）" },
    ],
    logs: [],
    memories: [],
    videos: [],
  }, over);
}

/** 各 tab 的 props 形状不同，按 tab 给。 */
function runTab(name, extraData, draftMod) {
  const fn = X[name];
  if (typeof fn !== "function") return check(name + " 存在", false, "提取失败");
  const draft = draftMod ? draftMod(mkDraft()) : mkDraft();
  const data = mkData(extraData);
  const base = { data, draft, set: () => {}, act: () => {}, busy: "", ttsText: "", setTtsText: () => {} };
  const tabProps = Object.assign({}, base, {
    // ConnectTab / ReplyTab 等可能读这些
    toast: "", setTtsText: () => {}, onRefresh: () => {},
  });
  try {
    fn(tabProps);
    return check(name + " 渲染", true);
  } catch (error) {
    return check(name + " 渲染", false, error && error.message);
  }
}

console.log("\n== 1. 各 tab 能渲染 ==");
for (const tab of ["OverviewTab", "PersonaTab", "ConnectTab", "ReplyTab", "AbilityTab", "BilibiliTab", "MemoryTab", "LogsTab"]) {
  runTab(tab);
}

console.log("\n== 2. AbilityTab 的各种数据形态 ==");
runTab("AbilityTab", { voices: [{ uri: "speech:a:b:c", name: "whale-x", model: "CosyVoice2" }] });
runTab("AbilityTab", { voices: null });
runTab("AbilityTab", { voices: undefined });
runTab("AbilityTab", {});
runTab("AbilityTab", null, (d) => {
  d.voice.custom.cloned = { uri: "", name: "", refText: "", createdAt: 0, source: "" };
  return d;
});
runTab("AbilityTab", null, (d) => {
  d.voice.custom.apiKind = "custom";
  return d;
});
runTab("AbilityTab", { stickers: [{ id: "a", file: "a.png", tags: ["x"], bytes: 100, usedCount: 0, addedAt: 0 }] });
runTab("AbilityTab", null, (d) => {
  d.image.enabled = false;
  d.sticker.enabled = false;
  d.voice.custom.enabled = false;
  return d;
});

console.log("\n== 4. 老配置缺字段时不崩 ==");
runTab("PersonaTab", null, (d) => {
  delete d.style;
  return d;
});
runTab("AbilityTab", null, (d) => {
  delete d.voice.custom.cloned;
  delete d.image.negativePrompt;
  return d;
});
runTab("PersonaTab", { styles: undefined });
runTab("AbilityTab", { presetVoices: undefined, imageModels: undefined, voices: undefined });

console.log("\n== 3. bundle 里不该出现未定义的 state 引用 ==");
check("AbilityTab 不含 state.", !/function AbilityTab[\s\S]*?\n}/.test("") || !/(^|[^.\w])state\./m.test(extract("AbilityTab") || ""), "有 state. 引用");

console.log("\n===== 结果 =====");
console.log("  通过 " + pass + " / 失败 " + fail);
process.exit(fail === 0 ? 0 : 1);
