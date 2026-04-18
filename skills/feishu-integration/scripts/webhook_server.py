#!/usr/bin/env python3
"""
飞书 Webhook 服务器 - 接收消息事件
"""

import http.server
import json
import hashlib
import base64
import hmac
from urllib.parse import urlparse, parse_qs
import subprocess
import sys

# 配置
PORT = 8080
FEISHU_TOKEN = ""  # 飞书开放平台设置的验证 Token

class FeishuWebhookHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        print(f"[{self.log_date_time_string()}] {format % args}")
    
    def do_POST(self):
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length).decode('utf-8')
        
        try:
            event = json.loads(body)
        except json.JSONDecodeError:
            self.send_response(400)
            self.end_headers()
            return
        
        # 处理 URL 验证
        if event.get("type") == "url_verification":
            challenge = event.get("challenge")
            print(f"🔐 URL 验证请求，challenge: {challenge}")
            self.send_response(200)
            self.send_header('Content-Type', 'text/plain')
            self.end_headers()
            self.wfile.write(challenge.encode())
            return
        
        # 处理事件
        schema = event.get("schema", "")
        print(f"📨 收到事件：{schema}")
        
        if schema == "im.message.receive_v1":
            self.handle_message(event)
        else:
            print(f"⚠️ 未处理的事件类型：{schema}")
        
        self.send_response(200)
        self.end_headers()
    
    def handle_message(self, event):
        """处理接收到的消息"""
        message = event.get("event", {}).get("message", {})
        sender = message.get("sender", {})
        chat_id = message.get("chat_id")
        msg_type = message.get("msg_type")
        content = json.loads(message.get("content", "{}"))
        
        text = content.get("text", "") if msg_type == "text" else str(content)
        sender_name = sender.get("sender_name", "Unknown")
        sender_id = sender.get("sender_id", {}).get("open_id", "")
        
        print(f"\n💬 新消息:")
        print(f"   群：{chat_id}")
        print(f"   发送者：{sender_name} ({sender_id})")
        print(f"   内容：{text}")
        
        # 调用 OpenClaw 处理消息
        self.process_with_openclaw(text, sender_id, chat_id, sender_name)
    
    def process_with_openclaw(self, text, sender_id, chat_id, sender_name):
        """调用 OpenClaw 处理消息"""
        # 这里可以调用 OpenClaw 的 API 或执行命令
        # 示例：将消息写入文件或调用脚本
        print(f"🤖 处理消息：{text[:50]}...")
        
        # 可以调用飞书 API 回复消息
        # subprocess.run([
        #     "python3", "send_message.py",
        #     "--token", TOKEN,
        #     "--receive-id", chat_id,
        #     "--type", "text",
        #     "--content", json.dumps({"text": f"收到：{text}"})
        # ])

def main():
    if len(sys.argv) > 1:
        global FEISHU_TOKEN
        FEISHU_TOKEN = sys.argv[1]
    
    server = http.server.HTTPServer(('0.0.0.0', PORT), FeishuWebhookHandler)
    print(f"🚀 飞书 Webhook 服务器启动")
    print(f"   监听端口：{PORT}")
    print(f"   配置 URL: http://<你的公网 IP>:{PORT}/feishu/webhook")
    print(f"\n按 Ctrl+C 停止服务")
    
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n👋 服务已停止")
        server.shutdown()

if __name__ == "__main__":
    main()
