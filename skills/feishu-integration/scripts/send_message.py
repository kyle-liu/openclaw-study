#!/usr/bin/env python3
"""
飞书消息发送工具
"""

import requests
import json
import sys
import argparse

def send_message(token: str, receive_id: str, msg_type: str, content: str) -> dict:
    """发送飞书消息"""
    url = "https://open.feishu.cn/open-apis/im/v1/messages"
    
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json"
    }
    
    payload = {
        "receive_id": receive_id,
        "msg_type": msg_type,
        "content": content
    }
    
    response = requests.post(url, headers=headers, json=payload)
    result = response.json()
    
    return result

def main():
    parser = argparse.ArgumentParser(description="发送飞书消息")
    parser.add_argument("--token", required=True, help="tenant_access_token")
    parser.add_argument("--receive-id", required=True, help="接收者 ID (ou_xxx 或 oc_xxx)")
    parser.add_argument("--type", default="text", choices=["text", "post", "interactive"], help="消息类型")
    parser.add_argument("--content", required=True, help="消息内容 (JSON 字符串)")
    
    args = parser.parse_args()
    
    result = send_message(args.token, args.receive_id, args.type, args.content)
    print(json.dumps(result, indent=2, ensure_ascii=False))
    
    if result.get("code") != 0:
        sys.exit(1)

if __name__ == "__main__":
    main()
