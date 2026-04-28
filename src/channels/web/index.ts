/* istanbul ignore file */

// ============================================================================
// channels/web/index.ts
//
// 这是 `channels/web` 这条模块路径下的索引入口文件。
//
// 它的作用和 `src/channel-web.ts` 很像，都是“重新导出”；
// 但层级语义不同：
// - `src/channel-web.ts`：Web 通道子系统自己的门面文件
// - `src/channels/web/index.ts`：挂在 `channels/` 模块体系下的标准索引入口
//
// 你可以把它理解成：
// “给 channels 子系统准备的 Web 通道出口”。
//
// 因此，这个文件依然不实现逻辑，只是把 `channel-web.ts` 的公开能力
// 再转一层导出，方便更上层统一从 `channels/*` 命名空间进入。
// ============================================================================

export {
  createWaSocket,
  loginWeb,
  logWebSelfId,
  monitorWebChannel,
  monitorWebInbox,
  pickWebChannel,
  sendMessageWhatsApp,
  WA_WEB_AUTH_DIR,
  waitForWaConnection,
  webAuthExists,
} from "../../channel-web.js";
