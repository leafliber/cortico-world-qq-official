<!-- Owner: src/definition.ts, src/world.ts, src/config.ts, package.json -->

<p align="center">
  <img src="https://raw.githubusercontent.com/leafliber/cortico-world-qq-official/v0.2.3/assets/icon.png" alt="QQ Official World" width="88" height="88">
</p>

# QQ Official World

[![npm](https://img.shields.io/npm/v/cortico-world-qq-official?color=1d4ed8)](https://www.npmjs.com/package/cortico-world-qq-official)
![Cortico World API 6](https://img.shields.io/badge/Cortico_World-API_6-1d4ed8)
![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-19815e)
[![AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0--or--later-64748b)](LICENSE)

[简体中文](README_zh.md)

A Cortico World for the QQ Official API. It receives QQ events through a WebSocket gateway or signed Webhooks and exposes messaging tools to the Persona. Credentials can be entered manually or obtained through QQ's official bot binding page.

The World uses ID `qqofficial`. It can coexist with `cortico-world-qq`, which uses a different protocol and World ID. One configured QQ bot is supported per deployment.

By [leafliber](https://github.com/leafliber) · [npm](https://www.npmjs.com/package/cortico-world-qq-official) · [Support](https://github.com/leafliber/cortico-world-qq-official/issues) · [Release notes](CHANGELOG.md). This community extension uses QQ’s official API; it is not an official Tencent or Cortico product.

## Panel previews

The screenshots render the actual extension panels with Cortico UI components and sample data. They contain no live QR authorization, bot credentials or private conversations.

![QQ connection panel](https://raw.githubusercontent.com/leafliber/cortico-world-qq-official/v0.2.3/assets/screenshots/connection-zh.png)

![Connection success panel with the QR code removed](https://raw.githubusercontent.com/leafliber/cortico-world-qq-official/v0.2.3/assets/screenshots/connected-zh.png)

![Credentials and connection settings](https://raw.githubusercontent.com/leafliber/cortico-world-qq-official/v0.2.3/assets/screenshots/configuration-zh.png)

## Install

Requires Node.js 22 or later. Install FFmpeg for common audio transcoding and audio tests, or configure `ffmpegPath`. The SILK codec is installed as an npm dependency. The main package targets **Cortico World API 6** and is developed against the `cortico@0.2.6` SDK.

In Cortico or Coopanion's extension page, select **World** and install `cortico-world-qq-official@0.2.3` from npm. Restart Core to load it. From an existing Cortico installation, the equivalent command is:

```sh
cd extensions
corepack pnpm add cortico-world-qq-official@0.2.3
```

From a checkout:

```sh
corepack pnpm install --frozen-lockfile --ignore-scripts
pnpm build
pnpm verify
```

In Cortico or Coopanion's extension page, choose **World → local directory** and select this repository. Restart Core to load the extension. For a portable archive, run `npm pack --ignore-scripts`; the archive contains the runtime source, browser panel and self-description.

For an older host that still uses **World API 5**, use the API 5 archive from [GitHub Releases](https://github.com/leafliber/cortico-world-qq-official/releases), or generate it from source:

```sh
pnpm pack:api5
```

Select the generated `dist/api5` directory in the extension page. The command also produces a `.tgz` in `dist/`, with a client-content hash in its API 5 version so the host reloads updated UI assets. This fallback changes the entry point, manifest contract and WebUI method name; it uses the same transport and tool implementation. Regenerate it after source changes.

## Connect

Open the QQ Official World’s **Connection** tab and generate a QR code. Scan it with QQ on your phone, then create or select a bot and authorize it on QQ's official page. The extension generates the QR code locally, checks the result automatically, saves the credentials, and enables or reconnects the World. The QR code disappears once credentials are received; connection success is shown only after the message transport is ready. A failed connection keeps the credentials and offers a retry. Reloading the panel resumes the current task while Core is running; tasks expire after ten minutes.

AppID, AppSecret and transport options are managed together in **Configuration**. AppSecret is never returned to the browser; only its configured status is displayed. Manual credentials remain available there. The binding key and decrypted secret stay on the Core side.

The binding link uses QQ's `/qqbot/openclaw/connect.html` page. This package is a Cortico extension independent of OpenClaw: it reuses QQ's public binding and bot APIs, with no OpenClaw dependency or integration. Binding obtains the bot's AppID and AppSecret; subsequent messaging goes directly to QQ. It does not connect to or control an OpenClaw instance.

The AppID is stored in `worlds.qqofficial.appId`. The secret is stored through `WorldContext.storeSecret` as `CORTICO_QQOFFICIAL_APP_SECRET` in the deployment environment. A blank secret keeps the existing secret only when the AppID is unchanged. Saving configuration applies changes to an enabled World. For a disabled World with manually entered credentials, use **Connect QQ** on the Connection tab.

The default transport is `websocket`, with Intents `33554432` for QQ group and C2C events. Set the Intents required by your bot's granted event subscriptions. QQ's permissions and quotas still apply to proactive messages, Markdown, keyboards, media and recalls.

For Webhooks, set `transport` to `webhook` and configure QQ's callback URL to reach the configured path. The default listener is `127.0.0.1:6196/qqofficial/callback`; expose it through your HTTPS reverse proxy. Challenge requests use the official Ed25519 handshake. Event signatures cover the exact request body. An acknowledgement is returned after Core persists the event; failed persistence returns HTTP 503 for platform retry. The Webhook connection lamp reports a listening local server, not successful QQ delivery.

## Event flow

Incoming messages become `qqofficial.message`; interactions, relationship changes and other dispatches become `qqofficial.notice`. Both use `origin: external` and `trigger: debounce`. Core stores and batches them; the Persona decides whether to act. Raw content, mentions, references, attachments and `message_scene` remain in `meta.data`.

Each message carries a routing `target`:

| `target.kind` | `target.id` |
| --- | --- |
| `c2c` | `author.user_openid` |
| `group` | `group_openid` |
| `channel` | `channel_id` |
| `dms` | The direct message's private `guild_id` |

Messages are deduplicated by AppID, target and message ID; their attachment index is rebuilt from the World archive at startup. Channel `AT_MESSAGE_CREATE` and `MESSAGE_CREATE` deliveries for the same message intentionally merge, retaining the first event type. Richer duplicates persist a `qqofficial.attachments` supplement, preserving the original cursor, existing attachments and attachment indices. New attachment IDs enqueue a compact reference summary with `trigger: piggyback`: it does not wake the Persona or reset batching timers, but travels with the next normal batch. URL/rkey-only refreshes remain archive-only. Failed supplement writes return HTTP 503 for Webhook retry. Other events use their event type and event ID, with up to 10,000 recent identities. WebSocket reconnects resume from the last persisted sequence during the running World instance. A process restart creates a new gateway session.

The message/attachment index still retains the full archive in memory, including messages without attachments; memory usage and startup work grow with history. A bounded recent-message index with on-demand archive lookup remains follow-up work, so older attachment references are not evicted prematurely.

Outgoing sequence reservations (`qqofficial.attempt`) and platform receipts (`qqofficial.sent`, `qqofficial.removed`, `qqofficial.acknowledged`) are archived with `deliver: false`. Sending therefore does not wake the Persona again. Sent records include the request and platform response; API acceptance does not prove recipient read status. HTTP 401 triggers one authentication retry. Explicit rate limits allow at most two retries, each waiting no more than five seconds. Configured downgrades handle only explicit rejections: expired reply anchors can become proactive sends, and denied Markdown can become text. Content moderation, permissions and quotas are not bypassed. Timeouts, HTTP 5xx or missing message IDs leave delivery unknown and never trigger an automatic resend.

## Tools

| Tool | Contract |
| --- | --- |
| `qqofficial_send_message` | Text or Markdown, optional message reference and native keyboard object. |
| `qqofficial_send_media` | Exactly one public URL or host-managed `log:`/`mem:` attachment; local paths are rejected; types 1 image, 2 video, 3 voice, 4 file. `items` sends up to eight sequentially. |
| `qqofficial_stream_message` | `followModel=true` forwards the next model round’s public reply to a selected target; also supports manual C2C parts. |
| `qqofficial_delete_message` | Recall a bot message in the given target. |
| `qqofficial_list_targets` | Known targets, recent reply anchors and proactive reception state for this AppID. |
| `qqofficial_history` | Stored World history for this AppID; `messagesOnly=true` selects incoming messages, and `meta.attachmentRefs` lists enriched references and cache status. |
| `qqofficial_read_attachment` | Prefer `attachmentId`, or use message `cursor` + `index`; quotes use `quotedIndex` or nested `quotedPath`. Voice becomes WAV. |
| `qqofficial_ack_interaction` | Explicit platform acknowledgement with a result code from 0 to 5. |

Pass `replyTo` or `eventId`, exclusively. `delivery` supports `reply`, `proactive`, `auto` and `wakeup`. `auto` chooses a recent anchor within a conservative age and sequence budget, then uses proactive delivery when none is available. `wakeup` requires C2C and platform permission. Omitting both anchors and `delivery` remains proactive. Known opt-outs or removed-bot relationships block proactive sends locally; passive replies remain possible. Target state and sequence reservations are restored from this account’s archive.

Scheduled notifications use the host’s existing `alarm_set`, `alarm_list` and `alarm_cancel`. Preserve the exact target from `qqofficial_list_targets` in the reminder, then send with `delivery=proactive` when awakened. The extension adds no scheduler. By default, each proactive attempt waits three seconds after the previous attempt completes, including rejected attempts and fallback retries. QQ permissions, quotas and recipient settings still apply.

`followModel=true` explicitly selects a target and forwards only the next round’s public text, excluding reasoning and tool arguments. Anchored C2C replies stream at the configured interval; proactive notifications, groups, channels and guild DMs buffer into ordinary messages. Explicit streaming endpoint 404/405 responses also enable buffered delivery. Round end, another tool call, cancellation, conversation changes and idle timeouts close the reply. Manual C2C parts use `content`, reuse the returned `streamId`, and retain the target, format, anchor and sequence; `finish` defaults to true. Partial failures never replay the complete reply. Uncertain continuations remain blocked after process restart.

Attachment reads accept HTTPS URLs on `qq.com`, `qq.com.cn`, `qpic.cn`, `ugcimg.cn` and their subdomains, checking every redirect and omitting bot authentication headers. Core decides whether the current model supports the returned MIME type. URLs and metadata alone are not treated as image or audio perception.

Prefer an `attachmentId` (starting with `qqa:`) from an event or history's `meta.attachmentRefs`, passing that field alone to the read tool. References are bound to the AppID, conversation and message and survive restarts while the event archive is retained. Legacy message `cursor` plus zero-based `index` remains supported: `quotedIndex=0` selects `msg_elements[0]`, and `quotedPath=[0,1]` selects `msg_elements[0].msg_elements[1]`; the two quote selectors are exclusive. Send receipts and notices cannot be used as message cursors; `messagesOnly=true` excludes them. History projects the enriched attachment union without modifying the original stored event or listing supplements separately. Messages without attachments omit `attachmentRefs`.

Incoming image metadata triggers background prefetch of PNG, JPEG, GIF, WebP and BMP images into the deployment's `dataDir/qqofficial/image-cache/`. Prefetch does not delay event persistence or Webhook acknowledgement. Defaults are 24 hours and 256 MiB across the deployment, capped at 10,000 images, with each image bounded by the lesser of `maxMediaBytes` and 30 MiB; at most two prefetches run concurrently and 256 wait in the queue. Oldest saved images are evicted first; expired data is cleaned at startup, on access and every minute while running. Unchanged pruning does not rewrite the index. An existing index exceeding the 4 MiB read limit disables caching for that run and leaves its files intact. Set `imageCacheTtlMs=0` or `imageCacheMaxBytes=0` to disable caching. Cached images still require the read tool and an image-capable model to be perceived. References and cache contents survive restarts; reads prefer cached bytes and download again when missing, expired or damaged. Prefetch failures do not discard the event or its attachment locators. Cancelling a read does not fail other readers or prefetches sharing its download; uncancelled consumers retry independently.

Preserve `attachmentId` in handoff summaries to read images again. If both the temporary cache and QQ URL have expired, a new upload is required. Core's `log:` blobs produced by successful tool reads follow the host's retention policy, independently of this prefetch cache's TTL. This extension does not modify Core/Persona context compaction.

[Issue #1](https://github.com/leafliber/cortico-world-qq-official/issues/1) remains open for live validation, including whether QQ keeps attachment IDs or URL `fileid` values stable across redelivery. URL identity ignores rotating `rkey` credentials but keeps content selectors such as `fileid`; if both attachment identity and content selectors change, the image may appear as an additional reference. This preserves both candidates instead of replacing an existing image.

Read failures return structured `code` and `message` fields, plus `available` attachment locators or `httpStatus` where applicable. Distinct codes include `MESSAGE_CURSOR_NOT_FOUND`, `MESSAGE_EVENT_TYPE_MISMATCH`, `MESSAGE_ACCOUNT_MISMATCH`, `ATTACHMENT_REFERENCE_NOT_FOUND`, `QUOTED_MESSAGE_NOT_FOUND`, `ATTACHMENT_INDEX_NOT_FOUND` and `ATTACHMENT_DOWNLOAD_FAILED`, separating locator errors from download failures.

Channels and guild DMs support text, Markdown, remote images and multipart host attachments. C2C and groups support images, voice, video and files. The default media read limit is 100 MiB; outgoing limits are additionally 30 MiB for images, 20 MiB for voice and 100 MiB for video/files. QQ may impose tighter limits. Files of 5 MiB or more use chunked uploads with plan validation, per-part confirmation and final merge. Uploaded handles are cached according to QQ’s TTL. Media batches stop on failure and return accepted items plus the failing index, without replaying the batch.

Outgoing voice is decoded by FFmpeg to 24 kHz mono PCM and encoded as Tencent SILK. Incoming SILK and common audio become WAV, bounded to ten minutes. Missing FFmpeg or malformed audio produces an explicit error. Audio URL downloads validate public addresses and pin DNS at every redirect; decoding disables nested file/network protocols. Speech recognition is left to an audio-capable model through Core. Interaction acknowledgements require an explicit tool call within QQ’s deadline.

From **0.2.3**, `qqofficial_send_media` accepts only public HTTP(S) URLs or existing attachments resolved through Core’s `log:` / `mem:` store. It does not open model-supplied filesystem paths. Legacy `path` arguments, `file:` URLs and path traversal disguised as attachment handles are rejected, including in batches. `fileName` is display metadata only. FFmpeg receives audio bytes through stdin with only the `pipe` protocol enabled; the model cannot supply commands or conversion options. The `external-setup` tag remains for FFmpeg.

To send a local image, audio clip, video or document, first upload it through the host’s attachment flow or use an attachment produced by a host tool. Pass the returned `log:` / `mem:` handle as `blob`, the original filename as `fileName`, and the corresponding `fileType` (1 image, 2 video, 3 voice, 4 file). Audio conversion, channel image uploads, chunking and batch sending remain available. Existing scripts using `path` must migrate to `blob` or a public `url`. No general filesystem permission can be enabled in this extension.

The current package no longer declares `unsafe`. Cortico retains warning tags from older releases until its maintainers approve removal, so an older market warning can remain during review.

## Configuration

All keys are under `worlds.qqofficial`. Defaults and validation are in [`src/config.ts`](src/config.ts).

| Key | Default | Effect |
| --- | --- | --- |
| `enabled` | `false` | Host-controlled activation. |
| `appId` | empty | Bot identity; requires restart. |
| `transport` | `websocket` | `websocket` or `webhook`; requires restart. |
| `sandbox` | `false` | QQ sandbox API endpoint; requires restart. |
| `intents` | `33554432` | Gateway event subscription bitmask; requires restart. |
| `webhook.host`, `port`, `path` | `127.0.0.1`, `6196`, `/qqofficial/callback` | Listener address; requires restart. |
| `webhook.maxBodyBytes` | `1048576` | Callback size limit; requires restart. |
| `timeoutMs` | `20000` | Network timeout; requires restart. |
| `reconnectMs`, `maxReconnectMs` | `1000`, `30000` | Gateway reconnect backoff bounds; requires restart. |
| `maxMediaBytes` | `104857600` | Media read limit, also capped by outgoing type limits; immediate. |
| `imageCacheTtlMs` | `86400000` | Temporary image lifetime in ms; 0 disables, up to 30 days; immediate. |
| `imageCacheMaxBytes` | `268435456` | Total temporary image bytes; 0 disables, up to 1 GiB; immediate. |
| `autoFallback` | `true` | Downgrade explicit rejections; override per call with `fallback=false`. |
| `proactiveIntervalMs` | `3000` | Minimum proactive send interval. |
| `streamIntervalMs` | `500` | Minimum stream part interval. |
| `streamIdleMs` | `15000` | Close streams after this idle period. |
| `ffmpegPath` | `ffmpeg` | Audio converter executable. |
| `modelLanguage` | `zh` | Model-facing Chinese or English; takes effect immediately. |

The operator panel supports all eleven Cortico UI languages. Model instructions live in `src/model-text.ts`; UI copy lives in `src/strings.ts`.

## Development and distribution

`pnpm describe` regenerates `describe.json`. `pnpm check:extension` runs the SDK's manifest, construction and self-description validators without starting a connection. Optional built-ins missing from the published SDK's dependencies are excluded from tool-name collision checking, with a warning. The package metadata follows the [Cortico extension registry](https://github.com/Pal-AI-Lab/cortico-extensions); registration in that registry and publication to npm are separate operations.

Publishing a GitHub Release runs [the release workflow](.github/workflows/release.yml): it verifies and builds the package, attaches the main and API 5 compatibility tarballs to the release, and publishes the main tarball to npm with provenance. Draft releases do not publish. The release tag must exactly match `v<package.json version>` (for example, `v0.2.1`). Stable versions use npm's `latest` tag; GitHub pre-releases and versions with a prerelease suffix use `next`. The API 5 tarball is only attached to GitHub Releases.

Before the first automated release, configure a [Trusted Publisher](https://docs.npmjs.com/trusted-publishers/) in the npm package's settings:

- Provider: **GitHub Actions**
- Organization or user: `leafliber`
- Repository: `cortico-world-qq-official`
- Workflow filename: `release.yml`
- Environment name: leave empty
- Allowed actions: enable direct publishing with `npm publish`

The workflow uses OIDC on a GitHub-hosted runner, so no `NPM_TOKEN` secret is needed. If the package does not exist on npm yet, publish it once from an authenticated local environment before configuring its trusted publisher. For each subsequent release, update `package.json` and `CHANGELOG.md`, commit the changes, and publish a GitHub Release at the matching tag. Use a new, unpublished npm version each time; the workflow does not bump versions automatically.

Tests use real local HTTP/WebSocket servers, Ed25519 and AES-GCM, the Cortico JSONL event store, and the SDK's browser UI primitives. They cover persistence, reconnection, deduplication, proactive throttling and opt-outs, model reply streaming, downgrades, uncertain-delivery recovery, chunked transfers, real audio codecs, media boundaries, binding and panel disposal. Automated tests never contact QQ or use an operator deployment. Live service checks run separately. The `experimental` tag remains because permissions and media support require validation for each QQ application.

Protocol references: [AstrBot QQ Official](https://github.com/AstrBotDevs/AstrBot/tree/master/astrbot/core/platform/sources/qqofficial), [AstrBot Webhook](https://github.com/AstrBotDevs/AstrBot/tree/master/astrbot/core/platform/sources/qqofficial_webhook), and [QQ's API documentation](https://bot.q.qq.com/wiki/develop/api-v2/). This package contains an independent TypeScript implementation; no AstrBot runtime is needed.

Licensed under AGPL-3.0-or-later; see [LICENSE](LICENSE).
