// ============================================================================
// auto-reply/reply/agent-runner-memory.ts
//
// 这个文件是 pre-compaction memory flush 的“运行时执行器”。
//
// 相关职责划分：
// - `memory-flush.ts`：定义默认 prompt、解析 flush 配置、提供纯判定函数
// - `agent-runner-memory.ts`：在一次真实 run 中收集上下文信号，判断是否该 flush，
//   若需要则真正启动一个 embedded agent run 去执行 memory 写入
//
// 也就是说：
// - `memory-flush.ts` 更像策略层
// - `agent-runner-memory.ts` 更像编排层 / orchestration layer
//
// 当前文件主要做四件事：
// 1. 估算本次 flush prompt 会额外消耗多少 token
// 2. 必要时从 transcript 日志尾部补读最新 usage / byteSize
// 3. 判断这次 reply 前是否应该触发 memory flush
// 4. 真正启动 embedded agent，并把 flush 元数据写回 session store
// ============================================================================

import crypto from "node:crypto"; // 为一次 flush run 生成唯一 runId
import fs from "node:fs"; // 直接读取 transcript 文件大小与尾部内容
import type { AgentMessage } from "@mariozechner/pi-agent-core"; // 供 token 估算器构造消息对象
import { resolveBootstrapWarningSignaturesSeen } from "../../agents/bootstrap-budget.js"; // 继承和更新 bootstrap prompt 截断告警状态
import { estimateMessagesTokens } from "../../agents/compaction.js"; // 估算消息列表 token 数
import { runWithModelFallback } from "../../agents/model-fallback.js"; // flush run 也支持 provider/model fallback
import { isCliProvider } from "../../agents/model-selection.js"; // CLI provider 场景下不做 memory flush
import { runEmbeddedPiAgent } from "../../agents/pi-embedded.js"; // 真正执行内部 memory flush agent turn
import { resolveSandboxConfigForAgent, resolveSandboxRuntimeStatus } from "../../agents/sandbox.js"; // 检查当前 session 是否允许写 workspace
import {
  derivePromptTokens,
  hasNonzeroUsage,
  normalizeUsage,
  type UsageLike,
} from "../../agents/usage.js"; // 从 transcript usage 结构里提取 prompt/output token 信息
import type { OpenClawConfig } from "../../config/config.js"; // 全局配置类型
import {
  resolveAgentIdFromSessionKey,
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  type SessionEntry,
  updateSessionStoreEntry,
} from "../../config/sessions.js"; // transcript 路径解析与 session store 写回
import { logVerbose } from "../../globals.js"; // verbose 级调试日志
import { registerAgentRunContext } from "../../infra/agent-events.js"; // 让内部 flush run 也带上 session 关联信息
import type { TemplateContext } from "../templating.js"; // 模板上下文，embedded agent run 会复用
import type { VerboseLevel } from "../thinking.js"; // 日志级别
import type { GetReplyOptions } from "../types.js"; // reply 相关可选项
import {
  buildEmbeddedRunBaseParams,
  buildEmbeddedRunContexts,
  resolveModelFallbackOptions,
} from "./agent-runner-utils.js"; // 组装 embedded run 所需公共参数
import {
  hasAlreadyFlushedForCurrentCompaction,
  resolveMemoryFlushContextWindowTokens,
  resolveMemoryFlushPromptForRun,
  resolveMemoryFlushSettings,
  shouldRunMemoryFlush,
} from "./memory-flush.js"; // flush 配置与纯判定逻辑
import type { FollowupRun } from "./queue.js"; // 当前待执行的 followup run 描述
import { incrementCompactionCount } from "./session-updates.js"; // flush run 过程中若触发了 compaction，要同步递增计数

// 估算本次 memory-flush prompt 本身的 token 开销。
// 这不是为了真正发消息，而是为了在“要不要触发 flush”之前先预测：
// 如果我现在再加上一条 flush prompt，会不会让上下文接近阈值？
export function estimatePromptTokensForMemoryFlush(prompt?: string): number | undefined {
  const trimmed = prompt?.trim();
  if (!trimmed) {
    return undefined;
  }
  const message: AgentMessage = { role: "user", content: trimmed, timestamp: Date.now() };
  const tokens = estimateMessagesTokens([message]);
  if (!Number.isFinite(tokens) || tokens <= 0) {
    return undefined;
  }
  return Math.ceil(tokens);
}

// 计算“下一次输入上下文”的预计 token 总量。
// 直觉上，它近似等于：
// - 目前累计 prompt token
// - + 上一次 assistant 输出 token
// - + 这次 memory flush prompt 预计 token
export function resolveEffectivePromptTokens(
  basePromptTokens?: number,
  lastOutputTokens?: number,
  promptTokenEstimate?: number,
): number {
  const base = Math.max(0, basePromptTokens ?? 0);
  const output = Math.max(0, lastOutputTokens ?? 0);
  const estimate = Math.max(0, promptTokenEstimate ?? 0);
  // Flush gating projects the next input context by adding the previous
  // completion and the current user prompt estimate.
  return base + output + estimate;
}

export type SessionTranscriptUsageSnapshot = {
  promptTokens?: number; // transcript 中最近一次可用 usage 里的 prompt token
  outputTokens?: number; // transcript 中最近一次可用 usage 里的 output token
};

// Keep a generous near-threshold window so large assistant outputs still trigger
// transcript reads in time to flip memory-flush gating when needed.
const TRANSCRIPT_OUTPUT_READ_BUFFER_TOKENS = 8192;
const TRANSCRIPT_TAIL_CHUNK_BYTES = 64 * 1024;

// 解析 transcript 某一行里的 usage 结构。
// transcript 中有些行会带模型 usage 数据；这里只关心“非零 usage”的行。
function parseUsageFromTranscriptLine(line: string): ReturnType<typeof normalizeUsage> | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as {
      message?: { usage?: UsageLike };
      usage?: UsageLike;
    };
    const usageRaw = parsed.message?.usage ?? parsed.usage;
    const usage = normalizeUsage(usageRaw);
    if (usage && hasNonzeroUsage(usage)) {
      return usage;
    }
  } catch {
    // ignore bad lines
  }
  return undefined;
}

// 根据 sessionId / sessionEntry / sessionKey 解析出 transcript 日志的真实路径。
// 这里会兼容：
// - sessionEntry.sessionFile
// - 某些兼容字段（如 transcriptPath）
// - 自定义 storePath / 多 agent 路径布局
function resolveSessionLogPath(
  sessionId?: string,
  sessionEntry?: SessionEntry,
  sessionKey?: string,
  opts?: { storePath?: string },
): string | undefined {
  if (!sessionId) {
    return undefined;
  }

  try {
    const transcriptPath = (
      sessionEntry as (SessionEntry & { transcriptPath?: string }) | undefined
    )?.transcriptPath?.trim();
    const sessionFile = sessionEntry?.sessionFile?.trim() || transcriptPath;
    const agentId = resolveAgentIdFromSessionKey(sessionKey);
    const pathOpts = resolveSessionFilePathOptions({
      agentId,
      storePath: opts?.storePath,
    });
    // Normalize sessionFile through resolveSessionFilePath so relative entries
    // are resolved against the sessions dir/store layout, not process.cwd().
    return resolveSessionFilePath(
      sessionId,
      sessionFile ? { sessionFile } : sessionEntry,
      pathOpts,
    );
  } catch {
    return undefined;
  }
}

// 把完整 usage 结构裁剪成当前文件真正关心的最小快照：
// - promptTokens
// - outputTokens
function deriveTranscriptUsageSnapshot(
  usage: ReturnType<typeof normalizeUsage> | undefined,
): SessionTranscriptUsageSnapshot | undefined {
  if (!usage) {
    return undefined;
  }
  const promptTokens = derivePromptTokens(usage);
  const outputRaw = usage.output;
  const outputTokens =
    typeof outputRaw === "number" && Number.isFinite(outputRaw) && outputRaw > 0
      ? outputRaw
      : undefined;
  if (!(typeof promptTokens === "number") && !(typeof outputTokens === "number")) {
    return undefined;
  }
  return {
    promptTokens,
    outputTokens,
  };
}

type SessionLogSnapshot = {
  byteSize?: number; // transcript 文件总字节数
  usage?: SessionTranscriptUsageSnapshot; // transcript 尾部最近一次非零 usage 快照
};

// 统一读取 transcript 的快照信息。
// 调用方可以选择：
// - 只看 byte size
// - 只看 usage
// - 两者都看
async function readSessionLogSnapshot(params: {
  sessionId?: string;
  sessionEntry?: SessionEntry;
  sessionKey?: string;
  opts?: { storePath?: string };
  includeByteSize: boolean;
  includeUsage: boolean;
}): Promise<SessionLogSnapshot> {
  const logPath = resolveSessionLogPath(
    params.sessionId,
    params.sessionEntry,
    params.sessionKey,
    params.opts,
  );
  if (!logPath) {
    return {};
  }

  const snapshot: SessionLogSnapshot = {};

  if (params.includeByteSize) {
    try {
      const stat = await fs.promises.stat(logPath);
      const size = Math.floor(stat.size);
      snapshot.byteSize = Number.isFinite(size) && size >= 0 ? size : undefined; // 保守确保为合法非负整数
    } catch {
      snapshot.byteSize = undefined;
    }
  }

  if (params.includeUsage) {
    try {
      const lastUsage = await readLastNonzeroUsageFromSessionLog(logPath);
      snapshot.usage = deriveTranscriptUsageSnapshot(lastUsage);
    } catch {
      snapshot.usage = undefined;
    }
  }

  return snapshot;
}

// 从 transcript 文件尾部倒着找“最后一个带非零 usage 的 JSONL 行”。
// 这样做比整文件正向扫描更高效，尤其适合大 transcript。
async function readLastNonzeroUsageFromSessionLog(logPath: string) {
  const handle = await fs.promises.open(logPath, "r");
  try {
    const stat = await handle.stat();
    let position = stat.size; // 从文件尾部向前扫描
    let leadingPartial = ""; // 当前块最前面可能被截断的一半行
    while (position > 0) {
      const chunkSize = Math.min(TRANSCRIPT_TAIL_CHUNK_BYTES, position);
      const start = position - chunkSize;
      const buffer = Buffer.allocUnsafe(chunkSize);
      const { bytesRead } = await handle.read(buffer, 0, chunkSize, start);
      if (bytesRead <= 0) {
        break;
      }
      const chunk = buffer.toString("utf-8", 0, bytesRead);
      const combined = `${chunk}${leadingPartial}`;
      const lines = combined.split(/\n+/);
      leadingPartial = lines.shift() ?? ""; // 第一段可能是被截断的半行，留到下一轮拼接
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const usage = parseUsageFromTranscriptLine(lines[i] ?? "");
        if (usage) {
          return usage;
        }
      }
      position = start;
    }
    return parseUsageFromTranscriptLine(leadingPartial);
  } finally {
    await handle.close();
  }
}

// 一个轻量辅助函数：只读取 transcript 中的 usage 快照，不关心字节大小。
export async function readPromptTokensFromSessionLog(
  sessionId?: string,
  sessionEntry?: SessionEntry,
  sessionKey?: string,
  opts?: { storePath?: string },
): Promise<SessionTranscriptUsageSnapshot | undefined> {
  const snapshot = await readSessionLogSnapshot({
    sessionId,
    sessionEntry,
    sessionKey,
    opts,
    includeByteSize: false,
    includeUsage: true,
  });
  return snapshot.usage;
}

// 当前文件的核心入口：
// 在真正执行一次 followup run 前，判断是否需要先做 memory flush；
// 如果需要，则启动一个内部的 embedded agent run 来完成 memory 写入。
export async function runMemoryFlushIfNeeded(params: {
  cfg: OpenClawConfig;
  followupRun: FollowupRun;
  promptForEstimate?: string;
  sessionCtx: TemplateContext;
  opts?: GetReplyOptions;
  defaultModel: string;
  agentCfgContextTokens?: number;
  resolvedVerboseLevel: VerboseLevel;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  isHeartbeat: boolean;
}): Promise<SessionEntry | undefined> {
  const memoryFlushSettings = resolveMemoryFlushSettings(params.cfg); // 解析统一 flush 配置
  if (!memoryFlushSettings) {
    return params.sessionEntry;
  }

  // 如果当前 session 运行在 sandbox 中，只有 workspaceAccess=rw 才允许 flush 写 memory 文件。
  const memoryFlushWritable = (() => {
    if (!params.sessionKey) {
      return true;
    }
    const runtime = resolveSandboxRuntimeStatus({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
    });
    if (!runtime.sandboxed) {
      return true;
    }
    const sandboxCfg = resolveSandboxConfigForAgent(params.cfg, runtime.agentId);
    return sandboxCfg.workspaceAccess === "rw";
  })();

  const isCli = isCliProvider(params.followupRun.run.provider, params.cfg); // CLI provider 不跑 memory flush
  const canAttemptFlush = memoryFlushWritable && !params.isHeartbeat && !isCli; // heartbeat / CLI / 只读 sandbox 一律跳过
  let entry =
    params.sessionEntry ??
    (params.sessionKey ? params.sessionStore?.[params.sessionKey] : undefined); // 优先使用最新 sessionEntry，否则回退到 sessionStore
  const contextWindowTokens = resolveMemoryFlushContextWindowTokens({
    modelId: params.followupRun.run.model ?? params.defaultModel,
    agentCfgContextTokens: params.agentCfgContextTokens,
  });

  // 估算如果现在要追加一轮 memory flush prompt，会额外增加多少 token。
  const promptTokenEstimate = estimatePromptTokensForMemoryFlush(
    params.promptForEstimate ?? params.followupRun.prompt,
  );
  const persistedPromptTokensRaw = entry?.totalTokens; // session store 中记录的 prompt token 总量
  const persistedPromptTokens =
    typeof persistedPromptTokensRaw === "number" &&
    Number.isFinite(persistedPromptTokensRaw) &&
    persistedPromptTokensRaw > 0
      ? persistedPromptTokensRaw
      : undefined;
  const hasFreshPersistedPromptTokens =
    typeof persistedPromptTokens === "number" && entry?.totalTokensFresh === true; // 标记该 token 值是否可信且新鲜

  // 真正的触发线：
  // contextWindow - reserveFloor - softThreshold
  const flushThreshold =
    contextWindowTokens -
    memoryFlushSettings.reserveTokensFloor -
    memoryFlushSettings.softThresholdTokens;

  // When totals are stale/unknown, derive prompt + last output from transcript so memory
  // flush can still be evaluated against projected next-input size.
  //
  // When totals are fresh, only read the transcript when we're close enough to the
  // threshold that missing the last output tokens could flip the decision.
  const shouldReadTranscriptForOutput =
    canAttemptFlush &&
    entry &&
    hasFreshPersistedPromptTokens &&
    typeof promptTokenEstimate === "number" &&
    Number.isFinite(promptTokenEstimate) &&
    flushThreshold > 0 &&
    (persistedPromptTokens ?? 0) + promptTokenEstimate >=
      flushThreshold - TRANSCRIPT_OUTPUT_READ_BUFFER_TOKENS;

  // 需要读 transcript 的两种典型情况：
  // 1. 现有 totalTokens 不新鲜
  // 2. 已经接近阈值，必须补读最新 output token 才能更准确判断
  const shouldReadTranscript = Boolean(
    canAttemptFlush && entry && (!hasFreshPersistedPromptTokens || shouldReadTranscriptForOutput),
  );

  const forceFlushTranscriptBytes = memoryFlushSettings.forceFlushTranscriptBytes; // transcript 字节级强制触发阈值
  const shouldCheckTranscriptSizeForForcedFlush = Boolean(
    canAttemptFlush &&
    entry &&
    Number.isFinite(forceFlushTranscriptBytes) &&
    forceFlushTranscriptBytes > 0,
  );
  const shouldReadSessionLog = shouldReadTranscript || shouldCheckTranscriptSizeForForcedFlush; // 只要 usage 或 byte size 有一项需要，就统一读一次日志快照
  const sessionLogSnapshot = shouldReadSessionLog
    ? await readSessionLogSnapshot({
        sessionId: params.followupRun.run.sessionId,
        sessionEntry: entry,
        sessionKey: params.sessionKey ?? params.followupRun.run.sessionKey,
        opts: { storePath: params.storePath },
        includeByteSize: shouldCheckTranscriptSizeForForcedFlush,
        includeUsage: shouldReadTranscript,
      })
    : undefined;
  const transcriptByteSize = sessionLogSnapshot?.byteSize; // 日志总字节数
  const shouldForceFlushByTranscriptSize =
    typeof transcriptByteSize === "number" && transcriptByteSize >= forceFlushTranscriptBytes; // transcript 太大时，即使 token 估算不准也强制 flush

  const transcriptUsageSnapshot = sessionLogSnapshot?.usage;
  const transcriptPromptTokens = transcriptUsageSnapshot?.promptTokens;
  const transcriptOutputTokens = transcriptUsageSnapshot?.outputTokens;
  const hasReliableTranscriptPromptTokens =
    typeof transcriptPromptTokens === "number" &&
    Number.isFinite(transcriptPromptTokens) &&
    transcriptPromptTokens > 0;
  const shouldPersistTranscriptPromptTokens =
    hasReliableTranscriptPromptTokens &&
    (!hasFreshPersistedPromptTokens ||
      (transcriptPromptTokens ?? 0) > (persistedPromptTokens ?? 0));

  // 如果 transcript 中读到了更可靠 / 更大的 prompt token 总量，则把它回写进内存和持久 store，
  // 后续判定就能少走一次 transcript IO。
  if (entry && shouldPersistTranscriptPromptTokens) {
    const nextEntry = {
      ...entry,
      totalTokens: transcriptPromptTokens,
      totalTokensFresh: true,
    };
    entry = nextEntry;
    if (params.sessionKey && params.sessionStore) {
      params.sessionStore[params.sessionKey] = nextEntry;
    }
    if (params.storePath && params.sessionKey) {
      try {
        const updatedEntry = await updateSessionStoreEntry({
          storePath: params.storePath,
          sessionKey: params.sessionKey,
          update: async () => ({ totalTokens: transcriptPromptTokens, totalTokensFresh: true }),
        });
        if (updatedEntry) {
          entry = updatedEntry;
          if (params.sessionStore) {
            params.sessionStore[params.sessionKey] = updatedEntry;
          }
        }
      } catch (err) {
        logVerbose(`failed to persist derived prompt totalTokens: ${String(err)}`);
      }
    }
  }

  // 选择当前可用的“最新 prompt token 快照”。
  const promptTokensSnapshot = Math.max(
    hasFreshPersistedPromptTokens ? (persistedPromptTokens ?? 0) : 0,
    hasReliableTranscriptPromptTokens ? (transcriptPromptTokens ?? 0) : 0,
  );
  const hasFreshPromptTokensSnapshot =
    promptTokensSnapshot > 0 &&
    (hasFreshPersistedPromptTokens || hasReliableTranscriptPromptTokens);

  // 如果有足够新鲜的 prompt token 快照，就进一步估算“下一次输入上下文”的总体 token 体积。
  const projectedTokenCount = hasFreshPromptTokensSnapshot
    ? resolveEffectivePromptTokens(
        promptTokensSnapshot,
        transcriptOutputTokens,
        promptTokenEstimate,
      )
    : undefined;
  const tokenCountForFlush =
    typeof projectedTokenCount === "number" &&
    Number.isFinite(projectedTokenCount) &&
    projectedTokenCount > 0
      ? projectedTokenCount
      : undefined;

  // Diagnostic logging to understand why memory flush may not trigger.
  logVerbose(
    `memoryFlush check: sessionKey=${params.sessionKey} ` +
      `tokenCount=${tokenCountForFlush ?? "undefined"} ` +
      `contextWindow=${contextWindowTokens} threshold=${flushThreshold} ` +
      `isHeartbeat=${params.isHeartbeat} isCli=${isCli} memoryFlushWritable=${memoryFlushWritable} ` +
      `compactionCount=${entry?.compactionCount ?? 0} memoryFlushCompactionCount=${entry?.memoryFlushCompactionCount ?? "undefined"} ` +
      `persistedPromptTokens=${persistedPromptTokens ?? "undefined"} persistedFresh=${entry?.totalTokensFresh === true} ` +
      `promptTokensEst=${promptTokenEstimate ?? "undefined"} transcriptPromptTokens=${transcriptPromptTokens ?? "undefined"} transcriptOutputTokens=${transcriptOutputTokens ?? "undefined"} ` +
      `projectedTokenCount=${projectedTokenCount ?? "undefined"} transcriptBytes=${transcriptByteSize ?? "undefined"} ` +
      `forceFlushTranscriptBytes=${forceFlushTranscriptBytes} forceFlushByTranscriptSize=${shouldForceFlushByTranscriptSize}`,
  );

  // 最终触发条件：
  // - 正常 token 阈值触发
  // - 或 transcript 字节数强制触发
  const shouldFlushMemory =
    (memoryFlushSettings &&
      memoryFlushWritable &&
      !params.isHeartbeat &&
      !isCli &&
      shouldRunMemoryFlush({
        entry,
        tokenCount: tokenCountForFlush,
        contextWindowTokens,
        reserveTokensFloor: memoryFlushSettings.reserveTokensFloor,
        softThresholdTokens: memoryFlushSettings.softThresholdTokens,
      })) ||
    (shouldForceFlushByTranscriptSize &&
      entry != null &&
      !hasAlreadyFlushedForCurrentCompaction(entry));

  // 不需要 flush 时，直接返回最新 sessionEntry（可能已经因 transcript usage 更新过）。
  if (!shouldFlushMemory) {
    return entry ?? params.sessionEntry;
  }

  logVerbose(
    `memoryFlush triggered: sessionKey=${params.sessionKey} tokenCount=${tokenCountForFlush ?? "undefined"} threshold=${flushThreshold}`,
  );

  let activeSessionEntry = entry ?? params.sessionEntry;
  const activeSessionStore = params.sessionStore;
  let bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
    activeSessionEntry?.systemPromptReport ??
      (params.sessionKey ? activeSessionStore?.[params.sessionKey]?.systemPromptReport : undefined),
  );
  const flushRunId = crypto.randomUUID(); // 给这次内部 flush run 一个独立 ID
  if (params.sessionKey) {
    registerAgentRunContext(flushRunId, {
      sessionKey: params.sessionKey,
      verboseLevel: params.resolvedVerboseLevel,
    });
  }
  let memoryCompactionCompleted = false; // flush run 自身如果触发了 compaction，后面要同步更新 compactionCount
  const flushSystemPrompt = [
    params.followupRun.run.extraSystemPrompt,
    memoryFlushSettings.systemPrompt,
  ]
    .filter(Boolean)
    .join("\n\n"); // 继承现有 extraSystemPrompt，再叠加 memory flush 专属 system prompt
  try {
    // 真正执行 memory flush：启动一个 embedded Pi agent。
    await runWithModelFallback({
      ...resolveModelFallbackOptions(params.followupRun.run),
      runId: flushRunId,
      run: async (provider, model, runOptions) => {
        // 组装 embedded run 所需的上下文（身份、sender、session 等）。
        const { authProfile, embeddedContext, senderContext } = buildEmbeddedRunContexts({
          run: params.followupRun.run,
          sessionCtx: params.sessionCtx,
          hasRepliedRef: params.opts?.hasRepliedRef,
          provider,
        });
        // 组装模型、provider、runId 等基础参数。
        const runBaseParams = buildEmbeddedRunBaseParams({
          run: params.followupRun.run,
          provider,
          model,
          runId: flushRunId,
          authProfile,
          allowTransientCooldownProbe: runOptions?.allowTransientCooldownProbe,
        });
        // 这里的 trigger="memory"，说明这不是普通聊天 run，而是内部 memory flush run。
        const result = await runEmbeddedPiAgent({
          ...embeddedContext,
          ...senderContext,
          ...runBaseParams,
          trigger: "memory",
          prompt: resolveMemoryFlushPromptForRun({
            prompt: memoryFlushSettings.prompt,
            cfg: params.cfg,
          }), // 把 YYYY-MM-DD 等模板替换成当前时区下的真实日期
          extraSystemPrompt: flushSystemPrompt,
          bootstrapPromptWarningSignaturesSeen,
          bootstrapPromptWarningSignature:
            bootstrapPromptWarningSignaturesSeen[bootstrapPromptWarningSignaturesSeen.length - 1],
          onAgentEvent: (evt) => {
            // flush run 内部如果发生 compaction，需要记录下来，
            // 以便后面把 compactionCount 一并更新。
            if (evt.stream === "compaction") {
              const phase = typeof evt.data.phase === "string" ? evt.data.phase : "";
              if (phase === "end") {
                memoryCompactionCompleted = true;
              }
            }
          },
        });
        // embedded run 结束后，刷新 bootstrap warning 签名状态，供后续 run 继承。
        bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
          result.meta?.systemPromptReport,
        );
        return result;
      },
    });
    // 计算这次 flush 应该标记在哪个 compaction 周期下。
    let memoryFlushCompactionCount =
      activeSessionEntry?.compactionCount ??
      (params.sessionKey ? activeSessionStore?.[params.sessionKey]?.compactionCount : 0) ??
      0;
    // 如果 flush run 过程中真的走完了一次 compaction，则递增 compactionCount。
    if (memoryCompactionCompleted) {
      const nextCount = await incrementCompactionCount({
        sessionEntry: activeSessionEntry,
        sessionStore: activeSessionStore,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
      });
      if (typeof nextCount === "number") {
        memoryFlushCompactionCount = nextCount;
      }
    }
    // 把本次 flush 的执行时间和 compaction 周期号写回 session store。
    // 后续 `hasAlreadyFlushedForCurrentCompaction()` 就靠这个避免重复 flush。
    if (params.storePath && params.sessionKey) {
      try {
        const updatedEntry = await updateSessionStoreEntry({
          storePath: params.storePath,
          sessionKey: params.sessionKey,
          update: async () => ({
            memoryFlushAt: Date.now(),
            memoryFlushCompactionCount,
          }),
        });
        if (updatedEntry) {
          activeSessionEntry = updatedEntry;
        }
      } catch (err) {
        logVerbose(`failed to persist memory flush metadata: ${String(err)}`);
      }
    }
  } catch (err) {
    // flush 失败不应该中断主回复流程，只记 verbose 日志即可。
    logVerbose(`memory flush run failed: ${String(err)}`);
  }

  return activeSessionEntry;
}
