# OpenClaw Memory Study Notes

## 1. `manager-sync-ops.ts` 的定位

`src/memory/manager-sync-ops.ts` 是 memory 索引系统里的“同步层 / 重建层”。

它本身不负责具体的 embedding 算法实现，而是负责：

- 打开和维护 SQLite 索引库
- 初始化 schema
- 监听 memory markdown 与 session transcript 的变化
- 判断应该做增量同步还是全量重建
- 在 provider、model、chunk 配置变化时安全重建整个索引库

继承关系可以理解为：

- `MemoryIndexManager`
- `MemoryManagerEmbeddingOps`
- `MemoryManagerSyncOps`

其中：

- `MemoryManagerSyncOps` 决定“什么时候同步、同步哪些文件、如何安全重建”
- `MemoryManagerEmbeddingOps` 决定“如何切块、如何生成 embedding、如何写入 chunks / vec / FTS”

## 2. 为什么要把 `memory.md` / `MEMORY.md` 同步到 sqlite-vec

同步到 sqlite-vec 的本质目的，不是备份文件，而是建立“可语义检索”的记忆索引。

如果只保留 Markdown 原文：

- 只能做简单关键词匹配
- 每次查询都要现读、现切块、现算 embedding
- 查询成本高、速度慢

同步到索引后，可以做到：

- 把长文档切成多个 chunk
- 为每个 chunk 生成 embedding
- 用向量相似度做语义召回
- 配合 FTS 做 hybrid search

一句话理解：

> `memory.md` 是源事实，SQLite / sqlite-vec 是查询优化后的索引副本。

## 3. `MEMORY.md` / `memory.md` 的内容来源

`manager-sync-ops.ts` 只负责读取和索引，不负责自动生成 `MEMORY.md` 本身。

`MEMORY.md` 的内容主要来自：

- 用户手工维护
- agent 在主会话中主动写入
- 日常记忆文件（如 `memory/YYYY-MM-DD.md`）整理后的沉淀

代码和文档中的定位是：

- `MEMORY.md`：长期、提炼后的记忆
- `memory/YYYY-MM-DD.md`：每日原始记录、短期上下文

所以：

- `MEMORY.md` 不是数据库生成的
- 不是 `manager-sync-ops.ts` 自动“总结”出来的
- 它是工作区中的真实 Markdown 文件，由人或 agent 维护

## 4. `MEMORY.md` 里应该写什么

适合写入 `MEMORY.md` 的信息：

- 长期偏好
- 稳定事实
- 关键决策
- 经验教训
- 持久约束

不适合写入的内容：

- 临时上下文
- 当天流水记录
- 很快过期的信息
- 纯日志
- 大段原始聊天记录

推荐格式不是 JSON schema，而是普通 Markdown。

系统没有强制要求固定数据结构；从代码上看，memory 文件只是被按文本行切块：

- 输入是 Markdown 文本
- 输出是 chunk
- chunk 进入 embedding / FTS / 向量检索流程

因此更推荐：

- 标题分组
- 短句 bullet
- 每条只表达一个稳定事实
- 同类信息集中放在一个 section

## 5. OpenClaw 如何“抽取内容并帮助写入 memory”

OpenClaw 不是传统的固定规则抽取器，而是两条机制并行：

### 5.1 Pre-compaction memory flush

当 session 接近 compaction 阈值时，OpenClaw 会触发一个静默的 embedded run。

系统 prompt 会提醒模型：

- 把 durable memory 写到 `memory/YYYY-MM-DD.md`
- 如果文件存在，只做 append
- 如果没有内容可写，返回 `NO_REPLY`

这条链路里：

- 触发时机由系统决定
- “该抽取什么内容”主要由模型判断
- 输出落到 memory Markdown 文件，而不是直接写数据库

### 5.2 `session-memory` hook

在 `/new` 或 `/reset` 时，会触发 `session-memory` hook。

它的逻辑更程序化：

- 找到上一段 session transcript
- 读取最近 N 条 user / assistant 消息
- 用 LLM 生成 slug
- 写入 `memory/YYYY-MM-DD-<slug>.md`

这条路径写出来的更像“会话归档”而不是高度提炼后的长期记忆。

## 6. `memory_index_meta_v1` 是什么

`memory_index_meta_v1` 存在 SQLite 的 `meta` 表中，是索引配置快照，不是业务记忆内容。

它的作用是判断：

- 当前索引是否还能复用
- 是否需要全量重建

它记录的内容包括：

- 当前 embedding model
- provider
- providerKey
- sources
- chunkTokens
- chunkOverlap
- vectorDims

所以它本质上是：

> memory 索引的“配置指纹快照”

## 7. `ensureMemoryIndexSchema()` 是干什么的

`src/memory/memory-schema.ts` 里的 `ensureMemoryIndexSchema()` 是 memory 索引数据库的初始化入口。

它做的不是单纯建表，而是同时完成：

- 基础表初始化
- 运行时能力探测
- 老库兼容迁移
- 必要索引补齐

换句话说，它是 runtime schema bootstrap + compatibility migration helper。

它创建/维护的核心结构包括：

- `meta`
- `files`
- `chunks`
- `embedding_cache`
- 可选 `FTS5` 虚拟表

## 8. `files`、`chunks`、`FTS5` 的关系

这三者可以理解成三层结构：

- `files`：文件层
- `chunks`：内容块层
- `FTS5`：全文检索加速层

### 8.1 `files`

`files` 表记录文件级状态：

- `path`
- `source`
- `hash`
- `mtime`
- `size`

它的主要作用是：

- 判断文件是否发生变化
- 支持增量同步
- 在文件删除时清理旧索引残留

### 8.2 `chunks`

`chunks` 表是真正的内容主表，存放：

- chunk id
- 来源 path
- 行号范围
- chunk hash
- model
- text
- embedding
- updated_at

它代表：

- 文件被切块后的索引内容
- 后续向量检索、全文检索、引用行号都围绕它展开

### 8.3 `FTS5`

FTS5 不是另一份独立主数据，而是：

> `chunks.text` 的全文搜索加速结构

关系不是：

- 文件 -> FTS5

而是：

- `chunks.text` -> FTS5

因此三者的关系是：

- 一个 `file` 可以拆成多个 `chunk`
- 每个 `chunk.text` 可以被同步到 `FTS5`

## 9. 为什么要监听 memory markdown 与 session transcript 的变化

因为 OpenClaw 的检索不是直接查原始文件，而是查提前构建好的索引。

只要源文件变化，索引就可能过期，所以必须监听。

### 9.1 监听 memory markdown 的原因

原因包括：

- 用户可能直接编辑 `MEMORY.md`
- 这些 Markdown 文件是源事实
- 不监听就会导致索引过时
- 不希望每次查询都全量重扫所有 Markdown

因此 watcher 的目的是：

- 标记 `dirty`
- 防抖
- 按需增量重建索引

### 9.2 监听 session transcript 的原因

原因包括：

- transcript 也是一种可检索 memory source
- session 文件是高频追加写入的
- 新对话内容需要尽快进入 recall

但 transcript 的变化模式和 memory markdown 不同，所以策略也不同：

- memory markdown：`chokidar.watch`
- session transcript：事件订阅 + 增量阈值判断

也就是说：

- 文档类变化适合 watcher
- 高频聊天追加适合 delta accumulation

## 10. `runSync()` 的核心判断逻辑

`runSync()` 是同步总入口。

它会先做：

- `ensureVectorReady()`
- `readMeta()`
- 读取当前配置中的 source / chunk / provider 信息

然后判断 `needsFullReindex`。

触发全量重建的条件包括：

- 没有 meta
- model 变化
- provider 变化
- providerKey 变化
- source 集合变化
- chunk 参数变化
- vector 信息缺失
- 外部显式 `force`

如果不需要全量重建，则走增量路径：

- `syncMemoryFiles()`
- `syncSessionFiles()`

如果需要重建，则走：

- `runSafeReindex()`（默认）
- `runUnsafeReindex()`（测试环境优化路径）

## 11. `runSafeReindex()` 为什么重要

`runSafeReindex()` 的思想是：

- 不直接在正式库上删了重建
- 而是在临时数据库里先完整建好
- 成功后原子替换正式库

它的好处：

- 重建过程中失败，不会破坏当前正式索引
- 可以在临时库里完整校验 schema、写入 chunks、写入 meta
- 最终切换更安全

因此它是 memory 索引“稳定性”的关键保障。

## 12. 关键理解总结

这轮学习里最重要的结论可以浓缩成下面几条：

1. memory 系统的源事实是 Markdown / transcript 文件，不是 SQLite。
2. SQLite / sqlite-vec / FTS 是索引副本，用来优化检索。
3. `files` 管文件级状态，`chunks` 管 chunk 级内容，`FTS5` 管全文索引。
4. `manager-sync-ops.ts` 的职责是“同步调度 + 重建控制”，不是 embedding 算法本身。
5. `ensureMemoryIndexSchema()` 是 memory 数据库的初始化与兼容迁移入口。
6. `MEMORY.md` 写的是长期、提炼后的记忆；`memory/YYYY-MM-DD.md` 写的是日常记录。
7. 系统通过 watcher、session 事件、meta 快照和 safe reindex 来保持“源文件”和“索引库”一致。

## 13. 后续可继续深入的主题

下一步可以继续深入这些问题：

- `chunks.embedding` 与 `chunks_vec` 的关系
- `providerKey` 为什么需要单独存在
- `indexFile()` 如何把文件切块并写入向量表
- hybrid search 如何融合 FTS 与向量相似度
- `manager.ts`、`manager-embedding-ops.ts`、`manager-sync-ops.ts` 的完整调用链
