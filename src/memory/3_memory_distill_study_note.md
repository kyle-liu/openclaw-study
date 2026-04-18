# OpenClaw Memory Distillation Study Note

## 1. 本笔记聚焦的问题

这份笔记主要总结两个问题：

1. OpenClaw 如何把 `transcript` 里的原始会话事实，逐步沉淀成 `memory`
2. `memory-flush` 提示词为什么能把模型注意力引向长期偏好、稳定事实、关键决策和可复用经验

一句话先概括：

> OpenClaw 不是把整份 transcript 直接变成 `MEMORY.md`，而是先保留原始 transcript，再在特定时机通过“规则过滤 + 触发机制 + 模型提炼”把值得长期保存的内容沉淀到 memory 文件中。

---

## 2. `transcript -> memory` 的整体关系

这一段逻辑不能简单理解成“一次转换”，它其实分成两层：

### 2.1 第一层：原始会话记录

用户在 OpenClaw 中的交互，首先会被记录成 session transcript（通常是 `.jsonl`）。

这层的特点是：

- 完整
- 原始
- 可回溯
- 噪音较多

它更像“事实流水账”。

### 2.2 第二层：memory 沉淀

在特定时机，系统会从 transcript 或当前上下文中提取、清洗、归档、提炼，写成 memory 文件。

这层的特点是：

- 更干净
- 更适合阅读
- 更适合索引
- 更偏长期价值

它更像“经过筛选的记忆材料”。

因此：

- transcript 是原材料池
- memory 是沉淀层

---

## 3. OpenClaw 如何从 transcript 中“提取候选事实”

这里最关键的代码在 `src/memory/session-files.ts`。

### 3.1 它不是直接拿整份 JSONL 去检索

系统会先逐行解析 transcript，并只保留真正有价值的消息记录：

- 只保留 `type === "message"`
- 只保留 `user` / `assistant`
- 只提取文本内容
- 丢掉空内容和解析失败内容
- 做敏感信息脱敏

这一层更像：

> 结构化日志 -> 可索引文本

### 3.2 `buildSessionEntry()` 做的事情

可以把它理解成“把原始 transcript 清洗成一个 `SessionFileEntry`”。

输出内容包括：

- `path`
- `absPath`
- `mtimeMs`
- `size`
- `hash`
- `content`
- `lineMap`

其中最重要的是：

- `content`：提取后的纯文本对话
- `lineMap`：映射回原始 JSONL 行号，保证引用可回溯

### 3.3 这一步算不算“蒸馏”

算，但它是**结构蒸馏**，不是语义蒸馏。

它做的是：

- 去噪
- 抽取
- 规范化
- 脱敏

它还没有真正决定“哪些东西值得长期记住”。

---

## 4. OpenClaw 如何把 transcript 进一步沉淀成 memory

这里主要有两条路径。

### 4.1 路径 A：`session-memory` hook

这是 `/new` 或 `/reset` 时的会话归档路径。

它会做这些事：

1. 找到上一段 session transcript
2. 提取最近 N 条 user / assistant 消息
3. 过滤 slash command 等不适合归档的内容
4. 用 LLM 生成一个 slug
5. 写入 `memory/YYYY-MM-DD-<slug>.md`

### 4.2 这条路径的本质

它不是在做高度抽象的“长期知识提炼”，而是在做：

> 会话材料的轻量归档

也就是说，这条路径更像是：

- transcript -> cleaned session note

而不是：

- transcript -> durable long-term memory

### 4.3 为什么它仍然有价值

因为它把原始 transcript 从：

- JSONL
- 混合事件流
- 不利于人工阅读

转成了：

- Markdown
- 带标题和上下文信息
- 方便后续搜索和人工回看

所以这一步虽然不是最终长期记忆，但它已经是一层“中间记忆材料”。

---

## 5. 真正的“长期记忆蒸馏”主要发生在哪里

真正更接近“把用户操作或者对话的客观事实，蒸馏成 memory”的路径，是：

### 5.1 Pre-compaction memory flush

当 session 快接近上下文压缩阈值时，OpenClaw 会触发一次隐藏的 memory flush turn。

系统不会让模型继续正常聊天，而是插入一个内部任务：

- 当前上下文很快要被压缩
- 请把 durable memories 写到 memory 文件
- 如果没什么值得写，就 `NO_REPLY`

### 5.2 这一步和 transcript 归档的区别

这一步不是机械地复制最近对话，而是让模型做判断：

- 哪些是长期偏好
- 哪些是稳定事实
- 哪些是关键决策
- 哪些是以后还会反复用到的经验

所以这一步是：

> 语义蒸馏

而不是：

> 结构清洗

---

## 6. `transcript -> memory` 的本质流程

如果用一条更完整的逻辑链来表示，可以写成：

```text
用户交互
  -> session transcript (.jsonl)
  -> 结构过滤 / 文本提取
      -> SessionFileEntry / recent session content
  -> 两种沉淀路径
      -> session-memory hook：生成会话归档型 memory 文件
      -> pre-compaction memory flush：生成 durable memory
  -> 最终写入 memory Markdown
```

也就是说，OpenClaw 不是一个“自动总结器”，而更像：

- 有原始记录层
- 有候选材料层
- 有特定时机的 memory 沉淀层

---

## 7. 为什么说“规则过滤 + 触发机制 + 模型提炼”三者结合

### 7.1 规则过滤

负责解决“哪些内容根本不应该进入候选材料”：

- 非 message 记录
- 非文本内容
- slash command
- 无效 JSON
- 噪音内容

### 7.2 触发机制

负责解决“什么时候应该把候选材料沉淀成 memory”：

- `/new`
- `/reset`
- pre-compaction
- 用户显式说“remember this”

### 7.3 模型提炼

负责解决“候选材料里哪些东西值得长期保存”：

- 是长期偏好，还是临时状态？
- 是关键结论，还是过程细节？
- 是以后会复用，还是只是当前上下文？

所以真正的 memory 蒸馏不是单一模块做完的，而是一个多层协作过程。

---

## 8. `memory-flush` 提示词本身为什么这样写

相关提示词位于 `src/auto-reply/reply/memory-flush.ts`。

核心内容包括：

- `Pre-compaction memory flush.`
- `Store durable memories now...`
- `APPEND new content only`
- `Do NOT create timestamped variant files`
- `If nothing to store, reply with NO_REPLY`

这段提示词的设计不是随便写的，它同时在约束：

- 写什么
- 写到哪里
- 怎么写
- 什么时候不要写

---

## 9. 这段提示词为什么能把模型引向“长期有价值信息”

### 9.1 `durable memories`

这是最关键的语义锚点。

`durable` 会让模型天然排斥这些内容：

- 一次性过程
- 临时状态
- 当前步骤细节
- 很快会过期的信息

同时更容易激活：

- 长期偏好
- 稳定事实
- 关键决策
- 可复用经验

所以最强的注意力引导，不是“memory”，而是：

> `durable memories`

### 9.2 `pre-compaction`

这相当于告诉模型：

> 很多上下文马上就要丢失，你只能抢救最值得保留的部分。

在这种“压缩前筛选”语境下，模型天然更容易优先保留那些跨时间价值更高的信息。

### 9.3 `APPEND only`

这暗示 memory 文件是一个长期累积容器，而不是一次性摘要。

模型会因此更倾向于写：

- 能长期并列存在的内容
- 不容易过时的条目
- 适合长期积累的结论

### 9.4 `canonical YYYY-MM-DD.md`

固定使用 daily memory 文件，而不是时间戳碎片文件，会把模型从“事件流水”拉向“日级沉淀”。

这有利于写出：

- 今天确认了什么偏好
- 今天形成了什么结论
- 今天学到了什么可复用经验

### 9.5 `NO_REPLY`

这是噪音抑制器。

它强迫模型先做一个隐含判断：

- 这条内容真的值得写入吗？
- 是否比“不写”更有价值？

所以 `NO_REPLY` 提高了写入门槛，从而提升了 durable memory 的纯度。

---

## 10. 这段提示词最重要的注意力锚点

如果把这段提示词抽象成“提示词工程视角”的设计要点，可以提炼出 5 个锚点：

1. `durable`
   - 控制“只保留长期有效内容”

2. `memory`
   - 控制“这是长期记忆容器，不是普通回答”

3. `pre-compaction`
   - 提供压缩前抢救语境，促进信息压缩与优先级判断

4. `append only`
   - 暗示这是长期积累容器，降低覆盖风险

5. `NO_REPLY`
   - 作为噪音抑制器，提高写入内容的价值门槛

---

## 11. 从学习角度，OpenClaw 给出的通用蒸馏框架

如果你想把这套思路迁移到自己的系统里，可以把它总结成下面这个通用框架：

### 11.1 保留原始事实层

先有 transcript，保证事实可回溯。

### 11.2 做结构清洗

把原始日志转成候选材料：

- 去噪
- 提取文本
- 保留角色
- 保留来源映射

### 11.3 建立触发时机

不要每轮都总结，而是在：

- 上下文快满
- 任务结束
- 会话切换
- 用户显式要求记忆

这些节点才进行沉淀。

### 11.4 进行 durable 判断

真正问模型的问题不是：

- 最近发生了什么？

而是：

- 以后还值得记住什么？

### 11.5 分层落盘

不要把所有记忆都塞进一个文件。

像 OpenClaw 这样分层更合理：

- `MEMORY.md`：长期、提炼后的记忆
- `memory/YYYY-MM-DD.md`：daily durable memory
- `memory/YYYY-MM-DD-<slug>.md`：会话归档材料

---

## 12. 最终总结

关于“OpenClaw 如何把 transcript 蒸馏成 memory”，可以浓缩成下面几句话：

1. transcript 先作为原始客观事实层保存下来。
2. 系统通过规则过滤，把 transcript 中的噪音剥离，形成候选材料。
3. `/new` / `/reset` 会把最近会话归档成 Markdown memory 文件。
4. pre-compaction memory flush 会进一步让模型挑出真正 durable 的信息。
5. 真正能让模型偏向长期偏好、稳定事实、关键决策和复用经验的关键提示词，是 `durable memories`、`pre-compaction`、`append only` 和 `NO_REPLY` 这几类注意力锚点。

一句话结论：

> OpenClaw 的 memory 蒸馏不是“复制 transcript”，而是“先保留原始事实，再在关键时机把其中长期有价值的部分沉淀成 memory”。
