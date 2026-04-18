import type { DatabaseSync } from "node:sqlite";

/**
 * 如果从架构角度总结，ensureMemoryIndexSchema() 做的不是“纯定义 schema”，而是 4 件事一起做：
 * 基础表初始化
 * 运行时能力探测
 * 老库兼容迁移
 * 必要索引补齐
 * 所以它更像是一个：
 *  runtime schema bootstrap + compatibility migration helper
 * 而不是一个单纯的 SQL 文件装载器。

 * 在整个 memory 系统中的作用链路
 * 你可以把它放进这条链里理解：
 * 一句话结论：
 * ensureMemoryIndexSchema() 的本质作用是：
 * 把一个普通 SQLite 数据库，初始化成 OpenClaw memory 系统可用的索引数据库。
 * 而这些 Schema 的分工分别是：
 * meta：索引配置快照
 * files：文件级变更跟踪，记录这个文件路径、hash、mtime、size
 * chunks：chunk 级核心索引数据，记录这个文件被切成了几个 chunk，每个 chunk 存文本、行号、embedding、模型等信息
 * embedding_cache：embedding 结果缓存
 * fts：全文检索加速，它是基于 chunk 文本建立的全文索引，用于关键词检索 / hybrid search
 * files 负责记录“有哪些源文件、它们是否变化”，chunks 负责保存“这些文件被切成了哪些可检索文本块”，FTS5 负责对这些文本块做全文搜索索引。
 * 所以层级关系是：文件 -> chunk -> FTS 索引 
* ensureColumn + 索引：兼容旧库并提升查询/清理效率
 * 立刻可执行的摘要：
 * 如果你想理解“为什么能增量同步”，重点看 files 表。
 * 如果你想理解“真正搜的是什么”，重点看 chunks 表。
 * 如果你想理解“为什么重建能更快”，重点看 embedding_cache 表。
 *  如果你想理解“为什么有时 FTS 不可用但系统还能工作”，重点看 ftsAvailable / ftsError 的返回设计。
 */
export function ensureMemoryIndexSchema(params: {
  db: DatabaseSync;
  embeddingCacheTable: string;
  ftsTable: string;
  ftsEnabled: boolean;
}): { ftsAvailable: boolean; ftsError?: string } {
  //meta 表：存“索引配置元数据”
  //   它最核心的用途，是存 memory_index_meta_v1 这种配置快照，供系统判断：
  // 当前索引是不是按现在的 provider/model 构建的
  // chunk 参数有没有变化
  // sources 有没有变化
  // 是否需要全量重建
  params.db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  //iles 表：存“文件级索引状态”
  //   这张表记录的是“某个源文件当前的整体状态”。

  // 字段意义：

  // path：文件路径，主键
  // source：来源，比如 memory 或 sessions
  // hash：文件内容 hash
  // mtime：修改时间
  // size：文件大小
  // 它的作用是：
  // 快速判断文件是否变了。

  // 比如在 syncMemoryFiles() 里，就会拿 files.hash 和当前扫描到的 entry.hash 对比：

  // 没变 -> 直接跳过
  // 变了 -> 重新索引
  // 所以 files 表解决的是“增量同步判定”问题。
  params.db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'memory',
      hash TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL
    );
  `);

  // chunks 表：存“真正可检索的文本块”
  //   这是最核心的一张表。

  // 因为 memory 检索不是按整个文件搜索，而是按 chunk 搜索。
  // 也就是说，MEMORY.md 或 transcript 文件会先被切成一段段文本块，再写入这里。

  // 字段意义：

  // id：chunk 唯一 ID
  // path：chunk 来自哪个文件
  // source：来源类型
  // start_line / end_line：原文件中的行号区间
  // hash：chunk 文本 hash
  // model：生成 embedding 用的模型
  // text：chunk 原始文本
  // embedding：该 chunk 的 embedding（这里是文本存储）
  // updated_at：更新时间
  // 所以 chunks 表是：

  // memory 语义检索的主数据表。

  // 后续无论向量搜、全文搜、引用源文件行号，最终都绕不开这里。
  params.db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'memory',
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      hash TEXT NOT NULL,
      model TEXT NOT NULL,
      text TEXT NOT NULL,
      embedding TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  //embedding_cache 表：避免重复算向量
  //   这张表不是存“某个文件 chunk 的当前索引结果”，而是存：

  // “某段文本在某个 provider/model 配置下算出来的 embedding”

  // 它的主键是联合主键：

  // provider
  // model
  // provider_key
  // hash
  // 这个设计非常关键，因为同一段文本：

  // 换一个 embedding model，向量会不同
  // 换一个 provider，向量也可能不同
  // 同 provider 但 endpoint/config 不同，结果也可能不同
  // 所以 cache 不能只按 hash 存。

  // 这张表的作用是：
  // 全量重建时尽量复用旧 embedding
  // 避免重复请求远程 API
  // 降低 embedding 成本和时间开销
  // updated_at 上单独建索引，是为了后续做 LRU 风格清理更方便。
  params.db.exec(`
    CREATE TABLE IF NOT EXISTS ${params.embeddingCacheTable} (
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      provider_key TEXT NOT NULL,
      hash TEXT NOT NULL,
      embedding TEXT NOT NULL,
      dims INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (provider, model, provider_key, hash)
    );
  `);
  params.db.exec(
    `CREATE INDEX IF NOT EXISTS idx_embedding_cache_updated_at ON ${params.embeddingCacheTable}(updated_at);`,
  );

  //FTS 虚拟表：提供全文搜索能力
  //   这里的重点是：FTS 是可选能力，不是硬依赖。
  /**
   * 换句话说：
   * chunks 保存真实 chunk 数据
   * FTS5 保存适合全文检索的倒排索引
   * 为什么 text 建索引，其他字段 UNINDEXED
   * 因为全文检索真正需要被分词、建立倒排索引的只有 text。
   * 像这些字段：
   * id
   * path
   * source
   * model
   * start_line
   * end_line
   * 只是为了在命中结果后把元信息带出来，不需要参与全文索引。
   * 所以 FTS5 的关系不是：
   * “文件 -> FTS5”
   * 而是：
   * “chunks.text -> FTS5”
   */

  let ftsAvailable = false;
  let ftsError: string | undefined;
  if (params.ftsEnabled) {
    try {
      params.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS ${params.ftsTable} USING fts5(\n` +
          `  text,\n` +
          `  id UNINDEXED,\n` +
          `  path UNINDEXED,\n` +
          `  source UNINDEXED,\n` +
          `  model UNINDEXED,\n` +
          `  start_line UNINDEXED,\n` +
          `  end_line UNINDEXED\n` +
          `);`,
      );
      ftsAvailable = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ftsAvailable = false;
      ftsError = message;
    }
  }

  ensureColumn(params.db, "files", "source", "TEXT NOT NULL DEFAULT 'memory'");
  ensureColumn(params.db, "chunks", "source", "TEXT NOT NULL DEFAULT 'memory'");
  params.db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);`);
  params.db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source);`);

  return { ftsAvailable, ...(ftsError ? { ftsError } : {}) };
}

function ensureColumn(
  db: DatabaseSync,
  table: "files" | "chunks",
  column: string,
  definition: string,
): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (rows.some((row) => row.name === column)) {
    return;
  }
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
