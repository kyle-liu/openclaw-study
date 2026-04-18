#!/usr/bin/env python3
"""
飞书认证工具 - 获取 tenant_access_token
"""

import requests
import json
import sys

def get_tenant_access_token(app_id: str, app_secret: str) -> dict:
    """获取应用级访问令牌"""
    url = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal"
    
    payload = {
        "app_id": app_id,
        "app_secret": app_secret
    }
    
    headers = {
        "Content-Type": "application/json"
    }
    
    response = requests.post(url, headers=headers, json=payload)
    result = response.json()
    
    if result.get("code") != 0:
        print(f"Error: {result}", file=sys.stderr)
        sys.exit(1)
    
    return result

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: get_token.py <app_id> <app_secret>", file=sys.stderr)
        sys.exit(1)
    
    app_id = sys.argv[1]
    app_secret = sys.argv[2]
    
    result = get_tenant_access_token(app_id, app_secret)
    print(json.dumps(result, indent=2))
