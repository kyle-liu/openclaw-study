// ============================================================================
// plugins/runtime/types-channel.ts
//
// 这个文件是插件运行时里 `runtime.channel` 这部分能力面的“类型契约文件”。
//
// 它的职责不是提供运行时代码，而是回答下面这些问题：
// 1. 插件在 `runtime.channel` 上能访问到哪些能力？
// 2. 这些能力按什么分组组织？
// 3. 每个能力的函数签名应该长什么样？
//
// 因此：
// - 这里几乎只有 `type` 和 `export type`
// - 真正的实现代码在 `runtime-channel.ts`
// - 这个文件更像“API 清单 + 类型地图”
//
// 阅读时可以把它理解成：
// “插件运行时 channel 子系统对外公开了哪些稳定接口”。
// ============================================================================

// 先复用 pairing-store 里真实函数的类型签名。
// 这里没有直接 import 运行时值，而是只拿类型来约束插件 runtime 暴露的 API。
//
// Java 对照理解：
// 语义上接近“引用某个现有方法的签名作为接口方法签名来源”，
// 只是 TypeScript 可以直接从真实函数定义里自动提取类型。
type ReadChannelAllowFromStore =
  typeof import("../../pairing/pairing-store.js").readChannelAllowFromStore;
type UpsertChannelPairingRequest =
  typeof import("../../pairing/pairing-store.js").upsertChannelPairingRequest;

// 这是一个“轻包装后的函数类型”：
// - 原始 `readChannelAllowFromStore` 的第一个参数就是 channel
// - 这里显式要求 `accountId` 必须作为独立字段传入
// - 返回值仍然保持和原函数一致
//
// 语法点：
// - `Parameters<F>[0]`：取函数 F 的第 1 个参数类型
// - `ReturnType<F>`：取函数 F 的返回值类型
type ReadChannelAllowFromStoreForAccount = (params: {
  channel: Parameters<ReadChannelAllowFromStore>[0];
  accountId: string;
  env?: Parameters<ReadChannelAllowFromStore>[1];
}) => ReturnType<ReadChannelAllowFromStore>;

// 这是另一个包装函数类型：
// - 先从原函数第一个参数对象里去掉 `accountId`
// - 再强制补回一个必填的 `accountId: string`
//
// 语法点：
// - `Omit<T, "k">`：从对象类型 T 里删除字段 `k`
type UpsertChannelPairingRequestForAccount = (
  params: Omit<Parameters<UpsertChannelPairingRequest>[0], "accountId"> & { accountId: string },
) => ReturnType<UpsertChannelPairingRequest>;

// `PluginRuntimeChannel` 是整个文件的核心：
// 它定义了插件运行时里 `runtime.channel` 对象的完整结构。
//
// 设计上按“能力域”分组，而不是把所有函数平铺在一个大对象上。
// 这样插件作者在使用时更容易发现和理解 API。
//
// Java 对照理解：
// 你可以把它脑补成一个总接口：
//
//   interface PluginRuntimeChannel {
//       TextApi text();
//       ReplyApi reply();
//       RoutingApi routing();
//       ...
//   }
//
// 下面每个 `text: { ... }`、`reply: { ... }`，都像在内联定义这些子接口。
export type PluginRuntimeChannel = {
  // 文本切块、命令检测、Markdown 表格转换等基础文本能力。
  /**
   * PluginRuntimeChannel 里有一个 text 子对象；这个子对象上有若干个函数字段，而每个字段的类型都直接复用某个现有模块里真实函数的类型签名。
   *
   * Java 对照理解：
   * 这一段可以脑补成：
   *
   *   interface TextApi {
   *       Xxx chunkByNewline(...);
   *       Xxx chunkMarkdownText(...);
   *       ...
   *   }
   *
   * 然后 `PluginRuntimeChannel` 上有一个方法/属性把这组能力暴露出来。
   */
  text: {
    // `chunkByNewline: typeof import("...").chunkByNewline`
    // 的意思不是“现在执行 import”，而是：
    // “字段 `chunkByNewline` 的类型，和那个模块里真实导出的
    //  `chunkByNewline` 函数签名完全一致”。
    //
    // Java 对照理解：
    // 相当于接口里有个方法 `chunkByNewline(...)`，
    // 只是这里不手写参数和返回值，而是直接复用已有实现函数的签名。
    chunkByNewline: typeof import("../../auto-reply/chunk.js").chunkByNewline;
    chunkMarkdownText: typeof import("../../auto-reply/chunk.js").chunkMarkdownText;
    chunkMarkdownTextWithMode: typeof import("../../auto-reply/chunk.js").chunkMarkdownTextWithMode;
    chunkText: typeof import("../../auto-reply/chunk.js").chunkText;
    chunkTextWithMode: typeof import("../../auto-reply/chunk.js").chunkTextWithMode;
    resolveChunkMode: typeof import("../../auto-reply/chunk.js").resolveChunkMode;
    resolveTextChunkLimit: typeof import("../../auto-reply/chunk.js").resolveTextChunkLimit;
    hasControlCommand: typeof import("../../auto-reply/command-detection.js").hasControlCommand;
    resolveMarkdownTableMode: typeof import("../../config/markdown-tables.js").resolveMarkdownTableMode;
    convertMarkdownTables: typeof import("../../markdown/tables.js").convertMarkdownTables;
  };
  // 自动回复与消息分发相关能力。
  // 这一组通常是“把一条消息交给 reply pipeline 去处理”的入口能力。
  reply: {
    dispatchReplyWithBufferedBlockDispatcher: typeof import("../../auto-reply/reply/provider-dispatcher.js").dispatchReplyWithBufferedBlockDispatcher;
    createReplyDispatcherWithTyping: typeof import("../../auto-reply/reply/reply-dispatcher.js").createReplyDispatcherWithTyping;
    resolveEffectiveMessagesConfig: typeof import("../../agents/identity.js").resolveEffectiveMessagesConfig;
    resolveHumanDelayConfig: typeof import("../../agents/identity.js").resolveHumanDelayConfig;
    dispatchReplyFromConfig: typeof import("../../auto-reply/reply/dispatch-from-config.js").dispatchReplyFromConfig;
    withReplyDispatcher: typeof import("../../auto-reply/dispatch.js").withReplyDispatcher;
    finalizeInboundContext: typeof import("../../auto-reply/reply/inbound-context.js").finalizeInboundContext;
    formatAgentEnvelope: typeof import("../../auto-reply/envelope.js").formatAgentEnvelope;
    /** @deprecated Prefer `BodyForAgent` + structured user-context blocks (do not build plaintext envelopes for prompts). */
    formatInboundEnvelope: typeof import("../../auto-reply/envelope.js").formatInboundEnvelope;
    resolveEnvelopeFormatOptions: typeof import("../../auto-reply/envelope.js").resolveEnvelopeFormatOptions;
  };
  // 会话 key 构造与 agent route 解析能力。
  routing: {
    buildAgentSessionKey: typeof import("../../routing/resolve-route.js").buildAgentSessionKey;
    resolveAgentRoute: typeof import("../../routing/resolve-route.js").resolveAgentRoute;
  };
  // pairing / allow-from 相关能力，常用于账号绑定或配对流程。
  pairing: {
    buildPairingReply: typeof import("../../pairing/pairing-messages.js").buildPairingReply;
    readAllowFromStore: ReadChannelAllowFromStoreForAccount;
    upsertPairingRequest: UpsertChannelPairingRequestForAccount;
  };
  // 媒体下载与保存。
  media: {
    fetchRemoteMedia: typeof import("../../media/fetch.js").fetchRemoteMedia;
    saveMediaBuffer: typeof import("../../media/store.js").saveMediaBuffer;
  };
  // 通道活跃度记录与读取。
  activity: {
    record: typeof import("../../infra/channel-activity.js").recordChannelActivity;
    get: typeof import("../../infra/channel-activity.js").getChannelActivity;
  };
  // session store 相关能力，供插件读写会话元数据。
  session: {
    resolveStorePath: typeof import("../../config/sessions.js").resolveStorePath;
    readSessionUpdatedAt: typeof import("../../config/sessions.js").readSessionUpdatedAt;
    recordSessionMetaFromInbound: typeof import("../../config/sessions.js").recordSessionMetaFromInbound;
    recordInboundSession: typeof import("../../channels/session.js").recordInboundSession;
    updateLastRoute: typeof import("../../config/sessions.js").updateLastRoute;
  };
  // 群聊提及判断能力。
  mentions: {
    buildMentionRegexes: typeof import("../../auto-reply/reply/mentions.js").buildMentionRegexes;
    matchesMentionPatterns: typeof import("../../auto-reply/reply/mentions.js").matchesMentionPatterns;
    matchesMentionWithExplicit: typeof import("../../auto-reply/reply/mentions.js").matchesMentionWithExplicit;
  };
  // 回复前后的 ack reaction 能力。
  reactions: {
    shouldAckReaction: typeof import("../../channels/ack-reactions.js").shouldAckReaction;
    removeAckReactionAfterReply: typeof import("../../channels/ack-reactions.js").removeAckReactionAfterReply;
  };
  // 群聊策略相关能力，例如群策略与是否要求 mention。
  groups: {
    resolveGroupPolicy: typeof import("../../config/group-policy.js").resolveChannelGroupPolicy;
    resolveRequireMention: typeof import("../../config/group-policy.js").resolveChannelGroupRequireMention;
  };
  // 入站防抖相关能力。
  debounce: {
    createInboundDebouncer: typeof import("../../auto-reply/inbound-debounce.js").createInboundDebouncer;
    resolveInboundDebounceMs: typeof import("../../auto-reply/inbound-debounce.js").resolveInboundDebounceMs;
  };
  // 命令授权、命令判定相关能力。
  commands: {
    resolveCommandAuthorizedFromAuthorizers: typeof import("../../channels/command-gating.js").resolveCommandAuthorizedFromAuthorizers;
    isControlCommandMessage: typeof import("../../auto-reply/command-detection.js").isControlCommandMessage;
    shouldComputeCommandAuthorized: typeof import("../../auto-reply/command-detection.js").shouldComputeCommandAuthorized;
    shouldHandleTextCommands: typeof import("../../auto-reply/commands-registry.js").shouldHandleTextCommands;
  };
  // Discord 专属能力面。
  discord: {
    messageActions: typeof import("../../channels/plugins/actions/discord.js").discordMessageActions;
    auditChannelPermissions: typeof import("../../discord/audit.js").auditDiscordChannelPermissions;
    listDirectoryGroupsLive: typeof import("../../discord/directory-live.js").listDiscordDirectoryGroupsLive;
    listDirectoryPeersLive: typeof import("../../discord/directory-live.js").listDiscordDirectoryPeersLive;
    probeDiscord: typeof import("../../discord/probe.js").probeDiscord;
    resolveChannelAllowlist: typeof import("../../discord/resolve-channels.js").resolveDiscordChannelAllowlist;
    resolveUserAllowlist: typeof import("../../discord/resolve-users.js").resolveDiscordUserAllowlist;
    sendMessageDiscord: typeof import("../../discord/send.js").sendMessageDiscord;
    sendPollDiscord: typeof import("../../discord/send.js").sendPollDiscord;
    monitorDiscordProvider: typeof import("../../discord/monitor.js").monitorDiscordProvider;
  };
  // Slack 专属能力面。
  slack: {
    listDirectoryGroupsLive: typeof import("../../slack/directory-live.js").listSlackDirectoryGroupsLive;
    listDirectoryPeersLive: typeof import("../../slack/directory-live.js").listSlackDirectoryPeersLive;
    probeSlack: typeof import("../../slack/probe.js").probeSlack;
    resolveChannelAllowlist: typeof import("../../slack/resolve-channels.js").resolveSlackChannelAllowlist;
    resolveUserAllowlist: typeof import("../../slack/resolve-users.js").resolveSlackUserAllowlist;
    sendMessageSlack: typeof import("../../slack/send.js").sendMessageSlack;
    monitorSlackProvider: typeof import("../../slack/index.js").monitorSlackProvider;
    handleSlackAction: typeof import("../../agents/tools/slack-actions.js").handleSlackAction;
  };
  // Telegram 专属能力面。
  telegram: {
    auditGroupMembership: typeof import("../../telegram/audit.js").auditTelegramGroupMembership;
    collectUnmentionedGroupIds: typeof import("../../telegram/audit.js").collectTelegramUnmentionedGroupIds;
    probeTelegram: typeof import("../../telegram/probe.js").probeTelegram;
    resolveTelegramToken: typeof import("../../telegram/token.js").resolveTelegramToken;
    sendMessageTelegram: typeof import("../../telegram/send.js").sendMessageTelegram;
    sendPollTelegram: typeof import("../../telegram/send.js").sendPollTelegram;
    monitorTelegramProvider: typeof import("../../telegram/monitor.js").monitorTelegramProvider;
    messageActions: typeof import("../../channels/plugins/actions/telegram.js").telegramMessageActions;
  };
  // Signal 专属能力面。
  signal: {
    probeSignal: typeof import("../../signal/probe.js").probeSignal;
    sendMessageSignal: typeof import("../../signal/send.js").sendMessageSignal;
    monitorSignalProvider: typeof import("../../signal/index.js").monitorSignalProvider;
    messageActions: typeof import("../../channels/plugins/actions/signal.js").signalMessageActions;
  };
  // iMessage 专属能力面。
  imessage: {
    monitorIMessageProvider: typeof import("../../imessage/monitor.js").monitorIMessageProvider;
    probeIMessage: typeof import("../../imessage/probe.js").probeIMessage;
    sendMessageIMessage: typeof import("../../imessage/send.js").sendMessageIMessage;
  };
  // WhatsApp / Web 通道专属能力面。
  whatsapp: {
    getActiveWebListener: typeof import("../../web/active-listener.js").getActiveWebListener;
    getWebAuthAgeMs: typeof import("../../web/auth-store.js").getWebAuthAgeMs;
    logoutWeb: typeof import("../../web/auth-store.js").logoutWeb;
    logWebSelfId: typeof import("../../web/auth-store.js").logWebSelfId;
    readWebSelfId: typeof import("../../web/auth-store.js").readWebSelfId;
    webAuthExists: typeof import("../../web/auth-store.js").webAuthExists;
    sendMessageWhatsApp: typeof import("../../web/outbound.js").sendMessageWhatsApp;
    sendPollWhatsApp: typeof import("../../web/outbound.js").sendPollWhatsApp;
    loginWeb: typeof import("../../web/login.js").loginWeb;
    startWebLoginWithQr: typeof import("../../web/login-qr.js").startWebLoginWithQr;
    waitForWebLogin: typeof import("../../web/login-qr.js").waitForWebLogin;
    monitorWebChannel: typeof import("../../channels/web/index.js").monitorWebChannel;
    handleWhatsAppAction: typeof import("../../agents/tools/whatsapp-actions.js").handleWhatsAppAction;
    createLoginTool: typeof import("../../channels/plugins/agent-tools/whatsapp-login.js").createWhatsAppLoginTool;
  };
  // LINE 专属能力面。
  line: {
    listLineAccountIds: typeof import("../../line/accounts.js").listLineAccountIds;
    resolveDefaultLineAccountId: typeof import("../../line/accounts.js").resolveDefaultLineAccountId;
    resolveLineAccount: typeof import("../../line/accounts.js").resolveLineAccount;
    normalizeAccountId: typeof import("../../line/accounts.js").normalizeAccountId;
    probeLineBot: typeof import("../../line/probe.js").probeLineBot;
    sendMessageLine: typeof import("../../line/send.js").sendMessageLine;
    pushMessageLine: typeof import("../../line/send.js").pushMessageLine;
    pushMessagesLine: typeof import("../../line/send.js").pushMessagesLine;
    pushFlexMessage: typeof import("../../line/send.js").pushFlexMessage;
    pushTemplateMessage: typeof import("../../line/send.js").pushTemplateMessage;
    pushLocationMessage: typeof import("../../line/send.js").pushLocationMessage;
    pushTextMessageWithQuickReplies: typeof import("../../line/send.js").pushTextMessageWithQuickReplies;
    createQuickReplyItems: typeof import("../../line/send.js").createQuickReplyItems;
    buildTemplateMessageFromPayload: typeof import("../../line/template-messages.js").buildTemplateMessageFromPayload;
    monitorLineProvider: typeof import("../../line/monitor.js").monitorLineProvider;
  };
};
