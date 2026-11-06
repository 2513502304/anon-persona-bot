# ANON Persona Bot

QQ 角色聊天机器人，部署在 Vercel Daemons，使用官方 QQ WebSocket 接入、私有 Vercel Blob 持久化和 Chat SDK 自定义适配器。

支持 OpenAI / DeepSeek 精确模型选择，千早爱音、芙宁娜和喜多郁代人格；仅用于非官方角色扮演。

## 开发

```sh
npm ci
npm run check
npm test
npm run build:daemon
```

运行环境 Node.js 24。凭证仅通过环境变量配置，不要提交 `.env` 或 `.vercel/`。

部署与使用文档将在后续功能提交中完善。
