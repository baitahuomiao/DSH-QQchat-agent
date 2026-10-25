/**
 * dsh-qq-agent — 自动生成的客户端模块，不要手改。
 * 真正的源码是 src/ui.js。重新生成：node build/build.mjs
 */
window.__ModuleLoader__.load({
	id: "dsh-qq-agent",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		// --- src/ui.js（内联：面板） ---
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
    const [newPersonaName, setNewPersonaName] = useState("");
    // 老配置里可能没有 style 段（加载时 config.normalize 会补，但面板不该依赖这一点）
    const style = Object.assign(
      { current: "", custom: "", strength: "normal", dynamic: true, catchphrases: [] },
      draft.style || {},
    );
    // 同理，这几个数组可能整段缺失
    if (!Array.isArray(style.catchphrases)) style.catchphrases = [];

    return h("div", null,
      h(Card, { title: "主人", desc: "被设为主人的那个人，主动搭话概率最高，也拥有全部管理指令权限。" },
        h("div", { className: "qqa-grid" },
          h(TextField, { label: "主人 QQ 号", value: draft.master.uin, placeholder: "例如 920420642", onChange: (v) => set("master.uin", v.trim()) }),
          h(TextField, { label: "称呼", value: draft.master.alias, placeholder: "主人", onChange: (v) => set("master.alias", v) })),
        h("div", { style: { marginTop: 12 } },
          h(TagsField, {
            label: "暧昧称呼",
            value: draft.master.sweetNames,
            hint: "只对主人用，比如「亲爱的」「老公」；别人不会被这么叫",
            onChange: (v) => set("master.sweetNames", v),
          })),
        h("div", { style: { marginTop: 12 } },
          h(Toggle, {
            label: "只认这一个主人",
            value: draft.master.only,
            hint: "打开后称呼和暧昧语气只给这个号：别人照常能聊，但不会被叫「主人」，也不许用上面的暧昧称呼；有人冒充主人也不认。没填主人 QQ 时此开关不生效",
            onChange: (v) => set("master.only", v),
          })),
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
            }, preset.name)))),

      h(Card, {
        title: "语言风格",
        desc: "管她「怎么说话」，和人设分开——换风格不用换人设，也不影响记忆。",
      },
        // 预设风格：点一下即选中
        h("div", { className: "qqa-row", style: { flexWrap: "wrap", gap: 8 } },
          (data.styles || []).map((s) =>
            h("button", {
              key: s.id,
              className: "qqa-btn" + (style.current === s.id ? " is-primary" : ""),
              disabled: Boolean(busy),
              title: s.desc,
              onClick: () => set("style.current", s.id),
            }, s.name))),
        h("div", { className: "qqa-hint", style: { marginTop: 8 } },
          (() => {
            const hit = (data.styles || []).find((s) => s.id === style.current);
            return hit ? hit.name + "：" + hit.desc : "未选择预设风格（只用下面的自定义要求）";
          })()),

        h("div", { style: { marginTop: 14 } },
          h(TextArea, {
            label: "自定义风格要求",
            rows: 3,
            value: style.custom,
            placeholder: "预设不够用时自己写，比如「说话带东北腔，爱用儿化音，偶尔冒一句网络梗」",
            hint: "会追加在预设之后，两者叠加生效",
            onChange: (v) => set("style.custom", v),
          })),
        h("div", { style: { marginTop: 12 } },
          h(TagsField, {
            label: "口头禅",
            value: style.catchphrases,
            hint: "会让她偶尔自然带出，不是每句都加",
            onChange: (v) => set("style.catchphrases", v),
          })),
        h("div", { className: "qqa-grid", style: { marginTop: 12 } },
          h(SelectField, {
            label: "强度",
            value: style.strength,
            options: [
              { value: "light", label: "轻微（只是倾向）" },
              { value: "normal", label: "正常" },
              { value: "strong", label: "强烈（一眼看得出）" },
            ],
            onChange: (v) => set("style.strength", v),
          }),
          h("div", { style: { display: "flex", alignItems: "flex-end" } },
            h(Toggle, {
              label: "允许按心情微调",
              value: style.dynamic,
              hint: "同一风格下，撒娇/吐槽/正经可以每轮不同，不会一个调子到底",
              onChange: (v) => set("style.dynamic", v),
            }))),
        h("div", { className: "qqa-row", style: { marginTop: 12, gap: 8 } },
          h("button", {
            className: "qqa-btn",
            disabled: Boolean(busy),
            onClick: () => act("previewStyle", {
              current: style.current,
              strength: style.strength,
              custom: style.custom,
              catchphrases: style.catchphrases,
              dynamic: style.dynamic,
            }),
          }, "预览提示词"),
          h("span", { className: "qqa-hint" }, "看看这段风格实际会怎么写进系统提示"))),

      h(Card, { title: "我的人格库", desc: "把调好的人设存下来，随时切回来。和上面的内置预设分开，这些是你自己的。" },
        h("div", { className: "qqa-row", style: { gap: 8, marginBottom: 10 } },
          h("input", {
            className: "qqa-input",
            style: { flex: 1 },
            placeholder: "给当前人格起个名字，比如「傲娇鲸鱼」",
            value: newPersonaName,
            onChange: (e) => setNewPersonaName(e.target.value),
          }),
          h("button", {
            className: "qqa-btn is-primary",
            disabled: Boolean(busy) || !String(newPersonaName || "").trim(),
            onClick: () => {
              act("savePersonaAs", {
                name: String(newPersonaName || "").trim(),
                prompt: draft.persona.prompt,
                extra: draft.persona.extra,
              });
              setNewPersonaName("");
            },
          }, "保存当前人设")),
        (draft.persona.saved || []).length === 0
          ? h("div", { className: "qqa-empty" }, "还没存过人格。调好上面的人设后，在这里起个名字保存。")
          : h("div", { className: "qqa-row", style: { flexWrap: "wrap", gap: 6 } },
              (draft.persona.saved || []).map((row) =>
                h("div", { key: row.id, className: "qqa-row", style: { gap: 4, alignItems: "center" } },
                  h("button", {
                    className: "qqa-btn is-sm" + (draft.persona.name === row.name ? " is-primary" : ""),
                    disabled: Boolean(busy),
                    title: row.prompt.slice(0, 120),
                    onClick: () => act("applyPersona", { id: row.id }),
                  }, row.name),
                  h("button", {
                    className: "qqa-btn is-sm is-danger",
                    disabled: Boolean(busy),
                    onClick: () => act("deletePersona", { id: row.id }),
                  }, "×"))))),
    );
  }

  function ConnectTab(props) {
    const { data, draft, set, act, busy } = props;
    const st = data.state || {};
    const conn = st.connection || {};
    const groups = data.groups || [];
    const friends = data.friends || [];
    const connecting = busy === "connectQQ";
    const checking = busy === "checkNapCat";
    // 老配置里没有 onebot.autoStart / selfId 这两个键，别让它把整页渲染搞崩
    const ob = Object.assign({ wsUrl: "", httpUrl: "", selfId: "", autoStart: true, shellDir: "" }, draft.onebot || {});

    return h("div", null,
      h(Card, { title: "一键连接 QQ", desc: "点一下就把 NapCat 拉起来并接上：自动补齐注入所需文件、关掉占着锁的 QQ、启动注入版 QQ，然后等 OneBot 就绪。" },
        h("div", {
          className: "qqa-pill " + (conn.connected ? "is-ok" : "is-bad"),
          style: { marginBottom: 12 },
        }, h("span", { className: "qqa-dot" }),
          conn.connected
            ? "已连接 " + (conn.nickname || "") + (conn.selfId ? " (" + conn.selfId + ")" : "")
            : "未连接" + (conn.lastError ? "：" + conn.lastError : "")),
        h("div", { className: "qqa-row", style: { gap: 8, flexWrap: "wrap" } },
          h("button", {
            className: "qqa-btn is-primary",
            disabled: Boolean(busy),
            onClick: () => act("connectQQ"),
          }, connecting ? "正在启动 NapCat…" : conn.connected ? "重新连接 QQ" : "一键连接 QQ"),
          h("button", {
            className: "qqa-btn",
            disabled: Boolean(busy),
            onClick: () => act("checkNapCat"),
          }, checking ? "检查中…" : "检查环境")),
        // 机器人 QQ 号 + 开机自动登录：这两个是「不用扫码直接上线」的关键
        h("div", { className: "qqa-grid", style: { marginTop: 12 } },
          h(TextField, {
            label: "机器人 QQ 号",
            value: ob.selfId,
            placeholder: "3886139976",
            hint: "快速登录用这个号，不是主人号。留空会自动挑以前登录成功过的那个。",
            onChange: (v) => set("onebot.selfId", String(v || "").trim()),
          }),
          h(Toggle, {
            label: "开机自动登录",
            value: ob.autoStart !== false,
            hint: "DSH 启动时自动拉起 NapCat 并快速登录，不用每次点按钮。",
            onChange: (v) => set("onebot.autoStart", Boolean(v)),
          })),
        connecting
          ? h("div", { className: "qqa-hint", style: { marginTop: 8 } },
              "正在启动。若快登失效，NapCat 会退回二维码：浏览器打开 http://127.0.0.1:6099/webui 扫码一次，之后就能自动登录。")
          : null),

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

      h(Card, {
        title: "自由聊天",
        desc: "打开后不再把回复硬切成固定条数：段数由内容决定，想一句就一句，想连发就连发，停顿也更像真人在打字。",
      },
        h(Toggle, {
          label: "启用自由聊天模式",
          value: draft.reply.freeChat.enabled,
          hint: "关掉则回到「按字数切分」的老行为",
          onChange: (v) => set("reply.freeChat.enabled", v),
        }),
        draft.reply.freeChat.enabled
          ? h("div", null,
              h("div", { className: "qqa-grid", style: { marginTop: 12 } },
                h(NumberField, { label: "最多分几条", min: 1, max: 10, value: draft.reply.freeChat.maxSegments, hint: "防止一次刷屏", onChange: (v) => set("reply.freeChat.maxSegments", v) }),
                h(NumberField, { label: "单条软上限（字）", min: 20, max: 1000, value: draft.reply.freeChat.softMaxChars, hint: "只在模型太失控时兜底", onChange: (v) => set("reply.freeChat.softMaxChars", v) }),
                h(NumberField, { label: "段落最短停顿（毫秒）", min: 0, step: 50, value: draft.reply.freeChat.minGapMs, onChange: (v) => set("reply.freeChat.minGapMs", v) }),
                h(NumberField, { label: "段落最长停顿（毫秒）", min: 0, step: 50, value: draft.reply.freeChat.maxGapMs, onChange: (v) => set("reply.freeChat.maxGapMs", v) }),
                h(NumberField, { label: "「想一下」的概率", min: 0, max: 1, step: 0.05, value: draft.reply.freeChat.thinkingChance, hint: "回第一句前先停顿", onChange: (v) => set("reply.freeChat.thinkingChance", v) }),
                h(NumberField, { label: "思考最短时长（毫秒）", min: 0, step: 100, value: draft.reply.freeChat.thinkingMinMs, onChange: (v) => set("reply.freeChat.thinkingMinMs", v) }),
                h(NumberField, { label: "思考最长时长（毫秒）", min: 0, step: 100, value: draft.reply.freeChat.thinkingMaxMs, onChange: (v) => set("reply.freeChat.thinkingMaxMs", v) })),
              h("div", { style: { marginTop: 10 } },
                h(Toggle, { label: "允许发表情包", value: draft.reply.freeChat.allowStickers, onChange: (v) => set("reply.freeChat.allowStickers", v) })),
              h("div", { style: { marginTop: 10 } },
                h(Toggle, { label: "允许自己画图", value: draft.reply.freeChat.allowImages, hint: "需要先在「能力」页配好生图 API", onChange: (v) => set("reply.freeChat.allowImages", v) })))
          : null),

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

  /**
   * 表情包列表。
   *
   * 只显示元信息（尺寸/标签/用过几次），缩略图靠文件路径直接给 <img>：
   * 图片就躺在数据目录里，浏览器能按 file:// 读（同源策略对本地文件宽松的部分
   * 由 DSH 自己处理），读不到就退化成占位文字，不影响管理操作。
   */
  function StickerList(props) {
    const { rows, busy, act, dir } = props;
    const list = Array.isArray(rows) ? rows : [];

    if (list.length === 0) {
      return h("div", null,
        h("div", { className: "qqa-empty" }, "还没有表情包。别人发图时会被自动收藏，也可以在下面手动添加。"),
        h(StickerUploader, { busy, act }));
    }

    return h("div", null,
      h("div", { className: "qqa-hint", style: { marginBottom: 8 } },
        "共 " + list.length + " 张" + (dir ? "，存在 " + dir : "")),
      h("div", { className: "qqa-row", style: { flexWrap: "wrap", gap: 8 } },
        list.slice(0, 40).map((row) =>
          h("div", {
            key: row.id,
            style: {
              border: "1px solid var(--dsw-alias-border, #e3e7ef)",
              borderRadius: 8,
              padding: 6,
              width: 108,
              display: "flex",
              flexDirection: "column",
              gap: 4,
            },
          },
            h("div", {
              style: {
                height: 70,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "var(--dsw-alias-bg-secondary, #f7f9fc)",
                borderRadius: 6,
                fontSize: 20,
                overflow: "hidden",
              },
            }, "🖼"),
            h("div", { className: "qqa-hint", style: { fontSize: 11 } },
              (row.tags && row.tags.length ? row.tags.join(" ") : "无标签") + " · 用" + (row.usedCount || 0) + "次"),
            h("button", {
              className: "qqa-btn is-sm is-danger",
              disabled: Boolean(busy),
              onClick: () => act("removeSticker", { id: row.id }),
            }, "删除")))),
      h(StickerUploader, { busy, act }));
  }

  /** 手动添加表情包：选本地图片，前端读成 base64 交给宿主。 */
  function StickerUploader(props) {
    const { busy, act } = props;
    const [tags, setTags] = useState("");
    const [pending, setPending] = useState(null);
    const fileRef = useRef(null);

    const onPick = (event) => {
      const file = event.target && event.target.files && event.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => setPending({ data: String(reader.result || ""), mediaType: file.type || "image/gif", name: file.name });
      reader.readAsDataURL(file);
    };

    return h("div", { style: { marginTop: 12 } },
      h("div", { className: "qqa-row", style: { gap: 8, flexWrap: "wrap" } },
        h("input", { ref: fileRef, type: "file", accept: "image/*", style: { display: "none" }, onChange: onPick }),
        h("button", { className: "qqa-btn", disabled: Boolean(busy), onClick: () => fileRef.current && fileRef.current.click() }, "选一张图"),
        h("input", {
          className: "qqa-input",
          style: { flex: "1 1 160px" },
          placeholder: "标签（可选，空格分隔）",
          value: tags,
          onChange: (e) => setTags(e.target.value),
        }),
        h("button", {
          className: "qqa-btn is-primary",
          disabled: Boolean(busy) || !pending,
          onClick: () => {
            if (!pending) return;
            act("addSticker", {
              data: pending.data,
              mediaType: pending.mediaType,
              tags: String(tags || "").split(/\s+/).filter(Boolean),
            });
            setPending(null);
            setTags("");
          },
        }, pending ? "添加 " + pending.name : "添加")),
      pending ? h("div", { className: "qqa-hint", style: { marginTop: 6 } }, "已选择：" + pending.name + "，点「添加」入库") : null);
  }

  function AbilityTab(props) {  const { data, draft, set, act, busy, ttsText, setTtsText } = props;
    // 老配置/半截配置里这些嵌套段可能整块缺失，面板不该因此白屏
    const cloned = draft.voice.custom.cloned || {};

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

      h(Card, { title: "语音回复", desc: "把文字转成语音发出去。默认走百度翻译的免费接口，也可以换成你自己的语音模型。" },
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
                set("voice.lexicon", parsed && typeof parsed === "object" ? parsed : {});
              } catch {
                /* 半截 JSON 不写回去，等用户输完 */
              }
            },
          }))),

      h(Card, {
        title: "自定义语音模型 API",
        desc: "留空就用内置百度接口（不用配也能响）。填了就走你自己的模型，音色更可控。",
      },
        h("div", { className: "qqa-grid" },
          h(SelectField, {
            label: "接口类型",
            value: draft.voice.custom.apiKind,
            options: [
              { value: "openai", label: "OpenAI 兼容 /audio/speech（硅基流动等）" },
              { value: "dashscope", label: "阿里百炼 DashScope（支持音色克隆）" },
              { value: "custom", label: "自定义（自己填 body）" },
            ],
            onChange: (v) => set("voice.custom.apiKind", v),
          }),
          h(TextField, {
            label: "Base URL",
            value: draft.voice.custom.baseUrl,
            placeholder: "https://api.openai.com/v1",
            hint: "留空 = 用内置接口",
            onChange: (v) => set("voice.custom.baseUrl", v.trim()),
          }),
          h(TextField, { label: "API Key", value: draft.voice.custom.apiKey, placeholder: "sk-...", onChange: (v) => set("voice.custom.apiKey", v.trim()) }),
          h(TextField, {
            label: "模型名",
            value: draft.voice.custom.model,
            placeholder: "tts-1",
            hint: draft.voice.custom.apiKind === "custom" ? "自定义模式下由 body 模板决定，可留空" : "",
            onChange: (v) => set("voice.custom.model", v.trim()),
          })),

        // 音色选择：预置音色下拉 + 手填。克隆音色也走手填那一格
        h("div", { className: "qqa-grid", style: { marginTop: 12 } },
          h(SelectField, {
            label: "预置音色",
            value: (() => {
              const cur = String(draft.voice.custom.voice || "");
              const hit = (data.presetVoices || []).find((v) => v.value === cur || v.id === cur);
              return hit ? hit.value : "";
            })(),
            options: [{ value: "", label: "（自定义 / 克隆音色）" }].concat(
              (data.presetVoices || []).map((v) => ({
                value: v.value,
                label: v.name + "（" + v.gender + "）· " + v.desc,
              })),
            ),
            hint: "选一个就自动填进下面的 voice",
            onChange: (v) => { if (v) set("voice.custom.voice", v); },
          }),
          h(TextField, {
            label: "音色 / voice（当前生效）",
            value: draft.voice.custom.voice,
            placeholder: "alloy 或 speech:名字:id:哈希",
            hint: (() => {
              const cur = String(draft.voice.custom.voice || "");
              const cloned = draft.voice.custom.cloned || {};
              if (cloned.uri && cloned.uri === cur) {
                return "克隆音色「" + (cloned.name || "未命名") + "」，绑定模型 " + (draft.voice.custom.model || "?");
              }
              if (/^speech:/.test(cur)) return "克隆音色（CosyVoice2 故障时合成会失败并回退）";
              if (/^[A-Za-z0-9._\-]+-tts-|^cosyvoice/.test(cur)) return "百炼音色，不要加模型前缀";
              if (!cur) return "留空会退回内置百度语音";
              return "填纯名字会自动补模型前缀";
            })(),
            // 不允许清空：空值会把已经建好的克隆音色弄丢（面板曾因此丢过 voice）
            onChange: (v) => {
              const next = String(v || "").trim();
              if (!next) return;
              set("voice.custom.voice", next);
            },
          })),
        draft.voice.custom.apiKind === "custom"
          ? h("div", { style: { marginTop: 12 } },
              h(TextArea, {
                label: "请求体模板",
                mono: true,
                rows: 3,
                value: draft.voice.custom.bodyTemplate,
                hint: "用 {text} {voice} {speed} 占位，速度是 0.25~4 的小数",
                onChange: (v) => set("voice.custom.bodyTemplate", v),
              }))
          : null,
        h("div", { className: "qqa-row", style: { marginTop: 12, gap: 8 } },
          h("button", {
            className: "qqa-btn",
            disabled: Boolean(busy),
            onClick: () => act("testVoice", { text: "你好呀，我是" + (draft.persona.name || "鲸鱼娘") + "。" }),
          }, "试听一下"),
          h("button", {
            className: "qqa-btn",
            disabled: Boolean(busy),
            onClick: () => act("sendVoice", { text: "你好呀，我是" + (draft.persona.name || "鲸鱼娘") + "。", uin: draft.master.uin }),
          }, "念一句发给主人"),
          h("span", { className: "qqa-hint" }, draft.voice.custom.baseUrl ? "当前用自定义 API" : "当前用内置接口"))),

      h(Card, {
        title: "音色克隆",
        desc: "上传一段 8~30 秒的干净人声，让鲸鱼娘用这个音色说话。硅基流动的 CosyVoice2 支持跨语言克隆——拿日语参考音也能说中文。",
      },
        h("div", { className: "qqa-grid" },
          h(TextField, {
            label: "参考音频路径",
            value: cloned.source || "",
            placeholder: "E:\\素材\\我的声音.mp3",
            hint: "本机绝对路径；mp3/wav 都行，30 秒以内",
            onChange: (v) => set("voice.custom.cloned.source", v.trim()),
          }),
          h(TextField, {
            label: "新音色名字",
            value: cloned.name || "",
            placeholder: "留空自动生成",
            onChange: (v) => set("voice.custom.cloned.name", v.trim()),
          })),
        h("div", { style: { marginTop: 12 } },
          h(TextArea, {
            label: "参考音频的文字内容（必填）",
            rows: 3,
            value: cloned.refText || "",
            hint: "这段音频里到底说了什么。服务端用它做对齐，填错音色会跑调。点下面「自动转写」可以代劳。",
            onChange: (v) => set("voice.custom.cloned.refText", v),
          })),
        h("div", { className: "qqa-row", style: { marginTop: 12, gap: 8, flexWrap: "wrap" } },
          h("button", {
            className: "qqa-btn",
            disabled: Boolean(busy) || !cloned.source,
            onClick: () => act("transcribeAudio", { path: cloned.source }),
          }, "自动转写"),
          h("button", {
            className: "qqa-btn",
            disabled: Boolean(busy) || !cloned.source || !cloned.refText,
            onClick: () => act("cloneVoice", {
              path: cloned.source,
              text: cloned.refText,
              name: cloned.name,
            }),
          }, "用这段音频做音色"),
          h("button", {
            className: "qqa-btn",
            disabled: Boolean(busy),
            onClick: () => act("listVoices", {}),
          }, "列出已有音色")),
        cloned.uri
          ? h("div", { className: "qqa-hint", style: { marginTop: 10 } },
              "当前克隆音色：" + (cloned.name || "(无名)") + " · " + cloned.uri)
          : h("div", { className: "qqa-hint", style: { marginTop: 10 } }, "还没有克隆音色，正在用 voice 字段里的那个。"),
        (data && Array.isArray(data.voices) && data.voices.length > 0)
          ? h("div", { style: { marginTop: 12 } },
              h("div", { className: "qqa-hint", style: { marginBottom: 6 } }, "账号下的自定义音色（点「用这个」切换）："),
              data.voices.map((v) =>
                h("div", { key: v.uri, className: "qqa-row", style: { gap: 8, alignItems: "center", marginBottom: 6 } },
                  h("span", { style: { fontSize: 12, flex: 1 } }, (v.name || "(无名)") + " · " + (v.model || "")),
                  h("button", {
                    className: "qqa-btn",
                    disabled: Boolean(busy),
                    onClick: () => set("voice.custom.voice", v.uri),
                  }, "用这个"),
                  h("button", {
                    className: "qqa-btn",
                    disabled: Boolean(busy),
                    onClick: () => act("deleteVoice", { uri: v.uri }),
                  }, "删除"))))
          : null),

      h(Card, {
        title: "表情包",
        desc: "她自己收藏表情包，聊天时按心情发。别人发的图有一定概率被顺手存下来。",
      },
        h(Toggle, { label: "启用表情包", value: draft.sticker.enabled, onChange: (v) => set("sticker.enabled", v) }),
        h("div", { style: { marginTop: 10 } },
          h(Toggle, { label: "自动收藏别人的图", value: draft.sticker.autoSave, onChange: (v) => set("sticker.autoSave", v) })),
        h("div", { className: "qqa-grid", style: { marginTop: 12 } },
          h(NumberField, { label: "收藏概率", min: 0, max: 1, step: 0.05, value: draft.sticker.autoSaveChance, onChange: (v) => set("sticker.autoSaveChance", v) }),
          h(NumberField, { label: "每天最多存几张", min: 0, max: 200, value: draft.sticker.autoSaveDailyLimit, onChange: (v) => set("sticker.autoSaveDailyLimit", v) }),
          h(NumberField, { label: "回复时带表情的概率", min: 0, max: 1, step: 0.01, value: draft.sticker.sendChance, onChange: (v) => set("sticker.sendChance", v) })),
        h(StickerList, { rows: data.stickers || [], busy, act, dir: data.stickerDir })),

      h(Card, {
        title: "生成图片",
        desc: "让她会画画。走 OpenAI 兼容的 /v1/images/generations，DALL·E、硅基流动、自建网关都能用。",
      },
        h(Toggle, { label: "启用生图", value: draft.image.enabled, onChange: (v) => set("image.enabled", v) }),
        h("div", { className: "qqa-grid", style: { marginTop: 12 } },
          h(TextField, { label: "Base URL", value: draft.image.baseUrl, placeholder: "https://api.siliconflow.cn/v1", onChange: (v) => set("image.baseUrl", v.trim()) }),
          h(TextField, { label: "API Key", value: draft.image.apiKey, placeholder: "sk-...", hint: "要和 Base URL 是同一家的 key", onChange: (v) => set("image.apiKey", v.trim()) })),

        // 模型：常见的一堆列出来直接选，也可以自己填
        h("div", { className: "qqa-grid", style: { marginTop: 12 } },
          h(SelectField, {
            label: "模型（点一下填入）",
            value: (data.imageModels || []).some((m) => m.id === draft.image.model) ? draft.image.model : "",
            options: [{ value: "", label: "（下面手填）" }].concat(
              (data.imageModels || []).map((m) => ({ value: m.id, label: m.label })),
            ),
            hint: "选中的模型会写进下面的「模型」",
            onChange: (v) => { if (v) set("image.model", v); },
          }),
          h(TextField, { label: "模型", value: draft.image.model, placeholder: "dall-e-3", onChange: (v) => set("image.model", v.trim()) }),
          h(SelectField, {
            label: "尺寸",
            value: draft.image.size,
            options: [
              { value: "1024x1024", label: "1024×1024 方形（通用）" },
              { value: "768x1024", label: "768×1024 竖版（人像）" },
              { value: "1024x768", label: "1024×768 横版（风景）" },
              { value: "512x512", label: "512×512 小图（快）" },
              { value: "1280x720", label: "1280×720 宽屏" },
            ],
            onChange: (v) => set("image.size", v),
          }),
          h(SelectField, {
            label: "返回格式",
            value: draft.image.responseFormat,
            options: [
              { value: "b64_json", label: "base64（推荐）" },
              { value: "url", label: "图片链接" },
            ],
            onChange: (v) => set("image.responseFormat", v),
          })),

        h("div", { className: "qqa-grid", style: { marginTop: 12 } },
          h(NumberField, { label: "超时（毫秒）", min: 20000, max: 300000, step: 5000, value: draft.image.timeoutMs, hint: "慢模型要留够", onChange: (v) => set("image.timeoutMs", v) }),
          h(NumberField, { label: "种子（0=随机）", min: 0, max: 99999999, value: draft.image.seed, hint: "固定种子可复现同一张", onChange: (v) => set("image.seed", v) }),
          h(NumberField, { label: "采样步数（0=默认）", min: 0, max: 100, value: draft.image.steps, onChange: (v) => set("image.steps", v) })),

        h("div", { style: { marginTop: 12 } },
          h(TextArea, {
            label: "负面提示词",
            rows: 2,
            value: draft.image.negativePrompt,
            placeholder: "lowres, bad anatomy, extra fingers, watermark",
            hint: "硅基流动、Kolors 等支持；留空不传",
            onChange: (v) => set("image.negativePrompt", v),
          })),
        h("div", { style: { marginTop: 12 } },
          h(TagsField, { label: "触发画图的关键词", value: draft.image.keywords, onChange: (v) => set("image.keywords", v) })),
        h("div", { style: { marginTop: 10 } },
          h(Toggle, {
            label: "图片引用原消息发出去",
            value: draft.image.quoteReply,
            hint: "生图要几秒，引用能让这张图明确挂在触发它的那条消息下面，不会看起来凭空冒出来",
            onChange: (v) => set("image.quoteReply", v),
          })),
        h("div", { className: "qqa-row", style: { marginTop: 12, gap: 8, flexWrap: "wrap" } },
          h("button", {
            className: "qqa-btn",
            disabled: Boolean(busy) || !draft.image.baseUrl,
            onClick: () => act("listImageModels", {}),
          }, "查账号可用的模型"),
          h("button", {
            className: "qqa-btn",
            disabled: Boolean(busy) || !draft.image.baseUrl,
            onClick: () => act("testImage", {}),
          }, "试画一张"),
          h("button", {
            className: "qqa-btn",
            disabled: Boolean(busy) || !draft.image.baseUrl || !draft.master.uin,
            onClick: () => act("testImage", { send: true, uin: draft.master.uin }),
          }, "画一张发给主人"),
          h("span", { className: "qqa-hint" }, draft.image.baseUrl ? "" : "先填 Base URL 和 API Key"))),

      h(Card, { title: "试听与试发", desc: "合成一段语音听听效果，或者直接发给主人。" },
        h("div", { className: "qqa-row", style: { gap: 8, flexWrap: "wrap" } },
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
      h(Card, { title: "刷 B 站", desc: "去哪里翻视频看，看完写下内容描述暂存起来，之后聊天时可以聊到。" },
        h("div", { className: "qqa-pill " + (draft.bilibili.approved ? "is-ok" : "is-warn"), style: { marginBottom: 10 } },
          h("span", { className: "qqa-dot" }), draft.bilibili.approved ? "主人已批准" : "还没批准——只有主人能让她刷"),
        h(Toggle, { label: "启用 B 站", value: draft.bilibili.enabled, onChange: (v) => set("bilibili.enabled", v) }),
        h("div", { style: { marginTop: 12 } },
          h(SelectField, {
            label: "刷哪里",
            value: draft.bilibili.source,
            options: [
              { value: "popular", label: "热门榜" },
              { value: "weekly", label: "每周必看（周榜）" },
              { value: "homepage", label: "主页推荐信息流" },
              { value: "mix", label: "混合（最像真人乱逛）" },
            ],
            onChange: (v) => set("bilibili.source", v),
          })),
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

		// --- 模块契约：DSH 从这里取 apply / inject ---
		const inject = ["slots"];
		function apply(ctx) {
			return register({
				slots: ctx.slots,
				layout: typeof ctx.get === "function" ? ctx.get("layout") : undefined,
				document: document
			});
		}
		exports.apply = apply;
		exports.inject = inject;
		exports.QqAgentPage = QqAgentPage;
		exports.QqAgentPanelIcon = QqAgentPanelIcon;
		return module.exports;
	}
});
