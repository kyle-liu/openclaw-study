// ============================================================================
// memory/manager-sync-ops.ts
//
// 这是记忆索引系统中的“同步层 / 重建层”抽象基类。
// 它位于继承链的中间位置：
//
//   MemoryIndexManager
//     -> MemoryManagerEmbeddingOps
//       -> MemoryManagerSyncOps   <- 当前文件
//
// 当前类主要负责：
//   1. 管理 SQLite 索引库的打开、schema 初始化、元数据读写
//   2. 管理 sqlite-vec 扩展加载，以及向量表的创建/重建
//   3. 监听 memory markdown 与 session transcript 的变化
//   4. 根据 dirty 标志决定做增量同步还是全量重建
//   5. 在 provider / chunk 配置变化时安全重建整个索引库
//
// 上层的 `MemoryManagerEmbeddingOps` 负责“如何生成 embedding 并写入 chunks”；
// 当前文件负责“什么时候同步、同步哪些文件、重建数据库时如何保证安全”。
// ============================================================================

import { randomUUID } from "node:crypto"; // 为临时数据库和备份文件生成唯一后缀
import fsSync from "node:fs"; // 仅在 watcher 初始化时做同步 lstat，便于快速判定路径类型
import fs from "node:fs/promises"; // 异步文件系统 API，用于 rename/stat/rm/open 等操作
import path from "node:path"; // 路径拼接、规范化、目录层级判断
import type { DatabaseSync } from "node:sqlite"; // Node.js 22+ 内置同步 SQLite 连接
import chokidar, { FSWatcher } from "chokidar"; // 跨平台文件监听器
import { resolveAgentDir } from "../agents/agent-scope.js"; // 解析 agent 私有目录，fallback provider 初始化会用到
import { ResolvedMemorySearchConfig } from "../agents/memory-search.js"; // 已归一化的 memory 配置类型
import { type OpenClawConfig } from "../config/config.js"; // OpenClaw 全局配置类型
import { resolveSessionTranscriptsDirForAgent } from "../config/sessions/paths.js"; // 解析某个 agent 的 transcript 目录
import { createSubsystemLogger } from "../logging/subsystem.js"; // 创建 memory 子系统日志器
import { onSessionTranscriptUpdate } from "../sessions/transcript-events.js"; // 订阅 transcript 更新事件
import { resolveUserPath } from "../utils.js"; // 解析带 ~ 的用户路径
import { DEFAULT_GEMINI_EMBEDDING_MODEL } from "./embeddings-gemini.js"; // Gemini 默认 embedding 模型
import { DEFAULT_MISTRAL_EMBEDDING_MODEL } from "./embeddings-mistral.js"; // Mistral 默认 embedding 模型
import { DEFAULT_OLLAMA_EMBEDDING_MODEL } from "./embeddings-ollama.js"; // Ollama 默认 embedding 模型
import { DEFAULT_OPENAI_EMBEDDING_MODEL } from "./embeddings-openai.js"; // OpenAI 默认 embedding 模型
import { DEFAULT_VOYAGE_EMBEDDING_MODEL } from "./embeddings-voyage.js"; // Voyage 默认 embedding 模型
import {
  createEmbeddingProvider,
  type EmbeddingProvider,
  type GeminiEmbeddingClient,
  type MistralEmbeddingClient,
  type OllamaEmbeddingClient,
  type OpenAiEmbeddingClient,
  type VoyageEmbeddingClient,
} from "./embeddings.js"; // provider 工厂与不同厂商客户端类型
import { isFileMissingError } from "./fs-utils.js"; // 判断文件不存在错误，避免把正常删除当异常
import {
  buildFileEntry,
  ensureDir,
  listMemoryFiles,
  normalizeExtraMemoryPaths,
  runWithConcurrency,
} from "./internal.js"; // memory 文件枚举、目录保证、并发执行等底层工具
import { type MemoryFileEntry } from "./internal.js"; // memory markdown 文件的索引描述对象
import { ensureMemoryIndexSchema } from "./memory-schema.js"; // 创建/校验 SQLite schema
import type { SessionFileEntry } from "./session-files.js"; // session transcript 文件的索引描述对象
import {
  buildSessionEntry,
  listSessionFilesForAgent,
  sessionPathForFile,
} from "./session-files.js"; // session 文件列表、路径归一、entry 构建
import { loadSqliteVecExtension } from "./sqlite-vec.js"; // 动态加载 sqlite-vec 扩展
import { requireNodeSqlite } from "./sqlite.js"; // 延迟获取 node:sqlite，兼容运行环境
import type { MemorySource, MemorySyncProgressUpdate } from "./types.js"; // 公共 memory 类型

// 索引元数据：写入 meta 表，用来判断当前数据库是否还能复用。
// 对应索引元数据的memory_index_meta_v1结构
// 是记忆索引的配置指纹快照，不是记忆内容本身；它决定的是“索引是否需要重建”，而不是“索引里存了什么文本”。
// 一旦 provider / model / chunking / sources 变了，就需要全量重建。
type MemoryIndexMeta = {
  model: string; // 生成 embedding 时使用的模型名
  provider: string; // 当前索引实际使用的 provider
  providerKey?: string; // provider 的更细粒度指纹（包含 endpoint、mode 等）
  sources?: MemorySource[]; // 当前索引包含了哪些数据源
  chunkTokens: number; // 分块 token 大小
  chunkOverlap: number; // 分块重叠大小
  vectorDims?: number; // 向量维度；若存在表示向量表已经按此维度建好
};

// 同步进度状态：对外暴露的是轻量 update，这里内部保留累计状态与 report 函数。
type MemorySyncProgressState = {
  completed: number; // 已处理文件数
  total: number; // 总文件数
  label?: string; // 当前阶段标签，例如 “Indexing session files…”
  report: (update: MemorySyncProgressUpdate) => void; // 统一上报进度的回调
};

// meta 表里使用的固定 key，升级元数据结构时可通过改版本号强制重新识别。
const META_KEY = "memory_index_meta_v1";
// sqlite-vec 虚拟表名。
const VECTOR_TABLE = "chunks_vec";
// FTS5 全文索引表名。
const FTS_TABLE = "chunks_fts";
// embedding 缓存表名。
const EMBEDDING_CACHE_TABLE = "embedding_cache";
// session 更新事件的防抖时间，避免每次 transcript 追加一行就触发一次同步。
const SESSION_DIRTY_DEBOUNCE_MS = 5000;
// 统计 session 增量中的换行数时，每次读取的块大小。
const SESSION_DELTA_READ_CHUNK_BYTES = 64 * 1024;
// sqlite-vec 扩展加载超时时间。
const VECTOR_LOAD_TIMEOUT_MS = 30_000;
const IGNORED_MEMORY_WATCH_DIR_NAMES = new Set([
  ".git", // Git 元数据目录
  "node_modules", // 依赖目录，避免大规模无意义监听
  ".pnpm-store", // pnpm 全局缓存目录
  ".venv", // Python 虚拟环境目录
  "venv", // Python 虚拟环境目录的常见别名
  ".tox", // Python tox 测试目录
  "__pycache__", // Python 字节码缓存目录
]);

// 当前子系统统一日志器。
const log = createSubsystemLogger("memory");

// watcher 过滤规则：只要路径中任一段命中忽略目录名，就跳过监听。
function shouldIgnoreMemoryWatchPath(watchPath: string): boolean {
  const normalized = path.normalize(watchPath); // 先把路径分隔符统一成当前平台风格
  const parts = normalized.split(path.sep).map((segment) => segment.trim().toLowerCase()); // 逐段做大小写归一化
  return parts.some((segment) => IGNORED_MEMORY_WATCH_DIR_NAMES.has(segment)); // 任一目录命中即忽略
}

// 抽象同步层：定义状态字段与同步流程骨架，具体 embedding 写入逻辑交给子类实现。
export abstract class MemoryManagerSyncOps {
  // ── 基础上下文 ────────────────────────────────────────────────────────────────
  protected abstract readonly cfg: OpenClawConfig; // 全局配置
  protected abstract readonly agentId: string; // 当前所属 agent
  protected abstract readonly workspaceDir: string; // 工作区目录
  protected abstract readonly settings: ResolvedMemorySearchConfig; // 已解析的 memory 配置

  // ── Embedding provider 运行时状态 ────────────────────────────────────────────
  protected provider: EmbeddingProvider | null = null; // 当前真正生效的 provider；FTS-only 时为 null
  protected fallbackFrom?: "openai" | "local" | "gemini" | "voyage" | "mistral" | "ollama"; // 若发生降级，记录原 provider
  protected openAi?: OpenAiEmbeddingClient; // OpenAI embedding 客户端
  protected gemini?: GeminiEmbeddingClient; // Gemini embedding 客户端
  protected voyage?: VoyageEmbeddingClient; // Voyage embedding 客户端
  protected mistral?: MistralEmbeddingClient; // Mistral embedding 客户端
  protected ollama?: OllamaEmbeddingClient; // Ollama embedding 客户端

  // ── 批处理配置 ────────────────────────────────────────────────────────────────
  protected abstract batch: {
    enabled: boolean;
    wait: boolean; // 是否等待远程批处理任务完成
    concurrency: number; // 并发批任务数
    pollIntervalMs: number; // 轮询远程批任务状态的间隔
    timeoutMs: number; // 单个批任务的超时上限
  };

  // ── 数据来源与 provider 指纹 ────────────────────────────────────────────────
  protected readonly sources: Set<MemorySource> = new Set(); // 当前索引包含的 source 集合
  protected providerKey: string | null = null; // provider 的唯一指纹，用来判断是否需要重建

  // ── 向量 / FTS 能力状态 ─────────────────────────────────────────────────────
  protected abstract readonly vector: {
    enabled: boolean;
    available: boolean | null; // null=未检查；true=可用；false=不可用
    extensionPath?: string; // 用户配置或探测到的 sqlite-vec 扩展路径
    loadError?: string; // 最近一次加载失败原因
    dims?: number; // 当前向量表维度
  };
  protected readonly fts: {
    enabled: boolean;
    available: boolean; // 当前 SQLite 连接是否支持 FTS
    loadError?: string; // FTS 初始化失败原因
  } = { enabled: false, available: false };

  // ── watcher / timer / dirty 状态 ───────────────────────────────────────────
  protected vectorReady: Promise<boolean> | null = null; // 缓存 sqlite-vec 加载中的 Promise，避免重复并发加载
  protected watcher: FSWatcher | null = null; // memory 文件 watcher
  protected watchTimer: NodeJS.Timeout | null = null; // memory 文件变化防抖定时器
  protected sessionWatchTimer: NodeJS.Timeout | null = null; // session 变化防抖定时器
  protected sessionUnsubscribe: (() => void) | null = null; // transcript 事件取消订阅函数
  protected fallbackReason?: string; // 触发 fallback 的原始错误原因
  protected intervalTimer: NodeJS.Timeout | null = null; // 周期性强制同步的定时器
  protected closed = false; // manager 是否已关闭
  protected dirty = false; // memory 文件是否有待同步变化
  protected sessionsDirty = false; // session 文件是否有待同步变化
  protected sessionsDirtyFiles = new Set<string>(); // 已达到阈值、需要重建索引的 session 文件集合
  protected sessionPendingFiles = new Set<string>(); // 正在防抖等待的一批 session 文件
  protected sessionDeltas = new Map<
    string,
    { lastSize: number; pendingBytes: number; pendingMessages: number }
  >(); // 每个 session 文件的增量统计状态
  private lastMetaSerialized: string | null = null; // 最近一次写入/读取的 meta JSON，避免重复写库

  // ── 需要子类提供的能力 ───────────────────────────────────────────────────────
  protected abstract readonly cache: { enabled: boolean; maxEntries?: number }; // embedding 缓存配置
  protected abstract db: DatabaseSync; // 当前 SQLite 连接
  protected abstract computeProviderKey(): string; // 计算 provider 指纹
  protected abstract sync(params?: {
    reason?: string;
    force?: boolean;
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void>; // 对外暴露的同步入口；子类通常会加锁后调用 runSync()
  protected abstract withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string,
  ): Promise<T>; // 给异步调用包一层超时保护
  protected abstract getIndexConcurrency(): number; // 计算索引阶段允许的并发度
  protected abstract pruneEmbeddingCacheIfNeeded(): void; // 必要时清理过大的 embedding cache
  protected abstract indexFile(
    entry: MemoryFileEntry | SessionFileEntry,
    options: { source: MemorySource; content?: string },
  ): Promise<void>; // 子类真正执行“分块 + 生成 embedding + 写入数据库”的地方

  /**
   * 确保向量扩展已就绪。
   *
   * 这里做了两件事：
   * 1. 懒加载 sqlite-vec 扩展，并把 Promise 缓存到 `vectorReady`
   * 2. 如果已经知道 embedding 维度，则顺手确保向量表存在且维度匹配
   */
  protected async ensureVectorReady(dimensions?: number): Promise<boolean> {
    // 如果配置明确关闭向量功能，直接返回 false。
    if (!this.vector.enabled) {
      return false;
    }
    // 首次调用时才真正触发扩展加载；后续共用同一个 Promise。
    if (!this.vectorReady) {
      this.vectorReady = this.withTimeout(
        this.loadVectorExtension(),
        VECTOR_LOAD_TIMEOUT_MS,
        `sqlite-vec load timed out after ${Math.round(VECTOR_LOAD_TIMEOUT_MS / 1000)}s`,
      );
    }
    let ready = false;
    try {
      // 等待扩展加载完成；若失败会进入 catch。
      ready = (await this.vectorReady) || false;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.vector.available = false;
      this.vector.loadError = message;
      this.vectorReady = null; // 允许下一次重试加载
      log.warn(`sqlite-vec unavailable: ${message}`);
      return false;
    }
    // 扩展可用且已知向量维度时，确保虚拟向量表已经创建。
    if (ready && typeof dimensions === "number" && dimensions > 0) {
      this.ensureVectorTable(dimensions);
    }
    return ready;
  }

  // 真正执行 sqlite-vec 动态加载；结果会写回 `this.vector` 状态对象。
  private async loadVectorExtension(): Promise<boolean> {
    // available !== null 说明之前已经探测过，直接复用结果即可。
    if (this.vector.available !== null) {
      return this.vector.available;
    }
    if (!this.vector.enabled) {
      this.vector.available = false;
      return false;
    }
    try {
      // 若用户配置了扩展路径，先展开 ~ 等用户目录写法。
      const resolvedPath = this.vector.extensionPath?.trim()
        ? resolveUserPath(this.vector.extensionPath)
        : undefined;
      const loaded = await loadSqliteVecExtension({ db: this.db, extensionPath: resolvedPath });
      if (!loaded.ok) {
        throw new Error(loaded.error ?? "unknown sqlite-vec load error");
      }
      this.vector.extensionPath = loaded.extensionPath; // 记录最终实际使用的扩展路径
      this.vector.available = true;
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.vector.available = false;
      this.vector.loadError = message;
      log.warn(`sqlite-vec unavailable: ${message}`);
      return false;
    }
  }

  // 确保向量虚拟表存在且维度正确；维度变化时需要先删后建。
  private ensureVectorTable(dimensions: number): void {
    // 已经是目标维度就不用重复建表。
    if (this.vector.dims === dimensions) {
      return;
    }
    // 旧维度与新维度不一致时，原表结构已不可复用，只能重建。
    if (this.vector.dims && this.vector.dims !== dimensions) {
      this.dropVectorTable();
    }
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${VECTOR_TABLE} USING vec0(\n` +
        `  id TEXT PRIMARY KEY,\n` +
        `  embedding FLOAT[${dimensions}]\n` +
        `)`,
    );
    this.vector.dims = dimensions;
  }

  // 删除向量表；通常发生在维度变化或全量重建时。
  private dropVectorTable(): void {
    try {
      this.db.exec(`DROP TABLE IF EXISTS ${VECTOR_TABLE}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.debug(`Failed to drop ${VECTOR_TABLE}: ${message}`);
    }
  }

  // 构造 SQL source 过滤片段，供搜索查询或清理逻辑复用。
  protected buildSourceFilter(alias?: string): { sql: string; params: MemorySource[] } {
    const sources = Array.from(this.sources);
    if (sources.length === 0) {
      return { sql: "", params: [] };
    }
    const column = alias ? `${alias}.source` : "source"; // 支持 `t.source` 这种带别名写法
    const placeholders = sources.map(() => "?").join(", "); // 为预编译 SQL 生成 ?, ?, ? 占位符
    return { sql: ` AND ${column} IN (${placeholders})`, params: sources };
  }

  // 使用配置中的索引库路径打开数据库。
  protected openDatabase(): DatabaseSync {
    const dbPath = resolveUserPath(this.settings.store.path); // 把用户路径解析成绝对路径
    return this.openDatabaseAtPath(dbPath);
  }

  // 打开指定路径上的 SQLite 数据库，并设置一些连接级参数。
  private openDatabaseAtPath(dbPath: string): DatabaseSync {
    const dir = path.dirname(dbPath);
    ensureDir(dir); // 数据库目录不存在时先创建
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(dbPath, { allowExtension: this.settings.store.vector.enabled }); // 只有允许向量扩展时才开启 extension 能力
    // busy_timeout is per-connection and resets to 0 on restart.
    // Set it on every open so concurrent processes retry instead of
    // failing immediately with SQLITE_BUSY.
    db.exec("PRAGMA busy_timeout = 5000");
    return db;
  }

  // 全量安全重建时，把旧库中的 embedding cache 复制到新库，避免全部重新请求远程 embedding。
  private seedEmbeddingCache(sourceDb: DatabaseSync): void {
    if (!this.cache.enabled) {
      return;
    }
    try {
      const rows = sourceDb
        .prepare(
          `SELECT provider, model, provider_key, hash, embedding, dims, updated_at FROM ${EMBEDDING_CACHE_TABLE}`,
        )
        .all() as Array<{
        provider: string;
        model: string;
        provider_key: string;
        hash: string;
        embedding: string;
        dims: number | null;
        updated_at: number;
      }>;
      if (!rows.length) {
        return;
      }
      const insert = this.db.prepare(
        `INSERT INTO ${EMBEDDING_CACHE_TABLE} (provider, model, provider_key, hash, embedding, dims, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider, model, provider_key, hash) DO UPDATE SET
           embedding=excluded.embedding,
           dims=excluded.dims,
           updated_at=excluded.updated_at`,
      );
      this.db.exec("BEGIN"); // 手动事务包裹，减少写放大并保证拷贝的一致性
      for (const row of rows) {
        insert.run(
          row.provider,
          row.model,
          row.provider_key,
          row.hash,
          row.embedding,
          row.dims,
          row.updated_at,
        );
      }
      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw err;
    }
  }

  // 用“备份 -> 替换 -> 删除备份”的方式原子切换索引数据库。
  private async swapIndexFiles(targetPath: string, tempPath: string): Promise<void> {
    const backupPath = `${targetPath}.backup-${randomUUID()}`; // 先把当前正式库移到临时备份位置
    await this.moveIndexFiles(targetPath, backupPath);
    try {
      await this.moveIndexFiles(tempPath, targetPath); // 再把新库提升为正式库
    } catch (err) {
      await this.moveIndexFiles(backupPath, targetPath); // 新库切换失败时回滚到旧库
      throw err;
    }
    await this.removeIndexFiles(backupPath); // 切换成功后清理备份文件
  }

  // 移动 SQLite 主文件以及 WAL/SHM 配套文件。
  private async moveIndexFiles(sourceBase: string, targetBase: string): Promise<void> {
    const suffixes = ["", "-wal", "-shm"];
    for (const suffix of suffixes) {
      const source = `${sourceBase}${suffix}`;
      const target = `${targetBase}${suffix}`;
      try {
        await fs.rename(source, target);
      } catch (err) {
        // 某些附属文件可能不存在，例如没有开启 WAL；这种情况可以忽略。
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          throw err;
        }
      }
    }
  }

  // 删除 SQLite 主文件及其 WAL/SHM 配套文件。
  private async removeIndexFiles(basePath: string): Promise<void> {
    const suffixes = ["", "-wal", "-shm"];
    await Promise.all(suffixes.map((suffix) => fs.rm(`${basePath}${suffix}`, { force: true })));
  }

  // 确保表结构存在，并同步更新 FTS 可用性状态。
  protected ensureSchema() {
    // schema 初始化函数会负责创建 files / chunks / meta / embedding_cache / FTS 等表。
    const result = ensureMemoryIndexSchema({
      db: this.db,
      embeddingCacheTable: EMBEDDING_CACHE_TABLE,
      ftsTable: FTS_TABLE,
      ftsEnabled: this.fts.enabled,
    });
    this.fts.available = result.ftsAvailable; // 记录当前连接下 FTS 是否真正可用
    if (result.ftsError) {
      this.fts.loadError = result.ftsError; // 保留错误信息，便于 status/debug 输出
      // Only warn when hybrid search is enabled; otherwise this is expected noise.
      if (this.fts.enabled) {
        log.warn(`fts unavailable: ${result.ftsError}`);
      }
    }
  }

  // 为 memory markdown 文件建立 chokidar watcher。
  protected ensureWatcher() {
    // 只在：
    // 1. sources 含有 memory
    // 2. 配置开启 watch
    // 3. 当前尚未创建 watcher
    // 时才初始化。
    if (!this.sources.has("memory") || !this.settings.sync.watch || this.watcher) {
      return;
    }
    // 默认监听 workspace 根目录的 MEMORY.md / memory.md，以及 memory/**/*.md。
    const watchPaths = new Set<string>([
      path.join(this.workspaceDir, "MEMORY.md"),
      path.join(this.workspaceDir, "memory.md"),
      path.join(this.workspaceDir, "memory", "**", "*.md"),
    ]);
    // 额外路径允许把工作区外或其他目录中的 markdown 一并纳入 memory 索引。
    const additionalPaths = normalizeExtraMemoryPaths(this.workspaceDir, this.settings.extraPaths);
    for (const entry of additionalPaths) {
      try {
        // 这里使用同步 lstat，是因为初始化 watcher 的时机很少，代码更直接。
        const stat = fsSync.lstatSync(entry);
        // 出于安全和稳定性考虑，忽略符号链接。
        if (stat.isSymbolicLink()) {
          continue;
        }
        // 目录要转成 glob 规则；文件则直接加入单文件监听。
        if (stat.isDirectory()) {
          watchPaths.add(path.join(entry, "**", "*.md"));
          continue;
        }
        if (stat.isFile() && entry.toLowerCase().endsWith(".md")) {
          watchPaths.add(entry);
        }
      } catch {
        // Skip missing/unreadable additional paths.
      }
    }
    // ignoreInitial=true：启动 watcher 时不把现有文件当成“新文件”事件触发。
    // awaitWriteFinish：等待文件写稳定后再触发 change，避免半写入状态就开始索引。
    this.watcher = chokidar.watch(Array.from(watchPaths), {
      ignoreInitial: true,
      ignored: (watchPath) => shouldIgnoreMemoryWatchPath(String(watchPath)),
      awaitWriteFinish: {
        stabilityThreshold: this.settings.sync.watchDebounceMs,
        pollInterval: 100,
      },
    });
    // 文件新增、修改、删除都只做一件事：标记 dirty，然后交给防抖调度器统一同步。
    const markDirty = () => {
      this.dirty = true;
      this.scheduleWatchSync();
    };
    this.watcher.on("add", markDirty);
    this.watcher.on("change", markDirty);
    this.watcher.on("unlink", markDirty);
  }

  // 为 session transcript 建立事件订阅，而不是直接扫目录 watcher。
  protected ensureSessionListener() {
    // 只有索引来源里包含 sessions，且尚未订阅时才创建监听器。
    if (!this.sources.has("sessions") || this.sessionUnsubscribe) {
      return;
    }
    this.sessionUnsubscribe = onSessionTranscriptUpdate((update) => {
      // manager 已关闭后，不再响应新的 transcript 事件。
      if (this.closed) {
        return;
      }
      const sessionFile = update.sessionFile;
      // 多 agent 共享进程时，只处理属于当前 agent transcript 目录的文件。
      if (!this.isSessionFileForAgent(sessionFile)) {
        return;
      }
      // transcript 更新只先入队，真正是否触发索引由增量阈值逻辑决定。
      this.scheduleSessionDirty(sessionFile);
    });
  }

  // session 文件更新后的防抖入口：把文件收集进 pending 集合，延迟批量处理。
  private scheduleSessionDirty(sessionFile: string) {
    this.sessionPendingFiles.add(sessionFile); // Set 自动去重，同一文件多次更新只保留一份
    // 已经有一个防抖计时器在跑，就不用重复启动。
    if (this.sessionWatchTimer) {
      return;
    }
    this.sessionWatchTimer = setTimeout(() => {
      this.sessionWatchTimer = null; // 计时器触发后立即清空，允许下一轮重新调度
      void this.processSessionDeltaBatch().catch((err) => {
        log.warn(`memory session delta failed: ${String(err)}`);
      });
    }, SESSION_DIRTY_DEBOUNCE_MS);
  }

  // 批量处理这一轮积累的 transcript 变化，并根据阈值决定是否触发一次 session 索引同步。
  private async processSessionDeltaBatch(): Promise<void> {
    if (this.sessionPendingFiles.size === 0) {
      return;
    }
    const pending = Array.from(this.sessionPendingFiles); // 固定这一轮待处理列表
    this.sessionPendingFiles.clear(); // 先清空，新的更新进入下一轮
    let shouldSync = false; // 只要任一文件达到阈值，就触发一次统一 sync
    for (const sessionFile of pending) {
      // 读取该文件当前累计增量状态（新增字节数 / 新增消息数）。
      const delta = await this.updateSessionDelta(sessionFile);
      if (!delta) {
        continue;
      }
      const bytesThreshold = delta.deltaBytes;
      const messagesThreshold = delta.deltaMessages;
      // deltaBytes <= 0 表示“只要有新增字节就算命中”。
      const bytesHit =
        bytesThreshold <= 0 ? delta.pendingBytes > 0 : delta.pendingBytes >= bytesThreshold;
      // deltaMessages <= 0 表示“只要有新增消息就算命中”。
      const messagesHit =
        messagesThreshold <= 0
          ? delta.pendingMessages > 0
          : delta.pendingMessages >= messagesThreshold;
      // 字节和消息两个阈值都没命中，则继续累计，下次再判断。
      if (!bytesHit && !messagesHit) {
        continue;
      }
      this.sessionsDirtyFiles.add(sessionFile); // 记录这个文件已经值得重新索引
      this.sessionsDirty = true; // 全局 session dirty 标志，用于 runSync 中做总判断
      // 触发一次索引后，不一定把 pending 全部清零，而是扣减掉已消费的阈值，
      // 这样连续大文件追加时，后续增量还能继续累计触发更多次更新。
      delta.pendingBytes =
        bytesThreshold > 0 ? Math.max(0, delta.pendingBytes - bytesThreshold) : 0;
      delta.pendingMessages =
        messagesThreshold > 0 ? Math.max(0, delta.pendingMessages - messagesThreshold) : 0;
      shouldSync = true;
    }
    // 这一轮只触发一次 sync，让多个脏文件在一次同步流程中统一处理。
    if (shouldSync) {
      void this.sync({ reason: "session-delta" }).catch((err) => {
        log.warn(`memory sync failed (session-delta): ${String(err)}`);
      });
    }
  }

  // 更新某个 session transcript 的“增量统计状态”。
  // 返回的是阈值 + 当前累计值，供上层判断是否需要实际索引。
  private async updateSessionDelta(sessionFile: string): Promise<{
    deltaBytes: number;
    deltaMessages: number;
    pendingBytes: number;
    pendingMessages: number;
  } | null> {
    const thresholds = this.settings.sync.sessions; // 会话同步的阈值配置
    if (!thresholds) {
      return null;
    }
    let stat: { size: number };
    try {
      stat = await fs.stat(sessionFile);
    } catch {
      return null;
    }
    const size = stat.size; // 当前 transcript 文件总字节数
    let state = this.sessionDeltas.get(sessionFile); // 上一次记录到的文件大小与累计值
    if (!state) {
      state = { lastSize: 0, pendingBytes: 0, pendingMessages: 0 };
      this.sessionDeltas.set(sessionFile, state);
    }
    const deltaBytes = Math.max(0, size - state.lastSize); // 本次相对上次增加的字节数
    // 文件大小完全没变化时，直接返回当前累计状态，不重复做 IO。
    if (deltaBytes === 0 && size === state.lastSize) {
      return {
        deltaBytes: thresholds.deltaBytes,
        deltaMessages: thresholds.deltaMessages,
        pendingBytes: state.pendingBytes,
        pendingMessages: state.pendingMessages,
      };
    }
    // 文件变小，通常代表 rotate / truncate / rewrite，不能简单按追加处理。
    if (size < state.lastSize) {
      state.lastSize = size; // 用当前较小的 size 作为新的基准
      state.pendingBytes += size; // 保守策略：把现有整个文件都视为“新增待处理内容”
      const shouldCountMessages =
        thresholds.deltaMessages > 0 &&
        (thresholds.deltaBytes <= 0 || state.pendingBytes < thresholds.deltaBytes);
      if (shouldCountMessages) {
        // 重新从头统计换行，估算本轮新增消息数。
        state.pendingMessages += await this.countNewlines(sessionFile, 0, size);
      }
    } else {
      state.pendingBytes += deltaBytes; // 正常追加写场景，累计新增字节
      const shouldCountMessages =
        thresholds.deltaMessages > 0 &&
        (thresholds.deltaBytes <= 0 || state.pendingBytes < thresholds.deltaBytes);
      if (shouldCountMessages) {
        // 只扫描新追加的区间，而不是全文件重扫。
        state.pendingMessages += await this.countNewlines(sessionFile, state.lastSize, size);
      }
      state.lastSize = size; // 更新基线，供下次计算 deltaBytes
    }
    this.sessionDeltas.set(sessionFile, state);
    return {
      deltaBytes: thresholds.deltaBytes,
      deltaMessages: thresholds.deltaMessages,
      pendingBytes: state.pendingBytes,
      pendingMessages: state.pendingMessages,
    };
  }

  // 统计文件某个字节区间内出现了多少个 '\n'，用作 transcript “新增消息数”的近似估计。
  private async countNewlines(absPath: string, start: number, end: number): Promise<number> {
    if (end <= start) {
      return 0;
    }
    let handle;
    try {
      handle = await fs.open(absPath, "r");
    } catch (err) {
      if (isFileMissingError(err)) {
        return 0;
      }
      throw err;
    }
    try {
      let offset = start; // 当前读取偏移
      let count = 0; // 换行计数器
      const buffer = Buffer.alloc(SESSION_DELTA_READ_CHUNK_BYTES); // 固定大小缓冲区，避免一次读太大
      while (offset < end) {
        const toRead = Math.min(buffer.length, end - offset);
        const { bytesRead } = await handle.read(buffer, 0, toRead, offset);
        if (bytesRead <= 0) {
          break;
        }
        // ASCII / UTF-8 下 '\n' 的字节值恒为 10，逐字节扫描即可。
        for (let i = 0; i < bytesRead; i += 1) {
          if (buffer[i] === 10) {
            count += 1;
          }
        }
        offset += bytesRead;
      }
      return count;
    } finally {
      await handle.close();
    }
  }

  // 某个 session 文件已经完成索引后，把它的增量统计清零并同步基线大小。
  private resetSessionDelta(absPath: string, size: number): void {
    const state = this.sessionDeltas.get(absPath);
    if (!state) {
      return;
    }
    state.lastSize = size;
    state.pendingBytes = 0;
    state.pendingMessages = 0;
  }

  // 判断某个 transcript 路径是否属于当前 agent 的 session 目录。
  private isSessionFileForAgent(sessionFile: string): boolean {
    if (!sessionFile) {
      return false;
    }
    const sessionsDir = resolveSessionTranscriptsDirForAgent(this.agentId); // 当前 agent 的 transcript 根目录
    const resolvedFile = path.resolve(sessionFile); // 归一化成绝对路径，避免 ../ 绕过
    const resolvedDir = path.resolve(sessionsDir);
    return resolvedFile.startsWith(`${resolvedDir}${path.sep}`);
  }

  // 启动基于固定时间间隔的后台同步。
  protected ensureIntervalSync() {
    const minutes = this.settings.sync.intervalMinutes; // 配置中的周期同步分钟数
    if (!minutes || minutes <= 0 || this.intervalTimer) {
      return;
    }
    const ms = minutes * 60 * 1000; // 分钟转毫秒
    this.intervalTimer = setInterval(() => {
      void this.sync({ reason: "interval" }).catch((err) => {
        log.warn(`memory sync failed (interval): ${String(err)}`);
      });
    }, ms);
  }

  // watcher 检测到 memory 文件变化后，通过防抖统一触发一次 sync。
  private scheduleWatchSync() {
    if (!this.sources.has("memory") || !this.settings.sync.watch) {
      return;
    }
    // 连续多次 change 事件时，始终以后一次为准，避免重复索引。
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
    }
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null;
      void this.sync({ reason: "watch" }).catch((err) => {
        log.warn(`memory sync failed (watch): ${String(err)}`);
      });
    }, this.settings.sync.watchDebounceMs);
  }

  // 判断本轮是否应该同步 session 数据源。
  private shouldSyncSessions(
    params?: { reason?: string; force?: boolean },
    needsFullReindex = false,
  ) {
    // 当前配置没有启用 sessions source，直接跳过。
    if (!this.sources.has("sessions")) {
      return false;
    }
    // 显式 force 永远允许同步。
    if (params?.force) {
      return true;
    }
    const reason = params?.reason;
    // 某些触发原因只应该更新 memory 文件，不应该顺带扫 session transcript。
    if (reason === "session-start" || reason === "watch") {
      return false;
    }
    // 全量重建时必须把 session 一并重建。
    if (needsFullReindex) {
      return true;
    }
    // 增量模式下，只有标记了 sessionsDirty 且存在具体脏文件时才需要同步。
    return this.sessionsDirty && this.sessionsDirtyFiles.size > 0;
  }

  private async syncMemoryFiles(params: {
    needsFullReindex: boolean;
    progress?: MemorySyncProgressState;
  }) {
    // FTS-only mode: skip embedding sync (no provider)
    if (!this.provider) {
      log.debug("Skipping memory file sync in FTS-only mode (no embedding provider)");
      return;
    }

    // 先枚举所有应纳入 memory source 的 markdown 文件。
    const files = await listMemoryFiles(this.workspaceDir, this.settings.extraPaths);
    // 再把绝对路径转换成带 hash/path/mtime/size 的 entry，供增量判断和索引使用。
    const fileEntries = (
      await Promise.all(files.map(async (file) => buildFileEntry(file, this.workspaceDir)))
    ).filter((entry): entry is MemoryFileEntry => entry !== null);
    log.debug("memory sync: indexing memory files", {
      files: fileEntries.length,
      needsFullReindex: params.needsFullReindex,
      batch: this.batch.enabled,
      concurrency: this.getIndexConcurrency(),
    });
    const activePaths = new Set(fileEntries.map((entry) => entry.path)); // 当前真实存在的文件相对路径集合
    if (params.progress) {
      params.progress.total += fileEntries.length;
      params.progress.report({
        completed: params.progress.completed,
        total: params.progress.total,
        label: this.batch.enabled ? "Indexing memory files (batch)..." : "Indexing memory files…",
      });
    }

    // 为每个文件创建一个任务，后面交给并发调度器统一执行。
    const tasks = fileEntries.map((entry) => async () => {
      // files 表里保存了这个 path 的上次 hash，可用于快速跳过未变化文件。
      const record = this.db
        .prepare(`SELECT hash FROM files WHERE path = ? AND source = ?`)
        .get(entry.path, "memory") as { hash: string } | undefined;
      // 非全量重建且 hash 未变化时，直接跳过，避免重复切块/embedding/写库。
      if (!params.needsFullReindex && record?.hash === entry.hash) {
        if (params.progress) {
          params.progress.completed += 1;
          params.progress.report({
            completed: params.progress.completed,
            total: params.progress.total,
          });
        }
        return;
      }
      // 文件已变化或正在全量重建，则让子类执行真正的索引逻辑。
      await this.indexFile(entry, { source: "memory" });
      if (params.progress) {
        params.progress.completed += 1;
        params.progress.report({
          completed: params.progress.completed,
          total: params.progress.total,
        });
      }
    });
    // 按配置并发度执行全部索引任务。
    await runWithConcurrency(tasks, this.getIndexConcurrency());

    // 本轮索引完成后，再反查数据库里是否存在“文件已删除，但旧索引还残留”的脏数据。
    const staleRows = this.db
      .prepare(`SELECT path FROM files WHERE source = ?`)
      .all("memory") as Array<{ path: string }>;
    for (const stale of staleRows) {
      // 当前磁盘上还存在的文件当然不能删索引。
      if (activePaths.has(stale.path)) {
        continue;
      }
      // 先删 files 表里的文件级记录。
      this.db.prepare(`DELETE FROM files WHERE path = ? AND source = ?`).run(stale.path, "memory");
      try {
        // 再删与该文件 chunks 对应的向量记录。
        this.db
          .prepare(
            `DELETE FROM ${VECTOR_TABLE} WHERE id IN (SELECT id FROM chunks WHERE path = ? AND source = ?)`,
          )
          .run(stale.path, "memory");
      } catch {}
      // 最后删文本 chunk 记录。
      this.db.prepare(`DELETE FROM chunks WHERE path = ? AND source = ?`).run(stale.path, "memory");
      if (this.fts.enabled && this.fts.available) {
        try {
          // 若启用 FTS，还要把全文索引里的该文件记录一起清掉。
          this.db
            .prepare(`DELETE FROM ${FTS_TABLE} WHERE path = ? AND source = ? AND model = ?`)
            .run(stale.path, "memory", this.provider.model);
        } catch {}
      }
    }
  }

  private async syncSessionFiles(params: {
    needsFullReindex: boolean;
    progress?: MemorySyncProgressState;
  }) {
    // FTS-only mode: skip embedding sync (no provider)
    if (!this.provider) {
      log.debug("Skipping session file sync in FTS-only mode (no embedding provider)");
      return;
    }

    const files = await listSessionFilesForAgent(this.agentId); // 枚举当前 agent 所有 transcript 文件
    const activePaths = new Set(files.map((file) => sessionPathForFile(file))); // 当前真实存在的 session 路径集合
    const indexAll = params.needsFullReindex || this.sessionsDirtyFiles.size === 0; // 全量重建或未知脏文件集合时，直接全扫
    log.debug("memory sync: indexing session files", {
      files: files.length,
      indexAll,
      dirtyFiles: this.sessionsDirtyFiles.size,
      batch: this.batch.enabled,
      concurrency: this.getIndexConcurrency(),
    });
    if (params.progress) {
      params.progress.total += files.length;
      params.progress.report({
        completed: params.progress.completed,
        total: params.progress.total,
        label: this.batch.enabled ? "Indexing session files (batch)..." : "Indexing session files…",
      });
    }

    // session 的任务列表与 memory 文件类似，但 entry 构建逻辑不同。
    const tasks = files.map((absPath) => async () => {
      // 增量模式下，只索引达到阈值、被标记为 dirty 的 transcript。
      if (!indexAll && !this.sessionsDirtyFiles.has(absPath)) {
        if (params.progress) {
          params.progress.completed += 1;
          params.progress.report({
            completed: params.progress.completed,
            total: params.progress.total,
          });
        }
        return;
      }
      // 把 JSONL transcript 转成统一 entry；其中 content 是被提取/扁平化后的纯文本内容。
      const entry = await buildSessionEntry(absPath);
      // transcript 可能在处理过程中被删掉或读取失败，此时直接跳过。
      if (!entry) {
        if (params.progress) {
          params.progress.completed += 1;
          params.progress.report({
            completed: params.progress.completed,
            total: params.progress.total,
          });
        }
        return;
      }
      // 与 memory 文件一样，用 files 表中的 hash 做“是否有变化”的快速判断。
      const record = this.db
        .prepare(`SELECT hash FROM files WHERE path = ? AND source = ?`)
        .get(entry.path, "sessions") as { hash: string } | undefined;
      if (!params.needsFullReindex && record?.hash === entry.hash) {
        if (params.progress) {
          params.progress.completed += 1;
          params.progress.report({
            completed: params.progress.completed,
            total: params.progress.total,
          });
        }
        // 即使内容未变，也要把增量状态清零，否则该 transcript 会反复被视为 dirty。
        this.resetSessionDelta(absPath, entry.size);
        return;
      }
      // 需要重建时，把 transcript 文本交给统一索引逻辑。
      await this.indexFile(entry, { source: "sessions", content: entry.content });
      this.resetSessionDelta(absPath, entry.size); // 索引成功后，当前大小成为新的基线
      if (params.progress) {
        params.progress.completed += 1;
        params.progress.report({
          completed: params.progress.completed,
          total: params.progress.total,
        });
      }
    });
    // 以统一并发度处理全部 session transcript。
    await runWithConcurrency(tasks, this.getIndexConcurrency());

    // 清理数据库中已经不存在的 transcript 残留记录。
    const staleRows = this.db
      .prepare(`SELECT path FROM files WHERE source = ?`)
      .all("sessions") as Array<{ path: string }>;
    for (const stale of staleRows) {
      if (activePaths.has(stale.path)) {
        continue;
      }
      // 依次清理文件记录、向量记录、chunk 记录和 FTS 记录。
      this.db
        .prepare(`DELETE FROM files WHERE path = ? AND source = ?`)
        .run(stale.path, "sessions");
      try {
        this.db
          .prepare(
            `DELETE FROM ${VECTOR_TABLE} WHERE id IN (SELECT id FROM chunks WHERE path = ? AND source = ?)`,
          )
          .run(stale.path, "sessions");
      } catch {}
      this.db
        .prepare(`DELETE FROM chunks WHERE path = ? AND source = ?`)
        .run(stale.path, "sessions");
      if (this.fts.enabled && this.fts.available) {
        try {
          this.db
            .prepare(`DELETE FROM ${FTS_TABLE} WHERE path = ? AND source = ? AND model = ?`)
            .run(stale.path, "sessions", this.provider.model);
        } catch {}
      }
    }
  }

  // 把外部 onProgress 回调包装成一个带累计状态的小状态机。
  private createSyncProgress(
    onProgress: (update: MemorySyncProgressUpdate) => void,
  ): MemorySyncProgressState {
    const state: MemorySyncProgressState = {
      completed: 0,
      total: 0,
      label: undefined,
      report: (update) => {
        // 阶段标签一旦被设置，就会沿用到后续只更新 completed/total 的事件里。
        if (update.label) {
          state.label = update.label;
        }
        // 给 label 自动拼上 “x/y” 的进度文本，便于 UI 直接展示。
        const label =
          update.total > 0 && state.label
            ? `${state.label} ${update.completed}/${update.total}`
            : state.label;
        onProgress({
          completed: update.completed,
          total: update.total,
          label,
        });
      },
    };
    return state;
  }

  // 执行同步操作的方法
  protected async runSync(params?: {
    reason?: string;
    force?: boolean;
    progress?: (update: MemorySyncProgressUpdate) => void;
  }) {
    const progress = params?.progress ? this.createSyncProgress(params.progress) : undefined;
    if (progress) {
      progress.report({
        completed: progress.completed,
        total: progress.total,
        label: "Loading vector extension…",
      });
    }
    const vectorReady = await this.ensureVectorReady(); // 懒加载 sqlite-vec，并探测是否可用
    const meta = this.readMeta(); // 从 meta 表读取旧索引快照
    const configuredSources = this.resolveConfiguredSourcesForMeta(); // 当前配置下应索引的 source 列表

    // 判断这次是否必须做“全量重建”而不是普通增量同步。
    const needsFullReindex =
      params?.force || // 外部显式要求重建
      !meta || // 没有任何旧 meta，说明索引是空的或损坏的
      (this.provider && meta.model !== this.provider.model) || // 模型变化
      (this.provider && meta.provider !== this.provider.id) || // provider 变化
      meta.providerKey !== this.providerKey || // provider 细粒度配置指纹变化
      this.metaSourcesDiffer(meta, configuredSources) || // source 集合变化
      meta.chunkTokens !== this.settings.chunking.tokens || // chunk size 变化
      meta.chunkOverlap !== this.settings.chunking.overlap || // chunk overlap 变化
      (vectorReady && !meta?.vectorDims); // 向量功能可用，但旧 meta 没记住维度
    try {
      if (needsFullReindex) {
        // 测试环境可选择 unsafe reindex，以换取更快速度；生产默认走 safe reindex。
        if (
          process.env.OPENCLAW_TEST_FAST === "1" &&
          process.env.OPENCLAW_TEST_MEMORY_UNSAFE_REINDEX === "1"
        ) {
          await this.runUnsafeReindex({
            reason: params?.reason,
            force: params?.force,
            progress: progress ?? undefined,
          });
        } else {
          await this.runSafeReindex({
            reason: params?.reason,
            force: params?.force,
            progress: progress ?? undefined,
          });
        }
        return;
      }

      // 增量模式下，分别判断是否要同步 memory source 和 sessions source。
      const shouldSyncMemory =
        this.sources.has("memory") && (params?.force || needsFullReindex || this.dirty);
      const shouldSyncSessions = this.shouldSyncSessions(params, needsFullReindex);

      if (shouldSyncMemory) {
        await this.syncMemoryFiles({ needsFullReindex, progress: progress ?? undefined });
        this.dirty = false; // 成功同步后清除 memory dirty 标志
      }

      if (shouldSyncSessions) {
        await this.syncSessionFiles({ needsFullReindex, progress: progress ?? undefined });
        this.sessionsDirty = false; // session 同步成功后清掉全局 dirty
        this.sessionsDirtyFiles.clear(); // 以及具体脏文件集合
      } else if (this.sessionsDirtyFiles.size > 0) {
        // 未同步但还有待处理文件时，继续保留 dirty 状态，等待下一次触发。
        this.sessionsDirty = true;
      } else {
        // 没有脏文件时，确保状态归零。
        this.sessionsDirty = false;
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // 某些 embedding/provider 相关错误允许自动切换 fallback provider 并重试。
      const activated =
        this.shouldFallbackOnError(reason) && (await this.activateFallbackProvider(reason));
      if (activated) {
        // provider 切换后，原来的全部向量都失效了，只能重新安全重建。
        await this.runSafeReindex({
          reason: params?.reason ?? "fallback",
          force: true,
          progress: progress ?? undefined,
        });
        return;
      }
      throw err;
    }
  }

  // 仅当错误信息看起来和 embedding 生成相关时，才考虑 fallback provider。
  private shouldFallbackOnError(message: string): boolean {
    return /embedding|embeddings|batch/i.test(message);
  }

  // 解析远程批处理配置；只有支持 batch 的 provider 才真正启用。
  protected resolveBatchConfig(): {
    enabled: boolean;
    wait: boolean;
    concurrency: number;
    pollIntervalMs: number;
    timeoutMs: number;
  } {
    const batch = this.settings.remote?.batch;
    // 目前仅 openai / gemini / voyage 的远程 provider 走批处理模式。
    const enabled = Boolean(
      batch?.enabled &&
      this.provider &&
      ((this.openAi && this.provider.id === "openai") ||
        (this.gemini && this.provider.id === "gemini") ||
        (this.voyage && this.provider.id === "voyage")),
    );
    return {
      enabled,
      wait: batch?.wait ?? true, // 是否阻塞等待 batch 结果
      concurrency: Math.max(1, batch?.concurrency ?? 2), // 最低并发度为 1
      pollIntervalMs: batch?.pollIntervalMs ?? 2000, // 轮询间隔
      timeoutMs: (batch?.timeoutMinutes ?? 60) * 60 * 1000, // 分钟转毫秒
    };
  }

  // 当主 provider 失败时，尝试切换到配置中的 fallback provider。
  private async activateFallbackProvider(reason: string): Promise<boolean> {
    const fallback = this.settings.fallback;
    // 没配 fallback / fallback=none / 还没 provider / fallback 与当前相同，都不能切换。
    if (!fallback || fallback === "none" || !this.provider || fallback === this.provider.id) {
      return false;
    }
    // 已经发生过一次 fallback 时，避免再次级联切换。
    if (this.fallbackFrom) {
      return false;
    }
    const fallbackFrom = this.provider.id as
      | "openai"
      | "gemini"
      | "local"
      | "voyage"
      | "mistral"
      | "ollama";

    // 为 fallback provider 选择一个合理默认模型。
    const fallbackModel =
      fallback === "gemini"
        ? DEFAULT_GEMINI_EMBEDDING_MODEL
        : fallback === "openai"
          ? DEFAULT_OPENAI_EMBEDDING_MODEL
          : fallback === "voyage"
            ? DEFAULT_VOYAGE_EMBEDDING_MODEL
            : fallback === "mistral"
              ? DEFAULT_MISTRAL_EMBEDDING_MODEL
              : fallback === "ollama"
                ? DEFAULT_OLLAMA_EMBEDDING_MODEL
                : this.settings.model;

    // 创建一个新的 embedding provider 实例；这里 fallback 再次禁用递归 fallback。
    const fallbackResult = await createEmbeddingProvider({
      config: this.cfg,
      agentDir: resolveAgentDir(this.cfg, this.agentId),
      provider: fallback,
      remote: this.settings.remote,
      model: fallbackModel,
      fallback: "none",
      local: this.settings.local,
    });

    this.fallbackFrom = fallbackFrom; // 记录“从哪个 provider 降级而来”
    this.fallbackReason = reason; // 记录触发降级的原始错误
    this.provider = fallbackResult.provider; // 替换当前 provider
    this.openAi = fallbackResult.openAi; // 同步替换各 provider 专属客户端
    this.gemini = fallbackResult.gemini;
    this.voyage = fallbackResult.voyage;
    this.mistral = fallbackResult.mistral;
    this.ollama = fallbackResult.ollama;
    this.providerKey = this.computeProviderKey(); // provider 变化后必须重新计算指纹
    this.batch = this.resolveBatchConfig(); // 批处理能力也要随 provider 变化重新解析
    log.warn(`memory embeddings: switched to fallback provider (${fallback})`, { reason });
    return true;
  }

  // 安全全量重建：先在临时数据库中完整建好索引，再原子替换正式库。
  private async runSafeReindex(params: {
    reason?: string;
    force?: boolean;
    progress?: MemorySyncProgressState;
  }): Promise<void> {
    const dbPath = resolveUserPath(this.settings.store.path); // 正式索引库路径
    const tempDbPath = `${dbPath}.tmp-${randomUUID()}`; // 临时重建库路径
    const tempDb = this.openDatabaseAtPath(tempDbPath); // 打开临时库

    const originalDb = this.db; // 保留原正式库连接
    let originalDbClosed = false; // 记录原库连接是否已关闭，用于失败恢复
    const originalState = {
      ftsAvailable: this.fts.available,
      ftsError: this.fts.loadError,
      vectorAvailable: this.vector.available,
      vectorLoadError: this.vector.loadError,
      vectorDims: this.vector.dims,
      vectorReady: this.vectorReady,
    };

    // 一旦中途失败，需要把 db 句柄、fts/vector 状态全部恢复回旧库环境。
    const restoreOriginalState = () => {
      if (originalDbClosed) {
        this.db = this.openDatabaseAtPath(dbPath);
      } else {
        this.db = originalDb;
      }
      this.fts.available = originalState.ftsAvailable;
      this.fts.loadError = originalState.ftsError;
      this.vector.available = originalDbClosed ? null : originalState.vectorAvailable;
      this.vector.loadError = originalState.vectorLoadError;
      this.vector.dims = originalState.vectorDims;
      this.vectorReady = originalDbClosed ? null : originalState.vectorReady;
    };

    this.db = tempDb; // 从这里开始，后续索引写入全部落到临时库
    this.vectorReady = null; // 新库上的扩展状态需要重新探测
    this.vector.available = null;
    this.vector.loadError = undefined;
    this.vector.dims = undefined;
    this.fts.available = false;
    this.fts.loadError = undefined;
    this.ensureSchema(); // 在临时库上初始化 schema

    let nextMeta: MemoryIndexMeta | null = null;

    try {
      this.seedEmbeddingCache(originalDb); // 复制旧库 embedding cache，减少远程重复计算
      const shouldSyncMemory = this.sources.has("memory"); // 全量重建时，只要启用了 memory source 就重扫
      const shouldSyncSessions = this.shouldSyncSessions(
        { reason: params.reason, force: params.force },
        true,
      );

      if (shouldSyncMemory) {
        await this.syncMemoryFiles({ needsFullReindex: true, progress: params.progress });
        this.dirty = false;
      }

      if (shouldSyncSessions) {
        await this.syncSessionFiles({ needsFullReindex: true, progress: params.progress });
        this.sessionsDirty = false;
        this.sessionsDirtyFiles.clear();
      } else if (this.sessionsDirtyFiles.size > 0) {
        this.sessionsDirty = true;
      } else {
        this.sessionsDirty = false;
      }

      // 重建成功后，生成一份全新的 meta 快照写入临时库。
      nextMeta = {
        model: this.provider?.model ?? "fts-only",
        provider: this.provider?.id ?? "none",
        providerKey: this.providerKey!,
        sources: this.resolveConfiguredSourcesForMeta(),
        chunkTokens: this.settings.chunking.tokens,
        chunkOverlap: this.settings.chunking.overlap,
      };
      if (!nextMeta) {
        throw new Error("Failed to compute memory index metadata for reindexing.");
      }

      // 若向量表已建立，则把维度也持久化到 meta 中，供下次判断是否可复用。
      if (this.vector.available && this.vector.dims) {
        nextMeta.vectorDims = this.vector.dims;
      }

      this.writeMeta(nextMeta); // 把新索引快照写入临时库
      this.pruneEmbeddingCacheIfNeeded?.(); // 如有必要，对 cache 做上限清理

      this.db.close(); // 先关闭临时库连接，确保文件可被移动/替换
      originalDb.close(); // 再关闭正式库连接，为原子替换做准备
      originalDbClosed = true;

      await this.swapIndexFiles(dbPath, tempDbPath); // 用临时库原子替换正式库文件

      this.db = this.openDatabaseAtPath(dbPath); // 替换成功后重新打开正式库
      this.vectorReady = null; // 新连接下重新探测扩展状态
      this.vector.available = null;
      this.vector.loadError = undefined;
      this.ensureSchema(); // 重新同步 schema / FTS 状态
      this.vector.dims = nextMeta?.vectorDims; // 恢复向量维度缓存，避免重复建表
    } catch (err) {
      try {
        this.db.close(); // 失败时尽量关闭临时库连接
      } catch {}
      await this.removeIndexFiles(tempDbPath); // 删除未提交的临时库文件
      restoreOriginalState(); // 恢复到旧正式库状态
      throw err;
    }
  }

  // 非安全全量重建：直接清空当前库并重建。只在测试环境下为性能使用。
  private async runUnsafeReindex(params: {
    reason?: string;
    force?: boolean;
    progress?: MemorySyncProgressState;
  }): Promise<void> {
    // Perf: for test runs, skip atomic temp-db swapping. The index is isolated
    // under the per-test HOME anyway, and this cuts substantial fs+sqlite churn.
    this.resetIndex();

    const shouldSyncMemory = this.sources.has("memory");
    const shouldSyncSessions = this.shouldSyncSessions(
      { reason: params.reason, force: params.force },
      true,
    );

    if (shouldSyncMemory) {
      await this.syncMemoryFiles({ needsFullReindex: true, progress: params.progress });
      this.dirty = false;
    }

    if (shouldSyncSessions) {
      await this.syncSessionFiles({ needsFullReindex: true, progress: params.progress });
      this.sessionsDirty = false;
      this.sessionsDirtyFiles.clear();
    } else if (this.sessionsDirtyFiles.size > 0) {
      this.sessionsDirty = true;
    } else {
      this.sessionsDirty = false;
    }

    // 直接在当前库中重建完成后，写回新 meta。
    const nextMeta: MemoryIndexMeta = {
      model: this.provider?.model ?? "fts-only",
      provider: this.provider?.id ?? "none",
      providerKey: this.providerKey!,
      sources: this.resolveConfiguredSourcesForMeta(),
      chunkTokens: this.settings.chunking.tokens,
      chunkOverlap: this.settings.chunking.overlap,
    };

    if (this.vector.available && this.vector.dims) {
      nextMeta.vectorDims = this.vector.dims;
    }

    this.writeMeta(nextMeta);
    this.pruneEmbeddingCacheIfNeeded?.();
  }

  // 直接清空当前索引内容，为 unsafe reindex 做准备。
  private resetIndex() {
    this.db.exec(`DELETE FROM files`); // 删除文件级记录
    this.db.exec(`DELETE FROM chunks`); // 删除文本分块记录
    if (this.fts.enabled && this.fts.available) {
      try {
        this.db.exec(`DELETE FROM ${FTS_TABLE}`); // 删除全文索引记录
      } catch {}
    }
    this.dropVectorTable(); // 向量表直接删掉，下次按新维度重建
    this.vector.dims = undefined; // 清空向量维度缓存
    this.sessionsDirtyFiles.clear(); // 清掉 session dirty 集合，避免带入旧状态
  }

  // 读取 meta 表中的 memory 索引快照。
  // 这份数据不是业务记忆内容，而是“当前索引是按什么配置构建出来的”。
  protected readMeta(): MemoryIndexMeta | null {
    // meta 表中 value 是一个 JSON 字符串。
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(META_KEY) as
      | { value: string }
      | undefined;
    // 没找到记录，说明索引还没初始化，或者已被清空。
    if (!row?.value) {
      this.lastMetaSerialized = null;
      return null;
    }
    try {
      // 解析成功后顺便缓存原始 JSON 字符串，后续写相同值时可跳过数据库写入。
      const parsed = JSON.parse(row.value) as MemoryIndexMeta;
      this.lastMetaSerialized = row.value;
      return parsed;
    } catch {
      // 元数据损坏时，保守地按“没有 meta”处理，让上层触发全量重建。
      this.lastMetaSerialized = null;
      return null;
    }
  }

  // 写入 meta 表中的 memory 索引快照。
  // key 固定为 META_KEY，value 是 MemoryIndexMeta 的 JSON 序列化结果。
  protected writeMeta(meta: MemoryIndexMeta) {
    const value = JSON.stringify(meta); // 把配置快照压成稳定 JSON 字符串
    // 与最近一次相同则不写，减少无意义 UPDATE。
    if (this.lastMetaSerialized === value) {
      return;
    }
    this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      )
      .run(META_KEY, value); // 不存在则插入，存在则覆盖
    this.lastMetaSerialized = value;
  }

  // 从当前运行时 sources 集合中，提取出需要写入 meta 的标准化 source 列表。
  private resolveConfiguredSourcesForMeta(): MemorySource[] {
    const normalized = Array.from(this.sources)
      // 只允许持久化已知 source，忽略未来可能扩展但当前版本不识别的值。
      .filter((source): source is MemorySource => source === "memory" || source === "sessions")
      .toSorted(); // 排序后可稳定比较，避免 Set 顺序差异导致误判
    // 为了兼容旧语义，没有显式配置时默认视为只有 memory source。
    return normalized.length > 0 ? normalized : ["memory"];
  }

  // 读取旧 meta 时，对里面的 sources 做兼容性归一化。
  private normalizeMetaSources(meta: MemoryIndexMeta): MemorySource[] {
    if (!Array.isArray(meta.sources)) {
      // Backward compatibility for older indexes that did not persist sources.
      return ["memory"];
    }
    const normalized = Array.from(
      new Set(
        meta.sources.filter(
          (source): source is MemorySource => source === "memory" || source === "sessions",
        ),
      ),
    ).toSorted(); // 去重 + 排序，得到稳定比较用的 source 列表
    return normalized.length > 0 ? normalized : ["memory"];
  }

  // 比较“旧索引构建时的 sources”和“当前配置下期望的 sources”是否不同。
  // 只要不同，就说明旧索引覆盖范围变了，必须全量重建。
  private metaSourcesDiffer(meta: MemoryIndexMeta, configuredSources: MemorySource[]): boolean {
    const metaSources = this.normalizeMetaSources(meta);
    // 长度不同，必然不同。
    if (metaSources.length !== configuredSources.length) {
      return true;
    }
    // 长度相同则逐项比较；由于双方都已排序，索引位相等即可认为集合相等。
    return metaSources.some((source, index) => source !== configuredSources[index]);
  }
}
