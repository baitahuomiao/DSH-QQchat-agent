/**
 * OneBot 11 客户端：连 NapCat 的 WebSocket，收发消息。
 *
 * 只用 node 内置的全局 WebSocket（Node 22+），不引第三方依赖。
 * 职责边界：
 *  - 连接管理（自动重连、状态查询）；
 *  - 请求/响应配对（echo）；
 *  - 事件派发（message / notice / meta_event）；
 *  - 发送相关的便捷封装（文本、图片、语音、@）。
 * 不做任何"要不要回"的判断，那是 engine 的事。
 */
"use strict";

const { EventEmitter } = require("node:events");

let echoSeq = 0;
function nextEcho() {
  echoSeq += 1;
  return "qqagent-" + Date.now().toString(36) + "-" + echoSeq;
}

/** 把 OneBot 的 message 段数组拍平成可读文本（图片/表情用占位标记）。 */
function flattenMessage(segments) {
  const parts = [];
  const images = [];
  for (const seg of Array.isArray(segments) ? segments : []) {
    const type = seg && seg.type;
    const data = (seg && seg.data) || {};
    if (type === "text") parts.push(String(data.text || ""));
    else if (type === "image") {
      images.push({
        url: data.url || data.file || "",
        file: data.file || "",
        subType: data.sub_type || "",
        summary: data.summary || "",
      });
      parts.push("[图片]");
    } else if (type === "face") parts.push("[表情]");
    else if (type === "mface") parts.push("[表情包]");
    else if (type === "at") parts.push("@" + String(data.qq || ""));
    else if (type === "reply") parts.push("[引用]");
    else if (type === "record") parts.push("[语音]");
    else if (type === "video") parts.push("[视频]");
    else if (type === "file") parts.push("[文件]");
    else if (type === "json" || type === "xml") parts.push("[卡片]");
    else if (type === "forward") parts.push("[转发消息]");
    else if (type === "dice" || type === "rps") parts.push("[骰子]");
  }
  return { text: parts.join("").trim(), images };
}

/** 从私聊/群聊事件里抽出统一结构。 */
function readEvent(event) {
  const postType = event && event.post_type;
  if (postType !== "message") return null;
  const messageType = event.message_type;
  const selfId = String(event.self_id || "");
  const userId = String(event.user_id || "");
  const segments = Array.isArray(event.message) ? event.message : [];
  const flat = flattenMessage(segments);
  const sender = event.sender || {};
  const atMe = segments.some(
    (seg) => seg && seg.type === "at" && String((seg.data && seg.data.qq) || "") === selfId,
  );
  const base = {
    postType,
    messageType,
    selfId,
    userId,
    nickname: String(sender.card || sender.nickname || userId),
    groupId: messageType === "group" ? String(event.group_id || "") : "",
    text: flat.text,
    images: flat.images,
    atMe,
    messageId: event.message_id,
    time: Number(event.time || Math.floor(Date.now() / 1000)),
  };
  if (messageType === "group") {
    base.sessionKey = "group:" + base.groupId;
    base.replyTarget = { kind: "group", groupId: base.groupId };
  } else if (messageType === "private") {
    base.sessionKey = "private:" + base.userId;
    base.replyTarget = { kind: "private", userId: base.userId };
  } else {
    return null;
  }
  return base;
}

class OneBotClient extends EventEmitter {
  constructor(options) {
    super();
    this.options = Object.assign({ wsUrl: "ws://127.0.0.1:3001", token: "", reconnectMs: 5000 }, options || {});
    this.ws = null;
    this.connected = false;
    this.selfId = "";
    this.nickname = "";
    this.pending = new Map();
    this.closedByUser = false;
    this.retryTimer = null;
    this.lastError = "";
    this.connectedAt = 0;
    this.reconnectCount = 0;
  }

  /** 建立连接；重复调用是安全的。 */
  connect() {
    if (this.ws && (this.connected || this.ws.readyState === 0)) return;
    this.closedByUser = false;
    this.clearRetry();

    const url = this.options.token
      ? this.options.wsUrl + (this.options.wsUrl.includes("?") ? "&" : "?") + "access_token=" + encodeURIComponent(this.options.token)
      : this.options.wsUrl;

    let ws;
    try {
      ws = new WebSocket(url);
    } catch (error) {
      this.lastError = String(error && error.message ? error.message : error);
      this.scheduleRetry();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.connected = true;
      this.connectedAt = Date.now();
      this.lastError = "";
      this.emit("status", this.status());
      this.handshake();
    };

    ws.onmessage = (event) => {
      let payload;
      try {
        payload = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
      } catch {
        return;
      }
      if (payload && payload.echo && this.pending.has(payload.echo)) {
        const waiter = this.pending.get(payload.echo);
        this.pending.delete(payload.echo);
        clearTimeout(waiter.timer);
        waiter.resolve(payload);
        return;
      }
      if (payload && payload.post_type) this.emit(payload.post_type, payload);
    };

    ws.onerror = (event) => {
      this.lastError = String((event && (event.message || event.type)) || "websocket error");
    };

    ws.onclose = () => {
      const wasConnected = this.connected;
      this.connected = false;
      this.ws = null;
      for (const [, waiter] of this.pending) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("连接已断开"));
      }
      this.pending.clear();
      this.emit("status", this.status());
      if (wasConnected) this.emit("disconnect", this.lastError);
      if (!this.closedByUser) this.scheduleRetry();
    };
  }

  handshake() {
    // 先把账号信息拿到再宣布 ready，这样上层日志里能看到昵称而不是「未知账号」。
    this.call("get_login_info", {})
      .then((payload) => {
        const data = (payload && payload.data) || {};
        this.selfId = String(data.user_id || "");
        this.nickname = String(data.nickname || "");
        this.emit("status", this.status());
      })
      .catch(() => {})
      .finally(() => {
        this.emit("ready");
      });
  }

  scheduleRetry() {
    this.clearRetry();
    const delay = Math.max(1000, Number(this.options.reconnectMs) || 5000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.reconnectCount += 1;
      this.connect();
    }, delay);
    if (this.retryTimer && typeof this.retryTimer.unref === "function") this.retryTimer.unref();
  }

  clearRetry() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  disconnect() {
    this.closedByUser = true;
    this.clearRetry();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.connected = false;
  }

  /** 应用新配置（主要用来换地址/令牌）。地址变了就重连。 */
  reconfigure(options) {
    const next = Object.assign({}, this.options, options || {});
    const urlChanged = next.wsUrl !== this.options.wsUrl || next.token !== this.options.token;
    this.options = next;
    if (urlChanged) {
      this.disconnect();
      this.closedByUser = false;
      this.connect();
    }
  }

  status() {
    return {
      connected: this.connected,
      wsUrl: this.options.wsUrl,
      selfId: this.selfId,
      nickname: this.nickname,
      lastError: this.lastError,
      connectedAt: this.connectedAt,
      reconnectCount: this.reconnectCount,
    };
  }

  /**
   * 调一个 OneBot API。
   * @param {string} action
   * @param {Record<string, any>} params
   * @param {number} [timeoutMs]
   */
  call(action, params, timeoutMs) {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return Promise.reject(new Error("尚未连接到 OneBot"));
    const echo = nextEcho();
    const payload = { action, params: params || {}, echo };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error("OneBot 调用超时：" + action));
      }, timeoutMs || 15000);
      if (timer && typeof timer.unref === "function") timer.unref();
      this.pending.set(echo, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify(payload));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(echo);
        reject(error);
      }
    });
  }

  // —— 发送封装 ——

  /** 发文本，target = {kind:'group',groupId} | {kind:'private',userId} */
  sendText(target, text) {
    return this.sendSegments(target, [{ type: "text", data: { text: String(text) } }]);
  }

  sendImage(target, fileUrlOrPath) {
    return this.sendSegments(target, [{ type: "image", data: { file: fileUrlOrPath } }]);
  }

  sendRecord(target, fileUrlOrPath) {
    return this.sendSegments(target, [{ type: "record", data: { file: fileUrlOrPath } }]);
  }

  sendSegments(target, segments) {
    if (target.kind === "group") {
      return this.call("send_group_msg", { group_id: Number(target.groupId) || target.groupId, message: segments });
    }
    return this.call("send_private_msg", { user_id: Number(target.userId) || target.userId, message: segments });
  }

  getGroupList() {
    return this.call("get_group_list", {}).then((payload) => (payload && payload.data) || []);
  }

  getFriendList() {
    return this.call("get_friend_list", {}).then((payload) => (payload && payload.data) || []);
  }

  /** 把消息里的图片下载成字节；返回 [] 表示没有可用图片。 */
  async downloadImages(images, maxBytes) {
    const out = [];
    const { fetchLoose } = require("./net.cjs");
    for (const image of Array.isArray(images) ? images : []) {
      const url = image && image.url;
      if (!url || !/^https?:\/\//i.test(url)) continue;
      try {
        const response = await fetchLoose(url, { timeoutMs: 20000 });
        if (!response.ok) continue;
        const bytes = response.buffer();
        if (maxBytes && bytes.length > maxBytes) continue;
        const header = String(response.headers.get("content-type") || "");
        out.push({ data: bytes, mediaType: pickImageMediaType(header, bytes), name: image.file || "qq-image" });
      } catch {
        /* 单张失败不影响其它 */
      }
    }
    return out;
  }
}

function pickImageMediaType(header, bytes) {
  const text = String(header || "").toLowerCase();
  if (text.includes("png")) return "image/png";
  if (text.includes("webp")) return "image/webp";
  if (text.includes("gif")) return "image/gif";
  if (text.includes("jpeg") || text.includes("jpg")) return "image/jpeg";
  if (bytes && bytes.length >= 4) {
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
    if (bytes[0] === 0x47 && bytes[1] === 0x49) return "image/gif";
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57) return "image/webp";
  }
  return "image/jpeg";
}

module.exports = { OneBotClient, readEvent, flattenMessage, pickImageMediaType };
