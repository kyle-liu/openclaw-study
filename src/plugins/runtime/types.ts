// ============================================================================
// plugins/runtime/types.ts
//
// 这个文件是插件运行时（Plugin Runtime）的“顶层类型定义文件”。
//
// 如果从职责上看：
// - `types-core.ts`：定义 runtime 的核心通用能力
// - `types-channel.ts`：定义 runtime.channel 这部分 channel 能力面
// - `types.ts`：把这些子模块重新聚合成完整的 `PluginRuntime`
//
// 如果用 Java 工程师更熟悉的语言来类比：
// - `PluginRuntimeCore` 像基础接口 / 父接口
// - `PluginRuntimeChannel` 像 `channel()` 这部分子接口
// - `PluginRuntime` 像最终对插件暴露的顶层总接口
//
// 所以这个文件最重要的价值不是“实现功能”，而是：
// 1. 定义插件最终拿到的 runtime 总结构
// 2. 统一收口 subagent 与 channel 等子模块的类型契约
// ============================================================================

import type { PluginRuntimeChannel } from "./types-channel.js";
import type { PluginRuntimeCore, RuntimeLogger } from "./types-core.js";

// 把 RuntimeLogger 类型重新导出，方便其他模块从当前文件统一获取 runtime 相关类型。
export type { RuntimeLogger };

// ── Subagent runtime types ──────────────────────────────────────────

// 启动一个 subagent run 所需的参数。
//
// Java 对照理解：
// 可以把它想成 `SubagentRunRequest` DTO。
export type SubagentRunParams = {
  sessionKey: string;
  message: string;
  extraSystemPrompt?: string;
  lane?: string;
  deliver?: boolean;
  idempotencyKey?: string;
};

// 启动 subagent 后立即返回的结果。
// 当前只暴露 `runId`，表示调用方之后可以凭这个 ID 去等待结果或查询状态。
export type SubagentRunResult = {
  runId: string;
};

// 等待 subagent 执行结果时的参数。
export type SubagentWaitParams = {
  runId: string;
  timeoutMs?: number;
};

// 等待 subagent 后返回的结果。
// 注意这里状态是一个字符串字面量联合类型：
// - "ok"
// - "error"
// - "timeout"
//
// Java 工程师可以把它类比成一个小型枚举状态字段。
export type SubagentWaitResult = {
  status: "ok" | "error" | "timeout";
  error?: string;
};

// 查询某个 subagent session 消息列表的参数。
export type SubagentGetSessionMessagesParams = {
  sessionKey: string;
  limit?: number;
};

// 查询 session 消息列表后的返回结果。
// 这里暂时把消息体记作 `unknown[]`，表示框架层不在此处强加更细的消息结构约束。
export type SubagentGetSessionMessagesResult = {
  messages: unknown[];
};

/** @deprecated Use SubagentGetSessionMessagesParams. */
export type SubagentGetSessionParams = SubagentGetSessionMessagesParams;

/** @deprecated Use SubagentGetSessionMessagesResult. */
export type SubagentGetSessionResult = SubagentGetSessionMessagesResult;

export type SubagentDeleteSessionParams = {
  sessionKey: string;
  deleteTranscript?: boolean;
};

// `PluginRuntime` 是整个插件运行时的顶层总类型。
//
// 语法解读：
// - `PluginRuntimeCore & { ... }`
//   这里的 `&` 是 TypeScript 里的“交叉类型”（intersection type）。
//   它的含义不是二选一，而是“同时拥有两边的结构”。
//
// Java 对照理解：
// 你可以把它脑补成：
//
//   interface PluginRuntime extends PluginRuntimeCore {
//       SubagentRuntime subagent();
//       PluginRuntimeChannel channel();
//   }
//
// 只是 TypeScript 这里不是用 `extends interface` 的写法来拼整体，
// 而是用“核心类型 + 补充对象结构”的方式进行组合。
export type PluginRuntime = PluginRuntimeCore & {
  // `subagent` 子模块：
  // 暴露给插件的，是一组操作 subagent 的能力，而不是单个函数。
  // 这和 `channel` 一样，都是顶层 runtime 的一个子能力面。
  /**
   * 如果翻译成人话，就是：
   * PluginRuntime 里有一个 subagent 子模块；这个子模块不是普通值，而是一个对象，里面提供了 run、waitForRun、getSessionMessages、getSession、deleteSession 这几个方法。
   * run 方法接收一个 SubagentRunParams 对象，返回一个 SubagentRunResult 对象。
   * waitForRun 方法接收一个 SubagentWaitParams 对象，返回一个 SubagentWaitResult 对象。
   * getSessionMessages 方法接收一个 SubagentGetSessionMessagesParams 对象，返回一个 SubagentGetSessionMessagesResult 对象。
   * getSession 方法接收一个 SubagentGetSessionParams 对象，返回一个 SubagentGetSessionResult 对象。
   * deleteSession 方法接收一个 SubagentDeleteSessionParams 对象，返回一个 void。
   */
  subagent: {
    run: (params: SubagentRunParams) => Promise<SubagentRunResult>;
    waitForRun: (params: SubagentWaitParams) => Promise<SubagentWaitResult>;
    getSessionMessages: (
      params: SubagentGetSessionMessagesParams,
    ) => Promise<SubagentGetSessionMessagesResult>;
    /** @deprecated Use getSessionMessages. */
    getSession: (params: SubagentGetSessionParams) => Promise<SubagentGetSessionResult>;
    deleteSession: (params: SubagentDeleteSessionParams) => Promise<void>;
  };
  // `channel` 子模块：
  // 这里直接引用 `PluginRuntimeChannel`，把 `types-channel.ts` 中定义的
  // 那整套 channel API 地图挂到总 runtime 上。
  //
  // 这也是 `types-channel.ts` 和 `runtime-channel.ts` 之间关系的关键桥梁：
  // - `types-channel.ts` 定义 `PluginRuntimeChannel`
  // - `types.ts` 声明 `PluginRuntime.channel: PluginRuntimeChannel`
  // - `runtime-channel.ts` 再返回 `PluginRuntime["channel"]`
  //
  // 因此你可以把这里看成：
  // “总 runtime 接口中声明了一个 `channel` 子接口入口”。
  channel: PluginRuntimeChannel;
};
