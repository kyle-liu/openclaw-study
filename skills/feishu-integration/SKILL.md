---
name: feishu-integration
description: 飞书 (Lark) 企业集成技能，支持消息发送/接收、机器人配置、事件订阅。Use when: (1) 配置飞书企业自建应用机器人，(2) 发送消息到飞书群组/用户，(3) 接收飞书消息事件，(4) 创建交互卡片，(5) 集成飞书 API 到 OpenClaw 工作流。
---

# 飞书集成技能

## 快速开始

### 1. 配置飞书应用

1. 访问 https://open.feishu.cn/
2. 创建企业自建应用
3. 获取凭证：
   - `App ID` (cli_xxxxxxxxxxxxx)
   - `App Secret`
4. 启用权限：
   - 机器人
   - 消息发送与接收
   - 通讯录读取 (可选)

### 2. 获取访问令牌

```bash
# 使用脚本获取 token (有效期 2 小时)
python scripts/get_token.py <app_id> <app_secret>

# 或使用 curl
curl -X POST "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal" \
  -H "Content-Type: application/json" \
  -d '{"app_id": "xxx", "app_secret": "xxx"}'
```

### 3. 发送消息

```bash
# 文本消息
python scripts/send_message.py \
  --token t-xxxxxxxxxxxxx \
  --receive-id oc_xxxxxxxxxxxxx \
  --type text \
  --content '{"text": "Hello from OpenClaw"}'

# 富文本消息
python scripts/send_message.py \
  --token t-xxxxxxxxxxxxx \
  --receive-id oc_xxxxxxxxxxxxx \
  --type post \
  --content '{"zh_cn": {"title": "标题", "content": [[{"tag": "text", "text": "内容"}]]}}'
```

---

## 核心功能

### 消息发送

支持的消息类型：

| 类型     | msg_type      | 说明                  |
| -------- | ------------- | --------------------- |
| 文本     | `text`        | 纯文本消息            |
| 富文本   | `post`        | 支持链接、@用户、表情 |
| 交互卡片 | `interactive` | 按钮、表单等交互元素  |
| 图片     | `image`       | 需先上传图片获取 key  |
| 文件     | `file`        | 需先上传文件获取 key  |

**获取接收者 ID：**

- 用户 ID: `ou_xxxxxxxxxxxxx` (open_id)
- 群组 ID: `oc_xxxxxxxxxxxxx` (chat_id)
- 部门 ID: `on_xxxxxxxxxxxxx` (open_id)

### 事件订阅

配置 Webhook 接收飞书事件：

1. 开放平台 → 事件订阅 → 配置请求 URL
2. 验证 URL (返回 challenge 值)
3. 订阅事件：
   - `im.message.receive_v1` - 接收消息
   - `im.chat.member_bot.add_v1` - 机器人进群

**事件处理流程：**

```
飞书服务器 → Webhook → OpenClaw → 处理逻辑 → API 响应
```

### 通讯录查询

```bash
# 通过手机号查询用户 ID
curl -X GET "https://open.feishu.cn/open-apis/contact/v3/users/mobile?mobile=13800138000" \
  -H "Authorization: Bearer t-xxxxxxxxxxxxx"
```

---

## OpenClaw 集成

### 方案 A：直接调用脚本

```bash
# 在 OpenClaw 中使用 exec 工具
exec: python skills/feishu-integration/scripts/send_message.py ...
```

### 方案 B：配置 Cron 定时任务

```bash
# 定时发送日报
cron add --schedule "0 9 * * *" --payload "systemEvent: 发送飞书日报"
```

### 方案 C：Webhook 接收器

创建 HTTP 端点接收飞书事件推送，触发 OpenClaw 处理逻辑。

---

## 凭证管理

**⚠️ 安全警告：不要明文存储 App Secret！**

推荐方式：

1. 环境变量：`FEISHU_APP_ID`, `FEISHU_APP_SECRET`
2. 配置文件：`~/.feishu/config.json` (权限 600)
3. OpenClaw TOOLS.md: 记录配置路径

---

## 参考文档

- **API 详情**: 见 `references/api.md`
- **开放平台**: https://open.feishu.cn/
- **API 文档**: https://open.feishu.cn/document/

---

## 故障排查

| 问题           | 可能原因     | 解决方案             |
| -------------- | ------------ | -------------------- |
| code: 99991665 | token 过期   | 重新获取 token       |
| code: 99991668 | 权限不足     | 检查应用权限配置     |
| code: 99991671 | 参数错误     | 检查 receive_id 格式 |
| 消息未送达     | 机器人不在群 | 邀请机器人进群       |
