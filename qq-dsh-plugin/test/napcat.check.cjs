/**
 * NapCat 一键连接 / 自动登录的自检。
 *
 * 这里钉死的是「启动器参数」这一层 —— 之前正是它错了：
 * 传裸 uin 或 -q 都取决于 NapCat 版本，插件不能只赌一种。
 */
"use strict";

const path = require("node:path");
const fs = require("node:fs");

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

const napcat = require(path.join(__dirname, "..", "src", "napcat.cjs"));
const config = require(path.join(__dirname, "..", "src", "config.cjs"));

console.log("\n=== 1. 账号自动探测 ===");
const shells = napcat.findShellDirs();
check("找到 NapCat 目录", shells.length > 0, String(shells.length));
const shell = shells[0] || "E:\\NapCat\\OneKey\\NapCat.52230.Shell";

check("listKnownUins 返回数组", Array.isArray(napcat.listKnownUins(shell)));
check("显式账号优先", napcat.guessBotUin(shell, "3886139976") === "3886139976", napcat.guessBotUin(shell, "3886139976"));
check("live 账号次之", napcat.guessBotUin(shell, "", "123456789") === "123456789", napcat.guessBotUin(shell, "", "123456789"));
check("非法账号被拒", napcat.guessBotUin(shell, "abc") !== "abc", napcat.guessBotUin(shell, "abc"));
check("空账号不报错", typeof napcat.guessBotUin(shell, "") === "string");
check("不存在的目录不崩", napcat.guessBotUin("Z:\\nope", "") === "", napcat.guessBotUin("Z:\\nope", ""));

console.log("\n=== 2. 只读探测函数健壮性 ===");
check("findAppRoot 不存在目录返回 null", napcat.findAppRoot("Z:\\nope") === null);
check("listQQProcesses 返回数组", Array.isArray(napcat.listQQProcesses()));

(async () => {
  check("isPortOpen 对关闭端口返回 false", (await napcat.isPortOpen(59999)) === false);
  check("isPortOpen 返回布尔", typeof (await napcat.isPortOpen(59998)) === "boolean");
  const bad = await napcat.probeLogin("http://127.0.0.1:59997", 1500);
  check("probeLogin 连不上不抛", bad.ok === false && typeof bad.reason === "string", JSON.stringify(bad));

  console.log("\n=== 3. 配置项 ===");
  const norm = config.normalize({});
  check("默认 autoStart 为 true", norm.onebot.autoStart === true, String(norm.onebot.autoStart));
  check("autoStart 可关闭", config.normalize({ onebot: { autoStart: false } }).onebot.autoStart === false);
  check("shellDir 默认空", norm.onebot.shellDir === "", JSON.stringify(norm.onebot.shellDir));
  check("selfId 是字符串", typeof norm.onebot.selfId === "string");
  check("selfId 去空格", config.normalize({ onebot: { selfId: "  123  " } }).onebot.selfId === "123");

  console.log("\n=== 4. 默认值里不能把主人号当机器人号 ===");
  // 曾经的 bug：connectQQ 用 cfg.master.uin 去快速登录，结果登录成主人
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "index.js"), "utf8");
  check("connectQQ 不再直接用 master.uin 当登录号", !/uin:\s*payload\.uin\s*\|\|\s*cfg\.master\.uin/.test(src));
  check("connectQQ 用 onebot.selfId", /uin:\s*explicitUin\s*\|\|\s*String\(cfg\.onebot\.selfId/.test(src));
  check("有自动启动逻辑", src.includes("autoStart"));
  check("用了 napcat.isPortOpen", src.includes("napcat.isPortOpen"));
  check("成功后回写 selfId", /onebot:\s*\{\s*selfId:/.test(src));

  console.log("\n=== 5. 启动器参数要兼容两种形式 ===");
  // 这个版本只认裸账号，别的版本只认 -q，代码必须两种都试；
  // 顺序也很重要：裸账号在前，否则每次都要白等 45 秒超时
  const napcatSrc = fs.readFileSync(path.join(__dirname, "..", "src", "napcat.cjs"), "utf8");
  check("两种参数形式都尝试", /\[\[uin\],\s*\["-q", uin\]\]/.test(napcatSrc));
  check("裸账号优先", napcatSrc.indexOf("[[uin], [\"-q\", uin]]") > 0);
  check("失败的参数形式会重试另一种", napcatSrc.includes("换一种参数重试"));

  console.log("\n===== 结果 =====");
  console.log("  通过 " + pass + " / 失败 " + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
