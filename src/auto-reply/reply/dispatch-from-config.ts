// ============================================================================
// auto-reply/reply/dispatch-from-config.ts
//
// 这个文件位于“渠道消息分发层”和“reply 核心层”之间。
//
// 如果把自动回复主链路拆开：
// - `provider-dispatcher.ts` / `dispatch.ts`：更外层的消息分发入口
// - `dispatch-from-config.ts`：把消息通道语义桥接到 reply 核心
// - `get-reply.ts`：真正的 reply 入口预处理
// - `get-reply-run.ts`：运行组装
// - `agent-runner.ts`：生命周期总编排
//
// 因此，这个文件最重要的职责不是“生成回复内容”，而是：
// 1. 在调用 `getReplyFromConfig()` 之前，先处理消息系统层面的事情
// 2. 把 reply 过程中的 tool/block/final payload 接回到具体消息通道
// 3. 统一处理 diagnostics、hooks、send policy、route-to-origin、TTS 等外围语义
//
// 可以把它理解成：
// “消息分发层 -> reply 核心层”的桥接器 / 适配器。
// ============================================================================

import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  loadSessionStore,
  resolveSessionStoreEntry,
  resolveStorePath,
  type SessionEntry,
} from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import { fireAndForgetHook } from "../../hooks/fire-and-forget.js";
import { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";
import {
  deriveInboundMessageHookContext,
  toInternalMessageReceivedContext,
  toPluginMessageContext,
  toPluginMessageReceivedEvent,
} from "../../hooks/message-hook-mappers.js";
import { isDiagnosticsEnabled } from "../../infra/diagnostic-events.js";
import {
  logMessageProcessed,
  logMessageQueued,
  logSessionStateChange,
} from "../../logging/diagnostic.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import { maybeApplyTtsToPayload, normalizeTtsAutoMode, resolveTtsConfig } from "../../tts/tts.js";
import { INTERNAL_MESSAGE_CHANNEL, normalizeMessageChannel } from "../../utils/message-channel.js";
import { getReplyFromConfig } from "../reply.js";
import type { FinalizedMsgContext } from "../templating.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { formatAbortReplyText, tryFastAbortFromMessage } from "./abort.js";
import { shouldBypassAcpDispatchForCommand, tryDispatchAcpReply } from "./dispatch-acp.js";
import { shouldSkipDuplicateInbound } from "./inbound-dedupe.js";
import type { ReplyDispatcher, ReplyDispatchKind } from "./reply-dispatcher.js";
import { shouldSuppressReasoningPayload } from "./reply-payloads.js";
import { isRoutableChannel, routeReply } from "./route-reply.js";
import { resolveRunTypingPolicy } from "./typing-policy.js";

// 某些通道会把音频消息包装成占位文本或标准头部。
// 这里先准备几个轻量启发式规则，用来判断这条消息是否属于“音频输入语境”。
const AUDIO_PLACEHOLDER_RE = /^<media:audio>(\s*\([^)]*\))?$/i;
const AUDIO_HEADER_RE = /^\[Audio\b/i;
const normalizeMediaType = (value: string): string => value.split(";")[0]?.trim().toLowerCase();

// 判断当前入站消息是否应按“音频输入”处理。
// 这会影响后面的 TTS 策略与某些通道输出行为。
const isInboundAudioContext = (ctx: FinalizedMsgContext): boolean => {
  const rawTypes = [
    typeof ctx.MediaType === "string" ? ctx.MediaType : undefined,
    ...(Array.isArray(ctx.MediaTypes) ? ctx.MediaTypes : []),
  ].filter(Boolean) as string[];
  const types = rawTypes.map((type) => normalizeMediaType(type));
  if (types.some((type) => type === "audio" || type.startsWith("audio/"))) {
    return true;
  }

  const body =
    typeof ctx.BodyForCommands === "string"
      ? ctx.BodyForCommands
      : typeof ctx.CommandBody === "string"
        ? ctx.CommandBody
        : typeof ctx.RawBody === "string"
          ? ctx.RawBody
          : typeof ctx.Body === "string"
            ? ctx.Body
            : "";
  const trimmed = body.trim();
  if (!trimmed) {
    return false;
  }
  if (AUDIO_PLACEHOLDER_RE.test(trimmed)) {
    return true;
  }
  return AUDIO_HEADER_RE.test(trimmed);
};

// 根据当前消息定位 session store 中已有的 session entry。
// dispatch 层在决定 send policy / TTS auto / ACP 分流时，经常需要先读一眼 session 状态。
const resolveSessionStoreLookup = (
  ctx: FinalizedMsgContext,
  cfg: OpenClawConfig,
): {
  sessionKey?: string;
  entry?: SessionEntry;
} => {
  const targetSessionKey =
    ctx.CommandSource === "native" ? ctx.CommandTargetSessionKey?.trim() : undefined;
  const sessionKey = (targetSessionKey ?? ctx.SessionKey)?.trim();
  if (!sessionKey) {
    return {};
  }
  const agentId = resolveSessionAgentId({ sessionKey, config: cfg });
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  try {
    const store = loadSessionStore(storePath);
    return {
      sessionKey,
      entry: resolveSessionStoreEntry({ store, sessionKey }).existing,
    };
  } catch {
    return {
      sessionKey,
    };
  }
};

export type DispatchFromConfigResult = {
  queuedFinal: boolean;
  counts: Record<ReplyDispatchKind, number>;
};

// 这是“普通消息路径”里最靠近 reply 核心的 dispatch 入口。
// 上游把一条已经 finalize 过的入站消息交进来后，这里会：
// - 做重复消息过滤、hooks、send policy、route 策略
// - 决定是否先走 fast abort / ACP
// - 最终调用 `getReplyFromConfig()` 获取回复
// - 再把 tool/block/final payload 回送到 dispatcher 或 originating channel
export async function dispatchReplyFromConfig(params: {
  ctx: FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcher: ReplyDispatcher;
  replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
  replyResolver?: typeof getReplyFromConfig;
}): Promise<DispatchFromConfigResult> {
  const { ctx, cfg, dispatcher } = params;
  const diagnosticsEnabled = isDiagnosticsEnabled(cfg);
  const channel = String(ctx.Surface ?? ctx.Provider ?? "unknown").toLowerCase();
  const chatId = ctx.To ?? ctx.From;
  const messageId = ctx.MessageSid ?? ctx.MessageSidFirst ?? ctx.MessageSidLast;
  const sessionKey = ctx.SessionKey;
  const startTime = diagnosticsEnabled ? Date.now() : 0;
  const canTrackSession = diagnosticsEnabled && Boolean(sessionKey);

  // diagnostics 辅助：统一记录“这条消息最终是完成、跳过还是报错”。
  const recordProcessed = (
    outcome: "completed" | "skipped" | "error",
    opts?: {
      reason?: string;
      error?: string;
    },
  ) => {
    if (!diagnosticsEnabled) {
      return;
    }
    logMessageProcessed({
      channel,
      chatId,
      messageId,
      sessionKey,
      durationMs: Date.now() - startTime,
      outcome,
      reason: opts?.reason,
      error: opts?.error,
    });
  };

  // diagnostics 辅助：进入 dispatch 主逻辑时，把 session 标记为 processing。
  const markProcessing = () => {
    if (!canTrackSession || !sessionKey) {
      return;
    }
    logMessageQueued({ sessionKey, channel, source: "dispatch" });
    logSessionStateChange({
      sessionKey,
      state: "processing",
      reason: "message_start",
    });
  };

  // diagnostics 辅助：离开 dispatch 主逻辑时，把 session 标记回 idle。
  const markIdle = (reason: string) => {
    if (!canTrackSession || !sessionKey) {
      return;
    }
    logSessionStateChange({
      sessionKey,
      state: "idle",
      reason,
    });
  };

  // 重复入站直接短路，避免同一消息被重复驱动回复链。
  if (shouldSkipDuplicateInbound(ctx)) {
    recordProcessed("skipped", { reason: "duplicate" });
    return { queuedFinal: false, counts: dispatcher.getQueuedCounts() };
  }

  // 先解析当前 session 的已有状态，供后面的 ACP / TTS / send policy 使用。
  const sessionStoreEntry = resolveSessionStoreLookup(ctx, cfg);
  const acpDispatchSessionKey = sessionStoreEntry.sessionKey ?? sessionKey;
  const inboundAudio = isInboundAudioContext(ctx);
  const sessionTtsAuto = normalizeTtsAutoMode(sessionStoreEntry.entry?.ttsAuto);
  const hookRunner = getGlobalHookRunner();

  // Extract message context for hooks (plugin and internal)
  const timestamp =
    typeof ctx.Timestamp === "number" && Number.isFinite(ctx.Timestamp) ? ctx.Timestamp : undefined;
  const messageIdForHook =
    ctx.MessageSidFull ?? ctx.MessageSid ?? ctx.MessageSidFirst ?? ctx.MessageSidLast;
  const hookContext = deriveInboundMessageHookContext(ctx, { messageId: messageIdForHook });
  const { isGroup, groupId } = hookContext;

  // Trigger plugin hooks (fire-and-forget)
  if (hookRunner?.hasHooks("message_received")) {
    fireAndForgetHook(
      hookRunner.runMessageReceived(
        toPluginMessageReceivedEvent(hookContext),
        toPluginMessageContext(hookContext),
      ),
      "dispatch-from-config: message_received plugin hook failed",
    );
  }

  // Bridge to internal hooks (HOOK.md discovery system) - refs #8807
  if (sessionKey) {
    fireAndForgetHook(
      triggerInternalHook(
        createInternalHookEvent("message", "received", sessionKey, {
          ...toInternalMessageReceivedContext(hookContext),
          timestamp,
        }),
      ),
      "dispatch-from-config: message_received internal hook failed",
    );
  }

  // 这里开始决定“回复应该发回哪里”。
  //
  // 默认情况下，reply payload 会交给当前 dispatcher。
  // 但如果消息最初来自另一个 channel，并且当前 surface 只是代管/转发，
  // 那么应该把回复 route 回 originating channel，而不是留在当前 surface。
  //
  // 这是跨 provider / 共享 session 场景的关键桥接逻辑。
  const originatingChannel = normalizeMessageChannel(ctx.OriginatingChannel);
  const originatingTo = ctx.OriginatingTo;
  const providerChannel = normalizeMessageChannel(ctx.Provider);
  const surfaceChannel = normalizeMessageChannel(ctx.Surface);
  // Prefer provider channel because surface may carry origin metadata in relayed flows.
  const currentSurface = providerChannel ?? surfaceChannel;
  const isInternalWebchatTurn =
    currentSurface === INTERNAL_MESSAGE_CHANNEL &&
    (surfaceChannel === INTERNAL_MESSAGE_CHANNEL || !surfaceChannel) &&
    ctx.ExplicitDeliverRoute !== true;
  const shouldRouteToOriginating = Boolean(
    !isInternalWebchatTurn &&
    isRoutableChannel(originatingChannel) &&
    originatingTo &&
    originatingChannel !== currentSurface,
  );
  const shouldSuppressTyping =
    shouldRouteToOriginating || originatingChannel === INTERNAL_MESSAGE_CHANNEL;
  const ttsChannel = shouldRouteToOriginating ? originatingChannel : currentSurface;

  // 小辅助：当决定 route 回 originating channel 时，用它统一发送 payload。
  // 这使后面的 tool/block/final 分支都不必重复 routeReply 样板代码。
  const sendPayloadAsync = async (
    payload: ReplyPayload,
    abortSignal?: AbortSignal,
    mirror?: boolean,
  ): Promise<void> => {
    // TypeScript doesn't narrow these from the shouldRouteToOriginating check,
    // but they're guaranteed non-null when this function is called.
    if (!originatingChannel || !originatingTo) {
      return;
    }
    if (abortSignal?.aborted) {
      return;
    }
    const result = await routeReply({
      payload,
      channel: originatingChannel,
      to: originatingTo,
      sessionKey: ctx.SessionKey,
      accountId: ctx.AccountId,
      threadId: ctx.MessageThreadId,
      cfg,
      abortSignal,
      mirror,
      isGroup,
      groupId,
    });
    if (!result.ok) {
      logVerbose(`dispatch-from-config: route-reply failed: ${result.error ?? "unknown error"}`);
    }
  };

  markProcessing();

  try {
    // 某些“停止/中断”类消息不需要走完整 reply 核心链。
    // 如果 fast abort 已经处理完，就在 dispatch 层直接产出最终回复。
    const fastAbort = await tryFastAbortFromMessage({ ctx, cfg });
    if (fastAbort.handled) {
      const payload = {
        text: formatAbortReplyText(fastAbort.stoppedSubagents),
      } satisfies ReplyPayload;
      let queuedFinal = false;
      let routedFinalCount = 0;
      if (shouldRouteToOriginating && originatingChannel && originatingTo) {
        const result = await routeReply({
          payload,
          channel: originatingChannel,
          to: originatingTo,
          sessionKey: ctx.SessionKey,
          accountId: ctx.AccountId,
          threadId: ctx.MessageThreadId,
          cfg,
          isGroup,
          groupId,
        });
        queuedFinal = result.ok;
        if (result.ok) {
          routedFinalCount += 1;
        }
        if (!result.ok) {
          logVerbose(
            `dispatch-from-config: route-reply (abort) failed: ${result.error ?? "unknown error"}`,
          );
        }
      } else {
        queuedFinal = dispatcher.sendFinalReply(payload);
      }
      const counts = dispatcher.getQueuedCounts();
      counts.final += routedFinalCount;
      recordProcessed("completed", { reason: "fast_abort" });
      markIdle("message_completed");
      return { queuedFinal, counts };
    }

    // ACP（某类更快/更专用的控制路径）对控制命令可能有特殊分流规则。
    const bypassAcpForCommand = shouldBypassAcpDispatchForCommand(ctx, cfg);

    // 在真正生成回复之前，先检查当前 session 是否允许发送。
    // 如果 send policy 明确禁止，则直接在这里结束，不进入 reply 核心。
    const sendPolicy = resolveSendPolicy({
      cfg,
      entry: sessionStoreEntry.entry,
      sessionKey: sessionStoreEntry.sessionKey ?? sessionKey,
      channel:
        sessionStoreEntry.entry?.channel ??
        ctx.OriginatingChannel ??
        ctx.Surface ??
        ctx.Provider ??
        undefined,
      chatType: sessionStoreEntry.entry?.chatType,
    });
    if (sendPolicy === "deny" && !bypassAcpForCommand) {
      logVerbose(
        `Send blocked by policy for session ${sessionStoreEntry.sessionKey ?? sessionKey ?? "unknown"}`,
      );
      const counts = dispatcher.getQueuedCounts();
      recordProcessed("completed", { reason: "send_policy_deny" });
      markIdle("message_completed");
      return { queuedFinal: false, counts };
    }

    // group/native 场景往往不适合发送冗长的 tool summary 文本；
    // 但纯媒体类结果（比如 TTS 音频）仍然应该被传递出去。
    const shouldSendToolSummaries = ctx.ChatType !== "group" && ctx.CommandSource !== "native";
    // 先给 ACP 一个机会直接接管这条消息。
    // 如果 ACP 已经消费了消息，就不再进入普通 reply 核心。
    const acpDispatch = await tryDispatchAcpReply({
      ctx,
      cfg,
      dispatcher,
      sessionKey: acpDispatchSessionKey,
      inboundAudio,
      sessionTtsAuto,
      ttsChannel,
      shouldRouteToOriginating,
      originatingChannel,
      originatingTo,
      shouldSendToolSummaries,
      bypassForCommand: bypassAcpForCommand,
      onReplyStart: params.replyOptions?.onReplyStart,
      recordProcessed,
      markIdle,
    });
    if (acpDispatch) {
      return acpDispatch;
    }

    // Track accumulated block text for TTS generation after streaming completes.
    // When block streaming succeeds, there's no final reply, so we need to generate
    // TTS audio separately from the accumulated block content.
    let accumulatedBlockText = "";
    let blockCount = 0;

    // tool result 出口过滤器：
    // - 某些场景保留完整 tool summary
    // - 某些场景只保留媒体，不保留文字
    const resolveToolDeliveryPayload = (payload: ReplyPayload): ReplyPayload | null => {
      if (shouldSendToolSummaries) {
        return payload;
      }
      // Group/native flows intentionally suppress tool summary text, but media-only
      // tool results (for example TTS audio) must still be delivered.
      const hasMedia = Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
      if (!hasMedia) {
        return null;
      }
      return { ...payload, text: undefined };
    };
    // dispatch 层统一决定这次 run 的 typing 策略，再把结果塞给 reply 核心。
    const typing = resolveRunTypingPolicy({
      requestedPolicy: params.replyOptions?.typingPolicy,
      suppressTyping: params.replyOptions?.suppressTyping === true || shouldSuppressTyping,
      originatingChannel,
      systemEvent: shouldRouteToOriginating,
    });

    // 这里是普通消息路径对 `reply.js` / `getReplyFromConfig()` 的真正调用点。
    //
    // 注意这层不是直接等一个“最终文本”回来，而是把两类回调也一并交进去：
    // - `onToolResult`：reply 核心在运行过程中产生 tool result 时，如何外发
    // - `onBlockReply`：reply 核心在 block streaming 过程中产生块回复时，如何外发
    //
    // 这就是 dispatch-from-config.ts 最核心的桥接职责：
    // reply 核心负责“生成什么”，dispatch 层负责“这些内容如何送出去”。
    const replyResult = await (params.replyResolver ?? getReplyFromConfig)(
      ctx,
      {
        ...params.replyOptions,
        typingPolicy: typing.typingPolicy,
        suppressTyping: typing.suppressTyping,
        onToolResult: (payload: ReplyPayload) => {
          const run = async () => {
            // tool result 也可能需要走 TTS 包装。
            const ttsPayload = await maybeApplyTtsToPayload({
              payload,
              cfg,
              channel: ttsChannel,
              kind: "tool",
              inboundAudio,
              ttsAuto: sessionTtsAuto,
            });
            const deliveryPayload = resolveToolDeliveryPayload(ttsPayload);
            if (!deliveryPayload) {
              return;
            }
            // 根据前面 route 策略，决定是：
            // - route 回 originating channel
            // - 还是交给当前 dispatcher
            if (shouldRouteToOriginating) {
              await sendPayloadAsync(deliveryPayload, undefined, false);
            } else {
              dispatcher.sendToolResult(deliveryPayload);
            }
          };
          return run();
        },
        onBlockReply: (payload: ReplyPayload, context) => {
          const run = async () => {
            // Suppress reasoning payloads — channels using this generic dispatch
            // path (WhatsApp, web, etc.) do not have a dedicated reasoning lane.
            // Telegram has its own dispatch path that handles reasoning splitting.
            if (shouldSuppressReasoningPayload(payload)) {
              return;
            }
            // block streaming 期间顺手累计文本，供“只生成 TTS final 音频”的兜底路径使用。
            if (payload.text) {
              if (accumulatedBlockText.length > 0) {
                accumulatedBlockText += "\n";
              }
              accumulatedBlockText += payload.text;
              blockCount++;
            }
            const ttsPayload = await maybeApplyTtsToPayload({
              payload,
              cfg,
              channel: ttsChannel,
              kind: "block",
              inboundAudio,
              ttsAuto: sessionTtsAuto,
            });
            if (shouldRouteToOriginating) {
              await sendPayloadAsync(ttsPayload, context?.abortSignal, false);
            } else {
              dispatcher.sendBlockReply(ttsPayload);
            }
          };
          return run();
        },
      },
      cfg,
    );

    // 某些 reset 流程会在 ACP 原地处理后，额外留下一段“尾 prompt”。
    // 这里检测到该标志后，再补跑一次 ACP dispatch，把尾部逻辑接上。
    if (ctx.AcpDispatchTailAfterReset === true) {
      // Command handling prepared a trailing prompt after ACP in-place reset.
      // Route that tail through ACP now (same turn) instead of embedded dispatch.
      ctx.AcpDispatchTailAfterReset = false;
      const acpTailDispatch = await tryDispatchAcpReply({
        ctx,
        cfg,
        dispatcher,
        sessionKey: acpDispatchSessionKey,
        inboundAudio,
        sessionTtsAuto,
        ttsChannel,
        shouldRouteToOriginating,
        originatingChannel,
        originatingTo,
        shouldSendToolSummaries,
        bypassForCommand: false,
        onReplyStart: params.replyOptions?.onReplyStart,
        recordProcessed,
        markIdle,
      });
      if (acpTailDispatch) {
        return acpTailDispatch;
      }
    }

    // 统一把 reply 核心返回值正规化为数组，便于后面统一发送 final payload。
    const replies = replyResult ? (Array.isArray(replyResult) ? replyResult : [replyResult]) : [];

    let queuedFinal = false;
    let routedFinalCount = 0;
    for (const reply of replies) {
      // Suppress reasoning payloads from channel delivery — channels using this
      // generic dispatch path do not have a dedicated reasoning lane.
      if (shouldSuppressReasoningPayload(reply)) {
        continue;
      }
      const ttsReply = await maybeApplyTtsToPayload({
        payload: reply,
        cfg,
        channel: ttsChannel,
        kind: "final",
        inboundAudio,
        ttsAuto: sessionTtsAuto,
      });
      if (shouldRouteToOriginating && originatingChannel && originatingTo) {
        // Route final reply to originating channel.
        const result = await routeReply({
          payload: ttsReply,
          channel: originatingChannel,
          to: originatingTo,
          sessionKey: ctx.SessionKey,
          accountId: ctx.AccountId,
          threadId: ctx.MessageThreadId,
          cfg,
          isGroup,
          groupId,
        });
        if (!result.ok) {
          logVerbose(
            `dispatch-from-config: route-reply (final) failed: ${result.error ?? "unknown error"}`,
          );
        }
        queuedFinal = result.ok || queuedFinal;
        if (result.ok) {
          routedFinalCount += 1;
        }
      } else {
        // 常规路径：final reply 直接交给 dispatcher 排队/发送。
        queuedFinal = dispatcher.sendFinalReply(ttsReply) || queuedFinal;
      }
    }

    // block streaming 成功时，reply 核心可能没有留下 final text payload。
    // 但如果累计过 block 文本，并且 TTS 模式需要 final 音频，这里会合成一个 TTS-only final reply 兜底发送。
    const ttsMode = resolveTtsConfig(cfg).mode ?? "final";
    // Generate TTS-only reply after block streaming completes (when there's no final reply).
    // This handles the case where block streaming succeeds and drops final payloads,
    // but we still want TTS audio to be generated from the accumulated block content.
    if (
      ttsMode === "final" &&
      replies.length === 0 &&
      blockCount > 0 &&
      accumulatedBlockText.trim()
    ) {
      try {
        const ttsSyntheticReply = await maybeApplyTtsToPayload({
          payload: { text: accumulatedBlockText },
          cfg,
          channel: ttsChannel,
          kind: "final",
          inboundAudio,
          ttsAuto: sessionTtsAuto,
        });
        // Only send if TTS was actually applied (mediaUrl exists)
        if (ttsSyntheticReply.mediaUrl) {
          // Send TTS-only payload (no text, just audio) so it doesn't duplicate the block content
          const ttsOnlyPayload: ReplyPayload = {
            mediaUrl: ttsSyntheticReply.mediaUrl,
            audioAsVoice: ttsSyntheticReply.audioAsVoice,
          };
          if (shouldRouteToOriginating && originatingChannel && originatingTo) {
            const result = await routeReply({
              payload: ttsOnlyPayload,
              channel: originatingChannel,
              to: originatingTo,
              sessionKey: ctx.SessionKey,
              accountId: ctx.AccountId,
              threadId: ctx.MessageThreadId,
              cfg,
              isGroup,
              groupId,
            });
            queuedFinal = result.ok || queuedFinal;
            if (result.ok) {
              routedFinalCount += 1;
            }
            if (!result.ok) {
              logVerbose(
                `dispatch-from-config: route-reply (tts-only) failed: ${result.error ?? "unknown error"}`,
              );
            }
          } else {
            const didQueue = dispatcher.sendFinalReply(ttsOnlyPayload);
            queuedFinal = didQueue || queuedFinal;
          }
        }
      } catch (err) {
        logVerbose(
          `dispatch-from-config: accumulated block TTS failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // 函数最终返回的不是“回复文本”，而是 dispatch 结果摘要：
    // - 有没有成功排队 final reply
    // - 各类 payload 被 dispatcher 接收了多少
    const counts = dispatcher.getQueuedCounts();
    counts.final += routedFinalCount;
    recordProcessed("completed");
    markIdle("message_completed");
    return { queuedFinal, counts };
  } catch (err) {
    // dispatch 层负责把异常同样纳入 diagnostics / session state 收口。
    recordProcessed("error", { error: String(err) });
    markIdle("message_error");
    throw err;
  }
}
