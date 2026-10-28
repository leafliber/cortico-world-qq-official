<!-- Owner: src/definition.ts, src/world.ts, src/config.ts, package.json -->

<p align="center">
  <img src="https://raw.githubusercontent.com/leafliber/cortico-world-qq-official/v0.2.3/assets/icon.png" alt="QQ Official World" width="88" height="88">
</p>

# QQ Official World

[![npm](https://img.shields.io/npm/v/cortico-world-qq-official?color=1d4ed8)](https://www.npmjs.com/package/cortico-world-qq-official)
![Cortico World API 6](https://img.shields.io/badge/Cortico_World-API_6-1d4ed8)
![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-19815e)
[![AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0--or--later-64748b)](LICENSE)

[English](README.md)

通过 QQ 官方接口接入 Cortico 的 World 扩展。使用 WebSocket 网关或签名 Webhook 接收事件，向 Persona 提供消息工具。支持手动填写凭证，也支持 QQ 官方机器人绑定页面。

World ID 为 `qqofficial`，可与使用其他协议、ID 为 `qq` 的 `cortico-world-qq` 共存。每份部署支持配置一个 QQ 机器人。

作者：[leafliber](https://github.com/leafliber) · [npm](https://www.npmjs.com/package/cortico-world-qq-official) · [问题反馈](https://github.com/leafliber/cortico-world-qq-official/issues) · [更新日志](CHANGELOG.md)。这是使用 QQ 官方接口的社区扩展，不是腾讯或 Cortico 官方出品。

## 界面预览

以下截图使用扩展的真实面板代码、Cortico 界面组件与示例数据渲染，不含有效扫码授权、真实机器人凭证或私人聊天。

![QQ 扫码连接面板](https://raw.githubusercontent.com/leafliber/cortico-world-qq-official/v0.2.3/assets/screenshots/connection-zh.png)

![连接成功后隐藏二维码](https://raw.githubusercontent.com/leafliber/cortico-world-qq-official/v0.2.3/assets/screenshots/connected-zh.png)

![凭证与接入配置](https://raw.githubusercontent.com/leafliber/cortico-world-qq-official/v0.2.3/assets/screenshots/configuration-zh.png)

## 安装

需要 Node.js 22 或更高版本；常见音频格式的收发转码和音频测试需要系统安装 FFmpeg（也可配置 `ffmpegPath`）。SILK 编解码器随 npm 依赖安装。主包使用 **Cortico World API 6**，开发依赖固定为 `cortico@0.2.6` SDK。

在 Cortico 或 Coopanion 的扩展页选择 **World**，从 npm 安装 `cortico-world-qq-official@0.2.3`，然后重启 Core。已有 Cortico 安装也可通过命令行安装：

```sh
cd extensions
corepack pnpm add cortico-world-qq-official@0.2.3
```

在源码目录运行：

```sh
corepack pnpm install --frozen-lockfile --ignore-scripts
pnpm build
pnpm verify
```

在 Cortico 或 Coopanion 扩展页选择 **World → 本机目录**，选择本仓库，重启 Core 后加载。运行 `npm pack --ignore-scripts` 可生成包含运行源码、浏览器面板和能力声明的安装包。

旧宿主仍使用 **World API 5** 时，可下载 [GitHub Releases](https://github.com/leafliber/cortico-world-qq-official/releases) 中的 API 5 兼容包，也可从源码生成：

```sh
pnpm pack:api5
```

在扩展页选择生成的 `dist/api5` 目录。该命令同时在 `dist/` 中生成 `.tgz` 包，API 5 版本号带有界面内容哈希，确保宿主加载更新后的页面脚本。兼容包调整入口、manifest 契约版本和 WebUI 方法名，传输与工具使用同一份实现。修改源码后需要重新生成。

## 接入

打开 QQ Official World 的「连接」页生成二维码，使用手机 QQ 扫码，在官方页面创建或选择机器人并确认授权。二维码由扩展本地生成。扩展会自动查询结果、保存凭证，并启用或重新连接 World。获取凭证后立即移除二维码，消息通道就绪后明确显示「连接成功」；连接失败时保留凭证并提供重试入口。在 Core 持续运行期间，刷新面板后也会继续等待当前任务。绑定任务有效期为十分钟。

AppID、AppSecret 和接入参数集中在「配置」页管理，也可在这里手动填写凭证。AppSecret 只显示已配置状态，不回显明文；绑定密钥和解密后的 AppSecret 留在 Core 端，不会返回浏览器。

绑定链接使用 QQ 官方的 `/qqbot/openclaw/connect.html` 页面。本扩展属于 Cortico，与 OpenClaw 项目无关，只复用 QQ 开放的绑定和机器人接口，不依赖或集成 OpenClaw。绑定取得机器人的 AppID 和 AppSecret 后，消息收发直接调用 QQ 官方接口，不会连接或控制 OpenClaw 实例。

AppID 保存到 `worlds.qqofficial.appId`；AppSecret 通过 `WorldContext.storeSecret` 保存为部署环境中的 `CORTICO_QQOFFICIAL_APP_SECRET`。AppID 不变时，AppSecret 留空会保留已有值；更换 AppID 必须同时提供新的 AppSecret。保存配置时，已启用的 World 会自动应用变更。未启用的 World 手动保存凭证后，可在「连接」页选择「连接 QQ」。

默认传输方式为 `websocket`，Intents 为 `33554432`，用于 QQ 群和单聊事件。其他事件需要根据机器人获批的订阅范围设置 Intents。主动消息、Markdown、键盘、媒体和撤回仍受 QQ 平台权限与额度限制。

使用 Webhook 时，将 `transport` 设置为 `webhook`，让 QQ 回调 URL 指向配置的路径。默认监听 `127.0.0.1:6196/qqofficial/callback`，通过 HTTPS 反向代理提供公网入口。验证请求使用官方 Ed25519 握手；事件验签使用原始请求体。Core 保存事件成功后才返回确认，保存失败返回 HTTP 503，供平台重试。Webhook 的连接状态表示本地服务器已监听，不代表已经收到 QQ 回调。

## 事件流

消息投递为 `qqofficial.message`，互动、关系变化及其他平台事件投递为 `qqofficial.notice`。两者均为 `origin: external`、`trigger: debounce`；Core 负责保存和批处理，Persona 决定是否行动。原始正文、提及、引用、附件和 `message_scene` 保留在 `meta.data`。

每条消息携带发送目标 `target`：

| `target.kind` | `target.id` |
| --- | --- |
| `c2c` | `author.user_openid` |
| `group` | `group_openid` |
| `channel` | `channel_id` |
| `dms` | 该频道私信的私有 `guild_id` |

消息按 AppID、目标和消息 ID 去重，启动时从 World 存档重建消息与附件索引。频道中同一消息的 `AT_MESSAGE_CREATE` 与 `MESSAGE_CREATE` 会有意合并，保留先到的 eventType。同一消息后到的附件会通过 `qqofficial.attachments` 补充记录持久保存，保留原 cursor、已有附件与附件序号。新增 attachmentId 时，用 `trigger: piggyback` 将精简引用摘要入队：不单独唤醒 Persona、不刷新批处理计时器，随下一批正常唤醒一起投递；只有 URL/rkey 刷新时仍仅归档。补充记录保存失败时，Webhook 返回 503 供重试。其他事件有事件 ID 时按事件类型与事件 ID 去重，最多保留一万条近期标识。WebSocket 在当前 World 实例内重连时使用最后已保存的序号恢复；进程重启后创建新的网关会话。

消息与附件索引目前仍在内存保留全量存档，包括没有附件的消息；内存占用和启动工作量会随历史增长。限制近期消息索引并按需查询旧存档属于后续工作，暂不直接淘汰索引，以免旧附件引用失效。

发送序号预留 `qqofficial.attempt` 以及平台回执 `qqofficial.sent`、`qqofficial.removed`、`qqofficial.acknowledged` 均以 `deliver: false` 存档，因此不会再次唤醒 Persona。发送记录包含请求和平台响应；平台接受请求不代表收件人已读。HTTP 401 会触发一次刷新凭证后的重试。明确的限流最多重试两次，单次等待不超过五秒。自动降级仅处理明确拒绝：回复依据过期后改为主动发送、Markdown 权限不足后改为纯文本。内容审核拒绝、权限或额度不足不会被绕过。超时、HTTP 5xx 或响应缺少消息 ID 时保留“发送结果未知”，不自动重发。

## 工具

| 工具 | 契约 |
| --- | --- |
| `qqofficial_send_message` | 发送文本或 Markdown，可携带消息引用和平台原生键盘对象。 |
| `qqofficial_send_media` | 发送公开 URL 或宿主管理的 `log:`/`mem:` 附件，二者选一；不接受本地路径；类型 1 图片、2 视频、3 语音、4 文件；`items` 可顺序发送至多 8 项。 |
| `qqofficial_stream_message` | `followModel=true` 将下一轮模型公开正文发送到选定目标；也支持手动 C2C 分片。 |
| `qqofficial_delete_message` | 撤回指定目标中机器人发送的消息。 |
| `qqofficial_list_targets` | 列出当前 AppID 的已知会话、近期回复依据和主动接收状态。 |
| `qqofficial_history` | 查询当前 AppID 的 World 存档；`messagesOnly=true` 只看入站消息，`meta.attachmentRefs` 列出补全后的附件引用和缓存状态。 |
| `qqofficial_read_attachment` | 优先按 `attachmentId` 读取，也兼容消息 `cursor` + `index`；引用用 `quotedIndex` 或嵌套 `quotedPath`，语音转为 WAV。 |
| `qqofficial_ack_interaction` | 使用 0 至 5 的结果码明确确认平台互动事件。 |

回复消息使用 `replyTo`，回复事件使用 `eventId`，两者互斥。`delivery` 支持 `reply`、`proactive`、`auto`、`wakeup`：`auto` 在保守的近期窗口和已使用序号范围内选取回复依据，否则主动发送；`wakeup` 仅用于 QQ 单聊，由 QQ 判定唤醒权限。省略 `delivery` 和回复依据时仍为主动发送。已知主动接收关闭或已删除机器人的目标会被本地拒绝，普通被动回复不受这一检查限制。目标状态、发送序号从当前账号的事件存档恢复。

定时通知复用宿主已有的 `alarm_set`、`alarm_list`、`alarm_cancel`；提醒内容保存 `qqofficial_list_targets` 返回的准确目标，唤醒后调用发送工具并指定 `delivery=proactive`。扩展不另起调度器。默认在上次主动发送尝试结束后等待三秒，再发起下一次；被拒绝的请求和降级重试同样受此间隔限制。QQ 的权限、配额和接收方设置仍可能拒绝请求。

`followModel=true` 必须明确选择目标；下一轮只转发公开正文，不包含推理和工具参数。带回复依据的 C2C 按间隔发送，主动通知、群、频道和频道私信缓冲后发普通消息；流式接口明确返回 404/405 时也缓冲降级。轮次结束、调用其他工具、取消、切换会话或空闲超时会结束流。手动 C2C 分片使用 `content`，续片沿用返回的 `streamId`，`finish` 默认为 true，目标、格式、回复依据和序号保持不变。已发送内容不会因后续失败而整段重发；结果未知的续片会在进程重启后继续禁止重放。

附件读取只接受 `qq.com`、`qq.com.cn`、`qpic.cn`、`ugcimg.cn` 及其子域的 HTTPS 地址，每次重定向重新校验，下载请求不携带机器人认证头。Core 按当前模型能力决定是否传递对应 MIME 类型；仅有 URL 和元数据不会被视为已经看见或听见附件。

附件定位优先使用事件或 `qqofficial_history` 的 `meta.attachmentRefs` 中的 `attachmentId`（`qqa:` 开头），读取时单独传入该字段。引用绑定当前 AppID、会话和消息，在事件存档保留期间可跨重启使用。也可继续传入消息的 `cursor` 和从 0 开始的 `index`：`quotedIndex=0` 选择 `msg_elements[0]`，`quotedPath=[0,1]` 选择 `msg_elements[0].msg_elements[1]`；二者互斥。历史中的发送回执和通知不是可读取附件的消息，可用 `messagesOnly=true` 排除。history 返回补全后的附件视图，原始存档事件保持不变；附件补充记录不单独出现在该工具结果中，没有附件的消息省略 `attachmentRefs`。

收到图片元数据后会后台预取 PNG、JPEG、GIF、WebP、BMP 图片到部署的 `dataDir/qqofficial/image-cache/`，不阻塞事件保存和 Webhook 确认。默认保留 24 小时、整个部署最多 256 MiB，并限制为 10,000 张图片，单图不超过 `maxMediaBytes` 与 30 MiB 的较小值；最多两个预取并发、256 个待处理项。缓存按最早保存时间淘汰，启动、访问和运行期间每分钟清理过期数据，无变化时不重写索引。已有索引超过 4 MiB 读取上限时，本次运行停用缓存并保留磁盘文件。设 `imageCacheTtlMs=0` 或 `imageCacheMaxBytes=0` 可关闭。缓存不会自动投递原图到模型，仍需调用读取工具；支持图片的模型才能看到其内容。引用与缓存都支持重启恢复，读取优先用缓存，缓存失效或损坏后重新下载。后台预取失败不丢弃消息或附件定位信息。取消一次读取不会使共享下载的其他读取或预取失败，未取消的调用方会重新发起下载。

交接摘要可保留 `attachmentId`，需要时重新读取图片。临时缓存过期且 QQ URL 已失效时，仍需用户重新上传。工具读取成功后产生的 Core `log:` 附件由宿主自己的附件保留策略管理，不受此预取缓存的 TTL 控制。本扩展不修改 Core/Persona 的上下文压缩策略。

[Issue #1](https://github.com/leafliber/cortico-world-qq-official/issues/1) 继续保留实测验收，其中包括 QQ 重复投递时附件 ID 或 URL 中的 `fileid` 是否稳定。URL 身份判定忽略会轮换的 `rkey`，保留 `fileid` 等内容选择参数；若附件身份和内容选择参数都变化，同一图片可能新增一个引用。此时保留两个候选，不覆盖已有图片。

读取失败返回结构化 `code`、`message`，并在适用时返回 `available` 附件列表或 `httpStatus`。可据此区分 `MESSAGE_CURSOR_NOT_FOUND`、`MESSAGE_EVENT_TYPE_MISMATCH`、`MESSAGE_ACCOUNT_MISMATCH`、`ATTACHMENT_REFERENCE_NOT_FOUND`、`QUOTED_MESSAGE_NOT_FOUND`、`ATTACHMENT_INDEX_NOT_FOUND` 与 `ATTACHMENT_DOWNLOAD_FAILED`，避免把定位错误误当作链接过期。

频道和频道私信支持文本、Markdown、远程图片及宿主附件图片的 multipart 上传，C2C 与群聊支持图片、语音、视频和文件。上传读取和附件下载默认上限为 100 MiB；发送还受图片 30 MiB、语音 20 MiB、视频和文件 100 MiB 的本地上限约束，QQ 可另行收紧。5 MiB 起使用平台分块上传协议，校验完整分块计划、逐块确认后合并，并按平台 TTL 缓存文件句柄。批量发送遇错即停止，返回已成功项与失败位置，避免整批重发。

出站语音通过 FFmpeg 转为 24 kHz 单声道 PCM，再编码为 Tencent SILK；入站 SILK 和常见音频转为 WAV，最多十分钟。FFmpeg 缺失或格式损坏会明确报错。音频 URL 下载校验公网地址并固定 DNS 解析，每次重定向重新检查；解码器禁用嵌套文件和网络协议。扩展不内置语音识别，Core 决定当前模型能否读取音频。互动确认仍需明确调用工具，并满足 QQ 的确认时限。

从 **0.2.3** 起，`qqofficial_send_media` 只接收公开 HTTP(S) URL 或 Core 管理的已有 `log:` / `mem:` 附件，不再打开模型指定的文件系统路径。旧的 `path` 参数、`file:` URL、伪装成附件句柄的路径穿越会被拒绝，批量发送同样受限。`fileName` 仅作为显示名称。FFmpeg 仅通过标准输入接收音频字节，并只启用 `pipe` 协议；模型不能指定命令或转码参数。FFmpeg 仍声明 `external-setup` 标签。

发送本地图片、音频、视频或文档时，请先通过宿主的附件流程上传，或使用宿主工具生成的附件，再把返回的 `log:` / `mem:` 句柄传给 `blob`，原文件名传给 `fileName`，并指定 `fileType`（1 图片、2 视频、3 语音、4 文件）。语音转码、频道图片上传、分块上传和批量发送均保留。原先使用 `path` 的脚本需要改用 `blob` 或公开 `url`，扩展不提供开启任意文件读取的选项。

新版包不再声明 `unsafe`。Cortico 会保留旧版本曾声明的警告标签，直到官方维护者批准撤销，因此审核期间仍可能显示旧警告。

## 配置

以下配置位于 `worlds.qqofficial`，默认值和校验见 [`src/config.ts`](src/config.ts)。

| 配置 | 默认值 | 生效方式 |
| --- | --- | --- |
| `enabled` | `false` | 由宿主启用或停用。 |
| `appId` | 空 | 机器人身份，重启后生效。 |
| `transport` | `websocket` | `websocket` 或 `webhook`，重启后生效。 |
| `sandbox` | `false` | QQ 沙箱 API 地址，重启后生效。 |
| `intents` | `33554432` | 网关事件订阅位掩码，重启后生效。 |
| `webhook.host`、`port`、`path` | `127.0.0.1`、`6196`、`/qqofficial/callback` | 监听地址，重启后生效。 |
| `webhook.maxBodyBytes` | `1048576` | 回调字节数上限，重启后生效。 |
| `timeoutMs` | `20000` | 网络请求超时毫秒数，重启后生效。 |
| `reconnectMs`、`maxReconnectMs` | `1000`、`30000` | 网关重连退避的毫秒数范围，重启后生效。 |
| `maxMediaBytes` | `104857600` | 附件读取上限；上传还受媒体类型限制，立即生效。 |
| `imageCacheTtlMs` | `86400000` | 图片临时缓存保留毫秒数，0 关闭，最长 30 天；立即生效。 |
| `imageCacheMaxBytes` | `268435456` | 图片临时缓存总字节上限，0 关闭，最大 1 GiB；立即生效。 |
| `autoFallback` | `true` | 明确拒绝后自动降级；单次工具可用 `fallback=false` 禁用。 |
| `proactiveIntervalMs` | `3000` | 主动消息最小间隔。 |
| `streamIntervalMs` | `500` | 流式分片最小间隔。 |
| `streamIdleMs` | `15000` | 流式空闲收尾时间。 |
| `ffmpegPath` | `ffmpeg` | 音频转码程序路径。 |
| `modelLanguage` | `zh` | 模型文本使用中文或英文，立即生效。 |

操作界面支持 Cortico 的十一种语言。模型文本位于 `src/model-text.ts`，界面文案位于 `src/strings.ts`。

## 开发与分发

`pnpm describe` 重新生成 `describe.json`；`pnpm check:extension` 使用 SDK 的 manifest、构造和能力声明校验器，不启动连接。发布版 SDK 缺少可选依赖的内建 World 会跳过工具名称冲突检查，并显示提示。包元数据遵循 [Cortico 扩展市场](https://github.com/Pal-AI-Lab/cortico-extensions) 的规范；向该市场登记和发布 npm 包是独立操作。

发布 GitHub Release 会运行 [release 工作流](.github/workflows/release.yml)：校验并构建项目，将主包和 API 5 兼容包附加到 Release，然后将主包发布到 npm，并生成来源证明（provenance）。草稿 Release 不会触发发布。Release 标签必须与 `v<package.json 中的版本号>` 完全一致，例如 `v0.2.1`。正式版本使用 npm 的 `latest` 标签；GitHub 预发布版本或版本号包含预发布后缀时使用 `next`。API 5 兼容包仅作为 GitHub Release 附件分发。

首次自动发布前，在 npm 包的设置中配置 [Trusted Publisher](https://docs.npmjs.com/trusted-publishers/)：

- Provider：**GitHub Actions**
- Organization or user：`leafliber`
- Repository：`cortico-world-qq-official`
- Workflow filename：`release.yml`
- Environment name：留空
- Allowed actions：允许通过 `npm publish` 直接发布

工作流在 GitHub 托管的 runner 上使用 OIDC 认证，无需配置 `NPM_TOKEN` Secret。如果 npm 上还没有这个包，需要先从已登录 npm 的本机环境发布一次，再配置 Trusted Publisher。之后每次发版，更新 `package.json` 和 `CHANGELOG.md`，提交后使用对应标签发布 GitHub Release。每次都需使用 npm 上尚未发布的新版本号；工作流不会自动递增版本。

测试使用本机 HTTP/WebSocket 服务器、Ed25519、AES-GCM、Cortico JSONL 事件库和 SDK 浏览器 UI 组件，覆盖回调持久化、重连、去重、主动消息节流与拒收、自动回复流、失败降级、未知结果恢复、分块上传、真实音频编解码、媒体边界、绑定和面板卸载。自动化测试不访问真实 QQ，也不读取操作员部署。真实服务联调单独运行；`experimental` 标签保留，因为不同 QQ 应用的权限与媒体能力仍需逐项验收。

协议参考：[AstrBot QQ Official](https://github.com/AstrBotDevs/AstrBot/tree/master/astrbot/core/platform/sources/qqofficial)、[AstrBot Webhook](https://github.com/AstrBotDevs/AstrBot/tree/master/astrbot/core/platform/sources/qqofficial_webhook) 和 [QQ 官方接口文档](https://bot.q.qq.com/wiki/develop/api-v2/)。本包使用独立的 TypeScript 实现，无需 AstrBot 运行时。

许可证为 AGPL-3.0-or-later，见 [LICENSE](LICENSE)。
