import type { TypingCallbacks } from "../../channels/typing.js";
import type { HumanDelayConfig } from "../../config/types.js";
import { sleep } from "../../utils.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { registerDispatcher } from "./dispatcher-registry.js";
import { normalizeReplyPayload, type NormalizeReplySkipReason } from "./normalize-reply.js";
import type { ResponsePrefixContext } from "./response-prefix-template.js";
import type { TypingController } from "./typing.js";

// ============================================================================
// auto-reply/reply/reply-dispatcher.ts
//
// 这个文件负责“把 reply payload 有序、可控地送出去”。
//
// 如果把自动回复流程拆成两层：
// - reply 核心层：决定要产出什么 payload（tool / block / final）
// - dispatch 层：决定这些 payload 如何被规范化、排队、发送、收口
//
// 那么本文件就是 dispatch 层里的“发送编排器”。
//
// 它不生成回复内容，它负责：
// 1. 统一 tool / block / final 三类 reply 的发送入口
// 2. 确保发送顺序稳定（串行）
// 3. 在发送前统一做 payload normalize
// 4. 在发送后统一维护 idle / complete / queuedCounts 等状态
// 5. 在需要时叠加 typing 相关能力
//
// 可以把它理解成：
// “reply pipeline 的最后一段发送调度器”。
// ============================================================================

export type ReplyDispatchKind = "tool" | "block" | "final";

// 发送出错时的统一错误回调签名。
type ReplyDispatchErrorHandler = (err: unknown, info: { kind: ReplyDispatchKind }) => void;

// payload 被 normalize 后判定为“应该跳过发送”时的统一回调签名。
type ReplyDispatchSkipHandler = (
  payload: ReplyPayload,
  info: { kind: ReplyDispatchKind; reason: NormalizeReplySkipReason },
) => void;

// 真正执行外发动作的底层 deliver 函数签名。
// dispatcher 自己不关心具体是哪个渠道，只要求上层提供一个真正发送 payload 的函数。
type ReplyDispatchDeliverer = (
  payload: ReplyPayload,
  info: { kind: ReplyDispatchKind },
) => Promise<void>;

const DEFAULT_HUMAN_DELAY_MIN_MS = 800;
const DEFAULT_HUMAN_DELAY_MAX_MS = 2500;

/** Generate a random delay within the configured range. */
function getHumanDelay(config: HumanDelayConfig | undefined): number {
  const mode = config?.mode ?? "off";
  if (mode === "off") {
    return 0;
  }
  const min =
    mode === "custom" ? (config?.minMs ?? DEFAULT_HUMAN_DELAY_MIN_MS) : DEFAULT_HUMAN_DELAY_MIN_MS;
  const max =
    mode === "custom" ? (config?.maxMs ?? DEFAULT_HUMAN_DELAY_MAX_MS) : DEFAULT_HUMAN_DELAY_MAX_MS;
  if (max <= min) {
    return min;
  }
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export type ReplyDispatcherOptions = {
  deliver: ReplyDispatchDeliverer;
  responsePrefix?: string;
  /** Static context for response prefix template interpolation. */
  responsePrefixContext?: ResponsePrefixContext;
  /** Dynamic context provider for response prefix template interpolation.
   * Called at normalization time, after model selection is complete. */
  responsePrefixContextProvider?: () => ResponsePrefixContext;
  onHeartbeatStrip?: () => void;
  onIdle?: () => void;
  onError?: ReplyDispatchErrorHandler;
  // AIDEV-NOTE: onSkip lets channels detect silent/empty drops (e.g. Telegram empty-response fallback).
  onSkip?: ReplyDispatchSkipHandler;
  /** Human-like delay between block replies for natural rhythm. */
  humanDelay?: HumanDelayConfig;
};

// 这是“带 typing 配套能力”的 dispatcher 配置。
// 在普通 dispatcher 配置基础上，再额外携带 typing 生命周期相关钩子。
export type ReplyDispatcherWithTypingOptions = Omit<ReplyDispatcherOptions, "onIdle"> & {
  typingCallbacks?: TypingCallbacks;
  onReplyStart?: () => Promise<void> | void;
  onIdle?: () => void;
  /** Called when the typing controller is cleaned up (e.g., on NO_REPLY). */
  onCleanup?: () => void;
};

// 带 typing 的工厂函数返回值不只是 dispatcher 本身，
// 还会额外返回一组需要注入给 reply pipeline 的回调与控制函数。
type ReplyDispatcherWithTypingResult = {
  dispatcher: ReplyDispatcher;
  replyOptions: Pick<GetReplyOptions, "onReplyStart" | "onTypingController" | "onTypingCleanup">;
  markDispatchIdle: () => void;
  /** Signal that the model run is complete so the typing controller can stop. */
  markRunComplete: () => void;
};

// `ReplyDispatcher` 是本文件最核心的发送器接口。
// Java 对照理解：它像一个小型有状态发送控制器，而不是单个回调函数。
export type ReplyDispatcher = {
  sendToolResult: (payload: ReplyPayload) => boolean;
  sendBlockReply: (payload: ReplyPayload) => boolean;
  sendFinalReply: (payload: ReplyPayload) => boolean;
  waitForIdle: () => Promise<void>;
  getQueuedCounts: () => Record<ReplyDispatchKind, number>;
  markComplete: () => void;
};

type NormalizeReplyPayloadInternalOptions = Pick<
  ReplyDispatcherOptions,
  "responsePrefix" | "responsePrefixContext" | "responsePrefixContextProvider" | "onHeartbeatStrip"
> & {
  onSkip?: (reason: NormalizeReplySkipReason) => void;
};

// 内部辅助：统一做 payload normalize。
// 这样 tool / block / final 三类发送入口都可以共用同一套前处理逻辑。
function normalizeReplyPayloadInternal(
  payload: ReplyPayload,
  opts: NormalizeReplyPayloadInternalOptions,
): ReplyPayload | null {
  // Prefer dynamic context provider over static context
  const prefixContext = opts.responsePrefixContextProvider?.() ?? opts.responsePrefixContext;

  return normalizeReplyPayload(payload, {
    responsePrefix: opts.responsePrefix,
    responsePrefixContext: prefixContext,
    onHeartbeatStrip: opts.onHeartbeatStrip,
    onSkip: opts.onSkip,
  });
}

// 创建一个“普通 dispatcher”。
//
// 这个函数是本文件的核心实现：
// - 返回一个 `ReplyDispatcher`
// - 内部维护发送队列、计数器、idle 状态与 complete 标记
export function createReplyDispatcher(options: ReplyDispatcherOptions): ReplyDispatcher {
  let sendChain: Promise<void> = Promise.resolve(); // 用 Promise 链串行化所有发送动作
  // Track in-flight deliveries so we can emit a reliable "idle" signal.
  // Start with pending=1 as a "reservation" to prevent premature gateway restart.
  // This is decremented when markComplete() is called to signal no more replies will come.
  let pending = 1; // 预留一个“保活占位”，防止还没 markComplete 就被误判 idle
  let completeCalled = false; // 标记上层是否已经声明“不会再有新 reply 进入”
  // Track whether we've sent a block reply (for human delay - skip delay on first block).
  let sentFirstBlock = false;
  // Serialize outbound replies to preserve tool/block/final order.
  const queuedCounts: Record<ReplyDispatchKind, number> = {
    tool: 0,
    block: 0,
    final: 0,
  };

  // Register this dispatcher globally for gateway restart coordination.
  const { unregister } = registerDispatcher({
    pending: () => pending,
    waitForIdle: () => sendChain,
  });

  // 统一入队函数：
  // - normalize payload
  // - 更新计数与 pending
  // - 接到 sendChain 后面串行执行
  const enqueue = (kind: ReplyDispatchKind, payload: ReplyPayload) => {
    const normalized = normalizeReplyPayloadInternal(payload, {
      responsePrefix: options.responsePrefix,
      responsePrefixContext: options.responsePrefixContext,
      responsePrefixContextProvider: options.responsePrefixContextProvider,
      onHeartbeatStrip: options.onHeartbeatStrip,
      onSkip: (reason) => options.onSkip?.(payload, { kind, reason }),
    });
    if (!normalized) {
      return false;
    }
    queuedCounts[kind] += 1;
    pending += 1;

    // Determine if we should add human-like delay (only for block replies after the first).
    const shouldDelay = kind === "block" && sentFirstBlock;
    if (kind === "block") {
      sentFirstBlock = true;
    }

    // 关键设计点：
    // 这里不是立刻并发 fire-and-forget 发送，而是把每次发送都接到 `sendChain` 后面。
    // 这样可以保证 tool -> block -> final 的发送顺序稳定。
    sendChain = sendChain
      .then(async () => {
        // Add human-like delay between block replies for natural rhythm.
        if (shouldDelay) {
          const delayMs = getHumanDelay(options.humanDelay);
          if (delayMs > 0) {
            await sleep(delayMs);
          }
        }
        // Safe: deliver is called inside an async .then() callback, so even a synchronous
        // throw becomes a rejection that flows through .catch()/.finally(), ensuring cleanup.
        await options.deliver(normalized, { kind });
      })
      .catch((err) => {
        // 单次发送失败不应把整个链彻底打断，因此统一走 onError 回调后继续收尾。
        options.onError?.(err, { kind });
      })
      .finally(() => {
        pending -= 1;
        // Clear reservation if:
        // 1. pending is now 1 (just the reservation left)
        // 2. markComplete has been called
        // 3. No more replies will be enqueued
        if (pending === 1 && completeCalled) {
          pending -= 1; // Clear the reservation
        }
        if (pending === 0) {
          // Unregister from global tracking when idle.
          unregister();
          options.onIdle?.();
        }
      });
    return true;
  };

  // 上层在确认“本轮不会再有新的 payload 入队”时调用它。
  // 它不会马上强行清空队列，而是和 pending / reservation 机制配合，
  // 在合适的时机把 dispatcher 推到 idle。
  const markComplete = () => {
    if (completeCalled) {
      return;
    }
    completeCalled = true;
    // If no replies were enqueued (pending is still 1 = just the reservation),
    // schedule clearing the reservation after current microtasks complete.
    // This gives any in-flight enqueue() calls a chance to increment pending.
    void Promise.resolve().then(() => {
      if (pending === 1 && completeCalled) {
        // Still just the reservation, no replies were enqueued
        pending -= 1;
        if (pending === 0) {
          unregister();
          options.onIdle?.();
        }
      }
    });
  };

  return {
    // 这三个方法只是把 kind 固定后复用同一个 enqueue 逻辑。
    sendToolResult: (payload) => enqueue("tool", payload),
    sendBlockReply: (payload) => enqueue("block", payload),
    sendFinalReply: (payload) => enqueue("final", payload),
    waitForIdle: () => sendChain,
    getQueuedCounts: () => ({ ...queuedCounts }),
    markComplete,
  };
}

// 在普通 dispatcher 之上再叠一层 typing 能力。
//
// 设计思想是“组合而不是重写”：
// - 仍然复用 `createReplyDispatcher(...)`
// - 只是把 typing controller 相关生命周期桥接进去
export function createReplyDispatcherWithTyping(
  options: ReplyDispatcherWithTypingOptions,
): ReplyDispatcherWithTypingResult {
  const { typingCallbacks, onReplyStart, onIdle, onCleanup, ...dispatcherOptions } = options;
  const resolvedOnReplyStart = onReplyStart ?? typingCallbacks?.onReplyStart;
  const resolvedOnIdle = onIdle ?? typingCallbacks?.onIdle;
  const resolvedOnCleanup = onCleanup ?? typingCallbacks?.onCleanup;
  let typingController: TypingController | undefined;
  // 先创建一个普通 dispatcher，再把 onIdle 包装成“顺便通知 typing controller 空闲”。
  const dispatcher = createReplyDispatcher({
    ...dispatcherOptions,
    onIdle: () => {
      typingController?.markDispatchIdle();
      resolvedOnIdle?.();
    },
  });

  return {
    dispatcher,
    // 这组 replyOptions 会被注入给更上层的 reply pipeline，
    // 让 agent run 开始/结束时能把 typing controller 接进来。
    replyOptions: {
      onReplyStart: resolvedOnReplyStart,
      onTypingCleanup: resolvedOnCleanup,
      onTypingController: (typing) => {
        typingController = typing;
      },
    },
    // dispatch 层结束时，允许上层显式告诉 typing controller：dispatch 已空闲。
    markDispatchIdle: () => {
      typingController?.markDispatchIdle();
      resolvedOnIdle?.();
    },
    // run 层结束时，允许上层显式告诉 typing controller：模型运行已完成。
    markRunComplete: () => {
      typingController?.markRunComplete();
    },
  };
}
