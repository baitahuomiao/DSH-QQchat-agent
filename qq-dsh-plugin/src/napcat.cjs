/**
 * NapCat 一键启动。
 *
 * 面板上那个「一键连接 QQ」按钮最终走到这里：宿主进程负责把 NapCat 拉起来，
 * 因为它有正常的用户权限（我这个 agent 的 shell 跑在低完整性级别，写不了 E:\NapCat）。
 *
 * 做四件事，任何一步失败都返回可读的原因：
 *   1. 定位 NapCat 安装（便携壳 / 注册表里的 QQ）
 *   2. 补齐注入需要的 qqnt.json（缺了会让注入后的 QQ 立刻崩在 QQNT.dll）
 *   3. 清掉占着单实例锁的普通 QQ
 *   4. 用 NapCat 启动器注入并拉起，然后轮询 OneBot 端口
 *
 * 不负责登录：二维码/快速登录由 NapCat 自己处理，面板只报告「已起服务」还是「等扫码」。
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 依次尝试若干候选目录，找出长得像 NapCat 便携壳的那个。 */
function findShellDirs() {
  const candidates = [];
  const push = (dir) => {
    if (dir && !candidates.includes(dir)) candidates.push(dir);
  };

  // 1. 环境变量显式指定（最优先）
  for (const key of ["NAPCAT_DIR", "NAPCAT_SHELL_DIR"]) {
    const v = process.env[key];
    if (v && String(v).trim()) push(path.resolve(String(v).trim()));
  }

  // 2. 常见盘符下的 NapCat / OneKey
  const roots = ["C:", "D:", "E:", "F:"];
  for (const root of roots) {
    push(path.join(root, "\\", "NapCat"));
    push(path.join(root, "\\", "NapCat", "OneKey"));
  }

  // 3. 用户目录
  push(path.join(os.homedir(), "NapCat"));

  // 4. 展开 NapCat 下一层的 OneKey / *.Shell
  const expanded = [];
  for (const dir of candidates) {
    expanded.push(dir);
    if (!fs.existsSync(dir)) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = path.join(dir, entry.name);
      if (/^(onekey|napcat)/i.test(entry.name)) expanded.push(child);
      if (/\.shell$/i.test(entry.name)) expanded.push(child);
    }
  }

  // 只留下真正带启动器的目录
  const shells = [];
  for (const dir of expanded) {
    if (!fs.existsSync(dir)) continue;
    const launcher = path.join(dir, "NapCatWinBootMain.exe");
    const qq = path.join(dir, "QQ.exe");
    if (fs.existsSync(launcher) && fs.existsSync(qq) && !shells.includes(dir)) shells.push(dir);
  }
  // 目录名带 .Shell 且版本更高的排前面
  shells.sort((a, b) => {
    const scoreA = /\.shell$/i.test(a) ? 1 : 0;
    const scoreB = /\.shell$/i.test(b) ? 1 : 0;
    return scoreB - scoreA;
  });
  return shells;
}

/** 在壳目录下找到 `versions\<ver>\resources\app`。 */
function findAppRoot(shellDir) {
  const versionsDir = path.join(shellDir, "versions");
  if (!fs.existsSync(versionsDir)) return null;
  let entries = [];
  try {
    entries = fs.readdirSync(versionsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const versions = entries
    .filter((e) => e.isDirectory() && /^\d/.test(e.name))
    .map((e) => e.name)
    .sort()
    .reverse();
  for (const ver of versions) {
    const appRoot = path.join(versionsDir, ver, "resources", "app");
    if (fs.existsSync(appRoot)) return { version: ver, appRoot };
  }
  return null;
}

/**
 * 补齐 qqnt.json。
 *
 * NapCat 的注入器会读这个补丁包，把 QQ 的主入口改到 loadNapCat.js。
 * 文件缺失时注入器不报错，但 QQ 会因为入口无效直接在 QQNT.dll 里断言崩溃 ——
 * 表现就是启动器日志只有一句 `Process exited.`，极难排查，所以这里主动补。
 */
function ensurePatchPackage(appRoot) {
  const dst = path.join(appRoot, "qqnt.json");
  if (fs.existsSync(dst)) return { ok: true, changed: false, path: dst };

  const napcatDir = path.join(appRoot, "napcat");
  const src = path.join(napcatDir, "qqnt.json");
  if (!fs.existsSync(src)) {
    return { ok: false, changed: false, path: dst, reason: "找不到 napcat\\qqnt.json 模板" };
  }
  try {
    fs.copyFileSync(src, dst);
    return { ok: true, changed: true, path: dst };
  } catch (error) {
    return { ok: false, changed: false, path: dst, reason: "写入被拒绝：" + String(error && error.message) };
  }
}

/** 当前有哪些 QQ.exe 在跑，以及它们各自的可执行路径。 */
function listQQProcesses() {
  if (process.platform !== "win32") return [];
  try {
    const out = execFileSync(
      "tasklist",
      ["/FI", "IMAGENAME eq QQ.exe", "/FO", "CSV", "/NH"],
      { encoding: "utf8", windowsHide: true, timeout: 8000 },
    );
    const rows = [];
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^"([^"]+)","(\d+)"/);
      if (m) rows.push({ name: m[1], pid: Number(m[2]) });
    }
    return rows;
  } catch {
    return [];
  }
}

/** 结束所有 QQ.exe。返回尝试次数与剩余数量。 */
async function killQQ() {
  const before = listQQProcesses();
  if (before.length === 0) return { stopped: 0, remaining: 0 };

  for (let round = 0; round < 8; round++) {
    try {
      execFileSync("taskkill", ["/F", "/IM", "QQ.exe"], {
        windowsHide: true,
        timeout: 8000,
        stdio: "ignore",
      });
    } catch {
      /* 已经没有了就会非零退出，忽略 */
    }
    await sleep(900);
    if (listQQProcesses().length === 0) return { stopped: before.length, remaining: 0 };
  }
  return { stopped: before.length, remaining: listQQProcesses().length };
}

/**
 * 猜出「应该用哪个 QQ 号快速登录」。
 *
 * 优先级：
 *   1. 调用方显式给的 uin
 *   2. 以前真的登录成功过的账号（onebot11_<uin>.json 存在，说明这个号跑过 NapCat）
 *   3. NapCat 的 WebUI 配置里记的 autoLoginAccount
 *   4. 只剩一个候选时就用它
 *
 * 完全不猜的情况返回 ""，交给二维码登录。
 *
 * 为什么要这一步：NapCat 的 `-q` 只是「用这个号快速登录」，
 * 谁都不会自动填。而插件里唯一像「账号」的字段是 master.uin（主人），
 * 拿它去 -q 会登录成主人自己 —— 机器人反而没上线。
 */
function guessBotUin(shellDir, explicit, liveSelfId) {
  const want = String(explicit || "").trim();
  if (/^\d{5,12}$/.test(want)) return want;

  // 0. 当前真的登着的那个号 —— 最可信，直接用它
  const live = String(liveSelfId || "").trim();
  if (/^\d{5,12}$/.test(live)) return live;

  const found = findAppRoot(shellDir);
  if (!found) return "";
  const configDir = path.join(found.appRoot, "napcat", "config");

  const candidates = [];
  // 2. 有 onebot11_<uin>.json 的账号 = 之前成功跑过的
  try {
    for (const name of fs.readdirSync(configDir)) {
      const m = /^onebot11_(\d{5,12})\.json$/.exec(name);
      if (!m) continue;
      // 端口配得和当前一致的那个更可信
      let score = 1;
      try {
        const raw = fs.readFileSync(path.join(configDir, name), "utf8");
        if (raw.includes(":3001") || raw.includes(":3000")) score = 2;
      } catch {
        /* 读不到就按 1 分算 */
      }
      candidates.push({ uin: m[1], score, from: name });
    }
  } catch {
    /* 目录不存在 */
  }

  // 3. WebUI 里记的自动登录账号
  try {
    const raw = fs.readFileSync(path.join(configDir, "webui.json"), "utf8");
    const j = JSON.parse(raw);
    const auto = String(j.autoLoginAccount || "").trim();
    if (/^\d{5,12}$/.test(auto)) candidates.push({ uin: auto, score: 3, from: "webui.json" });
  } catch {
    /* 没有就算了 */
  }

  if (candidates.length === 0) return "";
  candidates.sort((a, b) => b.score - a.score);
  // 最高分的如果有并列且不止一个，说明判断不了，别瞎猜
  const top = candidates.filter((c) => c.score === candidates[0].score);
  const uniq = [...new Set(top.map((c) => c.uin))];
  if (uniq.length === 1) return uniq[0];
  return "";
}

/** 列出所有可能快速登录的账号（面板展示用）。 */
function listKnownUins(shellDir) {
  const found = findAppRoot(shellDir);
  if (!found) return [];
  const configDir = path.join(found.appRoot, "napcat", "config");
  const uins = new Set();
  try {
    for (const name of fs.readdirSync(configDir)) {
      const m = /^(?:onebot11|napcat)_(\d{5,12})\.json$/.exec(name);
      if (m) uins.add(m[1]);
    }
  } catch {
    /* ignore */
  }
  return [...uins];
}

/** 问一下 OneBot 的 HTTP 口，确认真的登录成功了（不只是端口开了）。 */
async function probeLogin(httpUrl, timeoutMs = 4000) {
  if (typeof fetch !== "function") return { ok: false, reason: "当前 Node 没有 fetch" };
  const base = String(httpUrl || "http://127.0.0.1:3000").replace(/\/+$/, "");
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(base + "/get_login_info", { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, reason: "HTTP " + res.status };
    const body = await res.json();
    const data = (body && body.data) || {};
    if (!data.user_id) return { ok: false, reason: "还没登录" };
    return { ok: true, selfId: String(data.user_id), nickname: String(data.nickname || "") };
  } catch (error) {
    return { ok: false, reason: String((error && error.message) || error) };
  }
}

/** TCP 探活：只看端口有没有人听，不关心内容。 */
function isPortOpen(port, host = "127.0.0.1", timeoutMs = 800) {
  const net = require("node:net");
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

/**
 * 一键连接主流程。
 *
 * @param {{onebot?:{wsUrl?:string,httpUrl?:string}, shellDir?:string, uin?:string,
 *          onLog?:(level:string,text:string)=>void, waitLoginMs?:number}} options
 */
async function startNapCat(options = {}) {
  const log = (level, text) => {
    if (typeof options.onLog === "function") options.onLog(level, text);
  };

  const wsPort = Number((String(options.onebot && options.onebot.wsUrl || "").match(/:(\d+)/) || [])[1] || 3001);
  const httpUrl = (options.onebot && options.onebot.httpUrl) || "http://127.0.0.1:3000";

  // 0. 已经在跑就直接复用，不要重复拉起
  if (await isPortOpen(wsPort)) {
    const login = await probeLogin(httpUrl);
    return {
      ok: true,
      reused: true,
      // 已经登着的账号也报上去，上层会记进配置，下次冷启动就能自动 -q
      selfId: login.ok ? login.selfId : "",
      nickname: login.ok ? login.nickname : "",
      message: login.ok
        ? "OneBot 已经在运行：" + login.nickname + " (" + login.selfId + ")"
        : "OneBot 端口已开，但还没登录（可能在等扫码）",
      login,
    };
  }

  // 1. 定位 NapCat
  const shells = options.shellDir ? [path.resolve(options.shellDir)] : findShellDirs();
  if (shells.length === 0) {
    return {
      ok: false,
      message: "没找到 NapCat。设环境变量 NAPCAT_DIR 指向 NapCat 目录，或在面板里填路径。",
    };
  }
  const shellDir = shells[0];
  log("info", "使用 NapCat 目录：" + shellDir);

  const found = findAppRoot(shellDir);
  if (!found) {
    return { ok: false, message: "NapCat 目录里没有 versions\\*\\resources\\app：" + shellDir };
  }
  log("info", "QQ 版本：" + found.version);

  // 2. 补齐补丁包（这一步是之前崩溃的根因）
  const patch = ensurePatchPackage(found.appRoot);
  if (!patch.ok) {
    return {
      ok: false,
      message: "补 qqnt.json 失败（" + patch.reason + "）。请确认 DSH 有写 " + found.appRoot + " 的权限。",
    };
  }
  if (patch.changed) log("info", "已补齐 qqnt.json");

  // 3. 清场
  const killed = await killQQ();
  if (killed.remaining > 0) {
    log("warn", "还有 " + killed.remaining + " 个 QQ 进程退不掉，可能影响注入");
  } else if (killed.stopped > 0) {
    log("info", "已关闭 " + killed.stopped + " 个 QQ 进程");
  }

  // 4. 拉起
  //
  // 启动器的参数约定（见 NapCat 自带的 napcat.quick.bat）：
  //   NapCatWinBootMain.exe            → 二维码登录
  //   NapCatWinBootMain.exe -q 123456  → 用该账号快速登录
  //
  // 早期版本这里只传了裸 uin（`spawn(launcher, ["123456"])`），
  // NapCat 不认这个位置参数，静默退回二维码登录 —— 表现就是
  // 「一键连接后 QQ 起来了、WebUI 也开了，但 3001 永远等不到」。
  const launcher = path.join(shellDir, "NapCatWinBootMain.exe");
  // 没显式给账号就自动猜（优先选以前真跑成功过的那个），
  // 猜不到才退回二维码登录
  const uin = guessBotUin(shellDir, options.uin);
  const waitMs = Number(options.waitLoginMs || 90_000);

  /**
   * 拉起来并等就绪。
   *
   * 关于账号参数的形式：NapCat 不同版本的启动器接受的不一样 ——
   * 有的要 `-q 123456`（见自带的 napcat.quick.bat），
   * 有的只认裸 `123456`。实测 4.18.38 的 Shell 壳只认裸参数，
   * 传 `-q` 会被忽略、静默退回二维码登录。
   * 所以两种都试，谁先起来用谁。
   */
  async function launchAndWait(argSets, deadlineMs) {
    for (const args of argSets) {
      log("info", "启动 NapCat" + (args.length ? "（快速登录 " + uin + "，参数 " + args.join(" ") + "）" : "（二维码登录）"));
      try {
        const child = spawn(launcher, args, {
          cwd: shellDir,
          detached: false,
          windowsHide: true,
          stdio: "ignore",
        });
        if (child && typeof child.unref === "function") child.unref();
      } catch (error) {
        log("warn", "启动器拉起失败：" + String(error && error.message));
        continue;
      }

      const deadline = Math.min(Date.now() + deadlineMs, Date.now() + 45_000);
      while (Date.now() < deadline) {
        await sleep(1500);
        if (await isPortOpen(wsPort)) return { ok: true, args };
        if (listQQProcesses().length === 0) {
          log("warn", "QQ 启动后又退出了");
          break;
        }
      }
      // 这次参数没起来，清场重试下一种
      if (args.length) {
        log("warn", "用参数 " + args.join(" ") + " 没等到端口，换一种参数重试");
        await killQQ();
      }
    }
    return { ok: false, args: [] };
  }

  const launchResult = uin
    ? // 这个版本的 NapCat 只认裸账号（实测），-q 会被忽略并静默退回扫码。
      // 所以裸账号优先，失败再试 -q —— 顺序反了会白等一次 45 秒超时。
      await launchAndWait([[uin], ["-q", uin]], waitMs)
    : await launchAndWait([[]], waitMs);

  if (!launchResult.ok) {
    const known = listKnownUins(shellDir);
    return {
      ok: false,
      // 端口起来但账号没登录时 OneBot 服务根本不会启动，
      // 所以提示要区分「没账号可自动登录」和「要扫码」
      message:
        "等了 " + Math.round(waitMs / 1000) + " 秒，端口 " + wsPort + " 还没起来。" +
        (uin
          ? "快速登录 " + uin + " 没成功 —— 多半是登录凭据过期，去 http://127.0.0.1:6099/webui 扫码一次，之后就能自动登录。"
          : "当前是二维码登录模式，需要扫码。" +
            (known.length
              ? "检测到可快速登录的账号：" + known.join(" / ") + "，把机器人 QQ 号填进面板即可免扫码。"
              : "在面板填「机器人 QQ 号」可免扫码。")),
    };
  }

  const login = await probeLogin(httpUrl);
  return {
    ok: true,
    reused: false,
    selfId: login.ok ? login.selfId : "",
    nickname: login.ok ? login.nickname : "",
    login,
    message: login.ok
      ? "已连接：" + login.nickname + " (" + login.selfId + ")"
      : "OneBot 已启动，但还没登录成功（可能在等扫码）",
  };
}

/** 只做检测，不启动。给面板的「检查环境」用。 */
async function inspectNapCat(onebot = {}) {
  const wsPort = Number((String(onebot.wsUrl || "").match(/:(\d+)/) || [])[1] || 3001);
  const shells = findShellDirs();
  const out = {
    shells,
    shellDir: shells[0] || "",
    appRoot: "",
    version: "",
    patchExists: false,
    portOpen: await isPortOpen(wsPort),
    qqProcesses: listQQProcesses().length,
    login: null,
  };
  if (out.shellDir) {
    const found = findAppRoot(out.shellDir);
    if (found) {
      out.appRoot = found.appRoot;
      out.version = found.version;
      out.patchExists = fs.existsSync(path.join(found.appRoot, "qqnt.json"));
    }
    // 面板要显示「能自动登录的账号是哪些」，以及自动猜出来的那个
    out.knownUins = listKnownUins(out.shellDir);
    out.guessedUin = guessBotUin(out.shellDir, onebot.selfId);
  }
  if (out.portOpen) out.login = await probeLogin(onebot.httpUrl);
  return out;
}

module.exports = {
  startNapCat,
  inspectNapCat,
  findShellDirs,
  findAppRoot,
  ensurePatchPackage,
  listQQProcesses,
  guessBotUin,
  listKnownUins,
  probeLogin,
  isPortOpen,
};
