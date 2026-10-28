import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventEnvelope, ToolOutcome } from 'cortico/core/types.ts';
import { WakeBus } from 'cortico/core/bus.ts';
import { QQOfficialWorld } from '../src/world.ts';
import { QQOFFICIAL_DEFAULTS, QQOFFICIAL_SECRET } from '../src/config.ts';
import { TestHost, context, httpServer, json, SECRET, signedHeaders } from './helpers.ts';
import { AttachmentIndex } from '../src/attachments.ts';
import * as media from '../src/media.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const otherPng = Buffer.concat([png, Buffer.from('second-image')]);
const picture = (name = 'one', extra = {}) => ({ url: `https://multimedia.nt.qq.com.cn/${name}.png`, filename: `${name}.png`, content_type: 'image/png', ...extra });
let host: TestHost;
let world: QQOfficialWorld;
let ctx: ReturnType<typeof context>;
let api: Awaited<ReturnType<typeof httpServer>>;
let callback: string;
let downloads: string[];
let remoteStatus: number;
let releaseDownload: (() => void) | undefined;
let downloadGate: Promise<void> | undefined;

async function start() {
  world = new QQOfficialWorld({ context: ctx.value, endpoints: { mediaOrigin: api.url } });
  await world.start(host);
  callback = `http://${world.webUi().lamps![0].hint}`;
}
async function incoming(id: string, data: Record<string, unknown> = {}, eventType = 'GROUP_AT_MESSAGE_CREATE') {
  const body = JSON.stringify({ op: 0, t: eventType, id: `event-${id}`, d: { id, group_openid: 'group', content: id, ...data } });
  return fetch(callback, { method: 'POST', body, headers: signedHeaders(body) });
}
async function tool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string | ToolOutcome> {
  return world.tools().find(t => t.name === `qqofficial_${name}`)!.handler(args, { role: 'test', log: host.log, signal });
}
async function history() { return JSON.parse(await tool('history', { messagesOnly: true, limit: 100 }) as string) as EventEnvelope[]; }
async function refs(id: string) { return ((await history()).find(e => e.meta?.messageId === id)!.meta!.attachmentRefs ?? []) as Array<Record<string, any>>; }
async function cached(id: string) { await vi.waitFor(async () => expect((await refs(id)).every(r => r.cacheStatus === 'cached')).toBe(true)); }
async function read(args: Record<string, unknown>, signal?: AbortSignal) { return await tool('read_attachment', args, signal) as ToolOutcome; }
function bytes(out: ToolOutcome) {
  expect(out.failed, out.text).not.toBe(true);
  const blob = out.blobs![0];
  return 'bytes' in blob ? Buffer.from(blob.bytes) : Buffer.alloc(0);
}

beforeEach(async () => {
  host = new TestHost(undefined, 'r-20261024-000000-0001');
  downloads = []; remoteStatus = 200; releaseDownload = undefined; downloadGate = undefined;
  api = await httpServer(async (req, res) => {
    downloads.push(req.url!);
    expect(req.headers.authorization).toBeUndefined();
    expect(req.headers['x-union-appid']).toBeUndefined();
    await downloadGate;
    if (remoteStatus !== 200 || req.url!.includes('rkey=expired')) { json(res, { error: 'expired' }, remoteStatus === 200 ? 403 : remoteStatus); return; }
    // QQ/CDN occasionally sends a generic MIME; sniff the downloaded raster image.
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(req.url!.startsWith('/two.png') ? otherPng : png);
  });
  ctx = context({ appId: 'application', transport: 'webhook', webhook: { ...QQOFFICIAL_DEFAULTS.webhook, port: 0 } });
  Object.assign(ctx.value, { dataDir: host.dataDir });
  ctx.secrets.set(QQOFFICIAL_SECRET, SECRET);
  await start();
});
afterEach(async () => {
  releaseDownload?.();
  await world?.stop(); await api?.close(); host?.close();
  vi.restoreAllMocks();
});

describe('durable attachment recovery', () => {
  it('enriches an empty first delivery, keeping the original cursor and archiving only one supplement', async () => {
    await incoming('enriched');
    const original = (await history())[0];
    expect((await incoming('enriched', { attachments: [picture()] })).status).toBe(200);
    await cached('enriched');
    const [ref] = await refs('enriched');
    expect(ref).toMatchObject({ cursor: original.cursor, index: 0, contentType: 'image/png', cacheStatus: 'cached' });
    expect(bytes(await read({ cursor: original.cursor, index: 0 }))).toEqual(png);
    expect(bytes(await read({ attachmentId: ref.attachmentId }))).toEqual(png);
    expect((host.store.get(original.cursor)!.meta!.data as any).attachments).toBeUndefined();
    expect(((await history())[0].meta!.data as any).attachments).toEqual([picture()]);
    expect(host.pushes.filter(p => p.options?.deliver && p.options.trigger !== 'piggyback')).toHaveLength(1);
    const supplements = host.pushes.filter(p => p.event.type === 'qqofficial.attachments');
    expect(supplements).toHaveLength(1);
    expect(supplements[0].options).toMatchObject({ deliver: true, trigger: 'piggyback' });
    await incoming('enriched', { attachments: [picture()] });
    expect(host.pushes.filter(p => p.event.type === 'qqofficial.attachments')).toHaveLength(1);
  });

  it('queues only new references for the next normal wakeup and archives URL refreshes silently', async () => {
    ctx.value.cfg.imageCacheTtlMs = 0;
    // A normal event delivers immediately, so a wrongly scheduled supplement would also wake.
    const bus = new WakeBus({ quietGapMs: 0, minBatchAgeMs: 0, maxBatchAgeMs: 0, maxBatchSize: 1 });
    const append = host.pushEvent.bind(host);
    vi.spyOn(host, 'pushEvent').mockImplementation(async (event, options) => {
      const saved = await append(event, options);
      if (options?.deliver) bus.push({ event: saved }, options);
      return saved;
    });
    await incoming('piggyback');
    expect(bus.takeIfReady()?.map(item => item.event?.type)).toEqual(['qqofficial.message']);
    await incoming('piggyback', { attachments: [picture()] });
    const [first] = await refs('piggyback');
    expect(bus.pending()).toBe(1);
    expect(bus.pendingImmediate()).toBe(0);
    expect(bus.takeIfReady()).toBeNull();
    await incoming('piggyback', { attachments: [picture('one', { url: picture().url + '?rkey=new' })] });
    expect(host.pushes.at(-1)?.options?.deliver).toBe(false);
    expect(bus.pending()).toBe(1);
    await incoming('piggyback', { attachments: [picture(), picture('two')] });
    const all = await refs('piggyback');
    expect(bus.pending()).toBe(2);
    expect(bus.takeIfReady()).toBeNull();
    await incoming('can-you-see-it');
    const batch = bus.takeIfReady()!.map(item => item.event!);
    expect(batch.map(event => event.type)).toEqual(['qqofficial.attachments', 'qqofficial.attachments', 'qqofficial.message']);
    const notices = batch.slice(0, 2).map(event => JSON.parse(event.text.slice(event.text.indexOf('\n') + 1)));
    expect(notices.map(notice => notice.attachmentRefs.map((ref: any) => ref.attachmentId))).toEqual([[first.attachmentId], [all[1].attachmentId]]);
    expect(notices[0]).toMatchObject({ messageCursor: first.cursor, messageId: 'piggyback' });
    expect(notices.every(notice => !('entries' in notice))).toBe(true);
    expect(batch[0].meta!.entries).toHaveLength(1);
    expect(batch[1].meta!.entries).toHaveLength(2);
  });

  it('merges channel event variants for one message while retaining the first event type and separating targets', async () => {
    await incoming('channel-message', { channel_id: 'channel' }, 'AT_MESSAGE_CREATE');
    await incoming('channel-message', { channel_id: 'channel', attachments: [picture()] }, 'MESSAGE_CREATE');
    await incoming('channel-message', { channel_id: 'other-channel' }, 'MESSAGE_CREATE');
    const events = await history();
    expect(events).toHaveLength(2);
    expect(events[0].meta).toMatchObject({ eventType: 'AT_MESSAGE_CREATE', target: { kind: 'channel', id: 'channel' } });
    expect(events[0].meta!.attachmentRefs).toHaveLength(1);
    expect(events[1].meta).toMatchObject({ eventType: 'MESSAGE_CREATE', target: { kind: 'channel', id: 'other-channel' } });
    expect(events[1].meta).not.toHaveProperty('attachmentRefs');
  });

  it('never drops a saved image on 27 sparse duplicates or repeated delayed reads', async () => {
    await incoming('image', { attachments: [picture()] });
    await Promise.all(Array.from({ length: 27 }, () => incoming('image', { attachments: [] })));
    await cached('image');
    const [ref] = await refs('image');
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 20000);
    for (let i = 0; i < 30; i++) await incoming(`text-${i}`);
    remoteStatus = 403;
    expect(bytes(await read({ cursor: ref.cursor, index: 0 }))).toEqual(png);
    expect(bytes(await read({ attachmentId: ref.attachmentId }))).toEqual(png);
    expect(host.pushes.filter(p => p.event.meta?.messageId === 'image')).toHaveLength(1);
    expect(downloads).toEqual(['/one.png']);
  });

  it('preserves existing indices when duplicates reorder or add images and refresh signed URLs', async () => {
    await incoming('union', { attachments: [picture('one', { url: picture().url + '?rkey=old&fileid=first' })] });
    await cached('union');
    const [first] = await refs('union');
    await incoming('union', { attachments: [picture('two'), picture('one', { url: picture().url + '?fileid=first&rkey=new' })] });
    await cached('union');
    const all = await refs('union');
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ attachmentId: first.attachmentId, index: 0 });
    expect(all[1].index).toBe(1);
    expect(bytes(await read({ cursor: first.cursor, index: 0 }))).toEqual(png);
    expect(bytes(await read({ cursor: first.cursor, index: 1 }))).toEqual(otherPng);
    expect(((await history())[0].meta!.data as any).attachments[0].url).toContain('rkey=new');
  });

  it('discovers direct and nested quoted images and supports both durable IDs and quoted paths', async () => {
    await incoming('quote');
    await incoming('quote', { msg_elements: [{ attachments: [picture()], msg_elements: [{}, { attachments: [picture('two')] }] }] });
    await cached('quote');
    const [direct, nested] = await refs('quote');
    expect(direct).toMatchObject({ quotedIndex: 0, quotedPath: [0], index: 0 });
    expect(nested).toMatchObject({ quotedPath: [0, 1], index: 0 });
    expect(bytes(await read({ cursor: direct.cursor, index: 0, quotedIndex: 0 }))).toEqual(png);
    expect(bytes(await read({ cursor: nested.cursor, index: 0, quotedPath: [0, 1] }))).toEqual(otherPng);
    expect(bytes(await read({ attachmentId: nested.attachmentId }))).toEqual(otherPng);
  });

  it('restores supplemented IDs and cached image bytes across a real event-store/run reload with QQ unavailable', async () => {
    await incoming('restart');
    await incoming('restart', { attachments: [picture()] });
    await cached('restart');
    const [ref] = await refs('restart');
    await world.stop();
    host = new TestHost(host.dataDir, 'r-20261028-000000-0002');
    remoteStatus = 403;
    await start();
    const [restored] = await refs('restart');
    expect(restored.attachmentId).toBe(ref.attachmentId);
    expect(bytes(await read({ attachmentId: ref.attachmentId }))).toEqual(png);
    expect(bytes(await read({ cursor: ref.cursor, index: 0 }))).toEqual(png);
    await incoming('restart');
    expect(host.pushes).toHaveLength(0);
    expect(downloads).toEqual(['/one.png']);
  });

  it('does not acknowledge a failed supplement write or lose the richer retry', async () => {
    await incoming('retry');
    const append = host.pushEvent.bind(host);
    let fail = true;
    vi.spyOn(host, 'pushEvent').mockImplementation(async (event, options) => {
      if (event.type === 'qqofficial.attachments' && fail) { fail = false; throw new Error('disk full'); }
      return append(event, options);
    });
    expect((await incoming('retry', { attachments: [picture()] })).status).toBe(503);
    expect(await refs('retry')).toEqual([]);
    expect((await incoming('retry', { attachments: [picture()] })).status).toBe(200);
    await cached('retry');
    expect(bytes(await read({ attachmentId: (await refs('retry'))[0].attachmentId }))).toEqual(png);
  });

  it('acknowledges the message while prefetch is blocked and coalesces an explicit read with that download', async () => {
    downloadGate = new Promise(resolve => { releaseDownload = resolve; });
    expect((await incoming('slow', { attachments: [picture()] })).status).toBe(200);
    await vi.waitFor(() => expect(downloads).toHaveLength(1));
    const pending = read({ attachmentId: (await refs('slow'))[0].attachmentId });
    releaseDownload!();
    expect(bytes(await pending)).toEqual(png);
    expect(downloads).toHaveLength(1);
  });

  it('cancels a tool waiting on prefetch without cancelling background image preservation', async () => {
    downloadGate = new Promise(resolve => { releaseDownload = resolve; });
    await incoming('cancel', { attachments: [picture()] });
    await vi.waitFor(() => expect(downloads).toHaveLength(1));
    const [ref] = await refs('cancel');
    const controller = new AbortController();
    const pending = read({ attachmentId: ref.attachmentId }, controller.signal);
    await Promise.resolve(); await Promise.resolve();
    controller.abort();
    expect(JSON.parse((await pending).text).code).toBe('ATTACHMENT_READ_CANCELLED');
    releaseDownload!();
    await cached('cancel');
    expect(bytes(await read({ attachmentId: ref.attachmentId }))).toEqual(png);
    expect(downloads).toHaveLength(1);
  });

  it.each(['reader', 'prefetch'] as const)('retries for an uncancelled %s that joined a cancelled user download', async joiner => {
    ctx.value.cfg.imageCacheTtlMs = 0;
    await incoming('cancel-owner', { attachments: [picture()] });
    const [ref] = await refs('cancel-owner');
    // Keep the owner download alive after its waiter cancels, as a network request can be.
    const gate = new Promise<void>(resolve => { releaseDownload = resolve; });
    const fetch = vi.spyOn(media, 'readAttachment').mockImplementationOnce(async (_url, options) => {
      await gate;
      options.signal.throwIfAborted();
      throw new Error('Owner must have been cancelled');
    });
    const starts = vi.spyOn(world as any, 'downloadAttachment');
    const controller = new AbortController();
    const first = read({ attachmentId: ref.attachmentId }, controller.signal);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    let second: Promise<ToolOutcome> | undefined;
    if (joiner === 'reader') second = read({ attachmentId: ref.attachmentId });
    else {
      ctx.value.cfg.imageCacheTtlMs = QQOFFICIAL_DEFAULTS.imageCacheTtlMs;
      await incoming('cancel-owner', { attachments: [picture()] });
    }
    controller.abort();
    expect(JSON.parse((await first).text).code).toBe('ATTACHMENT_READ_CANCELLED');
    await vi.waitFor(() => expect(starts).toHaveBeenCalledTimes(2));
    releaseDownload!();
    if (second) expect(bytes(await second)).toEqual(png);
    else { await cached('cancel-owner'); expect(bytes(await read({ attachmentId: ref.attachmentId }))).toEqual(png); }
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('retries a refreshed duplicate URL when the previous download is still failing', async () => {
    downloadGate = new Promise(resolve => { releaseDownload = resolve; });
    await incoming('refreshed', { attachments: [picture('one', { url: picture().url + '?rkey=expired' })] });
    await vi.waitFor(() => expect(downloads).toHaveLength(1));
    const [ref] = await refs('refreshed');
    await incoming('refreshed', { attachments: [picture('one', { url: picture().url + '?rkey=fresh' })] });
    releaseDownload!();
    await cached('refreshed');
    expect((await refs('refreshed'))[0].attachmentId).toBe(ref.attachmentId);
    expect(bytes(await read({ attachmentId: ref.attachmentId }))).toEqual(png);
    expect(downloads).toEqual(['/one.png?rkey=expired', '/one.png?rkey=fresh']);
  });

  it('lets an explicit read use its larger limit after a shared prefetch hits the image limit', async () => {
    const gate = new Promise<void>(resolve => { releaseDownload = resolve; });
    const fetch = vi.spyOn(media, 'readAttachment').mockImplementationOnce(async () => {
      await gate;
      throw new media.AttachmentDownloadError('TOO_LARGE', 'Image exceeds the prefetch limit');
    });
    await incoming('large', { attachments: [picture()] });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const pending = read({ attachmentId: (await refs('large'))[0].attachmentId });
    await Promise.resolve(); await Promise.resolve();
    releaseDownload!();
    expect(bytes(await pending)).toEqual(png);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][1].maxBytes).toBe(30 * 1024 * 1024);
    expect(fetch.mock.calls[1][1].maxBytes).toBe(ctx.value.cfg.maxMediaBytes);
  });
});

describe('attachment diagnostics and cache limits', () => {
  it('keeps tool schemas compatible with providers that reject top-level combinators', () => {
    for (const tool of world.tools()) {
      expect(tool.parameters).toMatchObject({ type: 'object' });
      for (const key of ['anyOf', 'oneOf', 'allOf']) expect(tool.parameters).not.toHaveProperty(key);
    }
    expect(world.tools().find(t => t.name === 'qqofficial_read_attachment')!.parameters.required).toEqual([]);
  });

  it('omits empty reference lists and fills missing quoted positions without sparse array nulls', async () => {
    await incoming('plain');
    expect((await history())[0].meta).not.toHaveProperty('attachmentRefs');
    await incoming('plain', { msg_elements: [{}, {}, { msg_elements: [{}, { attachments: [picture()] }] }] });
    const data = (await history())[0].meta!.data as any;
    expect(data.msg_elements).toEqual([{}, {}, { msg_elements: [{}, { attachments: [picture()] }] }]);
    const [ref] = await refs('plain');
    expect(ref.quotedPath).toEqual([2, 1]);
    expect(bytes(await read({ cursor: ref.cursor, index: 0, quotedPath: [2, 1] }))).toEqual(png);
  });

  it('distinguishes cursor, source, event type, account, reference, quote and index errors', async () => {
    await incoming('diagnostics', { attachments: [picture()] });
    const [ref] = await refs('diagnostics');
    const external = await host.pushEvent({ type: 'console.message', source: 'console', ts: new Date().toISOString(), text: '' });
    const receipt = await host.pushEvent({ type: 'qqofficial.sent', source: 'qqofficial', ts: new Date().toISOString(), text: '', meta: { appId: 'application' } });
    const wrongAccount = await host.pushEvent({ type: 'qqofficial.message', source: 'qqofficial', ts: new Date().toISOString(), text: '', meta: { appId: 'other' } });
    for (const [args, code] of [
      [{}, 'ATTACHMENT_LOCATOR_INVALID'],
      [{ cursor: 999999, index: 0 }, 'MESSAGE_CURSOR_NOT_FOUND'],
      [{ cursor: external.cursor, index: 0 }, 'MESSAGE_SOURCE_MISMATCH'],
      [{ cursor: receipt.cursor, index: 0 }, 'MESSAGE_EVENT_TYPE_MISMATCH'],
      [{ cursor: wrongAccount.cursor, index: 0 }, 'MESSAGE_ACCOUNT_MISMATCH'],
      [{ cursor: ref.cursor, index: 9 }, 'ATTACHMENT_INDEX_NOT_FOUND'],
      [{ cursor: ref.cursor, index: 0, quotedIndex: 9 }, 'QUOTED_MESSAGE_NOT_FOUND'],
      [{ cursor: ref.cursor, index: 0, quotedIndex: 0, quotedPath: [0] }, 'ATTACHMENT_LOCATOR_INVALID'],
      [{ attachmentId: ref.attachmentId, cursor: ref.cursor }, 'ATTACHMENT_LOCATOR_INVALID'],
      [{ attachmentId: 'qqa:' + '0'.repeat(40) }, 'ATTACHMENT_REFERENCE_NOT_FOUND'],
      [{ attachmentId: '../../etc/passwd' }, 'ATTACHMENT_LOCATOR_INVALID'],
    ] as const) {
      const result = await read(args);
      expect(result.failed).toBe(true);
      expect(JSON.parse(result.text)).toMatchObject({ code });
      expect(result.text).not.toContain('delivery is unknown');
    }
    const badIndex = JSON.parse((await read({ cursor: ref.cursor, index: 9 })).text);
    expect(badIndex.available[0].attachmentId).toBe(ref.attachmentId);
    expect(await history()).toHaveLength(1);
  });

  it('expires cached images and reports remote failures without pretending bytes were retained forever', async () => {
    await incoming('expire', { attachments: [picture()] });
    await cached('expire');
    const [ref] = await refs('expire');
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + ctx.value.cfg.imageCacheTtlMs + 1);
    remoteStatus = 403;
    const result = await read({ attachmentId: ref.attachmentId });
    expect(result.failed).toBe(true);
    expect(JSON.parse(result.text)).toMatchObject({ code: 'ATTACHMENT_DOWNLOAD_FAILED', httpStatus: 403, cacheStatus: 'remote' });
    expect((await refs('expire'))[0].cacheStatus).toBe('remote');
  });

  it('enforces byte capacity and reduced per-file limits on already cached images', async () => {
    ctx.value.cfg.imageCacheMaxBytes = otherPng.length;
    await incoming('first', { attachments: [picture()] });
    await cached('first');
    await incoming('second', { attachments: [picture('two')] });
    await cached('second');
    expect((await refs('first'))[0].cacheStatus).toBe('remote');
    const [ref] = await refs('second');
    ctx.value.cfg.maxMediaBytes = otherPng.length - 1;
    const result = await read({ attachmentId: ref.attachmentId });
    expect(result.failed).toBe(true);
    expect(JSON.parse(result.text).code).toBe('ATTACHMENT_TOO_LARGE');
  });

  it.each([
    { error: new media.AttachmentDownloadError('URL_REJECTED', 'Rejected by URL policy'), code: 'ATTACHMENT_URL_REJECTED' },
    { error: new media.AttachmentDownloadError('TOO_LARGE', 'Size limit reached'), code: 'ATTACHMENT_TOO_LARGE' },
    { error: new media.AttachmentDownloadError('HTTP_ERROR', 'Remote token expired', 403), code: 'ATTACHMENT_DOWNLOAD_FAILED', httpStatus: 403 },
    { error: new Error('outside maxMediaBytes Attachment HTTP 403'), code: 'ATTACHMENT_DOWNLOAD_FAILED' },
  ])('uses typed transport failures for $code instead of parsing error text', async ({ error, code, httpStatus }) => {
    ctx.value.cfg.imageCacheTtlMs = 0;
    await incoming('typed-error', { attachments: [picture()] });
    const [ref] = await refs('typed-error');
    vi.spyOn(media, 'readAttachment').mockRejectedValueOnce(error);
    const result = JSON.parse((await read({ attachmentId: ref.attachmentId })).text);
    expect(result.code).toBe(code);
    expect(result.httpStatus).toBe(httpStatus);
  });

  it('isolates cached images and stable references after changing AppID', async () => {
    await incoming('account', { attachments: [picture()] });
    await cached('account');
    const [ref] = await refs('account');
    await world.stop(); ctx.value.cfg.appId = 'other'; await start();
    expect(JSON.parse((await read({ attachmentId: ref.attachmentId })).text).code).toBe('ATTACHMENT_REFERENCE_NOT_FOUND');
    expect(JSON.parse((await read({ cursor: ref.cursor, index: 0 })).text).code).toBe('MESSAGE_ACCOUNT_MISMATCH');
    expect(downloads).toHaveLength(1);
  });

  it('archives invalid and incomplete attachment metadata while returning precise read errors', async () => {
    await incoming('bad-url', { attachments: [picture('one', { url: 'https://127.0.0.1/private' })] });
    const [bad] = await refs('bad-url');
    expect(JSON.parse((await read({ attachmentId: bad.attachmentId })).text).code).toBe('ATTACHMENT_URL_REJECTED');
    await incoming('no-url', { attachments: [{ filename: 'one.png', content_type: 'image/png' }] });
    const [missing] = await refs('no-url');
    expect(JSON.parse((await read({ attachmentId: missing.attachmentId })).text).code).toBe('ATTACHMENT_URL_MISSING');
    await incoming('no-url', { attachments: [picture()] });
    await cached('no-url');
    expect((await refs('no-url'))[0].attachmentId).toBe(missing.attachmentId);
    expect(bytes(await read({ attachmentId: missing.attachmentId }))).toEqual(png);
  });

  it('does not prefetch audio/files, and can disable image caching without disabling reads', async () => {
    ctx.value.cfg.imageCacheTtlMs = 0;
    await incoming('uncached', { attachments: [picture(), { url: 'https://qpic.cn/report.pdf', filename: 'report.pdf', content_type: 'application/pdf' }] });
    const all = await refs('uncached');
    expect(downloads).toHaveLength(0);
    expect(bytes(await read({ attachmentId: all[0].attachmentId }))).toEqual(png);
    expect((await refs('uncached'))[0].cacheStatus).toBe('remote');
    ctx.value.cfg.imageCacheTtlMs = QQOFFICIAL_DEFAULTS.imageCacheTtlMs;
    await incoming('file', { attachments: [{ url: 'https://qpic.cn/report.pdf', filename: 'report.pdf', content_type: 'application/pdf' }] });
    expect(downloads).toHaveLength(1);
  });
});

describe('attachment identity', () => {
  it('never lets malformed fields on a sparse retry replace usable download metadata', () => {
    const index = new AttachmentIndex('app');
    const target = { kind: 'group' as const, id: 'group' };
    const original = picture('one', { id: 'image' });
    const first = index.merge(target, 'message', { attachments: [original] });
    const merged = index.merge(target, 'message', { attachments: [{ id: 'image', url: {}, filename: 0, content_type: false }] }, first);
    expect(merged).toEqual(first);
  });

  it('keeps content-selecting query parameters and sparse original indices distinct', () => {
    const index = new AttachmentIndex('app');
    const target = { kind: 'group' as const, id: 'group' };
    const first = index.merge(target, 'message', { attachments: [null, picture('one', { url: 'https://qpic.cn/download?fileid=1&rkey=a' })] });
    const merged = index.merge(target, 'message', { attachments: [picture('one', { url: 'https://qpic.cn/download?fileid=2&rkey=b' })] }, first);
    expect(merged).toHaveLength(2);
    expect(first[0].index).toBe(1);
    expect(merged[0].attachmentId).toBe(first[0].attachmentId);
    expect(merged[1].attachmentId).not.toBe(first[0].attachmentId);
  });
});
