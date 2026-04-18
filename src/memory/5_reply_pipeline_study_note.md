# OpenClaw Reply Pipeline Study Note

## 1. 本笔记聚焦的问题

这份笔记专门回答下面两个问题：

1. `reply.ts -> get-reply.ts -> get-reply-run.ts -> agent-runner.ts` 这四层之间到底是什么关系
2. 这条链路往上追时，更上层是谁在触发它

一句话先概括：

> 这四层不是并列关系，而是一条逐层下钻的自动回复主链路：`reply.ts` 提供公开出口，`get-reply.ts` 负责入口预处理，`get-reply-run.ts` 负责运行组装，`agent-runner.ts` 负责一次 reply run 的生命周期总编排。

---

## 2. 先看总图

先不要陷进细节，先看总结构：

```text
[更上层触发入口]
├─ 普通入站消息
│   ├─ WhatsApp / Telegram / Slack / Discord / LINE / 插件通道等
│   └─ 先进入 dispatch / provider-dispatcher 层
│
│   渠道入口
│   -> provider-dispatcher.ts
│   -> dispatch.ts
│   -> dispatch-from-config.ts
│   -> reply.ts
│   -> get-reply.ts
│   -> get-reply-run.ts
│   -> agent-runner.ts
│
└─ Heartbeat 后台触发
    -> heartbeat-runner.ts
    -> reply.ts
    -> get-reply.ts
    -> get-reply-run.ts
    -> agent-runner.ts
```

所以，如果只抓一条主线：

> 普通消息路径比你想象的更长，`get-reply.ts` 并不是最顶层入口；它上面还有 dispatch 层和渠道入口层。

---

## 3. 四层模块分层图

这四个文件可以按职责拆成下面 4 层：

```text
第 0 层：统一出口层
reply.ts
  - 暴露 auto-reply 子系统常用 API
  - 不承担业务执行

第 1 层：入口预处理层
get-reply.ts
  - 处理配置、session、directive、inline action、media staging
  - 决定这条消息是否继续进入 reply run

第 2 层：运行组装层
get-reply-run.ts
  - 组装最终 prompt / queue / followupRun / typing mode
  - 把预处理结果变成一次真正可执行的 run

第 3 层：生命周期总编排层
agent-runner.ts
  - 编排 queue、typing、memory flush、agent turn、usage、payload、followup
  - 负责一次 reply run 从开始到结束的统一收口
```

记忆时可以用一句口诀：

> 门面 -> 预处理 -> 组装 -> 编排

---

## 4. 第一层：`reply.ts` 是公开门面

`src/auto-reply/reply.ts` 本身几乎不实现业务逻辑，它更像 auto-reply 子系统对外暴露的统一出口。

它做的事情非常简单：

- 把 `getReplyFromConfig`
- 若干 directive 提取函数
- queue / exec / reply-tag 提取函数
- 输入输出类型

统一重新导出。

因此它的核心作用不是“执行回复”，而是：

> 给上游模块一个稳定、简短、统一的 import 入口。

所以要特别注意：

- `reply.ts` 是公开 API 门面
- 真正实现逻辑在 `reply/` 子目录内部

---

## 5. 第二层：`get-reply.ts` 是入口预处理层

`src/auto-reply/reply/get-reply.ts` 是自动回复的真正业务入口之一。

它接住一条消息之后，不会立刻启动 agent run，而是先做大量前置处理。

### 5.1 它主要负责什么

可以把它的职责概括成：

1. 加载配置和默认模型
2. 初始化 workspace
3. 初始化 session state
4. 处理 media understanding / link understanding
5. 解析 directive
6. 处理 inline action
7. 处理 reset / model override / sandbox media
8. 最后决定是否调用 `runPreparedReply(...)`

### 5.2 它解决的核心问题

这个文件解决的不是“模型如何回答”，而是：

> 这条消息是否应该继续往下跑，如果继续，应该带着什么运行参数继续。

### 5.3 它和下一层的交接点

当所有前置处理完成，而且没有被 directive 或 inline action 提前截断时，它才会进入：

- `runPreparedReply(...)`

也就是说：

> `get-reply.ts` 的出口，是把“原始消息”变成“已经准备好的 reply 请求”。

---

## 6. 第三层：`get-reply-run.ts` 是运行组装层

`src/auto-reply/reply/get-reply-run.ts` 接到的已经不是原始消息，而是一份“可继续执行”的上下文。

它的职责可以理解成：

> 把预处理后的请求，组装成一次完整的 reply run。

### 6.1 它主要做什么

这一层的关键工作包括：

1. 生成最终 prompt body
2. 拼接 inbound meta / group intro / thread context / system events
3. 处理 bare `/new` / `/reset` 这类特殊消息
4. 处理 think level / reasoning level 等运行参数
5. 计算 queue 行为
6. 生成 `followupRun`
7. 最终调用 `runReplyAgent(...)`

### 6.2 它和上一层的区别

- `get-reply.ts` 更像入口控制器
- `get-reply-run.ts` 更像运行参数装配器

更准确地说：

- `get-reply.ts` 偏 request preprocessing
- `get-reply-run.ts` 偏 run assembly

### 6.3 它和下一层的交接点

这个文件的最终目标，是把所有运行参数准备好，然后交给：

- `runReplyAgent(...)`

所以它本质上是：

> 预处理层和执行总编排层之间的桥。

---

## 7. 第四层：`agent-runner.ts` 是生命周期总编排层

`src/auto-reply/reply/agent-runner.ts` 不再处理消息入口分流，也不再负责拼 prompt 主体，而是负责：

> 把一次 reply run 从开始到结束完整编排起来。

### 7.1 它主要负责什么

这一层会统一处理：

1. 活跃 run 的 queue 冲突决策
2. typing 生命周期
3. pre-compaction memory flush
4. 调用执行层跑真正的 agent turn
5. fallback 状态更新
6. usage 持久化
7. payload 构建与去重
8. verbose notices / diagnostics / followup 收口
9. finally 清理

### 7.2 它解决的核心问题

这个文件解决的不是“是否跑”，而是：

> 既然已经决定跑了，这次 run 如何安全开始、稳定执行、正确收尾。

所以如果从架构角度给它命名，最合适的词就是：

> lifecycle orchestrator

---

## 8. 四层之间的真实关系

把这四个文件放在一起看，它们并不是“功能相似的四个文件”，而是严格串联的四段职责链。

### 8.1 关系图

```text
reply.ts
  -> 公开暴露 getReplyFromConfig 等入口

get-reply.ts
  -> 处理消息入口预处理
  -> 调用 runPreparedReply(...)

get-reply-run.ts
  -> 组装完整运行参数
  -> 调用 runReplyAgent(...)

agent-runner.ts
  -> 编排一次 reply run 的生命周期
```

### 8.2 一句话对应

- `reply.ts`：公开门面
- `get-reply.ts`：入口预处理
- `get-reply-run.ts`：运行组装
- `agent-runner.ts`：生命周期总编排

---

## 9. 更上层是谁在触发这条链

这是理解全链路时最容易漏掉的一层。

很多人看到 `get-reply.ts` 会误以为：

> “用户消息一进来就直接调用 `getReplyFromConfig()`”

其实不是。

普通消息和 heartbeat 走的是两条不同的上游触发路径。

---

## 10. 上游路径 A：普通入站消息

普通用户消息通常不会直接碰 `get-reply.ts`，而是先进入 dispatch 层。

### 10.1 主链路

```text
渠道 monitor / command handler
-> provider-dispatcher.ts
-> dispatch.ts
-> dispatch-from-config.ts
-> reply.ts
-> get-reply.ts
-> get-reply-run.ts
-> agent-runner.ts
```

### 10.2 渠道入口有哪些

这一层可能来自很多内建或插件化通道，例如：

- WhatsApp Web
- Telegram
- Slack
- Discord
- LINE
- Plugin SDK / channel adapters

它们的共同特征是：

> 不直接进入 `get-reply.ts`，而是先通过 dispatch / dispatcher 层统一处理发送、typing、block reply、tool result 等消息通道语义。

### 10.3 为什么需要 dispatch 层

因为在真正调用 reply 核心之前，系统还要处理很多“消息系统层”的事情，例如：

- inbound 去重
- ACP / abort 快速分流
- send policy
- route 到 originating channel
- TTS 包装
- tool result / block reply 的外发行为

这些都不是 `get-reply.ts` 应该负责的，所以被放在它的上游。

---

## 11. 普通消息路径里的 3 个关键上游文件

### 11.1 `provider-dispatcher.ts`

这个文件是渠道适配层进入 dispatch 核心的桥。

它的职责很轻，更多是：

> 给不同 provider 一个统一的 dispatch 调用入口。

### 11.2 `dispatch.ts`

这个文件负责：

- finalize inbound context
- 管理 dispatcher 生命周期
- 统一调用 `dispatchReplyFromConfig(...)`

所以它更像：

> dispatch 主入口封装层

### 11.3 `dispatch-from-config.ts`

这个文件是普通消息路径里，对 `getReplyFromConfig(...)` 的直接调用者。

它会：

- 组装 reply options
- 接入 `onToolResult`
- 接入 `onBlockReply`
- 决定最终如何发送 final/tool/block payload

所以如果你问：

> 普通消息路径上，谁直接调用了 `get-reply.ts`？

最准确答案是：

> `dispatch-from-config.ts`

---

## 12. 上游路径 B：Heartbeat 后台触发

第二条路径不是用户直接发消息，而是系统后台的 heartbeat 机制。

### 12.1 主链路

```text
heartbeat-runner.ts
-> reply.ts
-> get-reply.ts
-> get-reply-run.ts
-> agent-runner.ts
```

### 12.2 它和普通消息路径的区别

这条路径：

- 不经过普通消息 dispatch 主链
- 直接调用 `getReplyFromConfig(...)`
- 但带有 `isHeartbeat: true` 这类特殊运行参数

所以它不是“外部消息驱动”，而是：

> 系统内部主动发起的一次特殊 reply run

### 12.3 为什么它可以直接进入 reply 核心

因为 heartbeat 本质上已经是系统内部构造好的特殊消息上下文，不需要重复经过普通渠道的 dispatcher 语义层。

---

## 13. 两条上游路径的差异总结

### 13.1 普通消息路径

特点：

- 入口更高
- 经过 dispatch 层
- 处理消息通道语义
- 适合真实用户消息

### 13.2 heartbeat 路径

特点：

- 入口更靠近 reply 核心
- 不经过普通 dispatch 主链
- 适合系统内部定时/探测/保活场景

所以你可以这样记：

> 普通消息先过“消息系统层”，heartbeat 直接进入“reply 核心层”。

---

## 14. 更完整的总分层图

把更上层和更下层都串起来，可以得到下面这张更完整的图：

```text
[外部/系统触发层]
├─ 普通消息触发
│   ├─ WhatsApp / Telegram / Slack / Discord / LINE / Plugins
│   └─ 进入 dispatch / provider-dispatcher 链
│
└─ Heartbeat 后台触发
    └─ 直接进入 reply 核心链

[消息分发层]
provider-dispatcher.ts
dispatch.ts
dispatch-from-config.ts

[公开 API 层]
reply.ts

[自动回复核心链]
get-reply.ts
get-reply-run.ts
agent-runner.ts

[更下游执行层]
agent-runner-execution.ts
agent-runner-memory.ts
agent-runner-payloads.ts
queue / typing / fallback / followup / payload helpers
```

这张图最重要的意义是：

> 它把“上游谁在触发”和“下游谁在真正执行”都放到了同一张结构图里。

---

## 15. 学习这条链路的最佳顺序

如果你是为了学习源码，不建议直接从 `agent-runner.ts` 回头硬追所有上游。

更推荐下面这个顺序：

### 第一步：先记住四层职责

- `reply.ts`：门面
- `get-reply.ts`：预处理
- `get-reply-run.ts`：组装
- `agent-runner.ts`：编排

### 第二步：再补上普通消息路径

再把下面三层补进去：

- `provider-dispatcher.ts`
- `dispatch.ts`
- `dispatch-from-config.ts`

这样你就能看懂“真实用户消息为什么不是直接进 `get-reply.ts`”。

### 第三步：最后再单独看 heartbeat 路径

因为 heartbeat 是一条特例路径：

- 结构更短
- 参数更特殊
- 更像内部系统调用

把它和普通消息路径分开记，更不容易混。

---

## 16. 一句话总结整条链

可以把整条自动回复链浓缩成一句话：

> OpenClaw 先在更上层完成消息分发与通道语义处理，再通过 `reply.ts` 公开入口进入 reply 核心链，由 `get-reply.ts` 完成预处理、`get-reply-run.ts` 完成运行组装，最后由 `agent-runner.ts` 编排一次完整的回复生命周期。

---

## 17. 立刻可执行的学习行动

如果你要继续往下学，建议下一步按这个顺序读：

1. `src/auto-reply/reply/provider-dispatcher.ts`
2. `src/auto-reply/dispatch.ts`
3. `src/auto-reply/reply/dispatch-from-config.ts`
4. `src/auto-reply/reply/get-reply.ts`
5. `src/auto-reply/reply/get-reply-run.ts`
6. `src/auto-reply/reply/agent-runner.ts`

如果你更关心“真正执行 agent turn”的那一层，再继续下钻：

7. `src/auto-reply/reply/agent-runner-execution.ts`
8. `src/auto-reply/reply/agent-runner-payloads.ts`
9. `src/auto-reply/reply/agent-runner-memory.ts`
