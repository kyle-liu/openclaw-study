// ============================================================================
// auto-reply/reply.ts
//
// 这个文件本身几乎不承载业务逻辑，它是 auto-reply 子系统的“统一导出入口”
// （也可以理解成 barrel file / facade file）。
//
// 设计目的：
// 1. 给外部模块提供一个稳定、简短的 import 路径
// 2. 隐藏 `reply/` 目录内部更细的文件拆分
// 3. 明确哪些函数/类型属于“建议对外使用的公开接口”
//
// 因此：
// - 真正的实现逻辑在 `./reply/*.js` 或 `./types.js`
// - 这个文件负责把它们重新导出给上游调用方
//
// 例如：
// - `dispatch-from-config.ts`
// - `heartbeat-runner.ts`
// - `index.ts`
//
// 都可以从 `auto-reply/reply.js` 统一拿到这些入口，而不用分别引用
// `./reply/get-reply.js`、`./reply/directives.js`、`./reply/queue.js` 等内部文件。
// ============================================================================

// 导出几类常见的 inline directive 解析函数。
// 这些函数负责从用户输入中抽取 think / verbose / reasoning / elevated 等控制指令。
export {
  extractElevatedDirective,
  extractReasoningDirective,
  extractThinkDirective,
  extractVerboseDirective,
} from "./reply/directives.js";

// 导出自动回复系统的核心入口之一：
// 给定消息上下文 + 配置，生成最终 reply。
// 真正实现位于 `reply/get-reply.ts`。
export { getReplyFromConfig } from "./reply/get-reply.js";

// 导出 exec directive 解析函数。
// 用于识别消息里和执行策略相关的控制指令。
export { extractExecDirective } from "./reply/exec.js";

// 导出 queue directive 解析函数。
// 用于识别消息里控制排队/跟进/steer 行为的指令。
export { extractQueueDirective } from "./reply/queue.js";

// 导出 reply tag 解析函数。
// 用于从消息中提取 reply-to / 引用回复相关标签。
export { extractReplyToTag } from "./reply/reply-tags.js";

// 导出自动回复模块常用的输入/输出类型。
// 外部模块只需依赖这里即可获得 reply API 的主要类型定义。
export type { GetReplyOptions, ReplyPayload } from "./types.js";
