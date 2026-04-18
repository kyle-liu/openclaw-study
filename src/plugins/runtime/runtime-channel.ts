// ============================================================================
// plugins/runtime/runtime-channel.ts
//
// 这个文件是插件运行时里 `runtime.channel` 的“实现装配文件”。
//
// 如果用 Java 工程师更熟悉的语言来类比：
// - `types-channel.ts` 像 `PluginRuntimeChannel` 接口
// - `types.ts` 里的 `PluginRuntime` 像顶层运行时接口
// - `runtime-channel.ts` 则像一个工厂 / 配置装配器，用来创建
//   `PluginRuntimeChannel` 的具体实现对象
//
// 注意：
// - 这里没有显式写 `class XxxImpl implements PluginRuntimeChannel`
// - TypeScript 更常见的写法是：直接返回一个“结构满足接口要求”的对象字面量
//
// 因此，这个文件的本质不是算法文件，而是：
// “把分散在各个模块里的 channel 能力，按契约组装成一个统一 runtime 对象”。
// ============================================================================

import { resolveEffectiveMessagesConfig, resolveHumanDelayConfig } from "../../agents/identity.js";
import { handleSlackAction } from "../../agents/tools/slack-actions.js";
import {
  chunkByNewline,
  chunkMarkdownText,
  chunkMarkdownTextWithMode,
  chunkText,
  chunkTextWithMode,
  resolveChunkMode,
  resolveTextChunkLimit,
} from "../../auto-reply/chunk.js";
import {
  hasControlCommand,
  isControlCommandMessage,
  shouldComputeCommandAuthorized,
} from "../../auto-reply/command-detection.js";
import { shouldHandleTextCommands } from "../../auto-reply/commands-registry.js";
import { withReplyDispatcher } from "../../auto-reply/dispatch.js";
import {
  formatAgentEnvelope,
  formatInboundEnvelope,
  resolveEnvelopeFormatOptions,
} from "../../auto-reply/envelope.js";
import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "../../auto-reply/inbound-debounce.js";
import { dispatchReplyFromConfig } from "../../auto-reply/reply/dispatch-from-config.js";
import { finalizeInboundContext } from "../../auto-reply/reply/inbound-context.js";
import {
  buildMentionRegexes,
  matchesMentionPatterns,
  matchesMentionWithExplicit,
} from "../../auto-reply/reply/mentions.js";
import { dispatchReplyWithBufferedBlockDispatcher } from "../../auto-reply/reply/provider-dispatcher.js";
import { createReplyDispatcherWithTyping } from "../../auto-reply/reply/reply-dispatcher.js";
import { removeAckReactionAfterReply, shouldAckReaction } from "../../channels/ack-reactions.js";
import { resolveCommandAuthorizedFromAuthorizers } from "../../channels/command-gating.js";
import { discordMessageActions } from "../../channels/plugins/actions/discord.js";
import { signalMessageActions } from "../../channels/plugins/actions/signal.js";
import { telegramMessageActions } from "../../channels/plugins/actions/telegram.js";
import { recordInboundSession } from "../../channels/session.js";
import {
  resolveChannelGroupPolicy,
  resolveChannelGroupRequireMention,
} from "../../config/group-policy.js";
import { resolveMarkdownTableMode } from "../../config/markdown-tables.js";
import {
  readSessionUpdatedAt,
  recordSessionMetaFromInbound,
  resolveStorePath,
  updateLastRoute,
} from "../../config/sessions.js";
import { auditDiscordChannelPermissions } from "../../discord/audit.js";
import {
  listDiscordDirectoryGroupsLive,
  listDiscordDirectoryPeersLive,
} from "../../discord/directory-live.js";
import { monitorDiscordProvider } from "../../discord/monitor.js";
import { probeDiscord } from "../../discord/probe.js";
import { resolveDiscordChannelAllowlist } from "../../discord/resolve-channels.js";
import { resolveDiscordUserAllowlist } from "../../discord/resolve-users.js";
import { sendMessageDiscord, sendPollDiscord } from "../../discord/send.js";
import { monitorIMessageProvider } from "../../imessage/monitor.js";
import { probeIMessage } from "../../imessage/probe.js";
import { sendMessageIMessage } from "../../imessage/send.js";
import { getChannelActivity, recordChannelActivity } from "../../infra/channel-activity.js";
import {
  listLineAccountIds,
  normalizeAccountId as normalizeLineAccountId,
  resolveDefaultLineAccountId,
  resolveLineAccount,
} from "../../line/accounts.js";
import { monitorLineProvider } from "../../line/monitor.js";
import { probeLineBot } from "../../line/probe.js";
import {
  createQuickReplyItems,
  pushFlexMessage,
  pushLocationMessage,
  pushMessageLine,
  pushMessagesLine,
  pushTemplateMessage,
  pushTextMessageWithQuickReplies,
  sendMessageLine,
} from "../../line/send.js";
import { buildTemplateMessageFromPayload } from "../../line/template-messages.js";
import { convertMarkdownTables } from "../../markdown/tables.js";
import { fetchRemoteMedia } from "../../media/fetch.js";
import { saveMediaBuffer } from "../../media/store.js";
import { buildPairingReply } from "../../pairing/pairing-messages.js";
import {
  readChannelAllowFromStore,
  upsertChannelPairingRequest,
} from "../../pairing/pairing-store.js";
import { buildAgentSessionKey, resolveAgentRoute } from "../../routing/resolve-route.js";
import { monitorSignalProvider } from "../../signal/index.js";
import { probeSignal } from "../../signal/probe.js";
import { sendMessageSignal } from "../../signal/send.js";
import {
  listSlackDirectoryGroupsLive,
  listSlackDirectoryPeersLive,
} from "../../slack/directory-live.js";
import { monitorSlackProvider } from "../../slack/index.js";
import { probeSlack } from "../../slack/probe.js";
import { resolveSlackChannelAllowlist } from "../../slack/resolve-channels.js";
import { resolveSlackUserAllowlist } from "../../slack/resolve-users.js";
import { sendMessageSlack } from "../../slack/send.js";
import {
  auditTelegramGroupMembership,
  collectTelegramUnmentionedGroupIds,
} from "../../telegram/audit.js";
import { monitorTelegramProvider } from "../../telegram/monitor.js";
import { probeTelegram } from "../../telegram/probe.js";
import { sendMessageTelegram, sendPollTelegram } from "../../telegram/send.js";
import { resolveTelegramToken } from "../../telegram/token.js";
import { createRuntimeWhatsApp } from "./runtime-whatsapp.js";
import type { PluginRuntime } from "./types.js";

// 这是整个文件的核心工厂函数。
//
// 语法解读（Java 对照版）：
// - `createRuntimeChannel()`：像一个工厂方法
// - `: PluginRuntime["channel"]`：表示返回值类型等于 `PluginRuntime` 接口中
//   `channel` 这个字段的类型
//
// 你可以把它直接脑补成 Java 里的：
//
//   PluginRuntimeChannel createRuntimeChannel()
//
// 只是作者没有直接写 `PluginRuntimeChannel`，而是从总接口 `PluginRuntime`
// 中取出 `channel` 这部分的类型，保持“从总 runtime 切片”这一层语义。
export function createRuntimeChannel(): PluginRuntime["channel"] {
  // 这里直接返回一个大对象字面量。
  // 在 TypeScript 里，只要这个对象的结构满足 `PluginRuntime["channel"]`
  // 的约束，就等价于 Java 里“返回一个实现了接口的实例”。
  return {
    // 文本处理能力面：
    // 提供切块、Markdown 文本处理、命令检测等基础工具。
    text: {
      chunkByNewline,
      chunkMarkdownText,
      chunkMarkdownTextWithMode,
      chunkText,
      chunkTextWithMode,
      resolveChunkMode,
      resolveTextChunkLimit,
      hasControlCommand,
      resolveMarkdownTableMode,
      convertMarkdownTables,
    },
    // 自动回复能力面：
    // 这里挂的是与 reply pipeline 直接相关的一组入口和辅助函数。
    //
    // Java 类比：
    // 可以把它看成一个 `ReplyApi` 子接口的实现对象。
    reply: {
      dispatchReplyWithBufferedBlockDispatcher,
      createReplyDispatcherWithTyping,
      resolveEffectiveMessagesConfig,
      resolveHumanDelayConfig,
      dispatchReplyFromConfig,
      withReplyDispatcher,
      finalizeInboundContext,
      formatAgentEnvelope,
      /** @deprecated Prefer `BodyForAgent` + structured user-context blocks (do not build plaintext envelopes for prompts). */
      formatInboundEnvelope,
      resolveEnvelopeFormatOptions,
    },
    // 路由能力面：
    // 负责构建 session key、解析 agent route。
    routing: {
      buildAgentSessionKey,
      resolveAgentRoute,
    },
    // pairing 能力面：
    // 这里有一个很好的“类型契约 -> 运行时适配”例子。
    //
    // 在 `types-channel.ts` 里，这两个函数的签名被包装成了
    // `ReadChannelAllowFromStoreForAccount` 和
    // `UpsertChannelPairingRequestForAccount`。
    //
    // 而这里则把底层原函数适配成那种更适合 runtime 暴露的参数形式。
    pairing: {
      buildPairingReply,
      readAllowFromStore: ({ channel, accountId, env }) =>
        readChannelAllowFromStore(channel, env, accountId),
      upsertPairingRequest: ({ channel, id, accountId, meta, env, pairingAdapter }) =>
        upsertChannelPairingRequest({
          channel,
          id,
          accountId,
          meta,
          env,
          pairingAdapter,
        }),
    },
    // 媒体处理能力面。
    media: {
      fetchRemoteMedia,
      saveMediaBuffer,
    },
    // 通道活跃度读写能力面。
    activity: {
      record: recordChannelActivity,
      get: getChannelActivity,
    },
    // session 相关能力面：
    // 供插件读取/更新 session store 中的部分会话元数据。
    session: {
      resolveStorePath,
      readSessionUpdatedAt,
      recordSessionMetaFromInbound,
      recordInboundSession,
      updateLastRoute,
    },
    // mention 识别能力面。
    mentions: {
      buildMentionRegexes,
      matchesMentionPatterns,
      matchesMentionWithExplicit,
    },
    // ack reaction 相关能力面。
    reactions: {
      shouldAckReaction,
      removeAckReactionAfterReply,
    },
    // 群聊策略相关能力面。
    groups: {
      resolveGroupPolicy: resolveChannelGroupPolicy,
      resolveRequireMention: resolveChannelGroupRequireMention,
    },
    // 入站防抖相关能力面。
    debounce: {
      createInboundDebouncer,
      resolveInboundDebounceMs,
    },
    // 命令判定 / 命令授权相关能力面。
    commands: {
      resolveCommandAuthorizedFromAuthorizers,
      isControlCommandMessage,
      shouldComputeCommandAuthorized,
      shouldHandleTextCommands,
    },
    // Discord 平台专属能力面。
    discord: {
      messageActions: discordMessageActions,
      auditChannelPermissions: auditDiscordChannelPermissions,
      listDirectoryGroupsLive: listDiscordDirectoryGroupsLive,
      listDirectoryPeersLive: listDiscordDirectoryPeersLive,
      probeDiscord,
      resolveChannelAllowlist: resolveDiscordChannelAllowlist,
      resolveUserAllowlist: resolveDiscordUserAllowlist,
      sendMessageDiscord,
      sendPollDiscord,
      monitorDiscordProvider,
    },
    // Slack 平台专属能力面。
    slack: {
      listDirectoryGroupsLive: listSlackDirectoryGroupsLive,
      listDirectoryPeersLive: listSlackDirectoryPeersLive,
      probeSlack,
      resolveChannelAllowlist: resolveSlackChannelAllowlist,
      resolveUserAllowlist: resolveSlackUserAllowlist,
      sendMessageSlack,
      monitorSlackProvider,
      handleSlackAction,
    },
    // Telegram 平台专属能力面。
    telegram: {
      auditGroupMembership: auditTelegramGroupMembership,
      collectUnmentionedGroupIds: collectTelegramUnmentionedGroupIds,
      probeTelegram,
      resolveTelegramToken,
      sendMessageTelegram,
      sendPollTelegram,
      monitorTelegramProvider,
      messageActions: telegramMessageActions,
    },
    // Signal 平台专属能力面。
    signal: {
      probeSignal,
      sendMessageSignal,
      monitorSignalProvider,
      messageActions: signalMessageActions,
    },
    // iMessage 平台专属能力面。
    imessage: {
      monitorIMessageProvider,
      probeIMessage,
      sendMessageIMessage,
    },
    // WhatsApp 这里进一步拆到了单独工厂 `createRuntimeWhatsApp()`。
    // 这样做可以避免当前文件继续膨胀，也说明：
    // runtime channel 本身也可以递归拆分成更小的装配模块。
    whatsapp: createRuntimeWhatsApp(),
    // LINE 平台专属能力面。
    line: {
      listLineAccountIds,
      resolveDefaultLineAccountId,
      resolveLineAccount,
      normalizeAccountId: normalizeLineAccountId,
      probeLineBot,
      sendMessageLine,
      pushMessageLine,
      pushMessagesLine,
      pushFlexMessage,
      pushTemplateMessage,
      pushLocationMessage,
      pushTextMessageWithQuickReplies,
      createQuickReplyItems,
      buildTemplateMessageFromPayload,
      monitorLineProvider,
    },
  };
}
