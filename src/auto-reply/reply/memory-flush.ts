// ============================================================================
// auto-reply/reply/memory-flush.ts
//
// 这个文件专门负责“是否应该触发 pre-compaction memory flush”的判定与配置解析。
//
// 所谓 memory flush，指的是：
// - 当 session 快接近上下文压缩（compaction）阈值时
// - 系统先触发一次内部的、面向记忆沉淀的 agent turn
// - 提醒模型把 durable memories 写到 memory 文件
//
// 当前文件不负责真正执行写 memory 的动作；
// 它只负责：
// 1. 提供默认 prompt / system prompt
// 2. 解析配置，生成统一的 MemoryFlushSettings
// 3. 根据 token 数 / transcript 大小判断“现在要不要 flush”
// 4. 保证每个 compaction 周期最多只 flush 一次
// ============================================================================

import { lookupContextTokens } from "../../agents/context.js"; // 按模型 ID 查询上下文窗口大小
import { resolveCronStyleNow } from "../../agents/current-time.js"; // 解析带用户时区的“当前时间”描述
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js"; // 默认 context window 大小
import { DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR } from "../../agents/pi-settings.js"; // compaction 默认保留 token 水位
import { parseNonNegativeByteSize } from "../../config/byte-size.js"; // 把 2mb / 512kb 之类配置转成字节数
import type { OpenClawConfig } from "../../config/config.js"; // OpenClaw 全局配置类型
import { resolveFreshSessionTotalTokens, type SessionEntry } from "../../config/sessions.js"; // 获取 session 最新 token 计数
import { SILENT_REPLY_TOKEN } from "../tokens.js"; // 静默回复标记：通常是 NO_REPLY

// 在距离 compaction 阈值还剩多少 token 时，开始触发 memory flush。
// 4000 代表“离真正压缩还留一点提前量”，先给模型一次沉淀 memory 的机会。
export const DEFAULT_MEMORY_FLUSH_SOFT_TOKENS = 4000;

// transcript 大小达到该字节数时，也可以强制触发一次 memory flush。
// 这是 token 计数以外的第二条保护线，防止长会话在 token 估算不准时完全不 flush。
export const DEFAULT_MEMORY_FLUSH_FORCE_TRANSCRIPT_BYTES = 2 * 1024 * 1024;

// 默认用户提示词：
// - 明确这是一次 pre-compaction memory flush
// - 指定写入文件位置与文件名模板
// - 强调只能追加，不能覆盖
// - 禁止创建碎片化的时间戳变体文件
// - 如果没有值得沉淀的内容，就静默退出
export const DEFAULT_MEMORY_FLUSH_PROMPT = [
  "Pre-compaction memory flush.",
  "Store durable memories now (use memory/YYYY-MM-DD.md; create memory/ if needed).",
  "IMPORTANT: If the file already exists, APPEND new content only — do not overwrite existing entries.",
  "Do NOT create timestamped variant files (e.g., YYYY-MM-DD-HHMM.md); always use the canonical YYYY-MM-DD.md filename.",
  `If nothing to store, reply with ${SILENT_REPLY_TOKEN}.`,
].join(" ");

// 默认 system prompt：
// 比普通 prompt 更偏“回合身份声明”，告诉模型：
// - 这不是普通聊天，而是一次 pre-compaction flush turn
// - 当前的核心目标是 capture durable memories
// - 大多数情况下静默退出是合理的
export const DEFAULT_MEMORY_FLUSH_SYSTEM_PROMPT = [
  "Pre-compaction memory flush turn.",
  "The session is near auto-compaction; capture durable memories to disk.",
  `You may reply, but usually ${SILENT_REPLY_TOKEN} is correct.`,
].join(" ");

// 按用户时区把当前时间格式化成 YYYY-MM-DD，供 prompt 中替换 memory 文件名模板。
function formatDateStampInTimezone(nowMs: number, timezone: string): string {
  // 通过 Intl.DateTimeFormat 按指定时区拆出年/月/日，比直接用本地时区更可靠。
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (year && month && day) {
    return `${year}-${month}-${day}`;
  }
  // 极端兜底：若 Intl 解析失败，则退回 ISO 日期。
  return new Date(nowMs).toISOString().slice(0, 10);
}

// 为一次具体的 memory flush run 生成最终 prompt。
// 这里会把 prompt 里的 YYYY-MM-DD 模板替换成用户时区下的当天日期，
// 并在必要时自动补一行 "Current time: ..." 风格的时间上下文。
export function resolveMemoryFlushPromptForRun(params: {
  prompt: string;
  cfg?: OpenClawConfig;
  nowMs?: number;
}): string {
  const nowMs = Number.isFinite(params.nowMs) ? (params.nowMs as number) : Date.now(); // 优先使用调用方传入时间，便于测试
  const { userTimezone, timeLine } = resolveCronStyleNow(params.cfg ?? {}, nowMs);
  const dateStamp = formatDateStampInTimezone(nowMs, userTimezone); // 生成用户时区下的日期
  const withDate = params.prompt.replaceAll("YYYY-MM-DD", dateStamp).trimEnd(); // 把模板日期替换成真实日期
  if (!withDate) {
    // prompt 为空时，至少保留当前时间线索，避免模型完全不知道“今天是哪天”。
    return timeLine;
  }
  if (withDate.includes("Current time:")) {
    // 调用方若已经显式带了时间提示，就不要重复追加。
    return withDate;
  }
  // 默认在 prompt 后附加时间信息，让模型知道“今天”具体指哪一天。
  return `${withDate}\n${timeLine}`;
}

// memory flush 的统一配置结构。
export type MemoryFlushSettings = {
  enabled: boolean; // 是否启用 memory flush
  softThresholdTokens: number; // 提前距离 compaction 多少 token 时触发
  /**
   * Force a pre-compaction memory flush when the session transcript reaches this
   * size. Set to 0 to disable byte-size based triggering.
   */
  forceFlushTranscriptBytes: number; // transcript 达到多大时，额外强制触发
  prompt: string; // 实际运行的用户 prompt
  systemPrompt: string; // 实际运行的 system prompt
  reserveTokensFloor: number; // compaction 保留 token 下限
};

// 把任意 unknown 值归一成“非负整数”，无效则返回 null。
const normalizeNonNegativeInt = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const int = Math.floor(value); // 小数统一向下取整，保持阈值语义稳定
  return int >= 0 ? int : null;
};

// 从 OpenClaw 配置中解析 memory flush 设置，并填充合理默认值。
// 如果 flush 被显式禁用，则返回 null，表示上层无需再尝试触发。
export function resolveMemoryFlushSettings(cfg?: OpenClawConfig): MemoryFlushSettings | null {
  const defaults = cfg?.agents?.defaults?.compaction?.memoryFlush; // 读取 agents.defaults.compaction.memoryFlush
  const enabled = defaults?.enabled ?? true; // 未配置时默认开启
  if (!enabled) {
    return null;
  }
  // 触发阈值：优先配置值，否则落到默认 4000 token。
  const softThresholdTokens =
    normalizeNonNegativeInt(defaults?.softThresholdTokens) ?? DEFAULT_MEMORY_FLUSH_SOFT_TOKENS;
  // transcript 字节阈值：支持 "2mb" 这种字符串写法。
  const forceFlushTranscriptBytes =
    parseNonNegativeByteSize(defaults?.forceFlushTranscriptBytes) ??
    DEFAULT_MEMORY_FLUSH_FORCE_TRANSCRIPT_BYTES;
  const prompt = defaults?.prompt?.trim() || DEFAULT_MEMORY_FLUSH_PROMPT; // 自定义 prompt 或默认 prompt
  const systemPrompt = defaults?.systemPrompt?.trim() || DEFAULT_MEMORY_FLUSH_SYSTEM_PROMPT; // 自定义 system prompt 或默认值
  // reserve floor 不属于 memoryFlush 子配置，而是 compaction 的全局阈值之一。
  const reserveTokensFloor =
    normalizeNonNegativeInt(cfg?.agents?.defaults?.compaction?.reserveTokensFloor) ??
    DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR;

  return {
    enabled,
    softThresholdTokens,
    forceFlushTranscriptBytes,
    prompt: ensureNoReplyHint(prompt), // 强制补上 NO_REPLY 提示，避免自定义 prompt 忘记写静默出口
    systemPrompt: ensureNoReplyHint(systemPrompt), // system prompt 同样补齐
    reserveTokensFloor,
  };
}

// 确保 prompt / system prompt 中包含静默退出提示。
// 即使用户自定义覆盖了默认 prompt，也尽量保证“可以 NO_REPLY”这一行为不丢。
function ensureNoReplyHint(text: string): string {
  if (text.includes(SILENT_REPLY_TOKEN)) {
    return text;
  }
  return `${text}\n\nIf no user-visible reply is needed, start with ${SILENT_REPLY_TOKEN}.`;
}

// 解析当前 run 对应的 context window 大小。
// 优先顺序：
// 1. 模型固有上下文窗口（lookupContextTokens）
// 2. agent 配置里的 contextTokens
// 3. 全局默认值
export function resolveMemoryFlushContextWindowTokens(params: {
  modelId?: string;
  agentCfgContextTokens?: number;
}): number {
  return (
    lookupContextTokens(params.modelId) ?? params.agentCfgContextTokens ?? DEFAULT_CONTEXT_TOKENS
  );
}

// 判断“当前这次 run 是否应该触发 memory flush”。
// 这一步只做判定，不负责执行真正的 flush。
export function shouldRunMemoryFlush(params: {
  entry?: Pick<
    SessionEntry,
    "totalTokens" | "totalTokensFresh" | "compactionCount" | "memoryFlushCompactionCount"
  >;
  /**
   * Optional token count override for flush gating. When provided, this value is
   * treated as a fresh context snapshot and used instead of the cached
   * SessionEntry.totalTokens (which may be stale/unknown).
   */
  tokenCount?: number;
  contextWindowTokens: number;
  reserveTokensFloor: number;
  softThresholdTokens: number;
}): boolean {
  // 没有 session entry 时，无法判断 token 状态，也无法记录 flush 周期，直接不触发。
  if (!params.entry) {
    return false;
  }

  const override = params.tokenCount; // 调用方可传入最新 token 估算，覆盖缓存值
  const overrideTokens =
    typeof override === "number" && Number.isFinite(override) && override > 0
      ? Math.floor(override)
      : undefined;

  const totalTokens = overrideTokens ?? resolveFreshSessionTotalTokens(params.entry); // 优先使用 fresh override，否则回退到 session 中的最新 token 数据
  if (!totalTokens || totalTokens <= 0) {
    return false;
  }
  const contextWindow = Math.max(1, Math.floor(params.contextWindowTokens)); // 保底至少 1
  const reserveTokens = Math.max(0, Math.floor(params.reserveTokensFloor)); // 预留给正常回复/系统操作的保底 token
  const softThreshold = Math.max(0, Math.floor(params.softThresholdTokens)); // 离 compaction 还有多少 token 时提前触发
  const threshold = Math.max(0, contextWindow - reserveTokens - softThreshold); // 真正的触发阈值线
  if (threshold <= 0) {
    return false;
  }
  // 当前 token 还没达到阈值，说明离 compaction 还远，不需要 flush。
  if (totalTokens < threshold) {
    return false;
  }

  // 一个 compaction 周期里已经 flush 过一次，就不要重复执行。
  if (hasAlreadyFlushedForCurrentCompaction(params.entry)) {
    return false;
  }

  return true;
}

/**
 * Returns true when a memory flush has already been performed for the current
 * compaction cycle. This prevents repeated flush runs within the same cycle —
 * important for both the token-based and transcript-size–based trigger paths.
 */
export function hasAlreadyFlushedForCurrentCompaction(
  entry: Pick<SessionEntry, "compactionCount" | "memoryFlushCompactionCount">,
): boolean {
  const compactionCount = entry.compactionCount ?? 0; // 当前已经进行到第几个 compaction 周期
  const lastFlushAt = entry.memoryFlushCompactionCount; // 最近一次 flush 发生在哪个 compaction 周期
  // 两者相等，说明当前周期已经 flush 过了；不等则允许再触发一次。
  return typeof lastFlushAt === "number" && lastFlushAt === compactionCount;
}
