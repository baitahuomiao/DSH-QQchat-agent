/**
 * dsh-qq-agent 客户端面板。
 *
 * 这段代码会被 build/build.mjs 塞进 `window.__ModuleLoader__.load({...})` 的
 * factory 里执行，所以：
 *  - module scope 里除了 `require("react")` 之外不碰任何东西；
 *  - 文件末尾的 `module.exports = {...}` 会被构建脚本剥掉，真正生效的是
 *    factory 尾部的 contract 段；
 *  - 不要有相对路径 require（构建期没有模块解析能力）。
 *
 * 数据全来自宿主的四个路由：
 *   GET  /api/qq-agent/state   状态 + 配置 + 人设预设 + 路由 + 群/好友
 *   POST /api/qq-agent/config  保存配置
 *   POST /api/qq-agent/action  执行动作
 *   GET  /api/qq-agent/tts     试听语音（返回 audio/mpeg）
 */
const React = require("react");
const { useCallback, useEffect, useMemo, useRef, useState } = require("react");

const h = React.createElement;

const PANEL_ID = "dsh-qq-agent";
const PANEL_NS = "dsh-qq-agent";

const ROUTE_STATE = "/api/qq-agent/state";
const ROUTE_CONFIG = "/api/qq-agent/config";
const ROUTE_ACTION = "/api/qq-agent/action";
const ROUTE_TTS = "/api/qq-agent/tts";

const POLL_MS = 2500;

// ———————————————————————————— 小工具 ————————————————————————————

function clone(value) {
  if (value === null || typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value));
}

function setIn(obj, path, value) {
  const keys = path.split(".");
  const root = Array.isArray(obj) ? obj.slice() : Object.assign({}, obj);
  let cur = root;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const key = keys[i];
    const next = cur[key];
    cur[key] = Array.isArray(next) ? next.slice() : Object.assign({}, next);
    cur = cur[key];
  }
  cur[keys[keys.length - 1]] = value;
  return root;
}

function splitTags(text) {
  return String(text || "")
    .split(/[,，\s]+/)
    .map((row) => row.trim())
    .filter(Boolean);
}

function formatTime(ms) {
  if (!ms) return "—";
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatClock(ms) {
  if (!ms) return "—";
  const diff = Math.max(0, Math.round((ms - Date.now()) / 1000));
  if (diff < 60) return `${diff} 秒后`;
  if (diff < 3600) return `${Math.round(diff / 60)} 分钟后`;
  return `${(diff / 3600).toFixed(1)} 小时后`;
}

async function apiGet(url) {
  const response = await fetch(url, { credentials: "same-origin", headers: { accept: "application/json" } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) throw new Error(body.error || `请求失败（HTTP ${response.status}）`);
  return body;
}

async function apiPost(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(payload || {}),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) throw new Error(body.error || `请求失败（HTTP ${response.status}）`);
  return body;
}

// ———————————————————————————— 样式 ————————————————————————————

const PANEL_CSS = `
.qqa-root {
  display: flex; flex-direction: column; height: 100%; min-height: 0;
  color: var(--dsw-alias-label-primary, #1b2333);
  font-size: 13px; line-height: 1.55;
}
.qqa-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 18px 20px 40px; }
.qqa-head {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 14px 20px 12px; border-bottom: 1px solid var(--dsw-alias-border-secondary, #e6eaf2);
}
.qqa-title { font-size: 16px; font-weight: 650; letter-spacing: .2px; }
.qqa-sub { color: var(--dsw-alias-label-tertiary, #596b8e); font-size: 12px; }
.qqa-pills { display: flex; gap: 6px; flex-wrap: wrap; margin-left: auto; }
.qqa-pill {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 2px 9px; border-radius: 999px; font-size: 11.5px;
  background: var(--dsw-alias-bg-secondary, #f1f4f9);
  color: var(--dsw-alias-label-secondary, #3d4a63);
  border: 1px solid transparent;
}
.qqa-pill.is-ok { background: rgba(35,168,110,.12); color: #17925e; }
.qqa-pill.is-warn { background: rgba(224,150,28,.14); color: #a86c06; }
.qqa-pill.is-bad { background: rgba(220,68,68,.12); color: #c33; }
.qqa-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }

.qqa-tabs { display: flex; gap: 2px; padding: 0 20px; border-bottom: 1px solid var(--dsw-alias-border-secondary, #e6eaf2); overflow-x: auto; }
.qqa-tab {
  appearance: none; background: none; border: 0; cursor: pointer;
  padding: 9px 12px; font-size: 13px; color: var(--dsw-alias-label-tertiary, #596b8e);
  border-bottom: 2px solid transparent; white-space: nowrap;
}
.qqa-tab:hover { color: var(--dsw-alias-label-primary, #1b2333); }
.qqa-tab.is-active { color: var(--dsw-alias-label-primary, #1b2333); border-bottom-color: var(--dsw-alias-brand-primary, #4d6bfe); font-weight: 600; }

.qqa-card {
  border: 1px solid var(--dsw-alias-border-secondary, #e6eaf2);
  border-radius: 10px; padding: 14px 16px; margin-bottom: 14px;
  background: var(--dsw-alias-bg-primary, #fff);
}
.qqa-card-title { font-size: 13px; font-weight: 620; margin-bottom: 4px; }
.qqa-card-desc { color: var(--dsw-alias-label-tertiary, #596b8e); font-size: 12px; margin-bottom: 10px; }

.qqa-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px 18px; }
.qqa-row { display: flex; align-items: center; gap: 8px; }
.qqa-label { font-size: 12px; color: var(--dsw-alias-label-secondary, #3d4a63); margin-bottom: 4px; display: flex; gap: 6px; align-items: baseline; }
.qqa-hint { font-size: 11.5px; color: var(--dsw-alias-label-tertiary, #7a89a6); }

input.qqa-input, textarea.qqa-input, select.qqa-input {
  width: 100%; box-sizing: border-box;
  padding: 6px 9px; font-size: 13px; font-family: inherit;
  color: var(--dsw-alias-label-primary, #1b2333);
  background: var(--dsw-alias-bg-primary, #fff);
  border: 1px solid var(--dsw-alias-border-secondary, #d8dee9);
  border-radius: 7px; outline: none;
}
input.qqa-input:focus, textarea.qqa-input:focus, select.qqa-input:focus {
  border-color: var(--dsw-alias-brand-primary, #4d6bfe);
  box-shadow: 0 0 0 3px rgba(77,107,254,.12);
}
textarea.qqa-input { resize: vertical; min-height: 68px; line-height: 1.5; }
textarea.qqa-mono { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 12px; }

button.qqa-btn {
  appearance: none; cursor: pointer; font-family: inherit;
  padding: 5px 12px; font-size: 12.5px; border-radius: 7px;
  border: 1px solid var(--dsw-alias-border-secondary, #d8dee9);
  background: var(--dsw-alias-bg-primary, #fff);
  color: var(--dsw-alias-label-primary, #1b2333);
}
button.qqa-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-secondary, #f1f4f9); }
button.qqa-btn:disabled { opacity: .5; cursor: default; }
button.qqa-btn.is-primary {
  background: var(--dsw-alias-brand-primary, #4d6bfe); border-color: transparent; color: #fff;
}
button.qqa-btn.is-primary:hover:not(:disabled) { filter: brightness(1.06); }
button.qqa-btn.is-danger { color: #c33; border-color: rgba(204,51,51,.35); }
button.qqa-btn.is-sm { padding: 3px 9px; font-size: 12px; }

.qqa-switch { position: relative; width: 36px; height: 20px; flex: none; cursor: pointer; }
.qqa-switch input { position: absolute; opacity: 0; width: 0; height: 0; }
.qqa-switch span {
  position: absolute; inset: 0; border-radius: 999px; transition: background .15s;
  background: var(--dsw-alias-border-secondary, #cfd6e4);
}
.qqa-switch span::after {
  content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px;
  border-radius: 50%; background: #fff; transition: transform .15s; box-shadow: 0 1px 2px rgba(0,0,0,.2);
}
.qqa-switch input:checked + span { background: var(--dsw-alias-brand-primary, #4d6bfe); }
.qqa-switch input:checked + span::after { transform: translateX(16px); }

.qqa-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; }
.qqa-stat {
  border: 1px solid var(--dsw-alias-border-secondary, #e6eaf2); border-radius: 9px;
  padding: 9px 11px; background: var(--dsw-alias-bg-secondary, #f8fafd);
}
.qqa-stat-k { font-size: 11.5px; color: var(--dsw-alias-label-tertiary, #7a89a6); }
.qqa-stat-v { font-size: 17px; font-weight: 620; margin-top: 1px; }
.qqa-stat-v small { font-size: 11.5px; font-weight: 400; color: var(--dsw-alias-label-tertiary, #7a89a6); }

.qqa-logs { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 11.5px; line-height: 1.6; max-height: 420px; overflow-y: auto; }
.qqa-log { display: flex; gap: 8px; padding: 1px 0; }
.qqa-log-t { color: var(--dsw-alias-label-tertiary, #8b99b3); flex: none; }
.qqa-log-l { flex: none; width: 42px; text-transform: uppercase; font-size: 10.5px; padding-top: 1px; }
.qqa-log-l.is-warn { color: #c08a12; }
.qqa-log-l.is-error { color: #c33; }
.qqa-log-l.is-info { color: #2b8a5e; }
.qqa-log-m { flex: 1; word-break: break-word; }

.qqa-videos { display: flex; flex-direction: column; gap: 8px; }
.qqa-video {
  display: flex; gap: 10px; padding: 8px; border-radius: 9px;
  border: 1px solid var(--dsw-alias-border-secondary, #e6eaf2);
  background: var(--dsw-alias-bg-primary, #fff);
}
.qqa-video img { width: 96px; height: 60px; object-fit: cover; border-radius: 6px; flex: none; background: #eef1f7; }
.qqa-video-body { min-width: 0; flex: 1; }
.qqa-video-title { font-size: 12.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.qqa-video-meta { font-size: 11.5px; color: var(--dsw-alias-label-tertiary, #7a89a6); margin-top: 2px; }
.qqa-video-note { font-size: 12px; color: var(--dsw-alias-label-secondary, #3d4a63); margin-top: 4px; }

.qqa-empty { color: var(--dsw-alias-label-tertiary, #8b99b3); font-size: 12px; padding: 10px 0; }
.qqa-foot {
  display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
  padding: 10px 20px; border-top: 1px solid var(--dsw-alias-border-secondary, #e6eaf2);
  background: var(--dsw-alias-bg-primary, #fff);
}
.qqa-toast {
  margin-left: auto; font-size: 12px; color: var(--dsw-alias-label-tertiary, #596b8e);
  max-width: 60%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.qqa-toast.is-ok { color: #17925e; }
.qqa-toast.is-bad { color: #c33; }
.qqa-dirty { color: #c08a12; font-size: 12px; }
`;

let styleElement = null;

function installStyles(doc) {
  if (typeof doc === "undefined" || doc === null) return function noop() {};
  if (styleElement !== null && styleElement.isConnected) return function keep() {};
  const style = doc.createElement("style");
  style.setAttribute("data-dsh-qq-agent-style", "true");
  style.textContent = PANEL_CSS;
  doc.head.appendChild(style);
  styleElement = style;
  return function removeStyle() {
    if (style.isConnected) style.remove();
    if (styleElement === style) styleElement = null;
  };
}

// ———————————————————————————— 表单零件 ————————————————————————————

function Field(props) {
  return h(
    "div",
    null,
    h("div", { className: "qqa-label" }, h("span", null, props.label), props.hint ? h("span", { className: "qqa-hint" }, props.hint) : null),
    props.children,
  );
}

function TextField(props) {
  return h(Field, { label: props.label, hint: props.hint },
    h("input", {
      className: "qqa-input",
      type: "text",
      value: props.value === undefined || props.value === null ? "" : String(props.value),
      placeholder: props.placeholder || "",
      onChange: (event) => props.onChange(event.target.value),
    }));
}

function NumberField(props) {
  return h(Field, { label: props.label, hint: props.hint },
    h("input", {
      className: "qqa-input",
      type: "number",
      step: props.step === undefined ? "any" : props.step,
      min: props.min,
      max: props.max,
      value: props.value === undefined || props.value === null ? "" : String(props.value),
      onChange: (event) => {
        const raw = event.target.value;
        if (raw === "") return props.onChange(props.emptyAs === undefined ? 0 : props.emptyAs);
        const num = Number(raw);
        if (Number.isNaN(num)) return;
        props.onChange(num);
      },
    }));
}

function TextArea(props) {
  return h(Field, { label: props.label, hint: props.hint },
    h("textarea", {
      className: "qqa-input" + (props.mono ? " qqa-mono" : ""),
      rows: props.rows || 4,
      value: props.value === undefined || props.value === null ? "" : String(props.value),
      placeholder: props.placeholder || "",
      onChange: (event) => props.onChange(event.target.value),
    }));
}

function SelectField(props) {
  return h(Field, { label: props.label, hint: props.hint },
    h("select", {
      className: "qqa-input",
      value: props.value === undefined || props.value === null ? "" : String(props.value),
      onChange: (event) => props.onChange(event.target.value),
    }, (props.options || []).map((opt) => h("option", { key: opt.value, value: opt.value }, opt.label))));
}

function TagsField(props) {
  const [text, setText] = useState((props.value || []).join(", "));
  const lastValue = useRef((props.value || []).join(", "));
  useEffect(() => {
    const joined = (props.value || []).join(", ");
    if (joined !== lastValue.current) {
      lastValue.current = joined;
      setText(joined);
    }
  }, [props.value]);
  return h(Field, { label: props.label, hint: props.hint },
    h("input", {
      className: "qqa-input",
      type: "text",
      value: text,
      placeholder: props.placeholder || "用逗号或空格分隔",
      onChange: (event) => {
        setText(event.target.value);
        const list = splitTags(event.target.value);
        lastValue.current = list.join(", ");
        props.onChange(list);
      },
    }));
}

function Toggle(props) {
  return h("div", { className: "qqa-row", style: { justifyContent: "space-between", gap: 12 } },
    h("div", null,
      h("div", { className: "qqa-label", style: { marginBottom: 0 } }, props.label),
      props.hint ? h("div", { className: "qqa-hint" }, props.hint) : null),
    h("label", { className: "qqa-switch" },
      h("input", { type: "checkbox", checked: Boolean(props.value), onChange: (event) => props.onChange(event.target.checked) }),
      h("span", null)));
}

function Card(props) {
  return h("div", { className: "qqa-card" },
    props.title ? h("div", { className: "qqa-card-title" }, props.title) : null,
    props.desc ? h("div", { className: "qqa-card-desc" }, props.desc) : null,
    props.children);
}

function Stat(props) {
  return h("div", { className: "qqa-stat" },
    h("div", { className: "qqa-stat-k" }, props.label),
    h("div", { className: "qqa-stat-v" }, props.value, props.suffix ? h("small", null, " " + props.suffix) : null));
}

function VideoList(props) {
  const rows = props.rows || [];
  if (rows.length === 0) return h("div", { className: "qqa-empty" }, props.empty || "还没有内容。");
  return h("div", { className: "qqa-videos" },
    rows.map((row) =>
      h("div", { className: "qqa-video", key: row.bvid || row.at || row.title },
        row.cover ? h("img", { src: row.cover, alt: "", loading: "lazy", referrerPolicy: "no-referrer" }) : null,
        h("div", { className: "qqa-video-body" },
          h("div", { className: "qqa-video-title" }, row.title || row.bvid),
          h("div", { className: "qqa-video-meta" },
            [row.author ? "UP " + row.author : "", row.durationText || "", row.at ? formatTime(row.at) : ""]
              .filter(Boolean).join(" · ")),
          row.note ? h("div", { className: "qqa-video-note" }, row.note) : null))));
}

// ———————————————————————————— 各标签页 ————————————————————————————

function OverviewTab(props) {
  const { data, act, busy } = props;
  const st = data.state || {};
  const conn = st.connection || {};

  return h("div", null,
    h(Card, { title: "运行状态" },
      h("div", { className: "qqa-stats" },
        h(Stat, { label: "连接", value: conn.connected ? "在线" : "离线", suffix: conn.connected ? "" : conn.lastError ? "重连中" : "" }),
        h(Stat, { label: "小号", value: st.nickname || "—", suffix: st.selfId ? "(" + st.selfId + ")" : "" }),
        h(Stat, { label: "已回复", value: st.replyCount || 0, suffix: "条" }),
        h(Stat, { label: "主动发言", value: st.proactiveCount || 0, suffix: "次" }),
        h(Stat, { label: "下次主动", value: st.nextProactiveAt ? formatClock(st.nextProactiveAt) : "—" }),
        h(Stat, { label: "视频暂存", value: st.shelfSize || 0, suffix: "条" }))),

    h(Card, { title: "快捷操作" },
      h("div", { className: "qqa-row", style: { flexWrap: "wrap", gap: 8 } },
        h("button", { className: "qqa-btn is-primary", disabled: Boolean(busy) || !st.paused, onClick: () => act("resume") }, "恢复自动回复"),
        h("button", { className: "qqa-btn", disabled: Boolean(busy) || Boolean(st.paused), onClick: () => act("pause") }, "暂停自动回复"),
        h("button", { className: "qqa-btn", disabled: Boolean(busy), onClick: () => act("refreshGroups") }, "刷新群列表"),
        h("button", { className: "qqa-btn", disabled: Boolean(busy), onClick: () => act("refreshFriends") }, "刷新好友"),
        h("button", { className: "qqa-btn", disabled: Boolean(busy), onClick: () => act("reload") }, "重载配置"))),

    st.pendingApproval
      ? h(Card, { title: "有一件事等你点头", desc: "有人发起了刷 B 站的请求，但还没有主人批准。" },
          h("div", { className: "qqa-row", style: { gap: 8 } },
            h("span", { className: "qqa-hint" }, formatTime(st.pendingApproval.at) + " · " + (st.pendingApproval.by || "未知")),
            h("button", { className: "qqa-btn is-primary is-sm", disabled: Boolean(busy), onClick: () => act("approveBilibili") }, "批准"),
            h("button", { className: "qqa-btn is-sm", disabled: Boolean(busy), onClick: () => act("revokeBilibili") }, "忽略")))
      : null,

    h(Card, { title: "刚看过的视频", desc: "只保留最近 " + data.config.bilibili.retentionHours + " 小时。" },
      h(VideoList, { rows: (st.shelf || []).slice(0, 8), empty: "还没有刷过视频。" })),
  );
}

function PersonaTab(props) {
  const { data, draft, set, act, busy } = props;
  const presets = data.presets || [];

  return h("div", null,
    h(Card, { title: "主人", desc: "被设为主人的那个人，主动搭话概率最高，也拥有全部管理指令权限。" },
      h("div", { className: "qqa-grid" },
        h(TextField, { label: "主人 QQ 号", value: draft.master.uin, placeholder: "例如 920420642", onChange: (v) => set("master.uin", v.trim()) }),
        h(TextField, { label: "称呼", value: draft.master.alias, placeholder: "主人", onChange: (v) => set("master.alias", v) })),
      h("div", { style: { marginTop: 12 } },
        h(TextArea, { label: "对主人的额外设定", rows: 2, value: draft.master.extra, onChange: (v) => set("master.extra", v) }))),

    h(Card, { title: "人设", desc: "这段提示词会拼进每次对话的系统提示，决定她是谁、怎么说话。" },
      h("div", { className: "qqa-grid" },
        h(TextField, { label: "名字", value: draft.persona.name, onChange: (v) => set("persona.name", v) })),
      h("div", { style: { marginTop: 12 } },
        h(TextArea, { label: "人格提示词", rows: 10, value: draft.persona.prompt, placeholder: "你是谁、说话风格、好恶……", onChange: (v) => set("persona.prompt", v) })),
      h("div", { style: { marginTop: 12 } },
        h(TextArea, { label: "补充设定", rows: 3, value: draft.persona.extra, hint: "临时加一句要求，比如「最近在学吉他」", onChange: (v) => set("persona.extra", v) })),
      h("div", { className: "qqa-row", style: { marginTop: 12 } },
        h("button", { className: "qqa-btn is-primary", disabled: Boolean(busy), onClick: () => act("savePersona", { name: draft.persona.name, prompt: draft.persona.prompt }) }, "立即保存人设"))),

    h(Card, { title: "内置预设", desc: "点一下换个人格，会直接覆盖上面的名字和提示词。" },
      h("div", { className: "qqa-row", style: { flexWrap: "wrap", gap: 8 } },
        presets.map((preset) =>
          h("button", {
            key: preset.id,
            className: "qqa-btn" + (draft.persona.name === preset.name ? " is-primary" : ""),
            disabled: Boolean(busy),
            title: preset.prompt.slice(0, 120),
            onClick: () => act("usePreset", { id: preset.id }),
          }, preset.name)))));
}

function ConnectTab(props) {
  const { data, draft, set, act, busy } = props;
  const st = data.state || {};
  const conn = st.connection || {};
  const groups = data.groups || [];
  const friends = data.friends || [];

  return h("div", null,
    h(Card, { title: "OneBot 连接", desc: "NapCat / LLOneBot 的 OneBot 11 地址。电脑端 QQ 登录后一般就是这两个端口。" },
      h("div", {
        className: "qqa-pill " + (conn.connected ? "is-ok" : "is-bad"),
        style: { marginBottom: 10 },
      }, h("span", { className: "qqa-dot" }), conn.connected ? "已连接 " + (conn.wsUrl || "") : "未连接" + (conn.lastError ? "：" + conn.lastError : "")),
      h("div", { className: "qqa-grid" },
        h(TextField, { label: "WebSocket 地址", value: draft.onebot.wsUrl, placeholder: "ws://127.0.0.1:3001", onChange: (v) => set("onebot.wsUrl", v.trim()) }),
        h(TextField, { label: "HTTP 地址", value: draft.onebot.httpUrl, hint: "可选", onChange: (v) => set("onebot.httpUrl", v.trim()) }),
        h(TextField, { label: "访问令牌", value: draft.onebot.token, hint: "没设就留空", onChange: (v) => set("onebot.token", v.trim()) }),
        h(NumberField, { label: "重连间隔（毫秒）", min: 1000, step: 500, value: draft.onebot.reconnectMs, onChange: (v) => set("onebot.reconnectMs", v) })),
      h("div", { className: "qqa-row", style: { marginTop: 12, gap: 8 } },
        h("button", { className: "qqa-btn", disabled: Boolean(busy), onClick: () => act("refreshGroups") }, "拉群列表"),
        h("button", { className: "qqa-btn", disabled: Boolean(busy), onClick: () => act("refreshFriends") }, "拉好友列表"),
        h("span", { className: "qqa-hint" }, "改了地址要先保存配置再重载"))),

    h(Card, { title: "已发现的群", desc: "群名只是给人看的，授权要填群号。点一下加到白名单。" },
      groups.length === 0
        ? h("div", { className: "qqa-empty" }, "还没拉到群列表。")
        : h("div", { className: "qqa-row", style: { flexWrap: "wrap", gap: 6 } },
            groups.map((row) =>
              h("button", {
                key: row.group_id,
                className: "qqa-btn is-sm",
                onClick: () => {
                  const list = (draft.reply.groupWhitelist || []).slice();
                  if (!list.includes(row.group_id)) list.push(row.group_id);
                  set("reply.groupWhitelist", list);
                },
              }, (row.group_name || row.group_id) + " (" + row.member_count + ")")))),

    h(Card, { title: "已发现的好友", desc: "点一下加进私聊白名单。" },
      friends.length === 0
        ? h("div", { className: "qqa-empty" }, "还没拉到好友列表。")
        : h("div", { className: "qqa-row", style: { flexWrap: "wrap", gap: 6 } },
            friends.map((row) =>
              h("button", {
                key: row.user_id,
                className: "qqa-btn is-sm",
                onClick: () => {
                  const list = (draft.reply.privateWhitelist || []).slice();
                  if (!list.includes(row.user_id)) list.push(row.user_id);
                  set("reply.privateWhitelist", list);
                },
              }, (row.nickname || row.user_id) + " (" + row.user_id + ")")))));
}

function ReplyTab(props) {
  const { draft, set } = props;

  return h("div", null,
    h(Card, { title: "群聊", desc: "只有白名单里的群才会回应。" },
      h(Toggle, { label: "启用群聊回复", value: draft.reply.groupsEnabled, onChange: (v) => set("reply.groupsEnabled", v) }),
      h("div", { className: "qqa-grid", style: { marginTop: 12 } },
        h(SelectField, {
          label: "触发方式",
          value: draft.reply.groupMode,
          options: [
            { value: "at", label: "@ 我时回复" },
            { value: "keyword", label: "命中关键词时回复" },
            { value: "all", label: "每条都回（慎用）" },
            { value: "off", label: "群聊全关" },
          ],
          onChange: (v) => set("reply.groupMode", v),
        })),
      h("div", { className: "qqa-grid", style: { marginTop: 12 } },
        h(TagsField, { label: "授权群号", value: draft.reply.groupWhitelist, placeholder: "例如 1109502463, 1106077689", onChange: (v) => set("reply.groupWhitelist", v) }),
        h(TagsField, { label: "触发关键词", value: draft.reply.groupKeywords, hint: "groupMode=keyword 时生效", onChange: (v) => set("reply.groupKeywords", v) }))),

    h(Card, { title: "私聊", desc: "一对一聊天。" },
      h(Toggle, { label: "启用私聊回复", value: draft.reply.privateEnabled, onChange: (v) => set("reply.privateEnabled", v) }),
      h("div", { style: { marginTop: 10 } },
        h(Toggle, { label: "只回白名单里的人", value: draft.reply.privateWhitelistOnly, hint: "关掉就是谁都能私聊她", onChange: (v) => set("reply.privateWhitelistOnly", v) })),
      h("div", { style: { marginTop: 12 } },
        h(TagsField, { label: "私聊白名单", value: draft.reply.privateWhitelist, onChange: (v) => set("reply.privateWhitelist", v) }))),

    h(Card, { title: "说话方式" },
      h("div", { className: "qqa-grid" },
        h(NumberField, { label: "单条最长字数", min: 20, max: 2000, value: draft.reply.maxChars, onChange: (v) => set("reply.maxChars", v) }),
        h(NumberField, { label: "打字速度（字/秒）", min: 1, max: 120, value: draft.reply.typingCps, onChange: (v) => set("reply.typingCps", v) }),
        h(NumberField, { label: "最短停顿（毫秒）", min: 0, step: 100, value: draft.reply.minDelayMs, onChange: (v) => set("reply.minDelayMs", v) }),
        h(NumberField, { label: "最长停顿（毫秒）", min: 0, step: 100, value: draft.reply.maxDelayMs, onChange: (v) => set("reply.maxDelayMs", v) }),
        h(NumberField, { label: "记忆轮数", min: 0, max: 200, value: draft.reply.memoryTurns, onChange: (v) => set("reply.memoryTurns", v) }),
        h(NumberField, { label: "同一会话冷却（秒）", min: 0, max: 600, value: draft.reply.cooldownSec, onChange: (v) => set("reply.cooldownSec", v) }),
        h(NumberField, { label: "回复概率", min: 0, max: 1, step: 0.05, value: draft.reply.replyChance, hint: "1 = 每条都回", onChange: (v) => set("reply.replyChance", v) })),
      h("div", { style: { marginTop: 10 } },
        h(Toggle, { label: "长回复拆成多条", value: draft.reply.splitSegments, hint: "更像真人打字", onChange: (v) => set("reply.splitSegments", v) }))),

    h(Card, { title: "主动找话说", desc: "不需要有人先说话，她自己会来搭话。主人权重最高。" },
      h(Toggle, { label: "启用主动发言", value: draft.active.enabled, onChange: (v) => set("active.enabled", v) }),
      h("div", { className: "qqa-grid", style: { marginTop: 12 } },
        h(NumberField, { label: "对主人的权重", min: 0, max: 1, step: 0.05, value: draft.active.masterWeight, onChange: (v) => set("active.masterWeight", v) }),
        h(NumberField, { label: "对别人的权重", min: 0, max: 1, step: 0.01, value: draft.active.otherWeight, onChange: (v) => set("active.otherWeight", v) }),
        h(NumberField, { label: "最短间隔（分钟）", min: 1, max: 1440, value: draft.active.minGapMinutes, onChange: (v) => set("active.minGapMinutes", v) }),
        h(NumberField, { label: "最长间隔（分钟）", min: 1, max: 1440, value: draft.active.maxGapMinutes, onChange: (v) => set("active.maxGapMinutes", v) }),
        h(NumberField, { label: "每小时上限", min: 0, max: 60, value: draft.active.maxPerHour, onChange: (v) => set("active.maxPerHour", v) }),
        h(NumberField, { label: "主动时刷 B 站概率", min: 0, max: 1, step: 0.05, value: draft.active.browseChance, onChange: (v) => set("active.browseChance", v) }),
        h(NumberField, { label: "免打扰开始（时）", min: 0, max: 23, value: draft.active.quietStartHour, onChange: (v) => set("active.quietStartHour", v) }),
        h(NumberField, { label: "免打扰结束（时）", min: 0, max: 23, value: draft.active.quietEndHour, onChange: (v) => set("active.quietEndHour", v) }))),

    h(Card, { title: "权限" },
      h("div", { className: "qqa-grid" },
        h(TagsField, { label: "额外管理员 QQ", value: draft.admin.uins, hint: "除主人外能下指令的人", onChange: (v) => set("admin.uins", v) })),
      h("div", { style: { marginTop: 10 } },
        h(Toggle, { label: "允许群管理操作", value: draft.admin.groupAdmin, hint: "禁言、踢人、撤回等", onChange: (v) => set("admin.groupAdmin", v) }))),
  );
}

/**
 * 识图路由的提示条。
 * 最常见的坑：聊天路由是纯文本模型，图片进去只会变成一句占位文字，
 * 用户却以为「识图开了」。这里把「到底能不能看图」直接写出来。
 */
function visionHint(data, draft) {
  if (!draft.vision.enabled) return null;
  const route = data.route;
  if (!route) return null;
  const vision = route.vision || {};
  if (vision.seesImages) {
    // 识图路由和聊天路由不是同一条时要说出来：不然用户会以为聊天也在用那个模型
    const via = vision.differs ? "（跟聊天不是同一条，只在看图时切过去）" : "";
    return h("div", { className: "qqa-pill is-ok", style: { marginTop: 10 } },
      h("span", { className: "qqa-dot" }), "识图走 " + vision.provider + " / " + vision.model + "，能看图" + via);
  }
  if (vision.error) {
    return h("div", { className: "qqa-pill is-bad", style: { marginTop: 10 } },
      h("span", { className: "qqa-dot" }), "识图路由不可用：" + vision.error);
  }
  const tried = (vision.tried || []).length > 0 ? "（试过 " + vision.tried.join("、") + "）" : "";
  return h("div", { className: "qqa-pill is-warn", style: { marginTop: 10 } },
    h("span", { className: "qqa-dot" }),
    "所有模型路由都只声明了文字输入" + tried + "，图片会被忽略。换一个支持视觉的 provider，或给识图单独指定一条。");
}

function AbilityTab(props) {
  const { data, draft, set, act, busy, ttsText, setTtsText } = props;

  return h("div", null,
    h(Card, { title: "联网搜索", desc: "需要查东西时自己去搜，结果会作为参考塞进上下文。" },
      h(SelectField, {
        label: "搜索时机",
        value: draft.search.mode,
        options: [
          { value: "auto", label: "自动判断" },
          { value: "always", label: "每条都搜" },
          { value: "off", label: "关闭" },
        ],
        onChange: (v) => set("search.mode", v),
      }),
      h("div", { style: { marginTop: 12 } },
        h(NumberField, { label: "最多取几条结果", min: 1, max: 10, value: draft.search.maxResults, onChange: (v) => set("search.maxResults", v) }))),

    h(Card, { title: "看图", desc: "有人发图片时会先看图再回。图片必须走一条支持视觉输入的模型，否则模型只能看到一段占位文字。" },
      h(Toggle, { label: "启用图片识别", value: draft.vision.enabled, onChange: (v) => set("vision.enabled", v) }),
      h("div", { style: { marginTop: 12 } },
        h(NumberField, { label: "图片大小上限（MB）", min: 1, max: 32, value: Math.round((draft.vision.maxBytes || 0) / 1048576), onChange: (v) => set("vision.maxBytes", Math.round(v * 1048576)) })),
      visionHint(data, draft),
      h("div", { className: "qqa-grid", style: { marginTop: 12 } },
        h(SelectField, {
          label: "识图 Provider",
          value: draft.vision.provider,
          options: [{ value: "", label: "（跟聊天同一条）" }].concat(((data.route && data.route.providers) || []).map((row) => ({ value: row.id, label: (row.name || row.id) + (row.id === "deepseek-official" ? "（可看图）" : "") }))),
          onChange: (v) => set("vision.provider", v),
        }),
        h(SelectField, {
          label: "识图模型",
          value: draft.vision.model,
          options: [{ value: "", label: "（自动挑能看图的）" }].concat((((data.route && data.route.vision && data.route.vision.models) || (data.route && data.route.models)) || []).map((row) => ({ value: row.id, label: (row.name || row.id) + (row.inputModalities && row.inputModalities.includes("image") ? "（可看图）" : "") }))),
          onChange: (v) => set("vision.model", v),
        }))),

    h(Card, { title: "语音回复", desc: "把文字转成语音发出去。合成走百度翻译的免费接口，返回 MP3。" },
      h(Toggle, { label: "启用语音", value: draft.voice.enabled, onChange: (v) => set("voice.enabled", v) }),
      h("div", { className: "qqa-grid", style: { marginTop: 12 } },
        h(SelectField, {
          label: "什么时候发语音",
          value: draft.voice.mode,
          options: [
            { value: "auto", label: "随机概率" },
            { value: "keyword", label: "只有被要求时" },
            { value: "off", label: "不发语音" },
          ],
          onChange: (v) => set("voice.mode", v),
        }),
        h(NumberField, { label: "概率", min: 0, max: 1, step: 0.05, value: draft.voice.chance, onChange: (v) => set("voice.chance", v) }),
        h(NumberField, { label: "语速（1-15）", min: 1, max: 15, value: draft.voice.speed, onChange: (v) => set("voice.speed", v) }),
        h(NumberField, { label: "单条最长字数", min: 10, max: 500, value: draft.voice.maxChars, onChange: (v) => set("voice.maxChars", v) })),
      h("div", { style: { marginTop: 12 } },
        h(TagsField, { label: "被要求发语音的关键词", value: draft.voice.keywords, onChange: (v) => set("voice.keywords", v) })),
      h("div", { style: { marginTop: 12 } },
        h(TextArea, {
          label: "读音替换",
          mono: true,
          rows: 2,
          value: JSON.stringify(draft.voice.lexicon || {}),
          hint: 'JSON，例如 {"B站":"哔哩哔哩"}',
          onChange: (v) => {
            try {
              const parsed = JSON.parse(v || "{}");
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) set("voice.lexicon", parsed);
            } catch {
              /* 输入中间态先不管 */
            }
          },
        })),
      h("div", { className: "qqa-row", style: { marginTop: 12, gap: 8, flexWrap: "wrap" } },
        h("input", {
          className: "qqa-input",
          style: { flex: "1 1 200px", maxWidth: 320 },
          placeholder: "试听文本",
          value: ttsText,
          onChange: (event) => setTtsText(event.target.value),
        }),
        h("button", {
          className: "qqa-btn",
          disabled: Boolean(busy),
          onClick: () => {
            const text = ttsText || "你好呀，我是" + draft.persona.name + "。";
            const url = ROUTE_TTS + "?text=" + encodeURIComponent(text) + "&speed=" + draft.voice.speed;
            try {
              const audio = new Audio(url);
              audio.play().catch(() => props.showToast("浏览器拦下了自动播放，请再点一次", "bad"));
            } catch {
              act("testVoice", { text });
            }
          },
        }, "试听"),
        h("button", {
          className: "qqa-btn",
          disabled: Boolean(busy) || !draft.master.uin,
          onClick: () => act("sendVoice", { text: ttsText || "你好呀", uin: draft.master.uin }),
        }, "发给主人"))),

    h(Card, { title: "模型路由", desc: "留空就用 DSH 当前的默认路由。思考过程由 DSH 自己的模型服务提供。" },
      data.route
        ? h("div", { className: "qqa-pill is-ok", style: { marginBottom: 10 } },
            h("span", { className: "qqa-dot" }), data.route.provider + " / " + data.route.model)
        : h("div", { className: "qqa-pill is-bad", style: { marginBottom: 10 } }, h("span", { className: "qqa-dot" }), data.routeError || "不可用"),
      h("div", { className: "qqa-grid" },
        h(SelectField, {
          label: "Provider",
          value: draft.llm.provider,
          options: [{ value: "", label: "（默认）" }].concat(((data.route && data.route.providers) || []).map((row) => ({ value: row.id, label: row.name || row.id }))),
          onChange: (v) => set("llm.provider", v),
        }),
        h(SelectField, {
          label: "模型",
          value: draft.llm.model,
          options: [{ value: "", label: "（默认）" }].concat(((data.route && data.route.models) || []).map((row) => ({ value: row.id, label: row.name || row.id }))),
          onChange: (v) => set("llm.model", v),
        }),
        h(NumberField, { label: "Temperature", min: 0, max: 2, step: 0.05, value: draft.llm.temperature, onChange: (v) => set("llm.temperature", v) }),
        h(NumberField, {
          label: "Max Tokens",
          min: 100,
          max: 16384,
          step: 100,
          value: draft.llm.maxTokens,
          hint: "推理模型会先想再说，这笔预算包含思考。太小会只剩一段空白回复。",
          onChange: (v) => set("llm.maxTokens", v),
        }))),
  );
}

function BilibiliTab(props) {
  const { data, draft, set, act, busy } = props;
  const st = data.state || {};
  const last = (st.lastBrowse && st.lastBrowse.videos) || [];

  return h("div", null,
    h(Card, { title: "刷 B 站", desc: "去热门里翻视频看，看完写下内容描述暂存起来，之后聊天时可以聊到。" },
      h("div", { className: "qqa-pill " + (draft.bilibili.approved ? "is-ok" : "is-warn"), style: { marginBottom: 10 } },
        h("span", { className: "qqa-dot" }), draft.bilibili.approved ? "主人已批准" : "还没批准——只有主人能让她刷"),
      h(Toggle, { label: "启用 B 站", value: draft.bilibili.enabled, onChange: (v) => set("bilibili.enabled", v) }),
      h("div", { className: "qqa-grid", style: { marginTop: 12 } },
        h(NumberField, { label: "每次刷几条", min: 1, max: 20, value: draft.bilibili.batchSize, onChange: (v) => set("bilibili.batchSize", v) }),
        h(NumberField, { label: "候选池大小", min: 1, max: 50, value: draft.bilibili.feedSize, onChange: (v) => set("bilibili.feedSize", v) }),
        h(NumberField, { label: "暂存时长（小时）", min: 0.25, max: 48, step: 0.25, value: draft.bilibili.retentionHours, onChange: (v) => set("bilibili.retentionHours", v) })),
      h("div", { style: { marginTop: 10 } },
        h(Toggle, { label: "把描述写进记忆", value: draft.bilibili.keepNotes, onChange: (v) => set("bilibili.keepNotes", v) })),
      h("div", { style: { marginTop: 6 } },
        h(Toggle, { label: "主动发言时聊视频", value: draft.bilibili.talkAboutVideos, onChange: (v) => set("bilibili.talkAboutVideos", v) })),
      h("div", { style: { marginTop: 6 } },
        h(Toggle, { label: "用模型写观后感", value: draft.bilibili.aiNotes, hint: "关掉则用模板描述，更省 token", onChange: (v) => set("bilibili.aiNotes", v) })),
      h("div", { className: "qqa-row", style: { marginTop: 12, gap: 8, flexWrap: "wrap" } },
        h("button", { className: "qqa-btn is-primary", disabled: Boolean(busy), onClick: () => act("browse", { force: true }) }, "现在刷一次"),
        draft.bilibili.approved
          ? h("button", { className: "qqa-btn is-danger", disabled: Boolean(busy), onClick: () => act("revokeBilibili") }, "撤销批准")
          : h("button", { className: "qqa-btn", disabled: Boolean(busy), onClick: () => act("approveBilibili") }, "批准"),
        h("button", { className: "qqa-btn", disabled: Boolean(busy), onClick: () => act("clearShelf") }, "清空暂存"),
        h("button", { className: "qqa-btn", disabled: Boolean(busy), onClick: () => act("popular") }, "看热门榜"))),

    h(Card, { title: "暂存的视频", desc: "超过 " + draft.bilibili.retentionHours + " 小时会自动过期。" },
      h(VideoList, { rows: st.shelf || [], empty: "书架是空的。" })),

    last.length > 0
      ? h(Card, { title: "最近一次刷的结果" }, h(VideoList, { rows: last }))
      : null,
  );
}

function MemoryTab(props) {
  const { data, act, busy } = props;
  const st = data.state || {};
  const sessions = st.sessionList || [];

  return h("div", null,
    h(Card, { title: "会话记忆", desc: "每个群 / 每个人一条独立的上下文，长度由记忆轮数控制。" },
      sessions.length === 0
        ? h("div", { className: "qqa-empty" }, "还没有聊过。")
        : h("div", null,
            sessions.map((row) =>
              h("div", { key: row.sessionKey, className: "qqa-row", style: { justifyContent: "space-between", padding: "6px 2px", borderBottom: "1px solid var(--dsw-alias-border-secondary,#eef1f7)" } },
                h("div", null,
                  h("div", { style: { fontSize: 12.5, fontWeight: 600 } }, row.label || row.sessionKey),
                  h("div", { className: "qqa-video-meta" }, (row.count || 0) + " 条 · 最后 " + formatTime(row.at))),
                h("button", {
                  className: "qqa-btn is-sm is-danger",
                  disabled: Boolean(busy),
                  onClick: () => act("clearSession", { sessionKey: row.sessionKey }),
                }, "清空"))))),
    h("div", { className: "qqa-row", style: { gap: 8 } },
      h("button", { className: "qqa-btn is-danger", disabled: Boolean(busy), onClick: () => act("clearSession", {}) }, "清空全部记忆")));
}

function LogsTab(props) {
  const logs = (props.data.state || {}).logs || [];
  const [level, setLevel] = useState("all");
  const rows = level === "all" ? logs : logs.filter((row) => row.level === level);
  const boxRef = useRef(null);

  useEffect(() => {
    const box = boxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [logs.length, level]);

  return h(Card, { title: "运行日志", desc: "最近 60 条。" },
    h("div", { className: "qqa-row", style: { gap: 6, marginBottom: 8 } },
      ["all", "info", "warn", "error"].map((key) =>
        h("button", {
          key,
          className: "qqa-btn is-sm" + (level === key ? " is-primary" : ""),
          onClick: () => setLevel(key),
        }, key === "all" ? "全部" : key))),
    h("div", { className: "qqa-logs", ref: boxRef },
      rows.length === 0
        ? h("div", { className: "qqa-empty" }, "没有日志。")
        : rows.map((row, index) =>
            h("div", { className: "qqa-log", key: index },
              h("span", { className: "qqa-log-t" }, formatTime(row.at)),
              h("span", { className: "qqa-log-l is-" + (row.level || "info") }, row.level || "info"),
              h("span", { className: "qqa-log-m" }, row.text)))));
}

// ———————————————————————————— 面板主体 ————————————————————————————

const TABS = [
  { id: "overview", label: "总览" },
  { id: "persona", label: "主人与人设" },
  { id: "connect", label: "连接" },
  { id: "reply", label: "回复" },
  { id: "ability", label: "能力" },
  { id: "bilibili", label: "B 站" },
  { id: "memory", label: "记忆" },
  { id: "logs", label: "日志" },
];

function QqAgentPage() {
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState("overview");
  const [busy, setBusy] = useState("");
  const [toast, setToast] = useState("");
  const [toastKind, setToastKind] = useState("");
  const [ttsText, setTtsText] = useState("");
  const dirtyRef = useRef(false);
  const toastTimer = useRef(null);

  const showToast = useCallback((text, kind) => {
    setToast(text);
    setToastKind(kind || "");
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 6000);
  }, []);

  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  const applyData = useCallback((body) => {
    setData(body);
    if (!dirtyRef.current && body && body.config) setDraft(clone(body.config));
  }, []);

  const refresh = useCallback(async () => {
    try {
      applyData(await apiGet(ROUTE_STATE));
    } catch (error) {
      showToast(String(error.message || error), "bad");
    }
  }, [applyData, showToast]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const set = useCallback((path, value) => {
    setDraft((prev) => setIn(prev, path, value));
    setDirty(true);
    dirtyRef.current = true;
  }, []);

  const save = useCallback(async () => {
    if (!draft) return;
    setBusy("save");
    try {
      const body = await apiPost(ROUTE_CONFIG, { config: draft });
      dirtyRef.current = false;
      setDirty(false);
      setData(body);
      setDraft(clone(body.config));
      showToast("配置已保存", "ok");
    } catch (error) {
      showToast(String(error.message || error), "bad");
    } finally {
      setBusy("");
    }
  }, [draft, showToast]);

  const reset = useCallback(() => {
    if (!data) return;
    dirtyRef.current = false;
    setDirty(false);
    setDraft(clone(data.config));
    showToast("已还原为已保存的配置");
  }, [data, showToast]);

  const act = useCallback(async (action, payload) => {
    setBusy(action);
    try {
      const body = await apiPost(ROUTE_ACTION, { action, payload: payload || {} });
      if (body.config && !dirtyRef.current) setDraft(clone(body.config));
      setData(body);
      const result = body.result || {};
      showToast(result.message || "完成", result.ok === false ? "bad" : "ok");
      if (result.ok !== false) {
        dirtyRef.current = false;
        setDirty(false);
      }
    } catch (error) {
      showToast(String(error.message || error), "bad");
    } finally {
      setBusy("");
    }
  }, [showToast]);

  const content = useMemo(() => {
    if (!data || !draft) return h("div", { className: "qqa-empty" }, "加载中…");
    const shared = { data, draft, set, act, busy, showToast, ttsText, setTtsText };
    switch (tab) {
      case "persona": return h(PersonaTab, shared);
      case "connect": return h(ConnectTab, shared);
      case "reply": return h(ReplyTab, shared);
      case "ability": return h(AbilityTab, shared);
      case "bilibili": return h(BilibiliTab, shared);
      case "memory": return h(MemoryTab, shared);
      case "logs": return h(LogsTab, shared);
      default: return h(OverviewTab, shared);
    }
  }, [data, draft, tab, set, act, busy, showToast, ttsText]);

  const st = (data && data.state) || {};
  const conn = st.connection || {};

  return h("div", { className: "qqa-root" },
    h("div", { className: "qqa-head" },
      h("div", null,
        h("div", { className: "qqa-title" }, "QQ 助手"),
        h("div", { className: "qqa-sub" }, data && data.config ? data.config.persona.name + " · 思考由 DSH 提供" : "加载中…")),
      h("div", { className: "qqa-pills" },
        h("span", { className: "qqa-pill " + (conn.connected ? "is-ok" : "is-bad") },
          h("span", { className: "qqa-dot" }), conn.connected ? "QQ 在线" : "QQ 离线"),
        h("span", { className: "qqa-pill " + (st.paused ? "is-warn" : "is-ok") },
          h("span", { className: "qqa-dot" }), st.paused ? "已暂停" : "自动回复中"),
        data && data.config && data.config.bilibili.approved
          ? h("span", { className: "qqa-pill is-ok" }, h("span", { className: "qqa-dot" }), "B 站已授权")
          : h("span", { className: "qqa-pill" }, h("span", { className: "qqa-dot" }), "B 站未授权"))),

    h("div", { className: "qqa-tabs" },
      TABS.map((row) =>
        h("button", {
          key: row.id,
          className: "qqa-tab" + (tab === row.id ? " is-active" : ""),
          onClick: () => setTab(row.id),
        }, row.label))),

    h("div", { className: "qqa-scroll" }, content),

    h("div", { className: "qqa-foot" },
      h("button", { className: "qqa-btn is-primary", disabled: busy === "save" || !dirty, onClick: save }, dirty ? "保存配置" : "已保存"),
      h("button", { className: "qqa-btn", disabled: !dirty, onClick: reset }, "还原"),
      dirty ? h("span", { className: "qqa-dirty" }, "有未保存的修改") : null,
      h("span", { className: "qqa-toast " + (toastKind === "ok" ? "is-ok" : toastKind === "bad" ? "is-bad" : "") }, toast)));
}

function QqAgentPanelIcon() {
  return h("svg", { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", "aria-hidden": "true" },
    h("path", {
      d: "M12 3C7.6 3 4 6.1 4 10c0 2.2 1.2 4.2 3.1 5.5-.2 1-.7 2.1-1.6 3.1 1.7-.2 3.1-.9 4.1-1.6.8.2 1.6.3 2.4.3 4.4 0 8-3.1 8-7s-3.6-7.3-8-7.3Z",
      stroke: "currentColor", strokeWidth: 1.6, strokeLinejoin: "round",
    }),
    h("circle", { cx: 9, cy: 9.6, r: 1.1, fill: "currentColor" }),
    h("circle", { cx: 15, cy: 9.6, r: 1.1, fill: "currentColor" }));
}

// ———————————————————————————— 注册 ————————————————————————————

function register(api) {
  const { slots, layout, panelId = PANEL_ID, document: doc = typeof document === "undefined" ? null : document } = api || {};
  if (!slots || typeof slots.register !== "function") {
    throw new Error("[dsh-qq-agent] the slots service is required (ctx.slots)");
  }

  const disposers = [installStyles(doc)];

  const registerInto = (slotName, registration, component) => {
    if (typeof slots.inject === "function") {
      disposers.push(slots.inject(slotName, () => slots.register(registration, component)));
      return;
    }
    disposers.push(slots.register(registration, component));
  };

  registerInto(
    "main",
    { name: "main", key: panelId, locale: PANEL_NS, inject: () => ({}) },
    QqAgentPage,
  );

  registerInto(
    "sidebar.panellist",
    { name: "sidebar.panellist", id: panelId, order: 41, label: () => "QQ", locale: PANEL_NS },
    QqAgentPanelIcon,
  );

  const open = () => {
    if (layout && typeof layout.selectPanel === "function") layout.selectPanel(panelId);
  };

  return Object.assign(
    function dispose() {
      while (disposers.length > 0) {
        const entry = disposers.pop();
        try {
          if (typeof entry === "function") entry();
        } catch {
          /* ignore */
        }
      }
    },
    { open, panelId },
  );
}

module.exports = { register, QqAgentPage, QqAgentPanelIcon, PANEL_CSS, PANEL_ID, PANEL_NS };
/* BUILD_TAIL */
