#!/usr/bin/env node
/**
 * 上传自定义音色（声音克隆）到硅基流动，拿到 speech:... 的 uri，填进 QQ 插件面板的「音色 / voice」。
 *
 * 为什么要单独跑一次：插件只会打 /audio/speech 合成，不会调 /uploads/audio/voice 上传。
 * 上传是一次性的——同一段参考音频传一次，拿到 uri 存着，以后一直用。
 *
 * 用法：
 *   node tools/voice-upload.mjs --audio ref.mp3 --name my-voice --text "音频里说的原话"
 *   node tools/voice-upload.mjs --list
 *
 * 环境变量：SILICONFLOW_API_KEY（不填就交互式问，不回显）
 */

import { createInterface } from "node:readline";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";

const MIME = { ".mp3": "audio/mpeg", ".wav": "audio/wav", ".opus": "audio/opus", ".pcm": "application/octet-stream" };
const DEFAULT_MODEL = "FunAudioLLM/CosyVoice2-0.5B";
const DEFAULT_BASE = "https://api.siliconflow.cn/v1";

function usage(code = 0) {
  console.log(`
上传自定义音色到硅基流动，拿到可填进插件「音色 / voice」的 uri。

  node tools/voice-upload.mjs --audio <文件> --name <音色名> --text "<参考音频里的原话>"
                               [--model ${DEFAULT_MODEL}] [--out uri.txt]
  node tools/voice-upload.mjs --list        # 查看这个账号已有的自定义音色

参数：
  --audio   参考音频，mp3 / wav / pcm / opus，单人、安静、8~10 秒最佳，必须小于 30 秒
  --name    音色名，字母数字下划线短横线，1~40 字符，例如 my-voice
  --text    参考音频里一字不差说的那句话（最容易出错，一定要对）
  --text-file  同上，从 UTF-8 文本文件读（日文/中文长文本建议用这个，免命令行编码问题）
  --model   上传时绑定的模型，要和面板里「模型名」一致
  --list    只列出已有音色，不上传
  --out     把拿到的 uri 写到文件
  --api-key 直接给 Key，不填就读 $SILICONFLOW_API_KEY
  --base    默认 ${DEFAULT_BASE}

注意：自定义音色必须在硅基流动做过实名认证，否则接口会拒。
`);
  process.exit(code);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const key = a.slice(2);
    if (key === "list" || key === "help" || key === "h") {
      out[key] = true;
      continue;
    }
    const val = argv[i + 1];
    if (val === undefined || val.startsWith("--")) {
      console.error(`参数 --${key} 没给值`);
      process.exit(2);
    }
    out[key] = val;
    i++;
  }
  return out;
}

async function askSecret(question) {
  process.stdout.write(question);
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  // 简单遮蔽：有 terminal 时关掉回显
  const stdin = process.stdin;
  const muted = () => {};
  if (stdin.isTTY) stdin.on("data", muted);
  const answer = await new Promise((res) => rl.question("", (v) => res(v)));
  if (stdin.isTTY) stdin.off("data", muted);
  rl.close();
  process.stdout.write("\n");
  return answer;
}

async function apiError(response) {
  const text = await response.text().catch(() => "");
  let detail = text;
  try {
    const j = JSON.parse(text);
    detail = j.message || j.error || j.detail || text;
  } catch {
    /* 不是 JSON 就原样输出 */
  }
  return `HTTP ${response.status}：${String(detail).slice(0, 400)}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h || (!args.list && !args.audio)) usage(args.help || args.h ? 0 : 2);

  const base = String(args.base || DEFAULT_BASE).replace(/\/+$/, "");
  let apiKey = String(args["api-key"] || process.env.SILICONFLOW_API_KEY || "").trim();
  if (!apiKey) {
    apiKey = (await askSecret("硅基流动 API Key（sk-...，输入会显示，建议先 set SILICONFLOW_API_KEY）: ")).trim();
  }
  if (!apiKey) {
    console.error("没有 API Key，中止。");
    process.exit(2);
  }
  if (!apiKey.startsWith("sk-")) console.warn("提示：这个 Key 不是 sk- 开头，确认没粘错。");

  const headers = { authorization: `Bearer ${apiKey}` };

  // ---- 列出已有音色 ----
  if (args.list) {
    console.log("查询已有自定义音色…");
    const r = await fetch(`${base}/audio/voice/list`, { headers });
    if (!r.ok) {
      console.error("查询失败：" + (await apiError(r)));
      process.exit(1);
    }
    const j = await r.json().catch(() => null);
    console.log(JSON.stringify(j, null, 2));
    const uris = collectUris(j);
    if (uris.length) {
      console.log("\n把下面任意一条 uri 整段填进面板的「音色 / voice」（不要加模型名前缀）：");
      for (const u of uris) console.log("  " + u);
    }
    return;
  }

  // ---- 上传前检查 ----
  const audioPath = resolve(String(args.audio));
  const info = await stat(audioPath).catch(() => null);
  if (!info || !info.isFile()) {
    console.error(`找不到音频文件：${audioPath}`);
    process.exit(2);
  }
  const ext = extname(audioPath).toLowerCase();
  const mime = MIME[ext];
  if (!mime) {
    console.error(`格式 ${ext || "(无扩展名)"} 不支持。只吃 mp3 / wav / pcm / opus，推荐 192kbps 以上的 mp3。`);
    process.exit(2);
  }
  if (info.size > 12 * 1024 * 1024) {
    console.error(`文件 ${(info.size / 1024 / 1024).toFixed(1)}MB 太大。参考音频只要 8~10 秒，先压一下。`);
    process.exit(2);
  }

  const name = String(args.name || "").trim();
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(name)) {
    console.error('--name 只能用字母、数字、下划线、短横线（1~40 字符），例如 my-voice。');
    process.exit(2);
  }

  const text = String(
    args["text-file"] ? (await readFile(resolve(String(args["text-file"])), "utf8")) : args.text || ""
  )
    .replace(/^\uFEFF/, "")
    .replace(/\r?\n/g, "")
    .trim();
  if (!text) {
    console.error("--text（或 --text-file）必填：参考音频里一字不差说的那句话。");
    process.exit(2);
  }

  const model = String(args.model || DEFAULT_MODEL).trim();

  console.log(`
参考音频要求（直接决定克隆像不像）：
  - 只有一个人说话，没有第二个人搭话
  - 8~10 秒最佳，必须小于 30 秒
  - 安静环境、无背景音乐、无回声、音量稳定
  - --text 必须是音频里逐字对应的原话（当前 ${text.length} 个字符）
`);

  const bytes = await readFile(audioPath);
  const form = new FormData();
  form.set("file", new Blob([bytes], { type: mime }), basename(audioPath));
  form.set("model", model);
  form.set("customName", name);
  form.set("text", text);

  console.log(`正在上传 ${basename(audioPath)}（${(info.size / 1024).toFixed(0)} KB），模型 ${model} …`);
  const r = await fetch(`${base}/uploads/audio/voice`, { method: "POST", headers, body: form });
  if (!r.ok) {
    console.error("上传失败：" + (await apiError(r)));
    console.error("\n常见原因：没做实名认证（自定义音色必须实名）、音频超过 30 秒、音频里不是单一说话人、text 和音频对不上。");
    process.exit(1);
  }

  const payload = await r.json().catch(() => null);
  console.log(JSON.stringify(payload, null, 2));
  const [uri] = collectUris(payload);
  if (!uri) {
    console.error("接口回了 200，但返回里没找到 uri 字段，把上面的原始返回贴给我看。");
    process.exit(2);
  }

  console.log(`
成功了。面板「自定义语音模型 API」这样填：
  接口类型  : OpenAI 兼容 /audio/speech
  Base URL  : ${base}/audio/speech
  模型名    : ${model}
  音色      : ${uri}

音色那栏粘 uri 本身，不要加「模型名:」前缀，也不要带引号。`);

  if (args.out) {
    await writeFile(resolve(String(args.out)), uri + "\n", "utf8");
    console.log(`uri 已写入 ${resolve(String(args.out))}`);
  }
}

function collectUris(node, acc = []) {
  if (!node) return acc;
  if (Array.isArray(node)) {
    for (const item of node) collectUris(item, acc);
    return acc;
  }
  if (typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === "uri" && typeof v === "string" && v.startsWith("speech:")) acc.push(v);
      else collectUris(v, acc);
    }
  } else if (typeof node === "string" && node.startsWith("speech:")) {
    acc.push(node);
  }
  return acc;
}

main().catch((err) => {
  console.error("出错了：" + (err && err.message ? err.message : String(err)));
  process.exit(1);
});
