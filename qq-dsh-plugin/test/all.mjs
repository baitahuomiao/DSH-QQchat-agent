/**
 * 一把跑完所有检查。
 * 默认跳过要动 QQ / 发消息的实测（e2e、abilities、proactive 带 --send 会真发），
 * 需要时显式加参数：node test/all.mjs --live
 *
 * 用法：
 *   node test/all.mjs          # 纯离线：单测 + 契约 + 桥接 + 两个冒烟
 *   node test/all.mjs --live   # 再加真 NapCat 的回复链路与能力实测（不发送）
 */
import { spawnSync } from "node:child_process";

const live = process.argv.includes("--live");

const steps = [
  ["单元测试", ["test/core.test.cjs"], true],
  ["新功能自检", ["test/features.check.cjs"], true],
  ["风格音色自检", ["test/style.check.cjs"], true],
  ["百炼语音自检", ["test/dashscope.check.cjs"], true],
  ["一键连接自检", ["test/napcat.check.cjs"], true],
  ["契约自检", ["test/contract.check.mjs"], true],
  ["模型桥接", ["test/llm.bridge.mjs"], true],
  ["宿主冒烟", ["test/host.smoke.mjs"], true],
  ["客户端冒烟", ["test/client.smoke.mjs"], true],
  // 冒烟只验 slot 注册，不渲染组件；这条真跑每个 tab 的函数体，
  // 抓「引用未定义变量」那种只在浏览器里才白屏的 bug。
  ["客户端渲染", ["test/render.check.mjs"], true],
  // 装进 profile 的那份产物是不是新的。热挂载读不到新的宿主代码，
  // 所以这条用新进程直接导入安装位置——它绿了说明只差重启。
  ["安装产物", ["test/installed.check.mjs"], true],
  ["真实 QQ 链路", ["test/e2e.live.mjs"], live],
  ["能力实测", ["test/abilities.live.mjs"], live],
  ["主动发言", ["test/proactive.live.mjs"], live],
  // 这条会真调模型（有 token 成本，约一次识图），所以只在 --live 时跑
  ["识图链路", ["test/vision.live.mjs"], live],
];

const results = [];
for (const [label, args, enabled] of steps) {
  if (!enabled) {
    results.push([label, "skip"]);
    console.log("\n— 跳过：" + label);
    continue;
  }
  console.log("\n— 运行：" + label);
  const run = spawnSync(process.execPath, args, { stdio: "inherit", timeout: 180000 });
  results.push([label, run.status === 0 ? "ok" : "fail"]);
}

console.log("\n===== 汇总 =====");
for (const [label, state] of results) console.log("  " + label + "：" + state);
const failed = results.filter(([, state]) => state === "fail");
console.log(failed.length === 0 ? "\n全部通过" : "\n有 " + failed.length + " 项失败");
process.exit(failed.length === 0 ? 0 : 1);
