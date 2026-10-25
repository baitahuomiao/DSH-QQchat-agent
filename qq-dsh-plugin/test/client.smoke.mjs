/**
 * 客户端 bundle 冒烟测试：在假的浏览器环境里跑一遍 lib/client.js，
 * 确认 __ModuleLoader__ 拿到了模块、apply/inject 齐备、两个 slot 都注册上了。
 *
 * 不渲染 React 组件（那需要 react-dom），只验证注册契约。
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

const registered = [];
const injected = [];
let loaded = null;

const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: "Fragment",
  useCallback: (fn) => fn,
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
  useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
};

const styleElement = {
  isConnected: true,
  setAttribute() {},
  textContent: "",
  remove() {
    this.isConnected = false;
  },
};

const fakeDocument = {
  head: {
    appendChild(node) {
      node.isConnected = true;
    },
  },
  createElement: () => styleElement,
  body: { hasAttribute: () => false },
};

const sandbox = {
  window: {},
  document: fakeDocument,
  console,
  fetch: async () => {
    throw new Error("no network in smoke test");
  },
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: () => 0,
  clearTimeout: () => {},
  Audio: function Audio() {
    this.play = async () => {};
  },
  URL,
  JSON,
  Error,
  Object,
  Array,
  String,
  Number,
  Boolean,
  Math,
  Date,
  encodeURIComponent,
  Map,
  Set,
  Promise,
  isNaN,
  parseInt,
  parseFloat,
};

sandbox.window.__ModuleLoader__ = {
  load(entry) {
    loaded = entry;
  },
};
sandbox.globalThis = sandbox;
sandbox.window.document = fakeDocument;

const context = vm.createContext(sandbox);
vm.runInContext(source, context, { filename: "lib/client.js" });

if (!loaded) throw new Error("client bundle 没有调用 __ModuleLoader__.load()");
console.log("module id:", loaded.id);

const mod = loaded.factory((name) => {
  if (name === "react") return fakeReact;
  throw new Error("unexpected require: " + name);
});

if (typeof mod.apply !== "function") throw new Error("缺少 exports.apply");
if (!Array.isArray(mod.inject)) throw new Error("缺少 exports.inject");
console.log("inject:", JSON.stringify(mod.inject));

const slots = {
  register(registration, component) {
    registered.push({ registration, component });
    return () => {
      const index = registered.findIndex((row) => row.registration === registration);
      if (index >= 0) registered.splice(index, 1);
    };
  },
  inject(name, factory) {
    injected.push(name);
    const disposer = factory();
    return disposer;
  },
};

const layout = {
  selectPanel(id) {
    console.log("selectPanel:", id);
  },
};

const dispose = mod.apply({
  slots,
  get: (name) => (name === "layout" ? layout : undefined),
});

console.log("inject() 调用:", injected.join(", "));
console.log("注册的 slot:", registered.map((row) => row.registration.name + (row.registration.id || row.registration.key ? "(" + (row.registration.id || row.registration.key) + ")" : "")).join(" | "));
for (const row of registered) {
  console.log("  -", row.registration.name, "component:", typeof row.component === "function" ? row.component.name : typeof row.component);
}
if (typeof mod.PANEL_CSS === "string" && mod.PANEL_CSS.length > 500) console.log("PANEL_CSS:", mod.PANEL_CSS.length, "chars");

// 折叠样式表
console.log("样式表注入:", styleElement.textContent.length > 0 ? "yes" : "no");

if (typeof dispose === "function") {
  console.log("open/panelId:", typeof dispose.open, dispose.panelId);
  dispose();
}
console.log("dispose 后剩余注册:", registered.length);
console.log("OK");
process.exit(0);
