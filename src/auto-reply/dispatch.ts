import type { OpenClawConfig } from "../config/config.js";
import type { DispatchFromConfigResult } from "./reply/dispatch-from-config.js";
import { dispatchReplyFromConfig } from "./reply/dispatch-from-config.js";
import { finalizeInboundContext } from "./reply/inbound-context.js";
import {
  createReplyDispatcher,
  createReplyDispatcherWithTyping,
  type ReplyDispatcher,
  type ReplyDispatcherOptions,
  type ReplyDispatcherWithTypingOptions,
} from "./reply/reply-dispatcher.js";
import type { FinalizedMsgContext, MsgContext } from "./templating.js";
import type { GetReplyOptions } from "./types.js";

// 这个文件可以看成 auto-reply 的“dispatch 入口层”：
// - 不直接生成模型回复
// - 不直接决定工具结果/块回复如何外发
// - 主要负责把“入站消息 + dispatcher”接入 reply pipeline
//
// 职责分层可以概括成：
// 1. `withReplyDispatcher()`：保证 dispatcher 生命周期一定被收口
// 2. `dispatchInboundMessage()`：标准化上下文并调用 `dispatchReplyFromConfig()`
// 3. `dispatchInboundMessageWithBufferedDispatcher()`：帮上游创建“带 typing 配套能力”的 dispatcher
// 4. `dispatchInboundMessageWithDispatcher()`：帮上游创建“普通 dispatcher”
export type DispatchInboundResult = DispatchFromConfigResult;

// 这是一个泛型辅助函数：
// - `T` 表示“被包装的异步任务最终会返回什么类型”
// - 调用方传入一个 dispatcher 和一个 async run 函数
// - 无论 run 正常结束还是中途抛错，finally 里都会确保 dispatcher 被正确收尾

/**
 * 整体翻译成人话
这整段类型声明翻译成人话就是：
这个函数接收一个叫 params 的对象。这个对象必须带一个 dispatcher，必须带一个异步 run 函数，还可以可选带一个 onSettled 回调。这个函数最终会返回一个 Promise<T>。

语法解析
 params: {
  dispatcher: ReplyDispatcher;
  run: () => Promise<T>;
  onSettled?: () => void | Promise<void>;
}): Promise<T>

1. params: { ... } 是“参数对象类型声明”
意思是：这个函数只有一个参数，名字叫 params，它必须是一个对象，而且这个对象要满足下面这个结构：
{
  dispatcher: ReplyDispatcher;
  run: () => Promise<T>;
  onSettled?: () => void | Promise<void>;
}
  就是：

dispatcher：必须有，类型是 ReplyDispatcher
run：必须有，类型是一个函数，调用后返回 Promise<T>
onSettled：可选，类型是一个函数，调用后返回 void 或 Promise<void>

2. ): Promise<T> 是“整个函数的返回值类型”
这一段是在说：
这个函数本身返回一个 Promise<T>
因为它是 async function，所以返回 Promise 很正常。
也就是说：
如果你 await 这个函数
最终拿到的值类型就是 T

逐行拆解
ispatcher: ReplyDispatcher; 表示 params.dispatcher 必须存在，并且类型是 ReplyDispatcher。
run: () => Promise<T>;这是一个函数类型。
含义是：
run 是一个函数
它不接收参数：()
它返回一个 Promise<T>

onSettled?: () => void | Promise<void>;
这里有两个点。
?： 表示这个字段是可选的。也就是说，params 可以有 onSettled，也可以没有。
() => void | Promise<void> 表示如果有这个字段，它必须是一个函数，并且：
要么同步执行，不返回值：void
要么异步执行，返回 Promise<void>


 */
export async function withReplyDispatcher<T>(params: {
  dispatcher: ReplyDispatcher;
  run: () => Promise<T>;
  onSettled?: () => void | Promise<void>;
}): Promise<T> {
  try {
    return await params.run();
  } finally {
    // Ensure dispatcher reservations are always released on every exit path.
    params.dispatcher.markComplete();
    try {
      await params.dispatcher.waitForIdle();
    } finally {
      await params.onSettled?.();
    }
  }
}

// ----------------------------------------------------------------------------
// dispatchInboundMessage()
//
// 语法拆解：
// 1. `export`
//    表示把这个函数导出给其他模块使用。
//
// 2. `async function`
//    表示这是一个异步函数，内部可以使用 `await`；
//    返回值在类型上会被包装成 `Promise<...>`。
//
// 3. `dispatchInboundMessage(params: { ... })`
//    这里只有一个入参 `params`，它是一个“对象参数”。
//    这样做的好处是：
//    - 调用时用具名字段，语义更清晰
//    - 后续扩展参数时不容易破坏调用点
//
// 4. `ctx: MsgContext | FinalizedMsgContext`
//    `ctx` 可以是两种类型之一：
//    - 原始消息上下文 `MsgContext`
//    - 已经 finalize 过的上下文 `FinalizedMsgContext`
//    也就是说，这个函数既能接收上游原始上下文，也能接收已经规范化过的上下文。
//
// 5. `replyOptions?: ...`
//    `?` 表示这个字段是可选的。
//
// 6. `Omit<GetReplyOptions, "onToolResult" | "onBlockReply">`
//    `Omit` 是 TypeScript 内置工具类型，意思是：
//    “从 `GetReplyOptions` 里复制一份类型，但删掉 `onToolResult` 和 `onBlockReply` 这两个字段”。
//    这里这样设计，是因为这两个回调由 dispatch 层统一接管，不让更上层直接覆盖。
//
// 7. `replyResolver?: typeof import("./reply.js").getReplyFromConfig`
//    这是一个很典型的“函数类型复用”写法：
//    - `import("./reply.js").getReplyFromConfig` 先定位到另一个模块里的函数
//    - `typeof ...` 再取出这个函数本身的类型签名
//    这样就能保证：如果外部传入自定义的 `replyResolver`，它的参数和返回值必须与
//    `getReplyFromConfig` 保持兼容。
//
// 8. `): Promise<DispatchInboundResult>`
//    表示这个 async 函数最终返回一个 Promise；
//    await 之后拿到的实际结果类型是 `DispatchInboundResult`。
//
// 职责解读：
// 这个函数是 auto-reply dispatch 层的主入口之一。
// 它做的事情并不复杂，但位置非常关键：
// - 先把入站上下文做标准化（`finalizeInboundContext`）
// - 再把真正的处理交给 `dispatchReplyFromConfig(...)`
// - 同时用 `withReplyDispatcher(...)` 保证 dispatcher 生命周期一定会被收口
//
// 因此你可以把它理解成：
// “dispatch 主入口 + dispatcher 生命周期保护壳”。
// ----------------------------------------------------------------------------
export async function dispatchInboundMessage(params: {
  ctx: MsgContext | FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcher: ReplyDispatcher;
  replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
  replyResolver?: typeof import("./reply.js").getReplyFromConfig;
}): Promise<DispatchInboundResult> {
  // 不管上游传来的是原始上下文还是已 finalize 的上下文，
  // 这里都统一再走一次标准化入口，确保下游看到的是稳定结构。
  const finalized = finalizeInboundContext(params.ctx);

  // 用 withReplyDispatcher 包住真正的 dispatch 逻辑，
  // 这样无论中途 return 还是 throw，都能保证 dispatcher 最终 markComplete + waitForIdle。
  return await withReplyDispatcher({
    dispatcher: params.dispatcher,
    run: () =>
      dispatchReplyFromConfig({
        ctx: finalized,
        cfg: params.cfg,
        dispatcher: params.dispatcher,
        replyOptions: params.replyOptions,
        replyResolver: params.replyResolver,
      }),
  });
}

export async function dispatchInboundMessageWithBufferedDispatcher(params: {
  ctx: MsgContext | FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcherOptions: ReplyDispatcherWithTypingOptions;
  replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
  replyResolver?: typeof import("./reply.js").getReplyFromConfig;
}): Promise<DispatchInboundResult> {
  // 这个版本适合“需要 typing controller 配套逻辑”的渠道。
  //
  // 与普通 dispatcher 不同，这里不是只创建一个发送器对象，
  // 而是额外拿到：
  // - `replyOptions`：需要自动注入到底层 reply pipeline 的 typing 回调
  // - `markDispatchIdle()`：dispatch 结束后显式关闭 typing/idle 状态
  const { dispatcher, replyOptions, markDispatchIdle } = createReplyDispatcherWithTyping(
    params.dispatcherOptions,
  );
  try {
    // 上游传入的 replyOptions 与 dispatcher 自带的 typing 回调配置在这里合并。
    return await dispatchInboundMessage({
      ctx: params.ctx,
      cfg: params.cfg,
      dispatcher,
      replyResolver: params.replyResolver,
      replyOptions: {
        ...params.replyOptions,
        ...replyOptions,
      },
    });
  } finally {
    markDispatchIdle();
  }
}

// 这是“普通 dispatcher”版本的便捷入口。
//
// 如果上游还没有真正的 `ReplyDispatcher` 实例，只持有一份
// `ReplyDispatcherOptions` 配置，就可以走这个函数。
//
// 它的工作非常单纯：
// 1. 用 `createReplyDispatcher(...)` 把配置创建成 dispatcher 实例
// 2. 再把这个实例交给更核心的 `dispatchInboundMessage(...)`
//
// Java 对照理解：
// 这很像一个“先 new 依赖，再委托给核心方法”的包装函数。
export async function dispatchInboundMessageWithDispatcher(params: {
  ctx: MsgContext | FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcherOptions: ReplyDispatcherOptions;
  replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
  replyResolver?: typeof import("./reply.js").getReplyFromConfig;
}): Promise<DispatchInboundResult> {
  // 根据调用方提供的发送配置，创建一个普通 dispatcher。
  const dispatcher = createReplyDispatcher(params.dispatcherOptions);

  // 然后把真正的工作委托给 dispatch 主入口。
  // 也就是说，这个函数本身不做复杂业务逻辑，只做“依赖创建 + 转调”。
  return await dispatchInboundMessage({
    ctx: params.ctx,
    cfg: params.cfg,
    dispatcher,
    replyResolver: params.replyResolver,
    replyOptions: params.replyOptions,
  });
}
