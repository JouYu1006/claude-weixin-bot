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
| `LLM_API_KEY` | Kimi (Moonshot AI) API Key（必填，去 platform.moonshot.cn 创建） | - |
| `LLM_BASE_URL` | API 端点 | `https://api.moonshot.cn/v1` |
| `LLM_MODEL` | 主模型（始终推理） | `kimi-k3` |
| `LLM_REASONING` | 推理深度：`low` / `high` / `max` | `high` |
| `VISION_MODEL` | 视觉模型（图片识别） | `kimi-k2.6` |
| `MEMORY_MODEL` | 记忆抽取模型 | `kimi-k2.6` |
| `PUSH_CITY` | 每日推送查询天气的城市 | `北京` |
| `SYSTEM_PROMPT` | 系统提示词 | 中文友好助手 |
| `STATE_DIR` | 状态持久化目录 | `./state` |
| `PORT` | 健康检查端口 | `8080` |

## 功能特性

- **Kimi k3 推理对话**：始终推理，`reasoning_effort` 可调（low / high / max）
- **Kimi 内置联网搜索**：通过 `$web_search` 内置工具由 Kimi 服务端完成搜索
- **图片识别**：Kimi 视觉模型（kimi-k2.6）直读图片
- **Agent 工具**：计算、代码执行、联网搜索
- **持久记忆**：自动提取并记住用户事实
- **每日推送**：定时推送天气 + 科技新闻早间简报

## 模型配置

```bash
# Kimi (Moonshot AI)
LLM_BASE_URL=https://api.moonshot.cn/v1
LLM_MODEL=kimi-k3

# 任意 OpenAI 兼容接口
LLM_BASE_URL=https://your-proxy.com/v1
LLM_MODEL=your-model
```

## 云部署

支持 Docker 一键部署到 Railway / Render / Fly.io 等平台。

```bash
docker build -t claude-weixin-bot .
docker run -e LLM_API_KEY=sk-... -p 8080:8080 claude-weixin-bot
```

## 协议

基于微信官方 iLink Bot 协议（`@tencent-weixin/openclaw-weixin`），纯 HTTP/JSON 通信。
