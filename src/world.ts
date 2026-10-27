import { fileURLToPath } from 'node:url';
import { basename } from 'node:path';
import type { Language } from 'cortico/core/language.ts';
import type { EventEnvelope, OutputTap, ToolDef, ToolOutcome, World, WorldWebUiDecl, WorldHost } from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import type { WorldContext } from 'cortico/world.ts';
import { coerceGroupValues, getByPath, setByPath } from 'cortico/core/config-schema.ts';
import { QQOfficialBinding } from './binding.ts';
import { QQOfficialApiError, QQOfficialClient, QQOFFICIAL_SANDBOX_URL } from './client.ts';
import { QQOFFICIAL_ID, QQOFFICIAL_SECRET, qqOfficialConfigGroup, validateConfig, type QQOfficialConfigSection } from './config.ts';
import { QQOfficialGateway, type QQOfficialConnectionState } from './gateway.ts';
import { QQOFFICIAL_MODEL_TEXT, type ModelLanguage } from './model-text.ts';
import { readAttachment } from './media.ts';
import { normalize } from './normalize.ts';
import { integer, object, remoteUrl, route, string, target, targetKey, type JsonObject, type QQOfficialDispatch, type QQOfficialTarget } from './protocol.ts';
import { qqOfficialText } from './strings.ts';
import { qqOfficialTools, type QQOfficialAction } from './tools.ts';
import { QQOfficialWebhook } from './webhook.ts';
import { audioToSilk, audioToWav, isAudio, isSilk } from './audio.ts';
import { mediaBlobHandle, publicMedia } from './media-source.ts';
import { QQUploader, MEDIA_LIMITS } from './upload.ts';
import { QQSessionState } from './session-state.ts';
import { sendWithFallback, waitUntil } from './delivery.ts';
import { QQReplyStream } from './reply-stream.ts';
import { ATTACHMENT_ID, AttachmentError, AttachmentIndex, attachmentSummary, type AttachmentEntry, type AttachmentMessage } from './attachments.ts';
import { ImageCache, imageMime } from './image-cache.ts';

interface StreamState {
  target: QQOfficialTarget; streamId: string; format: string; anchors: JsonObject; sequence: number; index: number; at: number; uncertain?: boolean;
}
interface DownloadedAttachment { bytes: Buffer; mime: string; source: 'cache' | 'remote'; }

/** A cancelled tool stops waiting immediately, even when a background download owns the request. */
function awaitAttachment(task: Promise<DownloadedAttachment>, signal: AbortSignal): Promise<DownloadedAttachment> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    void task.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export interface QQOfficialWorldOptions {
  context: WorldContext<QQOfficialConfigSection>;
  modelLanguage?: () => ModelLanguage;
  /** Endpoint overrides for local protocol servers in tests. */
  endpoints?: { apiUrl?: string; tokenUrl?: string; bindingUrl?: string; mediaOrigin?: string };
}

/** QQ owns delivery semantics; Core owns event storage, batching and the Persona's decision to act. */
export class QQOfficialWorld implements World {
  readonly id = QQOFFICIAL_ID;
  private host: WorldHost | null = null;
  private client: QQOfficialClient | null = null;
  private gateway: QQOfficialGateway | null = null;
  private webhook: QQOfficialWebhook | null = null;
  private abort = new AbortController();
  private incoming = Promise.resolve();
  private outgoing = Promise.resolve<unknown>(undefined);
  private control = Promise.resolve<unknown>(undefined);
  private seen = new Set<string>();
  private appId = '';
  private state: QQOfficialConnectionState = 'offline';
  private detail = '';
  private binding: QQOfficialBinding;
  private sessions = new QQSessionState();
  private uploader: QQUploader | null = null;
  private streams = new Map<string, StreamState>();
  private streamTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private replyStream?: QQReplyStream;
  private replyTarget?: QQOfficialTarget;
  private replyCursor = 0;
  private modelRoundOpen = false;
  private replyWaitForRound = false;
  private lastProactiveAt = 0;
  private attachments = new AttachmentIndex('');
  private imageCache?: ImageCache;
  private imageCacheTimer?: ReturnType<typeof setInterval>;
  private imageQueue = new Map<string, AttachmentEntry>();
  private imageWorkers = new Set<Promise<void>>();
  private attachmentDownloads = new Map<string, { promise: Promise<DownloadedAttachment>; prefetch: boolean; url: unknown }>();

  constructor(private readonly options: QQOfficialWorldOptions) {
    this.binding = new QQOfficialBinding(options.context.cfg.timeoutMs, options.endpoints?.bindingUrl);
  }

  private get cfg() { return this.options.context.cfg; }
  private get text() { return QQOFFICIAL_MODEL_TEXT[this.options.modelLanguage?.() ?? this.cfg.modelLanguage]; }

  envPromptVars(): Record<string, string> { return { 'qqofficial.environment': this.text.environment }; }

  tools(): ToolDef[] {
    return qqOfficialTools(this.options.modelLanguage?.() ?? this.cfg.modelLanguage, (action, args, signal) => {
      return this.enqueue(() => this.execute(action, args, signal));
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.outgoing.then(operation);
    this.outgoing = task.catch(() => undefined);
    return task;
  }

  outputTap(): OutputTap | undefined {
    if (!this.host) return undefined;
    // Return a stable forwarding tap: the host may acquire it before the tool arms a reply.
    return {
      onEvent: event => {
        if (event.type === 'response.created') { this.modelRoundOpen = true; this.replyWaitForRound = false; }
        if (!this.replyWaitForRound && this.replyRouteValid()) this.replyStream?.tap.onEvent(event);
      },
      externalizes: event => !this.replyWaitForRound && this.replyRouteValid() && (this.replyStream?.tap.externalizes?.(event) ?? false),
      onRoundEnd: () => { this.modelRoundOpen = false; if (!this.replyWaitForRound) this.replyStream?.tap.onRoundEnd?.(); },
      onAbort: reason => { this.modelRoundOpen = false; this.replyStream?.tap.onAbort?.(reason); },
    };
  }

  private replyRouteValid(): boolean {
    if (!this.host || !this.replyTarget || !this.replyStream || this.replyStream.closed) return false;
    const latest = this.host.store.latestCursor();
    if (latest > this.replyCursor) {
      const incoming = this.host.store.range({ fromCursor: this.replyCursor + 1 });
      this.replyCursor = latest;
      if (incoming.some(e => e.origin === 'external' && (e.source !== this.id || (e.type === `${this.id}.message`
        && targetKey(e.meta!.target as QQOfficialTarget) !== targetKey(this.replyTarget!))))) {
        // A shared Core session may receive another conversation before the next round starts.
        // Close only text already selected for this reply; never route the new conversation to QQ.
        void this.replyStream.finish(); return false;
      }
    }
    return true;
  }

  onTurnEnded(): void { void this.finishStreams(); }
  onHandoffEnded(): void { void this.finishStreams(); }

  private async finishStreams(): Promise<void> {
    await this.replyStream?.finish();
    await Promise.allSettled([...this.streams.values()].filter(s => !s.uncertain).map(s =>
      this.enqueue(() => this.execute('stream', { target: s.target, streamId: s.streamId, content: '', finish: true }))));
  }

  async start(host: WorldHost): Promise<void> {
    validateConfig(this.cfg);
    this.appId = string(this.cfg.appId, 'AppID');
    const secret = string(this.options.context.secret(QQOFFICIAL_SECRET), 'AppSecret');
    this.host = host;
    this.abort = new AbortController();
    const saved = host.store.range({ source: this.id });
    this.attachments = new AttachmentIndex(this.appId);
    for (const event of saved) this.attachments.observe(event);
    this.imageCache = new ImageCache(this.options.context.dataDir, () => ({
      ttlMs: this.cfg.imageCacheTtlMs, maxBytes: this.cfg.imageCacheMaxBytes,
      maxFileBytes: Math.min(this.cfg.maxMediaBytes, 30 * 1024 * 1024),
    }));
    try { await this.imageCache.init(); }
    catch { host.log.warn('qqofficial.image_cache_unavailable'); this.imageCache = undefined; }
    if (this.imageCache && this.options.context.dataDir) {
      this.imageCacheTimer = setInterval(() => {
        void this.imageCache?.prune().catch(() => host.log.warn('qqofficial.image_cache_cleanup_failed'));
      }, 60000);
      this.imageCacheTimer.unref();
    }
    this.sessions = new QQSessionState(); this.streams.clear(); this.lastProactiveAt = 0;
    for (const event of saved) {
      if (event.meta?.appId !== this.appId) continue;
      this.sessions.observe(event);
      if (event.type === `${this.id}.attempt` && event.meta.streamId) {
        const state = this.streams.get(this.streamKey(event.meta.target as QQOfficialTarget, String(event.meta.streamId)));
        if (state) state.uncertain = true;
      }
      if (event.type === `${this.id}.notice` && event.meta.eventType === 'STREAM_PART_REJECTED') {
        const state = this.streams.get(this.streamKey(event.meta.target as QQOfficialTarget, String(event.meta.streamId)));
        if (state) state.uncertain = false;
      }
      if (event.type === `${this.id}.sent`) {
        if (!event.meta.msg_id && !event.meta.event_id) this.lastProactiveAt = Math.max(this.lastProactiveAt, Date.parse(event.ts));
        this.rememberStream(event.meta, Date.parse(event.ts));
      }
    }
    this.seen = new Set(saved.slice(-10000)
      .filter((e) => e.meta?.appId === this.appId && typeof e.meta?.dedupKey === 'string').map((e) => e.meta!.dedupKey as string));
    this.client = new QQOfficialClient({
      appId: this.appId, secret, timeoutMs: this.cfg.timeoutMs, signal: this.abort.signal,
      apiUrl: this.options.endpoints?.apiUrl ?? (this.cfg.sandbox ? QQOFFICIAL_SANDBOX_URL : undefined),
      tokenUrl: this.options.endpoints?.tokenUrl,
    });
    this.uploader = new QQUploader(this.client, this.cfg.timeoutMs, this.options.endpoints?.mediaOrigin);
    for (const state of this.streams.values()) this.watchStream(state);
    try {
      if (this.cfg.transport === 'websocket') {
        this.gateway = new QQOfficialGateway({
          client: this.client, intents: this.cfg.intents, reconnectMs: this.cfg.reconnectMs,
          maxReconnectMs: this.cfg.maxReconnectMs, timeoutMs: this.cfg.timeoutMs,
          onEvent: (event) => this.receive(event), onState: (state, detail) => this.setState(state, detail),
        });
        this.gateway.start();
      } else {
        this.webhook = new QQOfficialWebhook({
          secret, ...this.cfg.webhook, onEvent: (event) => this.receive(event),
          onError: () => this.setState('error', 'Webhook delivery failed'),
        });
        const port = await this.webhook.start();
        this.setState('online', `${this.cfg.webhook.host}:${port}${this.cfg.webhook.path}`);
      }
    } catch (error) { await this.stop(); throw error; }
  }

  async stop(): Promise<void> {
    // Give already-published streams a bounded opportunity to send DONE before aborting the transport.
    if (this.streams.size || this.replyStream) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([this.finishStreams(), new Promise<void>(resolve => { timer = setTimeout(resolve, 2000); })]);
      clearTimeout(timer);
    }
    this.replyStream?.cancel(); this.replyStream = undefined;
    this.modelRoundOpen = false; this.replyWaitForRound = false;
    for (const timer of this.streamTimers.values()) clearTimeout(timer);
    this.streamTimers.clear();
    clearInterval(this.imageCacheTimer); this.imageCacheTimer = undefined;
    this.imageQueue.clear();
    this.abort.abort();
    await Promise.allSettled([this.gateway?.stop(), this.webhook?.stop()]);
    await Promise.allSettled([this.incoming, this.outgoing]);
    await Promise.allSettled([...this.imageWorkers, ...[...this.attachmentDownloads.values()].map(d => d.promise)]);
    await this.imageCache?.flush();
    this.imageCache = undefined;
    this.gateway = null; this.webhook = null; this.client = null; this.uploader = null; this.host = null;
    this.binding.clear(); this.setState('offline');
  }

  private setState(state: QQOfficialConnectionState, detail = ''): void {
    if (state === this.state && detail === this.detail) return;
    this.state = state; this.detail = detail;
    this.host?.log.info('qqofficial.connection', { state, detail });
  }

  private receive(event: QQOfficialDispatch): Promise<void> {
    const task = this.incoming.then(async () => {
      this.abort.signal.throwIfAborted();
      const incoming = normalize(event);
      if (incoming.kind === 'message') {
        const previous = this.attachments.find(incoming.target!, incoming.messageId!);
        if (previous) {
          const entries = this.attachments.merge(previous.target, previous.messageId, incoming.data, previous.entries);
          if (JSON.stringify(entries) !== JSON.stringify(previous.entries)) {
            // Commit before updating the in-memory union, so a failed append can be retried.
            const supplement = await this.push('attachments', previous.target, {
              messageCursor: previous.cursor, messageId: previous.messageId, entries,
            });
            this.attachments.observe(supplement);
          }
          this.prefetchImages(previous.entries);
          return;
        }
      }
      if (incoming.key && this.seen.has(incoming.key)) return;
      const { key, ...data } = incoming;
      const entries = incoming.kind === 'message' ? this.attachments.merge(incoming.target!, incoming.messageId!, incoming.data) : [];
      const saved = await this.push(incoming.kind, incoming.target,
        { ...data, ...(entries.length ? { attachmentRefs: entries.map(e => attachmentSummary(e)) } : {}) }, true, key ? { dedupKey: key } : {});
      this.attachments.observe(saved);
      this.prefetchImages(entries);
      if (key) {
        this.seen.add(key);
        if (this.seen.size > 10000) this.seen.delete(this.seen.values().next().value!);
      }
    });
    this.incoming = task.catch(() => undefined);
    return task;
  }

  private sender(value?: QQOfficialTarget): string { return value ? `${this.id}.${targetKey(value)}` : this.id; }

  private async push(kind: 'message' | 'notice' | 'sent' | 'attempt' | 'removed' | 'acknowledged' | 'attachments', destination: QQOfficialTarget | undefined,
    data: JsonObject, deliver = false, extra: JsonObject = {}): Promise<EventEnvelope> {
    if (!this.host) throw new Error('World is not running');
    const event = await this.host.pushEvent({
      type: `${this.id}.${kind}`, source: this.id, origin: 'external', ts: nowIso(this.options.context.timezone),
      senderKey: this.sender(destination), ...(kind === 'sent' ? { tags: ['speak'] as const } : {}),
      text: `${this.text[kind]}\n${JSON.stringify(data)}`,
      meta: { ...data, ...extra, target: destination, appId: this.appId },
    }, { deliver, trigger: 'debounce' });
    this.sessions.observe(event);
    return event;
  }

  private prefetchImages(entries: AttachmentEntry[]): void {
    if (!this.imageCache?.enabled || this.abort.signal.aborted) return;
    for (const entry of entries) {
      const a = entry.attachment;
      if (typeof a.url !== 'string' || !(/^image\/(png|jpeg|gif|webp|bmp)(;|$)/i.test(String(a.content_type)) || /\.(png|jpe?g|gif|webp|bmp)$/i.test(String(a.filename ?? '')))) continue;
      if (this.imageCache.status(entry.attachmentId).cacheStatus === 'cached' || this.imageQueue.has(entry.attachmentId)) continue;
      if (this.imageQueue.size >= 256) { this.host?.log.warn('qqofficial.image_cache_queue_full'); break; }
      this.imageQueue.set(entry.attachmentId, entry);
    }
    while (this.imageWorkers.size < 2 && this.imageQueue.size) {
      const worker = (async () => {
        while (this.imageQueue.size && !this.abort.signal.aborted) {
          const [id, entry] = this.imageQueue.entries().next().value!;
          this.imageQueue.delete(id);
          try { await this.downloadAttachment(entry, this.abort.signal, true); }
          catch (error) {
            if (!this.abort.signal.aborted) this.host?.log.warn('qqofficial.image_prefetch_failed', {
              attachmentId: id, code: error instanceof AttachmentError ? error.code : 'ATTACHMENT_FETCH_FAILED',
            });
          }
        }
      })();
      this.imageWorkers.add(worker);
      void worker.finally(() => this.imageWorkers.delete(worker));
    }
  }

  private downloadAttachment(entry: AttachmentEntry, signal: AbortSignal, prefetch = false): Promise<DownloadedAttachment> {
    const active = this.attachmentDownloads.get(entry.attachmentId);
    if (active) return active.promise.catch(error => {
      const refreshed = active.url !== entry.attachment.url;
      const largerRead = !prefetch && active.prefetch && error instanceof AttachmentError && error.code === 'ATTACHMENT_TOO_LARGE';
      if (!signal.aborted && (refreshed || largerRead)) return this.downloadAttachment(entry, signal, prefetch);
      throw error;
    });
    const task = (async () => {
      signal.throwIfAborted();
      try {
        const cached = await this.imageCache?.get(entry.attachmentId);
        if (cached) return { ...cached, source: 'cache' as const };
      } catch { this.host?.log.warn('qqofficial.image_cache_read_failed', { attachmentId: entry.attachmentId }); }
      const url = entry.attachment.url;
      if (typeof url !== 'string' || !url) throw new AttachmentError('ATTACHMENT_URL_MISSING', 'Attachment metadata has no download URL; inspect history or ask for the image again.', attachmentSummary(entry));
      let media: Awaited<ReturnType<typeof readAttachment>>;
      try {
        media = await readAttachment(url, {
          maxBytes: Math.min(this.cfg.maxMediaBytes, prefetch ? 30 * 1024 * 1024 : Infinity),
          timeoutMs: this.cfg.timeoutMs, signal, testOrigin: this.options.endpoints?.mediaOrigin,
        });
      } catch (error) {
        signal.throwIfAborted();
        const reason = error instanceof Error ? error.message : '';
        const status = /Attachment HTTP (\d+)/.exec(reason)?.[1];
        const code = /outside|Invalid URL/.test(reason) ? 'ATTACHMENT_URL_REJECTED' : /maxMediaBytes/.test(reason) ? 'ATTACHMENT_TOO_LARGE' : 'ATTACHMENT_DOWNLOAD_FAILED';
        throw new AttachmentError(code, status ? `Attachment download returned HTTP ${status}; the cached image is unavailable. Ask for a new upload if the URL has expired.`
          : code === 'ATTACHMENT_URL_REJECTED' ? 'Attachment URL is outside the permitted QQ CDN URLs.'
          : code === 'ATTACHMENT_TOO_LARGE' ? 'Attachment exceeds the configured download limit.' : 'Attachment download failed or timed out; retry the same attachmentId.',
        { ...attachmentSummary(entry), cacheStatus: 'remote', ...(status ? { httpStatus: Number(status) } : {}) });
      }
      const mime = imageMime(media.bytes);
      if (mime) {
        media.mime = mime;
        signal.throwIfAborted();
        try { await this.imageCache?.put(entry.attachmentId, media.bytes, mime); }
        catch { this.host?.log.warn('qqofficial.image_cache_write_failed', { attachmentId: entry.attachmentId }); }
      }
      return { ...media, source: 'remote' as const };
    })();
    this.attachmentDownloads.set(entry.attachmentId, { promise: task, prefetch, url: entry.attachment.url });
    void task.finally(() => {
      if (this.attachmentDownloads.get(entry.attachmentId)?.promise === task) this.attachmentDownloads.delete(entry.attachmentId);
    }).catch(() => undefined);
    return task;
  }

  private locateAttachment(args: JsonObject): { message: AttachmentMessage; entry: AttachmentEntry } {
    if (args.attachmentId !== undefined) {
      if (typeof args.attachmentId !== 'string' || !ATTACHMENT_ID.test(args.attachmentId)
        || ['cursor', 'index', 'quotedIndex', 'quotedPath'].some(key => args[key] !== undefined)) {
        throw new AttachmentError('ATTACHMENT_LOCATOR_INVALID', 'Supply attachmentId alone, or cursor and index with an optional quotedIndex/quotedPath.');
      }
      const found = this.attachments.ref(args.attachmentId);
      if (!found) throw new AttachmentError('ATTACHMENT_REFERENCE_NOT_FOUND', 'Attachment reference not found for this AppID. Query qqofficial_history with messagesOnly=true for current references.', { attachmentId: args.attachmentId });
      return found;
    }
    if (args.cursor === undefined || args.index === undefined) throw new AttachmentError('ATTACHMENT_LOCATOR_INVALID', 'Supply attachmentId, or both cursor and zero-based index from qqofficial_history.');
    const cursor = integer(args.cursor, 'cursor', 1, Number.MAX_SAFE_INTEGER);
    const index = integer(args.index, 'index', 0, Number.MAX_SAFE_INTEGER);
    const event = this.host!.store.get(cursor);
    if (!event) throw new AttachmentError('MESSAGE_CURSOR_NOT_FOUND', 'Message event not found at this cursor. Query qqofficial_history with messagesOnly=true.', { cursor });
    if (event.source !== this.id) throw new AttachmentError('MESSAGE_SOURCE_MISMATCH', 'This cursor belongs to a different World.', { cursor });
    if (event.meta?.appId !== this.appId) throw new AttachmentError('MESSAGE_ACCOUNT_MISMATCH', 'This cursor belongs to a different QQ AppID.', { cursor });
    if (event.type !== `${this.id}.message`) throw new AttachmentError('MESSAGE_EVENT_TYPE_MISMATCH', 'This cursor is not an incoming message. Use a qqofficial.message cursor from history.', { cursor, eventType: event.type });
    if (args.quotedIndex !== undefined && args.quotedPath !== undefined) throw new AttachmentError('ATTACHMENT_LOCATOR_INVALID', 'quotedIndex and quotedPath are mutually exclusive.');
    const path = args.quotedPath !== undefined ? args.quotedPath : args.quotedIndex !== undefined ? [args.quotedIndex] : [];
    if (!Array.isArray(path) || path.length > 8 || path.some(i => !Number.isInteger(i) || i < 0 || i > 100)) throw new AttachmentError('ATTACHMENT_LOCATOR_INVALID', 'quotedPath must contain at most eight zero-based msg_elements indices (0–100).');
    const message = this.attachments.at(cursor);
    if (!message) throw new AttachmentError('MESSAGE_METADATA_UNAVAILABLE', 'This message has no usable saved attachment metadata. Query history or request a new upload.', { cursor });
    let data = object(this.attachments.view(event).meta!.data);
    for (const i of path) {
      if (!Array.isArray(data.msg_elements) || !data.msg_elements[i]) throw new AttachmentError('QUOTED_MESSAGE_NOT_FOUND', 'Quoted message not found at this path.', { cursor, quotedPath: path, available: this.attachments.summaries(message) });
      data = object(data.msg_elements[i]);
    }
    const entry = message.entries.find(e => e.index === index && e.quotedPath.join('.') === path.join('.'));
    if (!entry) throw new AttachmentError('ATTACHMENT_INDEX_NOT_FOUND', 'Attachment not found at this index. Use an attachmentId from available or query history again.', { cursor, index, quotedPath: path, available: this.attachments.summaries(message) });
    return { message, entry };
  }

  private anchors(args: JsonObject): JsonObject {
    if (args.replyTo !== undefined && args.eventId !== undefined) throw new Error('replyTo and eventId are mutually exclusive');
    return {
      ...(args.replyTo !== undefined ? { msg_id: string(args.replyTo, 'replyTo') } : {}),
      ...(args.eventId !== undefined ? { event_id: string(args.eventId, 'eventId') } : {}),
    };
  }

  private async prepare(destination: QQOfficialTarget, anchors: JsonObject): Promise<number> {
    const sequence = this.sessions.sequence(destination, anchors) + 1;
    await this.push('attempt', destination, { ...anchors, msg_seq: sequence });
    return sequence;
  }

  private async execute(action: QQOfficialAction, args: JsonObject, signal?: AbortSignal): Promise<string | ToolOutcome> {
    if (!this.host || !this.client) throw new Error('World is not running');
    const combined = AbortSignal.any([this.abort.signal, ...signal ? [signal] : []]);
    combined.throwIfAborted();
    if (action === 'targets') return JSON.stringify(this.sessions.list(args.limit === undefined ? 30 : integer(args.limit, 'limit', 1, 100)));
    if (action === 'read') {
      const { message, entry } = this.locateAttachment(args);
      const attachment = entry.attachment;
      const media = { ...await awaitAttachment(this.downloadAttachment(entry, combined), combined) };
      combined.throwIfAborted();
      if (media.bytes.byteLength > this.cfg.maxMediaBytes) throw new AttachmentError('ATTACHMENT_TOO_LARGE', 'Attachment exceeds the current download limit.', attachmentSummary(entry, message.cursor));
      if (isSilk(media.bytes) || isAudio(String(attachment.content_type ?? media.mime), String(attachment.filename ?? ''))) {
        media.bytes = Buffer.from(await audioToWav(media.bytes, { signal: combined, timeoutMs: this.cfg.timeoutMs, ffmpegPath: this.cfg.ffmpegPath }));
        media.mime = 'audio/wav';
      }
      const text = JSON.stringify({ ...attachmentSummary(entry, message.cursor), messageId: message.messageId,
        mime: media.mime, bytes: media.bytes.byteLength, source: media.source, ...(this.imageCache?.status(entry.attachmentId) ?? { cacheStatus: 'remote' }) });
      return { text, blobs: [{ ...media, ...(typeof attachment.filename === 'string' ? { name: media.mime === 'audio/wav' ? attachment.filename.replace(/\.[^.]*$/, '') + '.wav' : attachment.filename } : {}), fallbackText: text }] };
    }
    if (action === 'history') {
      if (args.messagesOnly !== undefined && typeof args.messagesOnly !== 'boolean') throw new Error('messagesOnly must be a boolean');
      const limit = args.limit === undefined ? 30 : integer(args.limit, 'limit', 1, 100);
      const before = args.beforeCursor === undefined ? undefined : integer(args.beforeCursor, 'beforeCursor', 1, Number.MAX_SAFE_INTEGER) - 1;
      const destination = args.target === undefined ? undefined : target(args.target);
      const events = this.host.store.range({ source: this.id, ...(destination ? { senderKey: this.sender(destination) } : {}), toCursor: before });
      return JSON.stringify(events.filter((e) => e.meta?.appId === this.appId && ![`${this.id}.attempt`, `${this.id}.attachments`].includes(e.type)
        && (!args.messagesOnly || e.type === `${this.id}.message`)).slice(-limit).map(event => {
        const view = this.attachments.view(event);
        const message = this.attachments.at(event.cursor);
        if (message) view.meta = { ...view.meta, attachmentRefs: message.entries.map(entry => ({
          ...attachmentSummary(entry, message.cursor), ...(this.imageCache?.status(entry.attachmentId) ?? { cacheStatus: 'remote' }),
        })) };
        return view;
      }));
    }
    if (action === 'interaction') {
      const id = string(args.interactionId, 'interactionId');
      const code = integer(args.code, 'code', 0, 5);
      const result = await this.client.request('PUT', `/interactions/${encodeURIComponent(id)}`, { code }, combined);
      await this.push('acknowledged', undefined, { interactionId: id, code, result });
      return JSON.stringify(result);
    }
    const destination = target(args.target);
    if (action === 'stream' && args.followModel === true) {
      const anchors = this.delivery(destination, args);
      return this.followModel(destination, args, anchors);
    }
    if (action === 'media' && args.items !== undefined) {
      if (!Array.isArray(args.items) || !args.items.length || args.items.length > 8 || ['url', 'blob', 'path', 'fileType'].some(k => args[k] !== undefined)) throw new Error('Supply 1–8 items or one media source');
      const items = args.items.map(item => object(item));
      for (const item of items) this.validateMedia(item);
      const sent: unknown[] = [];
      for (let index = 0; index < items.length; index++) {
        try { sent.push(await this.execute('media', { ...args, ...items[index], items: undefined }, combined)); }
        catch (error) { return { failed: true, text: JSON.stringify({ sent, failedIndex: index, error: error instanceof Error ? error.message : String(error), instruction: 'Do not resend the already accepted items' }) }; }
      }
      return JSON.stringify({ sent });
    }
    if (action === 'remove') {
      const id = string(args.messageId, 'messageId');
      const result = await this.client.request('DELETE', `${route(destination)}/messages/${encodeURIComponent(id)}`, undefined, combined);
      await this.push('removed', destination, { messageId: id, result });
      return JSON.stringify(result);
    }
    let anchors = this.delivery(destination, args);
    if (!anchors.msg_id && !anchors.event_id && args.streamId === undefined) this.sessions.assertProactive(destination);
    let payload: JsonObject;
    let suffix = 'messages';
    let streamData: JsonObject = {};
    let sequence: number | undefined;
    let multipart: { bytes: Uint8Array; name: string } | undefined;
    let prior: StreamState | undefined;
    if (action === 'media') {
      const fileType = this.validateMedia(args);
      if ((destination.kind === 'channel' || destination.kind === 'dms') && fileType !== 1) throw new Error('Channels and DMS accept images only');
      const limit = Math.min(this.cfg.maxMediaBytes, MEDIA_LIMITS[fileType]);
      let bytes: Uint8Array | undefined;
      let url = args.url === undefined ? undefined : remoteUrl(args.url);
      let name = basename(args.fileName !== undefined ? string(args.fileName, 'fileName') : fileType === 1 ? 'image.png' : fileType === 3 ? 'voice.silk' : 'attachment');
      if (args.blob !== undefined) {
        const handle = mediaBlobHandle(args.blob);
        bytes = this.host.blob(handle)?.bytes;
        if (!bytes) throw new Error('Blob not found');
      }
      if (bytes && (!bytes.length || bytes.byteLength > limit)) throw new Error('Media exceeds maxMediaBytes or QQ file type limit');
      if (fileType === 3) {
        if (!bytes) bytes = await publicMedia(url!, limit, this.cfg.timeoutMs, combined);
        bytes = await audioToSilk(bytes, { signal: combined, timeoutMs: this.cfg.timeoutMs, ffmpegPath: this.cfg.ffmpegPath }); url = undefined;
        name = name.replace(/\.[^.]*$/, '') + '.silk';
        if (bytes.byteLength > limit) throw new Error('Converted audio exceeds maxMediaBytes or QQ voice limit');
      }
      if (destination.kind === 'channel' || destination.kind === 'dms') {
        if (fileType !== 1) throw new Error('Channels and DMS accept images only');
        if (bytes) { multipart = { bytes, name }; payload = {}; }
        else payload = { image: url };
      } else {
        const info = await this.uploader!.upload(destination, fileType, { bytes, url, name }, combined);
        payload = { msg_type: 7, media: { file_info: info }, content: ' ' };
      }
      if (args.content !== undefined) payload.content = string(args.content, 'content');
    } else {
      const content = typeof args.content === 'string' ? args.content : string(args.content, 'content');
      const format = args.format ?? 'text';
      if (format !== 'text' && format !== 'markdown') throw new Error('Invalid format');
      if (action === 'stream') {
        if (destination.kind !== 'c2c') throw new Error('Streaming requires a c2c target');
        if (args.finish !== undefined && typeof args.finish !== 'boolean') throw new Error('Invalid finish');
        const finish = args.finish !== false;
        let index = 0;
        if (args.streamId !== undefined) {
          const streamId = string(args.streamId, 'streamId');
          prior = this.streams.get(this.streamKey(destination, streamId));
          if (!prior) throw new Error('Stream not found or already finished');
          if (prior.uncertain) throw new Error('Previous stream delivery is unknown; do not resend its content');
          if ((args.replyTo !== undefined && args.replyTo !== prior.anchors.msg_id) || (args.eventId !== undefined && args.eventId !== prior.anchors.event_id)
            || (args.format !== undefined && format !== prior.format)) throw new Error('Stream target, format and reply anchor must remain unchanged');
          anchors = prior.anchors;
          sequence = prior.sequence; index = prior.index + 1;
          streamData = { streamId, format: prior.format };
        }
        if (!content && !args.streamId) throw new Error('The first stream part needs content');
        streamData = { ...streamData, index, finish, format: streamData.format ?? format };
        // A terminal Markdown part needs a newline; an empty DONE frame must still carry one.
        const terminalNewline = finish && (streamData.format === 'markdown' || !content) && !content.endsWith('\n');
        payload = { input_mode: 'append', input_state: finish ? 10 : 1, index, content_type: streamData.format,
          content_raw: content + (terminalNewline ? '\n' : ''), ...(args.streamId ? { stream_msg_id: args.streamId } : {}) };
        suffix = 'stream_messages';
      } else {
        string(content, 'content');
        payload = format === 'markdown' ? { markdown: { content } } : { content };
        if (destination.kind === 'c2c' || destination.kind === 'group') payload.msg_type = format === 'markdown' ? 2 : 0;
        if (args.referenceId !== undefined) payload.message_reference = { message_id: string(args.referenceId, 'referenceId') };
        if (args.keyboard !== undefined) payload.keyboard = object(args.keyboard);
      }
    }
    sequence ??= await this.prepare(destination, anchors);
    if (prior) {
      await waitUntil(prior.at + this.cfg.streamIntervalMs, combined);
      await this.push('attempt', destination, { ...anchors, msg_seq: sequence, streamId: prior.streamId, index: streamData.index });
      prior.uncertain = true;
    }
    combined.throwIfAborted();
    if (destination.kind === 'c2c' || destination.kind === 'group') payload.msg_seq = sequence;
    Object.assign(payload, anchors);
    let sent: Awaited<ReturnType<typeof sendWithFallback>>;
    try { sent = await sendWithFallback({ payload, signal: combined, fallback: args.fallback === undefined ? this.cfg.autoFallback : args.fallback === true,
      continuation: !!prior,
      proactive: () => this.prepare(destination, {}),
      send: async final => {
        let body: JsonObject | FormData = final;
        if (multipart) {
          const form = new FormData();
          for (const [key, value] of Object.entries(final)) if (value !== undefined) form.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
          form.set('file_image', new Blob([new Uint8Array(multipart.bytes)]), multipart.name); body = form;
        }
        const proactive = !final.msg_id && !final.event_id && !prior;
        if (proactive) await this.proactive(destination, combined);
        try {
          const result = await this.client!.request('POST', `${route(destination)}/${suffix}`, body, combined);
          if (typeof result.id !== 'string' || !result.id) throw new Error('QQ accepted the request without a message id; delivery is unknown, do not resend');
          return result;
        } finally {
          // Token refresh and network latency must not consume the next send's cooldown.
          // Include rejected attempts so fallback retries obey the same interval.
          if (proactive) this.lastProactiveAt = Date.now();
        }
      },
    }); } catch (error) {
      if (prior && error instanceof QQOfficialApiError && error.rejected) {
        // An explicit rejection leaves the previous confirmed part intact; DONE can still close it.
        await this.push('notice', destination, { eventType: 'STREAM_PART_REJECTED', streamId: prior.streamId, index: streamData.index });
        prior.uncertain = false;
        if (!streamData.finish) this.watchStream(prior);
      }
      throw error;
    }
    const { result } = sent; payload = sent.payload;
    anchors = { ...(payload.msg_id ? { msg_id: payload.msg_id } : {}), ...(payload.event_id ? { event_id: payload.event_id } : {}), ...(payload.is_wakeup ? { is_wakeup: true } : {}) };
    sequence = typeof payload.msg_seq === 'number' ? payload.msg_seq : sequence;
    const messageId = typeof result.id === 'string' ? result.id : undefined;
    if (action === 'stream') { streamData.streamId = string(result.id, 'stream response id'); streamData.format = payload.content_type; }
    const receipt = { target: destination, ...anchors, msg_seq: sequence, ...streamData,
      ...(prior ? { previousStreamId: prior.streamId } : {}), messageId, request: payload, result, fallbacks: sent.fallbacks };
    await this.push('sent', destination, receipt);
    this.rememberStream(receipt, Date.now());
    return `${this.text.sent}\n${JSON.stringify(receipt)}`;
  }

  private validateMedia(args: JsonObject): number {
    if ('path' in args) throw new Error('Direct local paths are no longer supported; attach the file through the host and use its log:/mem: blob handle');
    const type = integer(args.fileType, 'fileType', 1, 4);
    if (['url', 'blob'].filter(k => args[k] !== undefined).length !== 1) throw new Error('Supply exactly one of url or blob');
    if (args.blob !== undefined) mediaBlobHandle(args.blob);
    if (args.url !== undefined) remoteUrl(args.url);
    return type;
  }

  private delivery(destination: QQOfficialTarget, args: JsonObject): JsonObject {
    if (args.fallback !== undefined && typeof args.fallback !== 'boolean') throw new Error('Invalid fallback');
    const anchors = this.anchors(args);
    const mode = args.delivery ?? (Object.keys(anchors).length ? 'reply' : 'proactive');
    if (!['auto', 'reply', 'proactive', 'wakeup'].includes(String(mode))) throw new Error('Invalid delivery');
    if (mode === 'proactive' || mode === 'wakeup') {
      if (Object.keys(anchors).length) throw new Error('Proactive/wakeup delivery cannot include replyTo or eventId');
      if (mode === 'wakeup') {
        if (destination.kind !== 'c2c') throw new Error('Wakeup messages require a c2c target');
        return { is_wakeup: true };
      }
      return {};
    }
    if (!Object.keys(anchors).length) {
      const recent = this.sessions.recentReply(destination);
      if (recent) return { msg_id: recent };
      if (mode === 'reply') throw new Error('No recent reply anchor; choose proactive delivery or wait for a user message');
    }
    return anchors;
  }

  private async proactive(destination: QQOfficialTarget, signal: AbortSignal): Promise<void> {
    this.sessions.assertProactive(destination);
    await waitUntil(this.lastProactiveAt + this.cfg.proactiveIntervalMs, signal);
  }

  private streamKey(destination: QQOfficialTarget, id: string): string { return JSON.stringify([targetKey(destination), id]); }
  private rememberStream(receipt: JsonObject, at: number): void {
    if (!receipt.streamId || !receipt.target) return;
    const destination = receipt.target as QQOfficialTarget;
    const id = String(receipt.streamId);
    if (typeof receipt.previousStreamId === 'string') {
      const previous = this.streamKey(destination, receipt.previousStreamId);
      this.streams.delete(previous); clearTimeout(this.streamTimers.get(previous)); this.streamTimers.delete(previous);
    }
    const key = this.streamKey(destination, id);
    clearTimeout(this.streamTimers.get(key)); this.streamTimers.delete(key);
    if (receipt.finish) { this.streams.delete(key); return; }
    const state: StreamState = { target: destination, streamId: id, format: String(receipt.format),
      anchors: { ...(receipt.msg_id ? { msg_id: receipt.msg_id } : {}), ...(receipt.event_id ? { event_id: receipt.event_id } : {}), ...(receipt.is_wakeup ? { is_wakeup: true } : {}) },
      sequence: Number(receipt.msg_seq), index: Number(receipt.index), at };
    this.streams.set(key, state);
    this.watchStream(state);
  }
  private watchStream(state: StreamState): void {
    if (state.uncertain) return;
    const key = this.streamKey(state.target, state.streamId);
    clearTimeout(this.streamTimers.get(key));
    const timer = setTimeout(() => {
      this.streamTimers.delete(key);
      void this.enqueue(async () => {
        if (this.streams.get(key) !== state || state.uncertain) return;
        await this.execute('stream', { target: state.target, streamId: state.streamId, content: '', finish: true });
      }).catch(error => this.host?.log.warn('qqofficial.stream.close_failed', { error: String(error) }));
    }, Math.max(0, state.at + this.cfg.streamIdleMs - Date.now()));
    timer.unref?.(); this.streamTimers.set(key, timer);
  }

  private followModel(destination: QQOfficialTarget, args: JsonObject, anchors: JsonObject): string {
    if (args.streamId !== undefined || args.finish !== undefined || args.content) throw new Error('followModel starts a new reply without content, finish or streamId');
    if (args.format !== undefined && !['text', 'markdown'].includes(String(args.format))) throw new Error('Invalid format');
    if (this.replyStream && !this.replyStream.closed) throw new Error('A streamed reply is already active');
    let streamId: string | undefined;
    let content = '';
    // Proactive notifications use the regular endpoint; native streams are reserved for anchored C2C replies.
    let buffered = destination.kind !== 'c2c' || (!anchors.msg_id && !anchors.event_id);
    const options = { target: destination, format: args.format ?? 'markdown', fallback: args.fallback,
      ...(anchors.msg_id ? { replyTo: anchors.msg_id } : {}), ...(anchors.event_id ? { eventId: anchors.event_id } : {}),
      delivery: anchors.is_wakeup ? 'wakeup' : anchors.msg_id || anchors.event_id ? 'reply' : 'proactive' };
    this.replyTarget = destination; this.replyCursor = this.host!.store.latestCursor();
    // Core may execute this tool eagerly before its calling model round has ended.
    this.replyWaitForRound = this.modelRoundOpen;
    this.replyStream = new QQReplyStream({ intervalMs: this.cfg.streamIntervalMs, idleMs: this.cfg.streamIdleMs,
      send: async (delta, finish) => {
        if (buffered) {
          content += delta;
          if (content.length > 64000) throw new Error('QQ reply exceeds 64000 characters');
          if (finish && content) await this.enqueue(() => this.execute('send', { ...options, content }));
          return;
        }
        let result: string | ToolOutcome;
        try { result = await this.enqueue(() => this.execute('stream', streamId
          ? { target: destination, streamId, content: delta, finish }
          : { ...options, content: delta, finish })); }
        catch (error) {
          if (!streamId && (args.fallback ?? this.cfg.autoFallback) && error instanceof QQOfficialApiError
            && error.rejected && [404, 405].includes(error.status)) {
            buffered = true; content = delta;
            await this.push('notice', destination, { eventType: 'REPLY_STREAM_BUFFERED', reason: `HTTP ${error.status}` });
            if (finish && content) await this.enqueue(() => this.execute('send', { ...options, content }));
            return;
          }
          throw error;
        }
        const receipt = JSON.parse(String(result).slice(String(result).indexOf('\n') + 1)) as JsonObject;
        streamId = String(receipt.streamId);
      },
      error: error => {
        this.host?.log.warn('qqofficial.stream.failed', { error: String(error) });
        if (this.host) void this.push('notice', destination, { eventType: 'REPLY_STREAM_FAILED', error: String(error), streamId,
          instruction: 'Some content may already be visible. Do not resend the complete reply.' }, true).catch(() => {});
      },
    });
    return JSON.stringify({ target: destination, streaming: !buffered,
      instruction: 'Your next model round public response text will be sent to this QQ target automatically. Do not call another send tool for the same text. Reasoning and tool arguments are excluded. The reply closes at round end, abort or idle timeout.' });
  }

  webUi(language?: Language): WorldWebUiDecl {
    const t = qqOfficialText(language);
    return {
      label: 'QQ Official',
      lamps: [{ label: t.connection, state: this.state === 'connecting' ? 'loading' : this.state, hint: this.detail || t[this.state] }],
      // A dedicated configuration panel keeps secret writes out of the generic config JSON.
      panels: [{ id: 'connection', title: t.connectionTab }, { id: 'configuration', title: t.configTab }],
      invoke: (panel, method, args) => {
        if (panel !== 'connection' && panel !== 'configuration') return Promise.reject(new Error('Unknown panel'));
        const task = this.control.then(async () => {
          if (method === 'state') {
            const state = { appId: this.cfg.appId, secretSet: !!this.options.context.secret(QQOFFICIAL_SECRET),
              enabled: this.cfg.enabled, status: this.state, detail: this.detail, binding: this.binding.current(), text: t };
            if (panel === 'connection') return state;
            const group = qqOfficialConfigGroup(language);
            const root = { worlds: { qqofficial: this.cfg } };
            return { ...state, group, values: Object.fromEntries(Object.keys(group.schema.properties).map((key) => [key, getByPath(root, key)])) };
          }
          if (panel === 'configuration') {
            if (method !== 'save') throw new Error('Unknown method');
            const data = object(args[0]);
            const result = coerceGroupValues(qqOfficialConfigGroup(language), object(data.values), language);
            if ('error' in result) throw new Error(result.error);
            const next = structuredClone(this.cfg);
            const root = { worlds: { qqofficial: next } };
            for (const [key, value] of Object.entries(result.values)) setByPath(root, key, value);
            validateConfig(next);
            const secret = typeof data.secret === 'string' ? data.secret : '';
            if (next.appId !== this.cfg.appId || secret) this.saveCredentials(string(next.appId, 'AppID'), secret);
            this.options.context.persist(next);
            this.binding.clear();
            const connectionError = next.enabled ? await this.connect() : undefined;
            return { message: t.configSaved, connectionError };
          }
          if (method === 'bind') return this.binding.start();
          if (method === 'poll') {
            const result = await this.binding.poll();
            if (result.kind !== 'bound') return { kind: result.kind, message: t[result.kind] };
            this.saveCredentials(result.appId, result.secret);
            this.binding.clear();
            return { kind: 'bound', appId: result.appId, connectionError: await this.connect() };
          }
          if (method === 'cancel') {
            this.binding.clear();
            return {};
          }
          if (method === 'connect') return { connectionError: await this.connect() };
          throw new Error('Unknown method');
        });
        this.control = task.catch(() => undefined);
        return task;
      },
      promptDocs: [{ key: 'worlds.qqofficial.envPrompt', title: t.promptTitle, description: t.promptDescription,
        role: 'envPrompt', path: fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url)),
        vars: [{ name: 'qqofficial.environment', description: t.promptDescription, multiline: true }] }],
    };
  }

  private async connect(): Promise<string | undefined> {
    try {
      string(this.cfg.appId, 'AppID');
      string(this.options.context.secret(QQOFFICIAL_SECRET), 'AppSecret');
      this.options.context.persist({ enabled: true });
      await this.options.context.restart();
    }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  }

  private saveCredentials(appId: string, secret: string): void {
    if (/[\r\n]/.test(appId + secret)) throw new Error('Credentials must occupy one line');
    if (!secret && (appId !== this.cfg.appId || !this.options.context.secret(QQOFFICIAL_SECRET))) throw new Error('AppSecret required');
    if (secret) this.options.context.storeSecret(QQOFFICIAL_SECRET, secret);
    this.options.context.persist({ appId });
  }
}
