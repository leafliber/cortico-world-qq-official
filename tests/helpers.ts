import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPrivateKey, sign } from 'node:crypto';
import { JsonlEventStore } from 'cortico/core/event-store.ts';
import { nullLogger } from 'cortico/core/util.ts';
import type { EventEnvelope, PushOptions, WorldHost } from 'cortico/core/types.ts';
import type { WorldContext } from 'cortico/world.ts';
import { QQOFFICIAL_DEFAULTS, type QQOfficialConfigSection } from '../src/config.ts';

export async function httpServer(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) {
  const server = createServer((req, res) => { void Promise.resolve(handler(req, res)).catch((error) => { res.writeHead(500); res.end(String(error)); }); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  return {
    server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    async close() { const closing = new Promise<void>((resolve) => server.close(() => resolve())); server.closeAllConnections(); await closing; },
  };
}

export async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString() || '{}') as Record<string, unknown>;
}

export function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body));
}

export class TestHost implements WorldHost {
  readonly dataDir: string;
  readonly store: JsonlEventStore;
  constructor(dataDir = mkdtempSync(join(tmpdir(), 'qqofficial-events-')), run = '20261024-000000') {
    this.dataDir = dataDir;
    this.store = new JsonlEventStore({ dataDir, run, timezone: 'UTC' });
  }
  readonly log = nullLogger();
  readonly pushes: Array<{ event: EventEnvelope; options?: PushOptions }> = [];
  readonly blobs = new Map<string, { bytes: Uint8Array; mime: string }>();
  modelFacts = { model: () => 'test', accepts: () => false, contextWindow: () => 128000 };
  async pushEvent(event: Parameters<WorldHost['pushEvent']>[0], options?: PushOptions) {
    const saved = this.store.append({ ...event, origin: event.origin ?? 'external', blobs: undefined });
    this.pushes.push({ event: saved, options });
    return saved;
  }
  pushDeferred(): void {}
  async drainPendingEvents(): Promise<EventEnvelope[]> { return []; }
  blob(handle: string) { return this.blobs.get(handle) ?? null; }
  reportUsage(): void {}
  close() { rmSync(this.dataDir, { recursive: true, force: true }); }
}

export function context(overrides: Partial<QQOfficialConfigSection> = {}) {
  const cfg = { ...structuredClone(QQOFFICIAL_DEFAULTS), proactiveIntervalMs: 0, streamIntervalMs: 0, ...overrides };
  const secrets = new Map<string, string>();
  const value: WorldContext<QQOfficialConfigSection> = {
    id: 'qqofficial', cfg, timezone: 'UTC', botName: 'test', botDir: '', packageDir: '', dataDir: '', repoRoot: '',
    secret: (name) => secrets.get(name) ?? '', storeSecret: (name, value) => { secrets.set(name, value); },
    persist: (patch) => { Object.assign(cfg, patch); }, restart: async () => {},
  };
  return { value, secrets };
}

export const SECRET = '0123456789abcdef0123456789abcdef';

export function signedHeaders(body: string, secret = SECRET) {
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(secret)]), format: 'der', type: 'pkcs8' });
  const timestamp = String(Math.floor(Date.now() / 1000));
  return { 'Content-Type': 'application/json', 'X-Signature-Timestamp': timestamp,
    'X-Signature-Ed25519': sign(null, Buffer.from(timestamp + body), key).toString('hex') };
}
