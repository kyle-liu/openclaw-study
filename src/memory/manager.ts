// ============================================================================
// memory/manager.ts
//
// 记忆系统的核心管理器。
// 职责：
//   1. 维护 SQLite 数据库（向量表 + FTS 全文索引表 + embedding 缓存表）
//   2. 监听工作区 Markdown 文件变化，增量更新索引（dirty flag + watcher）
//   3. 提供统一的 search() 接口：支持 FTS-only / 向量 / 混合三种检索模式
//   4. 提供 readFile() 接口：安全读取工作区内的记忆 Markdown 文件
//   5. 进程级单例缓存（INDEX_CACHE），相同配置复用同一实例
//
// 类继承链：
//   MemoryIndexManager
//     → MemoryManagerEmbeddingOps  （embedding 生成、批量处理、缓存）
//       → MemoryManagerSyncOps     （文件扫描、分块、SQLite 写入、watcher 生命周期）
// ============================================================================

import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite"; // Node.js 22+ 内置同步 SQLite API
import { type FSWatcher } from "chokidar"; // 跨平台文件系统监听库
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { ResolvedMemorySearchConfig } from "../agents/memory-search.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  createEmbeddingProvider,
  type EmbeddingProvider,
  type EmbeddingProviderResult,
  type GeminiEmbeddingClient,
  type MistralEmbeddingClient,
  type OllamaEmbeddingClient,
  type OpenAiEmbeddingClient,
  type VoyageEmbeddingClient,
} from "./embeddings.js";
import { isFileMissingError, statRegularFile } from "./fs-utils.js";
import { bm25RankToScore, buildFtsQuery, mergeHybridResults } from "./hybrid.js";
import { isMemoryPath, normalizeExtraMemoryPaths } from "./internal.js";
import { MemoryManagerEmbeddingOps } from "./manager-embedding-ops.js";
import { searchKeyword, searchVector } from "./manager-search.js";
import { extractKeywords } from "./query-expansion.js";
import type {
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemorySearchManager,
  MemorySearchResult,
  MemorySource,
  MemorySyncProgressUpdate,
} from "./types.js";

// ── 常量 ─────────────────────────────────────────────────────────────────────

// 搜索结果中每个片段的最大字符数；超出则截断，避免结果过长占用 token
const SNIPPET_MAX_CHARS = 700;

// SQLite 表名：向量索引（sqlite-vec 扩展）
const VECTOR_TABLE = "chunks_vec";

// SQLite 表名：全文索引（FTS5）
const FTS_TABLE = "chunks_fts";

// SQLite 表名：embedding 向量缓存（以文本 hash 为 key，避免重复调用 API）
const EMBEDDING_CACHE_TABLE = "embedding_cache";

// embedding 批处理连续失败超过此次数后停止使用批处理（降级到逐条请求）
const BATCH_FAILURE_LIMIT = 2;

// 子系统日志（输出到 memory 频道）
const log = createSubsystemLogger("memory");

// ── 进程级单例缓存 ─────────────────────────────────────────────────────────────
// key 格式：`${agentId}:${workspaceDir}:${JSON.stringify(settings)}`
// 相同配置共享同一个 MemoryIndexManager 实例，避免重复打开 SQLite 连接和 watcher

// 已就绪的实例缓存
const INDEX_CACHE = new Map<string, MemoryIndexManager>();

// 正在初始化（异步创建中）的实例 Promise 缓存，防止并发重复创建（双重检测锁）
const INDEX_CACHE_PENDING = new Map<string, Promise<MemoryIndexManager>>();

// ── 模块级清理函数 ──────────────────────────────────────────────────────────────

/**
 * 关闭进程中所有 MemoryIndexManager 实例。
 * 用于网关关闭时的资源释放：先等待所有正在创建的实例完成，再逐一 close()。
 */
export async function closeAllMemoryIndexManagers(): Promise<void> {
  // 等待所有仍在异步初始化中的实例完成（无论成功或失败），避免遗漏未注册进 INDEX_CACHE 的实例
  const pending = Array.from(INDEX_CACHE_PENDING.values());
  if (pending.length > 0) {
    await Promise.allSettled(pending);
  }
  // 取出所有已就绪实例后立即清空缓存，防止关闭期间有新请求进来复用已关闭的实例
  const managers = Array.from(INDEX_CACHE.values());
  INDEX_CACHE.clear();
  for (const manager of managers) {
    try {
      await manager.close();
    } catch (err) {
      // 关闭失败仅记录警告，不阻断其他实例的关闭
      log.warn(`failed to close memory index manager: ${String(err)}`);
    }
  }
}

// ── 主类 ────────────────────────────────────────────────────────────────────────

/**
 * MemoryIndexManager：记忆索引的核心管理类。
 *
 * 继承自 MemoryManagerEmbeddingOps（embedding 生成 + 批处理 + 缓存），
 * 后者再继承自 MemoryManagerSyncOps（SQLite schema、文件扫描、分块写入、watcher）。
 *
 * 外部通过静态工厂方法 `MemoryIndexManager.get()` 获取实例；
 * 构造函数为 private，禁止直接 new。
 */
export class MemoryIndexManager extends MemoryManagerEmbeddingOps implements MemorySearchManager {
  // 进程级缓存的 key，用于 close() 时从 INDEX_CACHE 中移除自身
  private readonly cacheKey: string;

  // ── 核心配置（从父类访问，protected） ──────────────────────────────────────
  protected readonly cfg: OpenClawConfig; // 全局配置对象
  protected readonly agentId: string; // 归属的 agent ID
  protected readonly workspaceDir: string; // agent 工作区目录（记忆文件根目录）
  protected readonly settings: ResolvedMemorySearchConfig; // 已解析的记忆搜索配置

  // ── Embedding 提供者 ───────────────────────────────────────────────────────
  // 当前实际使用的 provider（可能因 fallback 而与 requestedProvider 不同）
  protected provider: EmbeddingProvider | null;

  // 用户在配置中指定的 provider 类型（用于状态上报，区分"想要什么"和"实际用什么"）
  private readonly requestedProvider:
    | "openai"
    | "local"
    | "gemini"
    | "voyage"
    | "mistral"
    | "ollama"
    | "auto";

  // fallback 信息：当指定的 provider 不可用时降级使用其他 provider
  protected fallbackFrom?: "openai" | "local" | "gemini" | "voyage" | "mistral" | "ollama";
  protected fallbackReason?: string;

  // provider 完全不可用时的原因（FTS-only 模式时使用）
  private readonly providerUnavailableReason?: string;

  // 各厂商 embedding 客户端（由 createEmbeddingProvider 创建，父类 EmbeddingOps 调用）
  protected openAi?: OpenAiEmbeddingClient;
  protected gemini?: GeminiEmbeddingClient;
  protected voyage?: VoyageEmbeddingClient;
  protected mistral?: MistralEmbeddingClient;
  protected ollama?: OllamaEmbeddingClient;

  // ── 批处理配置与状态 ────────────────────────────────────────────────────────
  protected batch: {
    enabled: boolean;
    wait: boolean; // 是否等待批处理结果（同步等待 vs 异步提交）
    concurrency: number; // 并发批次数
    pollIntervalMs: number;
    timeoutMs: number;
  };
  protected batchFailureCount = 0; // 累计失败次数
  protected batchFailureLastError?: string; // 最后一次失败的错误信息
  protected batchFailureLastProvider?: string; // 最后一次失败的 provider 标识
  // 串行锁：防止多个批处理并发写入 SQLite 导致数据竞争
  protected batchFailureLock: Promise<void> = Promise.resolve();

  // ── SQLite 数据库连接 ────────────────────────────────────────────────────────
  // 使用 Node.js 内置的同步 SQLite API（DatabaseSync）；
  // 同步 API 避免了 async/await 竞态，但所有 DB 操作会阻塞事件循环（操作耗时很短）
  protected db: DatabaseSync;

  // ── 数据来源 ─────────────────────────────────────────────────────────────────
  // 可选值：'memory'（工作区 Markdown 文件）| 'sessions'（会话对话记录）
  protected readonly sources: Set<MemorySource>;

  // embedding provider 的唯一标识键，用于检测 provider 切换后触发全量重新索引
  protected providerKey: string;

  // ── embedding 缓存配置 ───────────────────────────────────────────────────────
  protected readonly cache: { enabled: boolean; maxEntries?: number };

  // ── 向量搜索状态 ─────────────────────────────────────────────────────────────
  protected readonly vector: {
    enabled: boolean; // 配置中是否开启向量搜索
    available: boolean | null; // null=未检测 / true=可用 / false=不可用
    extensionPath?: string; // sqlite-vec 扩展 .so/.dylib 路径
    loadError?: string; // 扩展加载失败的错误信息
    dims?: number; // embedding 向量维度（从 DB meta 读取）
  };

  // ── FTS 全文搜索状态 ─────────────────────────────────────────────────────────
  protected readonly fts: {
    enabled: boolean; // 配置中是否开启混合检索（hybrid = FTS + vector）
    available: boolean; // FTS5 扩展是否实际可用
    loadError?: string;
  };

  // ── 异步初始化状态 ────────────────────────────────────────────────────────────
  // sqlite-vec 扩展加载是异步的，vectorReady 缓存加载结果 Promise，避免重复加载
  protected vectorReady: Promise<boolean> | null = null;

  // ── 文件监听 ──────────────────────────────────────────────────────────────────
  protected watcher: FSWatcher | null = null; // 监听工作区 .md 文件变化
  protected watchTimer: NodeJS.Timeout | null = null; // debounce 定时器（文件变化防抖）
  protected sessionWatchTimer: NodeJS.Timeout | null = null; // session 文件变化防抖定时器
  protected sessionUnsubscribe: (() => void) | null = null; // 取消 session 事件订阅的函数
  protected intervalTimer: NodeJS.Timeout | null = null; // 定时强制 sync 的 interval

  // ── Dirty 标志（标记"有新内容待同步"）───────────────────────────────────────
  protected closed = false; // 是否已关闭
  protected dirty = false; // 工作区记忆文件是否有未同步的变化
  protected sessionsDirty = false; // session 文件是否有未同步的变化

  // 增量跟踪：记录哪些 session 文件发生了变化，用于精准增量同步
  protected sessionsDirtyFiles = new Set<string>();
  // 待处理的 session 文件（防抖期间积累）
  protected sessionPendingFiles = new Set<string>();
  // 每个 session 文件的增量状态：上次大小、新增字节数、新增消息数
  protected sessionDeltas = new Map<
    string,
    { lastSize: number; pendingBytes: number; pendingMessages: number }
  >();

  // 记录哪些 session key 已经做过 session-start 预热，避免同一会话重复触发同步
  private sessionWarm = new Set<string>();

  // 串行同步锁：保证同一时刻只有一个 runSync() 在执行（共享 Promise 引用）
  private syncing: Promise<void> | null = null;

  // SQLite 只读错误的自动恢复统计（只读错误可能因 macOS App Sandbox 文件权限问题触发）
  private readonlyRecoveryAttempts = 0;
  private readonlyRecoverySuccesses = 0;
  private readonlyRecoveryFailures = 0;
  private readonlyRecoveryLastError?: string;

  // ── 工厂方法（进程级单例，双重检测锁）────────────────────────────────────────

  /**
   * 获取或创建指定 agent 的 MemoryIndexManager 实例。
   *
   * 双重检测锁（double-checked locking）防止并发调用时重复创建：
   *   1. 检查 INDEX_CACHE（已就绪实例）
   *   2. 检查 INDEX_CACHE_PENDING（正在创建中的 Promise）
   *   3. 均未命中才启动新创建流程
   *
   * @param purpose 'default' 正常使用；'status' 仅查询状态（跳过首次全量同步）
   */
  static async get(params: {
    cfg: OpenClawConfig;
    agentId: string;
    purpose?: "default" | "status";
  }): Promise<MemoryIndexManager | null> {
    const { cfg, agentId } = params;

    // 根据 agentId 解析记忆搜索配置；若未配置记忆功能则返回 null
    const settings = resolveMemorySearchConfig(cfg, agentId);
    if (!settings) {
      return null;
    }

    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);

    // 缓存 key 包含完整配置的序列化结果：配置变化时会创建新实例（旧实例由 GC 回收）
    const key = `${agentId}:${workspaceDir}:${JSON.stringify(settings)}`;

    // 第一次检查：已就绪的实例
    const existing = INDEX_CACHE.get(key);
    if (existing) {
      return existing;
    }

    // 第二次检查：正在创建中的 Promise（并发调用时复用同一个 Promise）
    const pending = INDEX_CACHE_PENDING.get(key);
    if (pending) {
      return pending;
    }

    // 两次检查都未命中，开始创建新实例
    const createPromise = (async () => {
      // 异步创建 embedding provider（可能涉及网络探测，如加载本地模型）
      const providerResult = await createEmbeddingProvider({
        config: cfg,
        agentDir: resolveAgentDir(cfg, agentId),
        provider: settings.provider,
        remote: settings.remote,
        model: settings.model,
        fallback: settings.fallback,
        local: settings.local,
      });

      // 等待 provider 创建期间，其他并发调用可能已完成创建并注册了实例，需再次检查
      const refreshed = INDEX_CACHE.get(key);
      if (refreshed) {
        return refreshed;
      }

      // 创建实例并立即注册到缓存（注册后其他并发调用可直接复用）
      const manager = new MemoryIndexManager({
        cacheKey: key,
        cfg,
        agentId,
        workspaceDir,
        settings,
        providerResult,
        purpose: params.purpose,
      });
      INDEX_CACHE.set(key, manager);
      return manager;
    })();

    // 注册 pending Promise，让其他并发调用等待同一个 Promise
    INDEX_CACHE_PENDING.set(key, createPromise);
    try {
      return await createPromise;
    } finally {
      // 无论成功或失败，清理 pending 记录（防止内存泄漏）
      // 只清理自己注册的那个 Promise（防止与其他创建流程竞争）
      if (INDEX_CACHE_PENDING.get(key) === createPromise) {
        INDEX_CACHE_PENDING.delete(key);
      }
    }
  }

  // ── 构造函数（私有，只能通过 static get() 创建）──────────────────────────────

  private constructor(params: {
    cacheKey: string;
    cfg: OpenClawConfig;
    agentId: string;
    workspaceDir: string;
    settings: ResolvedMemorySearchConfig;
    providerResult: EmbeddingProviderResult;
    purpose?: "default" | "status";
  }) {
    super(); // 调用父类 MemoryManagerEmbeddingOps 构造函数

    // 保存配置
    this.cacheKey = params.cacheKey;
    this.cfg = params.cfg;
    this.agentId = params.agentId;
    this.workspaceDir = params.workspaceDir;
    this.settings = params.settings;

    // 保存 embedding provider 结果（包含 fallback 信息）
    this.provider = params.providerResult.provider;
    this.requestedProvider = params.providerResult.requestedProvider;
    this.fallbackFrom = params.providerResult.fallbackFrom;
    this.fallbackReason = params.providerResult.fallbackReason;
    this.providerUnavailableReason = params.providerResult.providerUnavailableReason;
    this.openAi = params.providerResult.openAi;
    this.gemini = params.providerResult.gemini;
    this.voyage = params.providerResult.voyage;
    this.mistral = params.providerResult.mistral;
    this.ollama = params.providerResult.ollama;

    // 初始化数据来源集合（memory / sessions）
    this.sources = new Set(params.settings.sources);

    // 打开 SQLite 数据库（路径由 settings.store.path 决定）
    this.db = this.openDatabase();

    // 计算当前 provider 的唯一键（provider 变更时触发全量重建）
    this.providerKey = this.computeProviderKey();

    // embedding 缓存配置
    this.cache = {
      enabled: params.settings.cache.enabled,
      maxEntries: params.settings.cache.maxEntries,
    };

    // FTS 状态初始化（available 将在 ensureSchema 中探测）
    this.fts = { enabled: params.settings.query.hybrid.enabled, available: false };

    // 初始化 DB schema（创建 tables、FTS5、触发器等）；同时探测 FTS 是否可用
    this.ensureSchema();

    // 向量搜索配置（sqlite-vec 扩展路径由配置或自动探测决定）
    this.vector = {
      enabled: params.settings.store.vector.enabled,
      available: null, // 延迟探测（首次 search 时才加载扩展）
      extensionPath: params.settings.store.vector.extensionPath,
    };

    // 从 DB meta 恢复上次存储的向量维度（防止 provider 切换后维度不匹配导致崩溃）
    const meta = this.readMeta();
    if (meta?.vectorDims) {
      this.vector.dims = meta.vectorDims;
    }

    // 启动文件监听（监听工作区 .md 文件变化，触发增量 sync）
    this.ensureWatcher();

    // 订阅 session 转录事件（新消息写入 session 文件时触发增量 sync）
    this.ensureSessionListener();

    // 启动定时强制 sync（兜底：即使 watcher 漏报也能定期刷新索引）
    this.ensureIntervalSync();

    // status-only 模式：若 DB 中已有 meta（历史索引存在），跳过首次全量同步
    // 正常模式：只要 sources 包含 memory，就标记为 dirty（触发首次同步）
    const statusOnly = params.purpose === "status";
    this.dirty = this.sources.has("memory") && (statusOnly ? !meta : true);

    // 批处理配置（从 settings 解析，父类使用）
    this.batch = this.resolveBatchConfig();
  }

  // ── 会话预热 ──────────────────────────────────────────────────────────────────

  /**
   * 在 session 开始时异步预热记忆索引。
   * 若配置了 sync.onSessionStart=true，触发一次后台 sync。
   * 同一 sessionKey 只预热一次（幂等）。
   */
  async warmSession(sessionKey?: string): Promise<void> {
    if (!this.settings.sync.onSessionStart) {
      return;
    }
    const key = sessionKey?.trim() || "";
    // 已预热过的 session 直接跳过
    if (key && this.sessionWarm.has(key)) {
      return;
    }
    // 后台异步触发同步，不阻塞调用方（失败仅记录警告）
    void this.sync({ reason: "session-start" }).catch((err) => {
      log.warn(`memory sync failed (session-start): ${String(err)}`);
    });
    if (key) {
      this.sessionWarm.add(key);
    }
  }

  // ── 搜索入口 ──────────────────────────────────────────────────────────────────

  /**
   * 统一搜索接口，支持三种模式（按优先级自动选择）：
   *
   *   1. FTS-only 模式：无 embedding provider 时，仅使用 BM25 全文检索
   *   2. 向量模式：有 provider 但未开启混合检索时，仅使用向量相似度
   *   3. 混合模式（默认）：向量 + BM25 双路召回，通过加权融合 + MMR 去重 + 时间衰减重排
   *
   * @param query 用户输入的查询字符串
   * @param opts.maxResults 最大返回结果数（覆盖配置默认值）
   * @param opts.minScore 最小分数阈值（低于此分数的结果被过滤）
   * @param opts.sessionKey 当前会话 key（用于 session-start 预热去重）
   */
  async search(
    query: string,
    opts?: {
      maxResults?: number;
      minScore?: number;
      sessionKey?: string;
    },
  ): Promise<MemorySearchResult[]> {
    // 异步预热（首次调用时触发索引同步）
    void this.warmSession(opts?.sessionKey);

    // 若有脏数据且配置了 onSearch 触发同步，后台异步执行（不阻塞当前搜索）
    if (this.settings.sync.onSearch && (this.dirty || this.sessionsDirty)) {
      void this.sync({ reason: "search" }).catch((err) => {
        log.warn(`memory sync failed (search): ${String(err)}`);
      });
    }

    const cleaned = query.trim();
    if (!cleaned) {
      return [];
    }

    const minScore = opts?.minScore ?? this.settings.query.minScore;
    const maxResults = opts?.maxResults ?? this.settings.query.maxResults;
    const hybrid = this.settings.query.hybrid;

    // 召回候选数 = maxResults × candidateMultiplier，用于两路召回后融合时有足够的候选池
    // 上限 200，防止召回太多导致 SQLite 查询慢
    const candidates = Math.min(
      200,
      Math.max(1, Math.floor(maxResults * hybrid.candidateMultiplier)),
    );

    // ── 模式 1：FTS-only（无 embedding provider）──────────────────────────────
    if (!this.provider) {
      if (!this.fts.enabled || !this.fts.available) {
        log.warn("memory search: no provider and FTS unavailable");
        return [];
      }

      // 对口语化查询做关键词提取，提升 BM25 命中率
      // 例如："那个关于 API 的讨论" → ["API", "讨论"]
      const keywords = extractKeywords(cleaned);
      const searchTerms = keywords.length > 0 ? keywords : [cleaned];

      // 对每个关键词并发执行 FTS 检索
      const resultSets = await Promise.all(
        searchTerms.map((term) => this.searchKeyword(term, candidates).catch(() => [])),
      );

      // 跨关键词去重：同一 chunk 出现多次时保留分数最高的那次
      const seenIds = new Map<string, (typeof resultSets)[0][0]>();
      for (const results of resultSets) {
        for (const result of results) {
          const existing = seenIds.get(result.id);
          if (!existing || result.score > existing.score) {
            seenIds.set(result.id, result);
          }
        }
      }

      const merged = [...seenIds.values()]
        .toSorted((a, b) => b.score - a.score)
        .filter((entry) => entry.score >= minScore)
        .slice(0, maxResults);

      return merged;
    }

    // ── 模式 2 & 3：有 embedding provider ─────────────────────────────────────

    // BM25 关键词召回（仅在 hybrid 开启且 FTS 可用时执行）
    const keywordResults =
      hybrid.enabled && this.fts.enabled && this.fts.available
        ? await this.searchKeyword(cleaned, candidates).catch(() => [])
        : [];

    // 向量召回：先对查询文本生成 embedding，再做向量最近邻搜索
    const queryVec = await this.embedQueryWithTimeout(cleaned);
    // 全零向量意味着 embedding 失败（降级），此时跳过向量搜索
    const hasVector = queryVec.some((v) => v !== 0);
    const vectorResults = hasVector
      ? await this.searchVector(queryVec, candidates).catch(() => [])
      : [];

    // ── 模式 2：向量-only（hybrid 未开启或 FTS 不可用）───────────────────────
    if (!hybrid.enabled || !this.fts.enabled || !this.fts.available) {
      return vectorResults.filter((entry) => entry.score >= minScore).slice(0, maxResults);
    }

    // ── 模式 3：混合检索 ────────────────────────────────────────────────────────
    // 加权融合向量分数和 BM25 分数，可选 MMR 多样性重排和时间衰减
    const merged = await this.mergeHybridResults({
      vector: vectorResults,
      keyword: keywordResults,
      vectorWeight: hybrid.vectorWeight,
      textWeight: hybrid.textWeight,
      mmr: hybrid.mmr,
      temporalDecay: hybrid.temporalDecay,
    });

    // 严格过滤：minScore 以上的结果
    const strict = merged.filter((entry) => entry.score >= minScore);
    if (strict.length > 0 || keywordResults.length === 0) {
      return strict.slice(0, maxResults);
    }

    // 宽松回退：混合模式下关键词命中的结果最高分 = textWeight（例如 0.3），
    // 若 minScore > textWeight（例如 0.35），精确的词汇命中会被错误过滤掉。
    // 当严格过滤无结果且存在关键词命中时，放宽 minScore 至 min(minScore, textWeight)。
    const relaxedMinScore = Math.min(minScore, hybrid.textWeight);
    const keywordKeys = new Set(
      keywordResults.map(
        (entry) => `${entry.source}:${entry.path}:${entry.startLine}:${entry.endLine}`,
      ),
    );
    // 只对"有关键词命中"的结果应用宽松阈值，纯向量结果仍受原始 minScore 约束
    return merged
      .filter(
        (entry) =>
          keywordKeys.has(`${entry.source}:${entry.path}:${entry.startLine}:${entry.endLine}`) &&
          entry.score >= relaxedMinScore,
      )
      .slice(0, maxResults);
  }

  // ── 私有搜索方法 ──────────────────────────────────────────────────────────────

  /**
   * 向量最近邻搜索（使用 sqlite-vec 扩展的 KNN 查询）。
   * 先通过 ensureVectorReady() 确保扩展已加载，再执行查询。
   */
  private async searchVector(
    queryVec: number[],
    limit: number,
  ): Promise<Array<MemorySearchResult & { id: string }>> {
    if (!this.provider) {
      return [];
    }
    const results = await searchVector({
      db: this.db,
      vectorTable: VECTOR_TABLE,
      providerModel: this.provider.model,
      queryVec,
      limit,
      snippetMaxChars: SNIPPET_MAX_CHARS,
      ensureVectorReady: async (dimensions) => await this.ensureVectorReady(dimensions),
      // 按数据来源过滤（'c' 为 chunks_vec 的别名前缀；不带前缀为 chunks 表）
      sourceFilterVec: this.buildSourceFilter("c"),
      sourceFilterChunks: this.buildSourceFilter(),
    });
    return results.map((entry) => entry as MemorySearchResult & { id: string });
  }

  /**
   * 将原始查询字符串转换为 SQLite FTS5 查询语法。
   * 例如："用户 偏好" → `"用户" OR "偏好"`
   */
  private buildFtsQuery(raw: string): string | null {
    return buildFtsQuery(raw);
  }

  /**
   * BM25 全文关键词搜索（使用 SQLite FTS5）。
   * FTS-only 模式下不过滤 model（搜索全部历史数据）；
   * 混合模式下只搜索当前 provider 的 model 下的数据。
   */
  private async searchKeyword(
    query: string,
    limit: number,
  ): Promise<Array<MemorySearchResult & { id: string; textScore: number }>> {
    if (!this.fts.enabled || !this.fts.available) {
      return [];
    }
    const sourceFilter = this.buildSourceFilter();
    // FTS-only 模式下 provider 为 null，不按 model 过滤
    const providerModel = this.provider?.model;
    const results = await searchKeyword({
      db: this.db,
      ftsTable: FTS_TABLE,
      providerModel,
      query,
      limit,
      snippetMaxChars: SNIPPET_MAX_CHARS,
      sourceFilter,
      buildFtsQuery: (raw) => this.buildFtsQuery(raw),
      bm25RankToScore,
    });
    return results.map((entry) => entry as MemorySearchResult & { id: string; textScore: number });
  }

  /**
   * 融合向量检索结果和关键词检索结果。
   *
   * 算法：
   *   1. 对每个候选 chunk，计算 vectorWeight × vectorScore + textWeight × textScore
   *   2. 可选 MMR（Maximal Marginal Relevance）：在相关性和多样性之间权衡，减少重复片段
   *   3. 可选时间衰减：较旧的记忆片段乘以衰减因子，让近期记忆排名更靠前
   */
  private mergeHybridResults(params: {
    vector: Array<MemorySearchResult & { id: string }>;
    keyword: Array<MemorySearchResult & { id: string; textScore: number }>;
    vectorWeight: number;
    textWeight: number;
    mmr?: { enabled: boolean; lambda: number };
    temporalDecay?: { enabled: boolean; halfLifeDays: number };
  }): Promise<MemorySearchResult[]> {
    return mergeHybridResults({
      vector: params.vector.map((r) => ({
        id: r.id,
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        source: r.source,
        snippet: r.snippet,
        vectorScore: r.score,
      })),
      keyword: params.keyword.map((r) => ({
        id: r.id,
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        source: r.source,
        snippet: r.snippet,
        textScore: r.textScore,
      })),
      vectorWeight: params.vectorWeight,
      textWeight: params.textWeight,
      mmr: params.mmr,
      temporalDecay: params.temporalDecay,
      workspaceDir: this.workspaceDir,
    }).then((entries) => entries.map((entry) => entry as MemorySearchResult));
  }

  // ── 同步控制 ──────────────────────────────────────────────────────────────────

  /**
   * 触发记忆索引同步（增量或全量）。
   *
   * 串行化设计：同一时刻只允许一个 sync 在运行。
   * 若已有 sync 在进行中，直接返回同一个 Promise（调用方等待同一次 sync 完成）。
   * sync 完成后 syncing 置 null，下次调用可以重新触发。
   */
  async sync(params?: {
    reason?: string; // 触发原因（用于日志，如 "search" / "watch" / "session-start"）
    force?: boolean; // 强制全量重建（忽略文件未变化的优化）
    progress?: (update: MemorySyncProgressUpdate) => void; // 进度回调
  }): Promise<void> {
    if (this.closed) {
      return;
    }
    // 若当前有 sync 在运行，复用同一个 Promise（不重复触发）
    if (this.syncing) {
      return this.syncing;
    }
    // 启动新 sync，完成后清空 syncing（finally 保证即使抛出异常也会清空）
    this.syncing = this.runSyncWithReadonlyRecovery(params).finally(() => {
      this.syncing = null;
    });
    return this.syncing ?? Promise.resolve();
  }

  // ── SQLite 只读错误检测与自动恢复 ────────────────────────────────────────────

  /**
   * 判断错误是否为 SQLite 只读数据库错误。
   * 在 macOS App Sandbox 环境下，文件权限可能在进程运行期间变化，
   * 需要能够自动恢复（关闭并重新打开数据库连接）。
   */
  private isReadonlyDbError(err: unknown): boolean {
    const readonlyPattern =
      /attempt to write a readonly database|database is read-only|SQLITE_READONLY/i;
    const messages = new Set<string>();

    const pushValue = (value: unknown): void => {
      if (typeof value !== "string") {
        return;
      }
      const normalized = value.trim();
      if (!normalized) {
        return;
      }
      messages.add(normalized);
    };

    // 收集错误对象各层级的 message / code / name
    pushValue(err instanceof Error ? err.message : String(err));
    if (err && typeof err === "object") {
      const record = err as Record<string, unknown>;
      pushValue(record.message);
      pushValue(record.code);
      pushValue(record.name);
      // 也检查嵌套的 cause（Node.js Error cause chain）
      if (record.cause && typeof record.cause === "object") {
        const cause = record.cause as Record<string, unknown>;
        pushValue(cause.message);
        pushValue(cause.code);
        pushValue(cause.name);
      }
    }

    return [...messages].some((value) => readonlyPattern.test(value));
  }

  /**
   * 从各种错误类型中提取可读的错误信息字符串。
   */
  private extractErrorReason(err: unknown): string {
    if (err instanceof Error && err.message.trim()) {
      return err.message;
    }
    if (err && typeof err === "object") {
      const record = err as Record<string, unknown>;
      if (typeof record.message === "string" && record.message.trim()) {
        return record.message;
      }
      if (typeof record.code === "string" && record.code.trim()) {
        return record.code;
      }
    }
    return String(err);
  }

  /**
   * 带只读错误自动恢复的 sync 执行器。
   *
   * 流程：
   *   1. 尝试执行 runSync()
   *   2. 若失败且是只读错误 → 关闭并重新打开 SQLite 连接 → 重置向量状态 → 重试一次
   *   3. 重试仍失败 → 抛出异常（记录恢复失败次数）
   */
  private async runSyncWithReadonlyRecovery(params?: {
    reason?: string;
    force?: boolean;
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void> {
    try {
      await this.runSync(params);
      return;
    } catch (err) {
      // 非只读错误或已关闭：直接抛出，不尝试恢复
      if (!this.isReadonlyDbError(err) || this.closed) {
        throw err;
      }
      const reason = this.extractErrorReason(err);
      this.readonlyRecoveryAttempts += 1;
      this.readonlyRecoveryLastError = reason;
      log.warn(`memory sync readonly handle detected; reopening sqlite connection`, { reason });

      // 关闭旧连接（静默处理关闭失败）
      try {
        this.db.close();
      } catch {}

      // 重新打开数据库连接
      this.db = this.openDatabase();

      // 重置向量扩展状态（重新打开连接后需要重新加载扩展）
      this.vectorReady = null;
      this.vector.available = null;
      this.vector.loadError = undefined;

      // 重建 schema（新连接上还没有表结构）
      this.ensureSchema();

      // 从 DB meta 恢复向量维度
      const meta = this.readMeta();
      this.vector.dims = meta?.vectorDims;

      // 重试一次 sync
      try {
        await this.runSync(params);
        this.readonlyRecoverySuccesses += 1;
      } catch (retryErr) {
        this.readonlyRecoveryFailures += 1;
        throw retryErr;
      }
    }
  }

  // ── 文件读取接口（安全沙箱）──────────────────────────────────────────────────

  /**
   * 安全读取工作区内的记忆 Markdown 文件（供 memory_get 工具调用）。
   *
   * 安全策略（防路径穿越攻击）：
   *   1. 路径必须在工作区目录内（不允许 "../" 逃出工作区）
   *   2. 路径必须满足 isMemoryPath()（仅允许 MEMORY.md 和 memory/*.md）
   *   3. 或者路径在配置的 extraPaths 白名单内（支持额外挂载的记忆目录）
   *   4. 符号链接（symlink）一律拒绝（防止通过 symlink 读取任意文件）
   *   5. 文件扩展名必须为 .md
   *
   * 文件不存在时优雅降级：返回 { text: "", path } 而非抛出 ENOENT，
   * 让 agent 能处理"今天还没有记忆文件"的情况。
   *
   * @param params.relPath 相对于工作区的路径（或绝对路径）
   * @param params.from 起始行号（1-indexed），可选
   * @param params.lines 读取行数，可选
   */
  async readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ text: string; path: string }> {
    const rawPath = params.relPath.trim();
    if (!rawPath) {
      throw new Error("path required");
    }

    // 路径规范化：相对路径基于工作区目录解析；绝对路径直接使用
    const absPath = path.isAbsolute(rawPath)
      ? path.resolve(rawPath)
      : path.resolve(this.workspaceDir, rawPath);

    // 计算相对于工作区的路径，用于权限检查
    const relPath = path.relative(this.workspaceDir, absPath).replace(/\\/g, "/");

    // 检查路径是否在工作区内（relPath 不以 ".." 开头且不是绝对路径）
    const inWorkspace =
      relPath.length > 0 && !relPath.startsWith("..") && !path.isAbsolute(relPath);

    // 检查是否是允许的记忆路径（MEMORY.md 或 memory/ 目录下的文件）
    const allowedWorkspace = inWorkspace && isMemoryPath(relPath);

    // 若不在工作区允许路径内，检查 extraPaths 白名单
    let allowedAdditional = false;
    if (!allowedWorkspace && this.settings.extraPaths.length > 0) {
      const additionalPaths = normalizeExtraMemoryPaths(
        this.workspaceDir,
        this.settings.extraPaths,
      );
      for (const additionalPath of additionalPaths) {
        try {
          const stat = await fs.lstat(additionalPath);
          // 拒绝符号链接，防止通过 symlink 读取工作区外的文件
          if (stat.isSymbolicLink()) {
            continue;
          }
          if (stat.isDirectory()) {
            // 目标路径在此额外目录下（或就是此目录本身）
            if (absPath === additionalPath || absPath.startsWith(`${additionalPath}${path.sep}`)) {
              allowedAdditional = true;
              break;
            }
            continue;
          }
          if (stat.isFile()) {
            // 额外路径直接指向单个 .md 文件
            if (absPath === additionalPath && absPath.endsWith(".md")) {
              allowedAdditional = true;
              break;
            }
          }
        } catch {}
      }
    }

    // 路径不在任何允许范围内：拒绝访问（故意使用通用错误信息，不暴露具体原因）
    if (!allowedWorkspace && !allowedAdditional) {
      throw new Error("path required");
    }

    // 强制要求 .md 扩展名（防止读取 .env、.json 等非记忆文件）
    if (!absPath.endsWith(".md")) {
      throw new Error("path required");
    }

    // 文件存在性检查（graceful degradation：文件不存在返回空字符串）
    const statResult = await statRegularFile(absPath);
    if (statResult.missing) {
      return { text: "", path: relPath };
    }

    let content: string;
    try {
      content = await fs.readFile(absPath, "utf-8");
    } catch (err) {
      // ENOENT（文件在 stat 和 readFile 之间被删除）也优雅降级
      if (isFileMissingError(err)) {
        return { text: "", path: relPath };
      }
      throw err;
    }

    // 无行号限制：返回全部内容
    if (!params.from && !params.lines) {
      return { text: content, path: relPath };
    }

    // 行号切片（1-indexed）
    const lines = content.split("\n");
    const start = Math.max(1, params.from ?? 1);
    const count = Math.max(1, params.lines ?? lines.length);
    const slice = lines.slice(start - 1, start - 1 + count);
    return { text: slice.join("\n"), path: relPath };
  }

  // ── 状态快照 ──────────────────────────────────────────────────────────────────

  /**
   * 返回当前记忆索引的运行状态快照（用于 `openclaw memory status` 命令和健康检查）。
   *
   * 包含：文件数/块数、provider 信息、FTS/向量可用性、批处理状态、
   * 只读恢复统计、embedding 缓存条目数等。
   */
  status(): MemoryProviderStatus {
    const sourceFilter = this.buildSourceFilter();

    // 统计已索引的文件总数（按来源过滤）
    const files = this.db
      .prepare(`SELECT COUNT(*) as c FROM files WHERE 1=1${sourceFilter.sql}`)
      .get(...sourceFilter.params) as {
      c: number;
    };

    // 统计已索引的文本块总数
    const chunks = this.db
      .prepare(`SELECT COUNT(*) as c FROM chunks WHERE 1=1${sourceFilter.sql}`)
      .get(...sourceFilter.params) as {
      c: number;
    };

    // 按来源（memory / sessions）分别统计文件数和块数
    const sourceCounts = (() => {
      const sources = Array.from(this.sources);
      if (sources.length === 0) {
        return [];
      }
      const bySource = new Map<MemorySource, { files: number; chunks: number }>();
      for (const source of sources) {
        bySource.set(source, { files: 0, chunks: 0 });
      }
      const fileRows = this.db
        .prepare(
          `SELECT source, COUNT(*) as c FROM files WHERE 1=1${sourceFilter.sql} GROUP BY source`,
        )
        .all(...sourceFilter.params) as Array<{ source: MemorySource; c: number }>;
      for (const row of fileRows) {
        const entry = bySource.get(row.source) ?? { files: 0, chunks: 0 };
        entry.files = row.c ?? 0;
        bySource.set(row.source, entry);
      }
      const chunkRows = this.db
        .prepare(
          `SELECT source, COUNT(*) as c FROM chunks WHERE 1=1${sourceFilter.sql} GROUP BY source`,
        )
        .all(...sourceFilter.params) as Array<{ source: MemorySource; c: number }>;
      for (const row of chunkRows) {
        const entry = bySource.get(row.source) ?? { files: 0, chunks: 0 };
        entry.chunks = row.c ?? 0;
        bySource.set(row.source, entry);
      }
      return sources.map((source) => Object.assign({ source }, bySource.get(source)!));
    })();

    // 搜索模式：无 provider 时为 fts-only，有 provider 时为 hybrid
    const searchMode = this.provider ? "hybrid" : "fts-only";
    const providerInfo = this.provider
      ? { provider: this.provider.id, model: this.provider.model }
      : { provider: "none", model: undefined };

    return {
      backend: "builtin",
      files: files?.c ?? 0,
      chunks: chunks?.c ?? 0,
      dirty: this.dirty || this.sessionsDirty,
      workspaceDir: this.workspaceDir,
      dbPath: this.settings.store.path,
      provider: providerInfo.provider,
      model: providerInfo.model,
      requestedProvider: this.requestedProvider,
      sources: Array.from(this.sources),
      extraPaths: this.settings.extraPaths,
      sourceCounts,
      cache: this.cache.enabled
        ? {
            enabled: true,
            entries:
              (
                this.db.prepare(`SELECT COUNT(*) as c FROM ${EMBEDDING_CACHE_TABLE}`).get() as
                  | { c: number }
                  | undefined
              )?.c ?? 0,
            maxEntries: this.cache.maxEntries,
          }
        : { enabled: false, maxEntries: this.cache.maxEntries },
      fts: {
        enabled: this.fts.enabled,
        available: this.fts.available,
        error: this.fts.loadError,
      },
      fallback: this.fallbackReason
        ? { from: this.fallbackFrom ?? "local", reason: this.fallbackReason }
        : undefined,
      vector: {
        enabled: this.vector.enabled,
        available: this.vector.available ?? undefined,
        extensionPath: this.vector.extensionPath,
        loadError: this.vector.loadError,
        dims: this.vector.dims,
      },
      batch: {
        enabled: this.batch.enabled,
        failures: this.batchFailureCount,
        limit: BATCH_FAILURE_LIMIT,
        wait: this.batch.wait,
        concurrency: this.batch.concurrency,
        pollIntervalMs: this.batch.pollIntervalMs,
        timeoutMs: this.batch.timeoutMs,
        lastError: this.batchFailureLastError,
        lastProvider: this.batchFailureLastProvider,
      },
      custom: {
        searchMode,
        providerUnavailableReason: this.providerUnavailableReason,
        // 只读错误自动恢复统计（运维诊断用）
        readonlyRecovery: {
          attempts: this.readonlyRecoveryAttempts,
          successes: this.readonlyRecoverySuccesses,
          failures: this.readonlyRecoveryFailures,
          lastError: this.readonlyRecoveryLastError,
        },
      },
    };
  }

  // ── 探针方法（用于健康检查）──────────────────────────────────────────────────

  /**
   * 探测向量搜索是否可用（触发 sqlite-vec 扩展延迟加载）。
   * FTS-only 模式或向量功能未开启时直接返回 false。
   */
  async probeVectorAvailability(): Promise<boolean> {
    if (!this.provider) {
      return false;
    }
    if (!this.vector.enabled) {
      return false;
    }
    return this.ensureVectorReady();
  }

  /**
   * 探测 embedding provider 是否可用（发送 "ping" 文本测试 API 连通性）。
   * FTS-only 模式：返回 ok=false 但 search() 仍可正常工作。
   */
  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    if (!this.provider) {
      return {
        ok: false,
        error: this.providerUnavailableReason ?? "No embedding provider available (FTS-only mode)",
      };
    }
    try {
      // 发送最小 batch（["ping"]）测试 API 是否正常响应
      await this.embedBatchWithRetry(["ping"]);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  }

  // ── 生命周期：关闭 ────────────────────────────────────────────────────────────

  /**
   * 优雅关闭 MemoryIndexManager：
   *   1. 标记为已关闭（防止新的 sync 启动）
   *   2. 清理所有定时器
   *   3. 关闭文件 watcher（chokidar）
   *   4. 取消 session 事件订阅
   *   5. 等待正在进行的 sync 完成（避免 DB 连接在 sync 中途被关闭）
   *   6. 关闭 SQLite 数据库连接
   *   7. 从进程级缓存中移除自身
   */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;

    // 保存 syncing 引用：置 closed=true 后父类不会启动新 sync，
    // 但已经在运行的 sync 需要等待它完成
    const pendingSync = this.syncing;

    // 清理文件变化防抖定时器
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
      this.watchTimer = null;
    }

    // 清理 session 文件变化防抖定时器
    if (this.sessionWatchTimer) {
      clearTimeout(this.sessionWatchTimer);
      this.sessionWatchTimer = null;
    }

    // 清理定时强制 sync 的 interval
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }

    // 关闭 chokidar 文件 watcher（异步，等待完成）
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }

    // 取消 session 转录事件订阅
    if (this.sessionUnsubscribe) {
      this.sessionUnsubscribe();
      this.sessionUnsubscribe = null;
    }

    // 等待正在进行的 sync 完成（静默处理 sync 失败，因为我们正在关闭）
    if (pendingSync) {
      try {
        await pendingSync;
      } catch {}
    }

    // 关闭 SQLite 连接（所有写操作已完成）
    this.db.close();

    // 从进程级单例缓存中移除（释放引用，允许 GC 回收）
    INDEX_CACHE.delete(this.cacheKey);
  }
}
