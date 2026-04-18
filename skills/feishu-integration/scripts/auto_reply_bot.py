#!/usr/bin/env python3
"""
飞书自动回复机器人
监听群消息并自动回复
"""

import http.server
import json
import requests
import sys
import os

# 配置
PORT = 8080
FEISHU_TOKEN = os.environ.get("FEISHU_TOKEN", "")  # 飞书验证 Token
APP_ID = "cli_a939695b23f8dbde"
APP_SECRET = "0QInnM55A3JI2FJK5E1e0bPfwk0ax1L5"
TARGET_CHAT_ID = "oc_4935087f82770d3ef19a215c41206d05"  # openclaw test 群

def get_tenant_token():
    """获取访问令牌"""
    url = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal"
    resp = requests.post(url, json={"app_id": APP_ID, "app_secret": APP_SECRET})
    result = resp.json()
    if result.get("code") == 0:
        return result["tenant_access_token"]
    raise Exception(f"获取 token 失败：{result}")

def send_message(chat_id, text):
    """发送消息"""
    token = get_tenant_token()
    url = "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id"
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    payload = {
        "receive_id": chat_id,
        "msg_type": "text",
        "content": json.dumps({"text": text})
    }
    resp = requests.post(url, headers=headers, json=payload)
    return resp.json()

class FeishuBotHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        print(f"[{self.log_date_time_string()}] {format % args}")
    
    def do_POST(self):
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length).decode('utf-8')
        
        try:
            event = json.loads(body)
        except:
            self.send_response(400)
            self.end_headers()
            return
        
        # URL 验证
        if event.get("type") == "url_verification":
            challenge = event.get("challenge")
            print(f"🔐 URL 验证：{challenge}")
            self.send_response(200)
            self.send_header('Content-Type', 'text/plain')
            self.end_headers()
            self.wfile.write(challenge.encode())
            return
        
        # 处理消息事件
        schema = event.get("schema", "")
        if schema == "im.message.receive_v1":
            self.handle_message(event)
        
        self.send_response(200)
        self.end_headers()
    
    def handle_message(self, event):
        message = event.get("event", {}).get("message", {})
        chat_id = message.get("chat_id")
        msg_type = message.get("msg_type")
        content = json.loads(message.get("content", "{}"))
        sender = message.get("sender", {})
        sender_name = sender.get("sender_name", "Unknown")
        
        # 忽略机器人自己的消息
        if sender.get("sender_type") == "app":
            return
        
        text = content.get("text", "") if msg_type == "text" else ""
        
        print(f"\n💬 {sender_name}: {text}")
        
        # 简单回复逻辑
        if "你好" in text or "hello" in text.lower():
            reply = f"👋 你好 {sender_name}！我是 KyleMaster 机器人 🚀"
        elif "厉害" in text:
            reply = "😎 当然厉害！"
        elif "大龙虾" in text:
            reply = "🦞 大龙虾在此！"
        elif text.strip():
            reply = f"收到：{text}"
        else:
            return
        
        print(f"🤖 回复：{reply}")
        result = send_message(chat_id, reply)
        if result.get("code") == 0:
            print(f"✅ 消息已发送：{result['data']['message_id']}")
        else:
            print(f"❌ 发送失败：{result}")

def main():
    server = http.server.HTTPServer(('0.0.0.0', PORT), FeishuBotHandler)
    print(f"🚀 飞书自动回复机器人启动")
    print(f"   端口：{PORT}")
    print(f"   监听群：{TARGET_CHAT_ID}")
    print(f"\n飞书配置 URL: http://<你的公网 IP>:{PORT}/feishu/webhook")
    print(f"按 Ctrl+C 停止")
    
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n👋 服务已停止")
        server.shutdown()

if __name__ == "__main__":
    main()
