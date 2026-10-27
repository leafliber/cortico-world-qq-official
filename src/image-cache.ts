import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ATTACHMENT_ID } from './attachments.ts';

interface CachedImage { mime: string; size: number; savedAt: number; digest: string; }
export interface ImageCachePolicy { ttlMs: number; maxBytes: number; maxFileBytes: number; }

/** Only ordinary raster images are prefetched/cached; MIME headers alone are not sufficient. */
export function imageMime(bytes: Uint8Array): string | undefined {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString())) return 'image/gif';
  if (b.length >= 12 && b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (b.length >= 14 && b.subarray(0, 2).toString() === 'BM') return 'image/bmp';
  return undefined;
}

/** Disposable deployment cache. Account-scoped attachment IDs live in the event archive. */
export class ImageCache {
  private dir?: string;
  private entries: Record<string, CachedImage> = {};
  private pending = Promise.resolve<unknown>(undefined);
  constructor(dataDir: string, private readonly policy: () => ImageCachePolicy) {
    if (dataDir) this.dir = join(dataDir, 'qqofficial', 'image-cache');
  }
  get enabled(): boolean { return !!this.dir && this.policy().ttlMs > 0 && this.policy().maxBytes > 0; }
  private file(id: string) {
    if (!this.dir || !ATTACHMENT_ID.test(id)) throw new Error('Invalid image cache reference');
    return join(this.dir, id.slice(4) + '.bin');
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.pending.then(fn); this.pending = task.catch(() => undefined); return task;
  }
  private async atomic(path: string, bytes: Uint8Array | string) {
    const temp = `${path}.${randomUUID()}.tmp`;
    try { await writeFile(temp, bytes, { mode: 0o600 }); await rename(temp, path); }
    finally { await rm(temp, { force: true }); }
  }
  private async save() { if (this.dir) await this.atomic(join(this.dir, 'index.json'), JSON.stringify(this.entries)); }
  private async remove(id: string) { await rm(this.file(id), { force: true }); delete this.entries[id]; }

  async init(): Promise<void> {
    if (!this.dir) return;
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    try {
      const file = join(this.dir, 'index.json');
      if ((await stat(file)).size > 4 * 1024 * 1024) throw new Error('Oversized image cache index');
      const value: unknown = JSON.parse(await readFile(file, 'utf8'));
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [id, entry] of Object.entries(value)) {
          const e = entry as CachedImage;
          if (ATTACHMENT_ID.test(id) && e && /^[a-f0-9]{64}$/.test(e.digest) && /^image\/(png|jpeg|gif|webp|bmp)$/.test(e.mime)
            && Number.isSafeInteger(e.size) && e.size > 0 && Number.isFinite(e.savedAt) && e.savedAt <= Date.now()) this.entries[id] = e;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.entries = {};
    }
    // A crash between the data rename and index commit may leave an unreferenced file.
    for (const name of await readdir(this.dir)) {
      const match = /^([a-f0-9]{40})\.bin$/.exec(name);
      if ((match && !this.entries[`qqa:${match[1]}`]) || /^[a-f0-9]{40}\.bin\.[\da-f-]+\.tmp$/.test(name)
        || /^index\.json\.[\da-f-]+\.tmp$/.test(name)) await rm(join(this.dir, name), { force: true });
    }
    await this.prune();
  }

  private async trim(): Promise<void> {
    const policy = this.policy();
    for (const [id, e] of Object.entries(this.entries)) {
      if (!this.enabled || Date.now() - e.savedAt >= policy.ttlMs || e.size > policy.maxFileBytes) await this.remove(id);
    }
    let size = Object.values(this.entries).reduce((sum, e) => sum + e.size, 0);
    for (const [id, e] of Object.entries(this.entries).sort((a, b) => a[1].savedAt - b[1].savedAt)) {
      if (size <= policy.maxBytes) break;
      await this.remove(id); size -= e.size;
    }
  }
  prune(): Promise<void> { return this.serial(async () => { if (this.dir) { await this.trim(); await this.save(); } }); }
  async flush(): Promise<void> { await this.pending; }

  status(id: string): { cacheStatus: 'cached' | 'remote'; cachedUntil?: string } {
    const e = this.entries[id], p = this.policy();
    return e && this.enabled && e.size <= Math.min(p.maxFileBytes, p.maxBytes) && e.savedAt + p.ttlMs > Date.now()
      ? { cacheStatus: 'cached', cachedUntil: new Date(e.savedAt + p.ttlMs).toISOString() } : { cacheStatus: 'remote' };
  }

  get(id: string): Promise<{ bytes: Buffer; mime: string } | undefined> {
    return this.serial(async () => {
      if (!this.entries[id]) return undefined;
      if (this.status(id).cacheStatus !== 'cached') { await this.remove(id); await this.save(); return undefined; }
      const e = this.entries[id];
      try {
        if ((await stat(this.file(id))).size !== e.size) throw new Error('Image cache size mismatch');
        const bytes = await readFile(this.file(id));
        if (imageMime(bytes) !== e.mime || createHash('sha256').update(bytes).digest('hex') !== e.digest) throw new Error('Invalid cached image');
        return { bytes, mime: e.mime };
      } catch { await this.remove(id); await this.save(); return undefined; }
    });
  }

  put(id: string, bytes: Buffer, mime: string): Promise<void> {
    return this.serial(async () => {
      const p = this.policy();
      if (!this.enabled || bytes.length > Math.min(p.maxBytes, p.maxFileBytes) || imageMime(bytes) !== mime) return;
      await this.trim();
      // Make space before writing, so the byte budget also bounds the temporary disk footprint.
      let size = Object.entries(this.entries).reduce((sum, [key, e]) => sum + (key === id ? 0 : e.size), 0);
      for (const [key, e] of Object.entries(this.entries).sort((a, b) => a[1].savedAt - b[1].savedAt)) {
        if (size + bytes.length <= p.maxBytes) break;
        if (key !== id) { await this.remove(key); size -= e.size; }
      }
      if (this.entries[id]) await this.remove(id);
      try {
        await this.atomic(this.file(id), bytes);
        this.entries[id] = { mime, size: bytes.length, savedAt: Date.now(), digest: createHash('sha256').update(bytes).digest('hex') };
        await this.save();
      } catch (error) {
        delete this.entries[id];
        await rm(this.file(id), { force: true }).catch(() => undefined);
        throw error;
      }
    });
  }
}
