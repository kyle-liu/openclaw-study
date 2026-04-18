# Why OpenClaw Watches Memory Changes

## 1. 问题背景

OpenClaw 的 memory 检索不是直接实时读取原始 Markdown 或 transcript 文件，而是依赖一套提前构建好的本地索引。

这意味着系统内部始终存在两层数据：

- 源数据层
  - 根记忆文件支持两个兼容命名：`MEMORY.md`（推荐）和 `memory.md`（兼容别名）
  - `memory/**/*.md`
  - session transcript
- 索引层
  - `files`
  - `chunks`
  - `chunks_vec`
  - `chunks_fts`

一旦源数据发生变化，而索引层没有更新，就会出现“索引过时”的问题。

所以监听变化的本质目的不是为了知道“文件变了”这件事本身，而是为了知道：

> memory 索引需要重新同步了。

## 2. 为什么要监听 `memory markdown`

`memory markdown` 包括：

- 根记忆文件：`MEMORY.md`（推荐）或 `memory.md`（兼容）
- `memory/**/*.md`
- 以及配置中的额外 Markdown 路径

监听它们的原因主要有以下几点。

### 2.1 这些文件是长期记忆的源事实

SQLite / sqlite-vec / FTS 不是 memory 的真实来源，它们只是优化检索用的索引副本。

真正的内容来源仍然是工作区中的 Markdown 文件。

因此，如果用户或 agent 修改了这些文件：

- 新内容需要进入索引
- 旧内容如果被删除，也要从索引中清掉

否则就会出现：

- 新记忆搜不到
- 已删除记忆仍然被召回
- 检索结果与真实文件内容不一致

### 2.2 用户可能直接手动编辑

`MEMORY.md` 很可能被用户直接编辑，而不是总通过系统命令生成。

例如：

- 添加一条新的长期偏好
- 修改一个决策说明
- 删除一条过期记忆

如果没有 watcher，系统并不会自动知道这些改动已经发生。

### 2.3 不希望每次查询都全量重扫

理论上可以不监听，而是在每次 `memory_search` 时：

- 重新扫描所有 Markdown
- 重新切块
- 重新生成 embedding
- 重新组织检索结果

但这样代价很高：

- IO 开销大
- embedding 代价高
- 查询延迟高
- 重复计算严重

因此更合理的设计是：

- 平时监听变化
- 文件变更时做增量索引
- 查询时直接读取现成索引

这就是典型的“写时更新索引，读时快速查询”。

## 3. 为什么要监听 `session transcript`

`session transcript` 是另一类 memory source。

它和 `memory markdown` 的最大不同在于：

- Markdown 更像人工维护的知识文档
- transcript 更像不断增长的会话流

监听 transcript 的原因主要有以下几点。

### 3.1 transcript 本身也是可检索记忆

OpenClaw 支持把 `sessions` 作为 memory source 进行索引。

这意味着：

- 历史对话也可以参与召回
- 某些刚刚讨论过的内容，未来可以作为“记忆”被搜索到

如果 transcript 增长了，但索引没有更新，那么：

- 新聊天内容不会进入 recall
- “刚聊过的内容”无法及时被再次检索

### 3.2 transcript 的变化频率很高

Markdown 文件通常是低频编辑；
但 transcript 往往是高频追加写入。

如果每写入一条消息就立即全量重建，会非常浪费。

因此 OpenClaw 对 transcript 不采用简单的目录 watcher 全量扫描，而是用：

- transcript 更新事件
- 防抖
- 按字节数 / 消息数累计阈值
- 达到阈值后再触发同步

这是一种更适合流式数据的策略。

### 3.3 transcript 更适合增量处理

对于 transcript，系统更关心的是：

- 从上次索引后新增了多少内容
- 是否已经多到值得重新索引

因此 transcript 监听不是“有变化就立刻重建”，而是：

> 先累计增量，再决定是否值得同步。

## 4. 为什么两者要用不同监听策略

OpenClaw 对这两类 source 使用了不同的监控机制，不是为了增加复杂度，而是因为它们的数据形态不同。

### 4.1 `memory markdown`

特点：

- 文件数相对少
- 修改频率低
- 常见操作是新增、编辑、删除

适合策略：

- 文件系统 watcher
- 防抖后触发 sync

### 4.2 `session transcript`

特点：

- 文件持续增长
- 写入频率高
- 常见操作是 append

适合策略：

- 订阅 transcript 更新事件
- 统计 delta
- 达阈值再触发 sync

所以本质上不是“为什么不用统一机制”，而是：

> 因为文档型数据和流式会话数据的更新模式不同，最优同步策略也不同。

## 5. 监听之后系统会做什么

监听只是起点，后续真正重要的是同步流程。

### 5.1 memory markdown 变化后的链路

大致流程：

1. watcher 发现 Markdown 文件新增 / 修改 / 删除
2. `dirty = true`
3. `scheduleWatchSync()`
4. 防抖结束后调用 `sync({ reason: "watch" })`
5. 对变化文件增量重建 chunk / FTS / 向量记录
6. 清理已经删除文件对应的旧索引

### 5.2 session transcript 变化后的链路

大致流程：

1. session transcript 触发更新事件
2. 文件路径进入 `sessionPendingFiles`
3. 防抖后统一批处理
4. 统计新增字节数 / 换行数
5. 达到阈值后标记 `sessionsDirtyFiles`
6. 调用 `sync({ reason: "session-delta" })`
7. 只重建有必要更新的 transcript

所以监听最终不是终点，而是：

> 索引刷新调度链路的入口。

## 6. 如果不监听，会发生什么

如果没有监听机制，会带来几个直接问题。

### 6.1 检索结果过时

原始 memory 文件已经更新，但索引还停留在旧版本。

### 6.2 已删除内容仍被召回

文件中删掉的内容，在 SQLite / FTS / vec 里仍可能残留。

### 6.3 新内容无法及时进入 recall

特别是 transcript，刚刚发生的聊天内容无法进入后续 recall。

### 6.4 查询性能退化

如果不用监听，就只能把“重建索引”的成本推迟到查询时承担。

这会导致：

- 查询更慢
- 计算更重
- 用户体验更差

## 7. 从架构角度的本质理解

这个问题可以抽象成一个经典架构问题：

> 当系统有“源数据层”和“索引层”时，如何保证索引层与源数据层保持一致？

OpenClaw 的答案是：

- 对低频文档变化，使用 watcher
- 对高频 transcript 变化，使用事件 + delta 阈值
- 统一汇总到 sync / reindex 流程中处理

因此监听机制解决的是：

- 索引时效性
- 增量更新效率
- 源数据与检索数据的一致性

## 8. 关键结论

关于“为什么要监听 memory markdown 与 session transcript 的变化”，可以归纳成 4 条核心结论：

1. memory 检索查的是索引，不是原始文件，所以源文件变化后必须同步索引。
2. `memory markdown` 是长期记忆的源事实，修改后必须更新索引副本。
3. `session transcript` 是高频增长的另一类 memory source，需要增量进入 recall。
4. 两者的监听策略不同，是因为文档编辑和流式会话追加的更新模式本来就不同。

## 9. 一句话总结

监听 `memory markdown` 与 `session transcript` 的变化，是为了在不牺牲查询性能的前提下，让 memory 索引始终与真实源数据保持近实时一致。
