<!-- Owner: package.json, src/definition.ts -->

# Changelog

## Unreleased

- Enrich duplicate messages through durable attachment supplements without replacing original events or shifting existing attachment indices. New references piggyback on the next normal wakeup; URL-only refreshes remain archive-only.
- Add stable AppID/conversation/message attachment references, enriched history, nested quote paths and structured locator/download errors; keep cursor/index reads compatible.
- Prefetch raster images into a bounded disk cache (24 hours / 256 MiB by default, up to 10,000 images) and restore references and cached bytes across process restarts. Missing, expired or damaged cache entries fall back to QQ CDN downloads. Skip unchanged index writes and preserve files when an oversized old index cannot be loaded.
- Keep tool schemas free of top-level combinators, classify download failures with typed errors, isolate shared downloads from a reader's cancellation, and omit empty reference lists and generated sparse quote slots from history.
- Cover sparse/richer duplicates, 27 repeated deliveries, delayed reads, nested quotes, failed supplement writes, account isolation, WakeBus piggyback delivery, cache limits/corruption and cancellation in both sharing directions. Issue #1 remains open for real QQ identity/redelivery and Core/Persona handoff validation. Bounding the archive-backed message index remains follow-up work.

## 0.2.3

- Close model-directed local filesystem access: media now accepts host-managed `log:` / `mem:` attachments or public HTTP(S) URLs. Legacy `path` inputs are rejected and must migrate to `blob` or `url`.
- Reject path traversal, encoded filesystem paths and file URLs before resolving attachments or starting a media batch. Display filenames never select a local file.
- Preserve image, voice, video and document sends, channel multipart images, batching, chunked uploads and FFmpeg/SILK conversion. Add regression coverage for attachment sends and attempts to read local files through paths, handles or audio playlists.
- Withdraw the package’s `unsafe` declaration for 0.2.3; market warning removal requires approval from the Cortico maintainers.

## 0.2.2

- Complete the market listing with a display name, project icon, three panel previews, bilingual feature descriptions, author profile, homepage and discovery keywords.
- Add illustrated English and Chinese READMEs, with links to installation, support and release notes.
- Keep the API 6 runtime and API 5 compatibility implementation unchanged from the verified 0.2.0 release.

## 0.2.0

- Add persistent target discovery, proactive reception checks, delivery modes, throttling and host alarm guidance.
- Keep proactive cooldowns after slow authentication, responses and rejections, and apply them to fallback retries.
- Add local and batch media, Tencent chunked upload with TTL caching, channel multipart images, FFmpeg/SILK voice conversion and quoted attachment reads.
- Forward explicitly selected model replies through the existing World output tap, with chunk throttling, conversation isolation and automatic stream completion; buffer proactive notifications through the regular message API.
- Downgrade explicit expired-anchor, Markdown and unsupported-stream rejections; bound rate retries and preserve uncertain delivery across restarts without replaying content.
- Extend protocol, streaming and real codec regression coverage for API 6 and Coopanion’s API 5 runtime; update model instructions, localized settings and package metadata.
- Document npm installation and declare the Cortico tags for FFmpeg setup and local-file media access.

## 0.1.1

- Redesign Connection around an embedded QR code, automatic credential retrieval, and live connection status; remove the QR after authorization.
- Move manual credentials and transport settings to Configuration, keeping AppSecret in the deployment secret store.
- Resume pending binding tasks after a page reload and enable or reconnect the World after authorization.
- Cover QR decoding, automatic binding, configuration validation and panel lifecycle on API 6 and Coopanion's API 5 runtime.

## 0.1.0

- Deliver QQ Official gateway and signed Webhook messages and notices through Core's event stream.
- Add explicit message, media, C2C streaming, recall, history, attachment-read and interaction tools.
- Support QQ bot credential binding and manual credential configuration in eleven UI languages.
- Ship World API 6 metadata, a generated self-description and an API 5 compatibility package.
- Mark the release experimental pending live QQ validation.
