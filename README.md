# ANON Persona Bot

运行在 Vercel 上的 QQ 人格聊天机器人。使用 QQ 官方 WebSocket Gateway 接收消息，用 OpenAI 或 DeepSeek API 回复；模型、推理强度和人格由用户明确选择。

当前实现一个已绑定 QQ 群及 C2C 私聊路由。私聊是否收到事件、跨场景身份字段是否可用，取决于 QQ 应用权限，部署后需要实测。Telegram、Discord、微信尚未接入。

## 功能

- 人格：千早爱音、芙宁娜、喜多郁代。属于非官方角色扮演，不代表原作官方。
- 精确模型和 effort 选择；失败不会静默切换模型或提供方。
- 每个会话、每个人格独立保存文字对话，按 256k 上下文预算自动压缩，不按轮数截断。
- `/image` 文字生图，明确指定图片模型、质量、尺寸和 complexity。
- 按个人计算每日次数，群聊与私聊自动共用额度。
- 群内命令回复在 QQ 自动 @请求人后换行；帮助按用途分组。`/help`、`/ping` 和模型/人格/图片列表走独立的持久化队列，不等待聊天模型完成。
- 私有 Blob 保存状态，无需本地持久磁盘。

不执行终端、网页操作或文件任务；暂不支持图片理解、上传图片编辑、语音或自然语言自动调用生图工具。

## 使用

群里先真正 @机器人，再输入命令；私聊直接发送。

```text
/help
/model --ls
/model openai:gpt-6.1-sol high
/model openai:gpt-6.1-terra high
/model deepseek:deepseek-flash high
/persona --ls
/persona 芙宁娜
/status
/reset --confirm
/usage
```

`/model` 和 `/persona` 的选择只影响当前会话，不改变其他人的选择。群聊与私聊的对话记忆分开。

```text
/image 一只戴蓝色围巾的小猫，水彩画
/image --model gpt-image-2.6-sunburst --quality high --size 1536x1024 海边的落日
/image --ls
/image --help
```

图片默认 `openai:gpt-image-2.6-flare`、medium 质量、1024x1024、medium complexity。图片作为 JPEG 字节上传 QQ，避免 QQ 需要访问外部图片网址。文本模型的 effort 与生图 complexity 是两个独立参数。

模型可用性和额度由对应 API 账号决定；模型清单位于 `src/models.ts` 与 `src/images.ts`。ChatGPT/Codex 客户端里的显示名称不应直接当成其他 API 的模型 ID。

## 对话记忆与压缩

每个人格的上下文预算为 256,000 tokens，约 90% 时触发压缩。预算以内保留所有对话原文，不限制 12 或 20 轮；触发时按约 20k tokens 保留最近的完整对话，其余内容与上次摘要一起压成新摘要。原文保留量按 token 计算，短对话可以保留远多于 20 轮。`/status` 显示本地估算占用和压缩次数，`/reset --confirm` 同时清除当前人格的原文与摘要。

本地使用 o200k tokenizer 估算，**不是提供方的精确计量**；当前三个模型的官方窗口均大于本应用的 256k 预算。若新增窗口更小的模型，需要同步调整预算，不能直接沿用此值。

设计参考 [Codex 本地压缩实现](https://github.com/openai/codex/blob/main/codex-rs/core/src/compact.rs)：按 token 阈值触发、构建摘要、保留预算内的近期原文。这里使用当前选中的模型及 effort 生成可跨 OpenAI/DeepSeek 继续使用的文本摘要；并非把 OpenAI 的不透明加密 compaction item 传给其他提供方。人格指令每次重新注入，摘要仅作历史数据，不授予额外权限。

压缩不额外扣个人每日次数，但会产生对应模型的 API token 费用。压缩失败保留原记忆，不自动重试付费请求；成功摘要先持久化，再继续聊天。压缩有信息损失，不承诺永久逐字记忆。模型切换保留同一人格的原文和摘要，群聊与私聊仍分开。

## 个人额度与身份

| 身份 | 每日默认次数 |
| --- | ---: |
| 普通成员 | 10 |
| 管理员 | 100 |
| 绑定群的机器人所有者 | 无限 |

北京时间每天 00:00 重置。一次文字模型请求或一次生图请求计一次；帮助和设置命令免费。失败、超时请求也计次，因为上游可能已经处理并收费。

绑定群的所有者可在群内设置成员的每日总上限：

```text
/usage-limit 100 @成员
/usage-limit --reset @成员
```

必须使用 QQ 的真实 @；手打昵称或数字 QQ 号不能作为授权依据。支持 0–10000；修改上限不清空当天用量。管理员身份从 QQ 签名事件/已认证 Gateway 事件读取，私聊沿用最近 24 小时确认过的群内身份；过期后需在群内发消息刷新。首次 `/bind` 的账号是部署所有者，请只由预期所有者完成。

QQ 官方机器人提供 OpenID，而非数字 QQ 号。同一应用收到的相同用户 OpenID 直接归入一个个人账户；群聊与私聊无需绑定码。首次使用的普通成员先在已绑定群里 @机器人发一次 `/usage`，系统便能验证群成员身份；所有者可直接私聊。若 QQ 提供统一身份字段，也使用该字段关联身份。聊天记忆依然按会话分开。

从早期按场景分账户的版本升级时，会原子合并同一个 OpenID 的旧账户，保留当天用量、群主权限及自定义额度。旧 `/link` 流程已移除。

## 部署

需要 Node.js 24、QQ 开放平台机器人应用、OpenAI/DeepSeek API Key，以及可使用 Daemons 和私有 Blob 的 Vercel 项目。

1. 安装并验证：

   ```sh
   npm ci
   npm run check
   npm test
   npm run build:daemon
   ```

2. 在 Vercel 创建项目，Framework 选 Other，Build Command 为 `npm run build`，Output Directory 为 `public`。连接一个 **private Blob** store。推荐用项目 OIDC 授权；Daemon 会重新读取轮换的 OIDC 文件。
3. 在 Vercel 的 **Production** 环境配置 `.env.example` 中的变量。API Key 和 QQ Secret 设为敏感变量；`QQ_PAIRING_CODE`、`CRON_SECRET` 各使用独立的高熵随机值。初始设置 `BOT_ENABLED=false`。
4. 为 QQ 应用开通相应的群聊、C2C 权限并添加测试群/用户。程序订阅 `GROUP_AND_C2C` intent，通过出站 WebSocket 连接；此部署方式不依赖 QQ 请求 Vercel Webhook 域名。
5. 使用 Vercel CLI 关联项目并部署：

   ```sh
   npx vercel link
   npx vercel deploy --prod
   ```

6. 所有者在目标群真正 @机器人并发送 `/bind 配对码`。之后发 `/ping`、`/help`，确认收到回复。配对码不会保存在对话记忆里。
7. 将 `BOT_ENABLED=true` 后重新部署，测试文字聊天、`/image` 和私聊 `/usage`。私聊需单独验证，不应仅凭群聊成功认定私聊可用。

保留绑定和会话的 Blob store，不要在升级时替换为空 store。不要将生产凭据或生产 Blob 连接复制到不受信任的 PR/预览环境。

`vercel.json` 配置一个 1 GiB QQ Gateway Daemon 和辅助 Functions。Daemon 是持续计费资源，会消耗 Vercel 平台额度；额度并不保证零账单。公开仓库不包含账号配置、密钥、聊天内容或部署诊断记录。

## 结构与恢复

### 可选 Cloudflare Webhook 入口

`cloudflare/qq-entry` 是无密钥的固定上游转发器：QQ → Worker → Vercel `/api/qq`。
它只接受该路径的 POST，限制请求体大小，原样转发签名字节与签名头；签名验证、持久入队和模型调用仍由 Vercel 完成。
上游错误不会被转换为成功 ACK，也不会主动重试；不提供通用代理或管理接口。

Cloudflare Workers Builds 连接本仓库时，生产分支选 `main`，根目录填 `cloudflare/qq-entry`，
项目名填 `anon-qq-entry`，构建命令留空，部署命令为 `npm run deploy`；关闭预览自动部署。
入口地址为 `https://<worker>.<account>.workers.dev/api/qq`，健康检查路径为 `/health`。
不需要复制 OpenAI、DeepSeek、QQ Secret 或 Vercel 凭据到 Worker。

必须先在 QQ 控制台验证实际 Worker 域名，再测试群聊和私聊；不能由临时 Tunnel 成功推断 `workers.dev` 可达。
这不是完整的 Cloudflare 迁移，原有 Vercel 持久化和任务恢复仍需保留。
停用 Daemon 前需另行配置 Webhook 任务恢复扫描，不能仅因回调验证通过就直接删除 Gateway。

| 路径 | 职责 |
| --- | --- |
| `daemon/main.ts` | 官方 QQ WebSocket、心跳/重连、滚动部署租约与恢复扫描 |
| `src/qq.ts` | 事件归一化、QQ 文本/图片投递与签名校验 |
| `src/chat.ts` | Chat SDK 的 QQ 适配层；持久化由 Engine 负责 |
| `src/engine.ts` | 持久 inbox/outbox、会话串行化、模型调用与投递阶段 |
| `src/accounts.ts` | 个人身份、权限、每日额度与原子预留 |
| `src/store.ts` | 私有 Blob 的强 ETag 条件写入 |
| `src/models.ts`, `src/images.ts` | 明确的提供方请求；不自动回退 |
| `api/admin.ts` | Bearer `CRON_SECRET` 保护的运维检查 |

Gateway 租约防止滚动部署时两个进程同时消费；会话锁按群/私聊和用户分开。状态按 `pending → generating → prepared → sending` 推进。若重启时付费请求或 QQ 投递结果不确定，不自动重复执行，避免二次扣费或重复消息；用户可主动重新请求。

图片生成最多等待 160 秒，再上传和回复。生成期间部署重启、QQ 被动回复窗口过期或媒体引用过期可能导致图片未送达；不会为此自动再生成。适合小群使用，不承诺高吞吐或持久任务队列语义。

Blob 读取使用 `Accept-Encoding: identity` 保留强 ETag；不能把弱 ETag 去掉 `W/` 后当成强校验器。所有状态都从私有源读取，避免缓存导致覆盖。

## 参考

- [QQ 群聊事件](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_at_message_create.html)
- [QQ 私聊事件](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/c2c_message_create.html)
- [OpenAI 图片生成 API](https://developers.openai.com/api/reference/resources/images/methods/generate)
- [Vercel Daemons](https://vercel.com/docs/daemons)

仓库公开不等于授予开源许可；当前 `package.json` 标记为 `UNLICENSED`。
