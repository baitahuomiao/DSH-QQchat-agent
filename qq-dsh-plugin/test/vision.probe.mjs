/**
 * 直接问各家的 /v1/models，看有没有多模态（能看图）的模型可用。
 * 目的：确认「识图」这条需求能不能落到某个真实模型上。
 * 用法：node test/vision.probe.mjs
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const credPath = join(process.env.DSH_HOME || join(homedir(), ".dsh"), ".credentials.yaml");
const cred = readFileSync(credPath, "utf8");
const pick = (name) => {
  const match = new RegExp(name + ":\\s*(\\S+)").exec(cred);
  return match ? match[1] : null;
};
const DEEPSEEK = pick("DEEPSEEK_API_KEY");
const ABC = pick("ABC_API_KEY");
console.log("DEEPSEEK_API_KEY:", DEEPSEEK ? DEEPSEEK.slice(0, 6) + "…" : "(无)");
console.log("ABC_API_KEY     :", ABC ? ABC.slice(0, 6) + "…" : "(无)");

async function listModels(label, url, key) {
  if (!key) {
    console.log("\n" + label + "：没有 key，跳过");
    return;
  }
  try {
    const response = await fetch(url, { headers: { authorization: "Bearer " + key } });
    const text = await response.text();
    console.log("\n" + label + " -> " + response.status);
    try {
      const body = JSON.parse(text);
      const rows = body.data || body.models || [];
      if (!rows.length) {
        console.log("  原文：" + text.slice(0, 300));
        return;
      }
      for (const row of rows) {
        const id = row.id || row.name || "?";
        const modalities = row.input_modalities || row.inputModalities || row.modalities || null;
        console.log("  - " + id + (modalities ? "  [" + JSON.stringify(modalities) + "]" : ""));
      }
    } catch {
      console.log("  原文：" + text.slice(0, 300));
    }
  } catch (error) {
    console.log("\n" + label + " 请求失败：" + error.message);
  }
}

await listModels("api.deepseek.com", "https://api.deepseek.com/v1/models", DEEPSEEK);
await listModels("llm.ujn.edu.cn", "https://llm.ujn.edu.cn/v1/models", ABC);
