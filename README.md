# Claude-Weixin-Bot

微信 ClawBot + LLM 智能回复，零依赖 OpenClaw，纯 TypeScript 实现。

## 快速开始

```bash
cp .env.example .env
# 编辑 .env 填入你的 LLM_API_KEY
npm install
npm start
```

首次运行会显示二维码，用微信扫码即可连接。后续启动自动恢复。

## 环境变量

| 变量 | 说明 | 默认值 |
|---|---|---|
| `LLM_API_KEY` | API Key（必填） | - |
| `LLM_BASE_URL` | API 端点 | `https://api.deepseek.com/v1` |
| `LLM_MODEL` | 模型名称 | `deepseek-chat` |
| `SYSTEM_PROMPT` | 系统提示词 | 中文友好助手 |
| `STATE_DIR` | 状态持久化目录 | `./state` |
| `PORT` | 健康检查端口 | `8080` |

## 模型配置

```bash
# DeepSeek
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_MODEL=deepseek-chat

# OpenAI
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o

# 任意兼容接口
LLM_BASE_URL=https://your-proxy.com/v1
LLM_MODEL=claude-sonnet-4-6
```

## 云部署

支持 Docker 一键部署到 Railway / Render / Fly.io 等平台。

```bash
docker build -t claude-weixin-bot .
docker run -e LLM_API_KEY=sk-... -p 8080:8080 claude-weixin-bot
```

## 协议

基于微信官方 iLink Bot 协议（`@tencent-weixin/openclaw-weixin`），纯 HTTP/JSON 通信。
