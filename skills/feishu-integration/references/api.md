# 飞书 API 参考

## 基础信息

- **Base URL**: `https://open.feishu.cn/open-apis`
- **认证方式**: Bearer Token (tenant_access_token / user_access_token)
- **Token 有效期**: 2 小时 (7200 秒)

---

## 认证 API

### 获取应用级令牌 (tenant_access_token)

```bash
POST /open-apis/auth/v3/tenant_access_token/internal
Content-Type: application/json

{
  "app_id": "cli_xxxxxxxxxxxxx",
  "app_secret": "xxxxxxxxxxxxxxxxx"
}

# 响应
{
  "code": 0,
  "tenant_access_token": "t-xxxxxxxxxxxxx",
  "expire": 7200
}
```

---

## 消息 API

### 发送消息

```bash
POST /open-apis/im/v1/messages
Authorization: Bearer {tenant_access_token}
Content-Type: application/json

{
  "receive_id": "ou_xxxxxxxxxxxxx",
  "msg_type": "text",
  "content": "{\"text\": \"消息内容\"}"
}
```

**receive_id 类型：**

- `ou_` 开头：用户 open_id
- `oc_` 开头：群组 chat_id
- `on_` 开头：部门 open_id

**msg_type 支持：**

- `text`: 纯文本
- `post`: 富文本
- `interactive`: 交互卡片
- `image`: 图片
- `file`: 文件

### 发送富文本消息

```json
{
  "receive_id": "oc_xxxxx",
  "msg_type": "post",
  "content": {
    "zh_cn": {
      "title": "标题",
      "content": [
        [{ "tag": "text", "text": "第一行内容" }],
        [{ "tag": "a", "text": "链接文本", "href": "https://example.com" }],
        [{ "tag": "at", "user_id": "ou_xxxxx" }]
      ]
    }
  }
}
```

### 发送交互卡片

```json
{
  "receive_id": "oc_xxxxx",
  "msg_type": "interactive",
  "content": {
    "config": {
      "wide_screen_mode": true
    },
    "elements": [
      {
        "tag": "div",
        "text": {
          "content": "**标题**\n内容描述",
          "tag": "lark_md"
        }
      },
      {
        "tag": "action",
        "actions": [
          {
            "tag": "button",
            "text": {
              "content": "确认",
              "tag": "plain_text"
            },
            "type": "primary"
          }
        ]
      }
    ]
  }
}
```

---

## 联系人 API

### 查询用户 ID

```bash
GET /open-apis/contact/v3/users/:user_id_type?user_id={手机号/邮箱/工号}
Authorization: Bearer {tenant_access_token}

# user_id_type: mobile / email / user_id
```

### 获取群组列表

```bash
GET /open-apis/im/v1/chats?page_size=50
Authorization: Bearer {tenant_access_token}
```

---

## 事件订阅

### 回调验证

飞书会发送 URL 验证请求：

```json
{
  "challenge": "xxxxxxxxx",
  "token": "xxxxxxxxx",
  "type": "url_verification"
}
```

**响应**: 直接返回 `challenge` 值

### 事件类型

**接收消息事件：**

```json
{
  "schema": "im.message.receive_v1",
  "header": {
    "event_id": "xxx",
    "event_type": "im.message.receive_v1",
    "create_time": "1234567890"
  },
  "event": {
    "message": {
      "message_id": "om_xxxxx",
      "chat_id": "oc_xxxxx",
      "msg_type": "text",
      "content": "{\"text\": \"@机器人 你好\"}",
      "sender_id": {
        "open_id": "ou_xxxxx"
      }
    }
  }
}
```

**机器人进群事件：**

```json
{
  "schema": "im.chat.member_bot.add_v1",
  "event": {
    "chat_id": "oc_xxxxx"
  }
}
```

---

## 错误码

| Code     | 说明                     |
| -------- | ------------------------ |
| 0        | 成功                     |
| 99991663 | app_ticket 无效          |
| 99991665 | tenant_access_token 无效 |
| 99991668 | 没有权限                 |
| 99991671 | 参数错误                 |
