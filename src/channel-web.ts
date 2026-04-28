// ============================================================================
// channel-web.ts
//
// 这是 Web / WhatsApp 通道子系统的“门面文件”（barrel file / facade）。
//
// 它本身不实现具体业务逻辑，而是把分散在 `src/web/...` 下的能力统一重新导出。
//
// 设计目的：
// 1. 给外部模块提供一个更短、更稳定的 import 路径
// 2. 隐藏 `src/web/...` 内部更细的目录拆分
// 3. 让 Web 通道的公开 API 在一个地方集中可见
//
// 所以阅读这个文件时，不要把它当成“实现文件”，而要把它当成：
// “Web / WhatsApp 子系统对外公开了哪些入口”的目录。
// ============================================================================

// 自动回复 / 心跳 / 监控相关导出。
// 这组最重要的入口通常是 `monitorWebChannel`，
// 它会进一步进入 Web 通道的监听与 auto-reply 主链路。
export {
  DEFAULT_WEB_MEDIA_BYTES,
  HEARTBEAT_PROMPT,
  HEARTBEAT_TOKEN,
  monitorWebChannel,
  resolveHeartbeatRecipients,
  runWebHeartbeatOnce,
  type WebChannelStatus,
  type WebMonitorTuning,
} from "./web/auto-reply.js";

// 原始入站监听能力导出。
// 如果 `monitorWebChannel` 更像“高层自动回复入口”，
// 那 `monitorWebInbox` 更像“更底层的 Web 入站监听器”。
export {
  extractMediaPlaceholder,
  extractText,
  monitorWebInbox,
  type WebInboundMessage,
  type WebListenerCloseReason,
} from "./web/inbound.js";

// 登录 / 媒体 / 出站发送 / session 相关基础能力导出。
// 这些能力组合起来，构成 Web / WhatsApp 通道的基础操作面。
export { loginWeb } from "./web/login.js";
export { loadWebMedia, optimizeImageToJpeg } from "./web/media.js";
export { sendMessageWhatsApp } from "./web/outbound.js";
export {
  createWaSocket,
  formatError,
  getStatusCode,
  logoutWeb,
  logWebSelfId,
  pickWebChannel,
  WA_WEB_AUTH_DIR,
  waitForWaConnection,
  webAuthExists,
} from "./web/session.js";
