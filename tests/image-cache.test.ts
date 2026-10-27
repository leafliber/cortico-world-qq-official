import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ImageCache, type ImageCachePolicy } from '../src/image-cache.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const id = (n: number) => `qqa:${String(n).padStart(40, '0')}`;
let root: string;
let dir: string;
let policy: ImageCachePolicy;
let cache: ImageCache;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'qq-image-cache-'));
  dir = join(root, 'qqofficial', 'image-cache');
  policy = { ttlMs: 86400000, maxBytes: png.length * 2, maxFileBytes: png.length };
  cache = new ImageCache(root, () => policy);
  await cache.init();
});
afterEach(async () => { await cache.flush(); await rm(root, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe('temporary image persistence', () => {
  it('loads image bytes after restart and physically removes expired files when pruning', async () => {
    await cache.put(id(1), png, 'image/png');
    cache = new ImageCache(root, () => policy); await cache.init();
    expect((await cache.get(id(1)))?.bytes).toEqual(png);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + policy.ttlMs + 1);
    await cache.prune();
    expect(cache.status(id(1)).cacheStatus).toBe('remote');
    expect(await cache.get(id(1))).toBeUndefined();
    expect(await readdir(dir)).toEqual(['index.json']);
  });

  it('serializes concurrent writes, bounds total bytes, and honours disabled caching', async () => {
    await Promise.all([cache.put(id(1), png, 'image/png'), cache.put(id(2), png, 'image/png'), cache.put(id(3), png, 'image/png')]);
    expect(await cache.get(id(1))).toBeUndefined();
    expect((await cache.get(id(2)))?.bytes).toEqual(png);
    expect((await cache.get(id(3)))?.bytes).toEqual(png);
    expect((await readdir(dir)).filter(name => name.endsWith('.bin'))).toHaveLength(2);
    policy.maxBytes = 0;
    await cache.prune();
    expect(await readdir(dir)).toEqual(['index.json']);
  });

  it('discards damaged bytes, orphaned writes and malformed cache indexes without touching other files', async () => {
    await cache.put(id(1), png, 'image/png');
    const damaged = Buffer.from(png); damaged[damaged.length - 1] ^= 1;
    await writeFile(join(dir, id(1).slice(4) + '.bin'), damaged);
    expect(await cache.get(id(1))).toBeUndefined();
    await writeFile(join(dir, id(2).slice(4) + '.bin'), png);
    await writeFile(join(dir, 'notes.txt'), 'unrelated');
    await writeFile(join(dir, 'index.json'), '{incomplete');
    cache = new ImageCache(root, () => policy); await cache.init();
    expect((await readdir(dir)).sort()).toEqual(['index.json', 'notes.txt']);
  });

  it('does not claim persistence if the index commit fails', async () => {
    await rm(join(dir, 'index.json'));
    await mkdir(join(dir, 'index.json'));
    await expect(cache.put(id(1), png, 'image/png')).rejects.toThrow();
    expect(cache.status(id(1)).cacheStatus).toBe('remote');
    expect(await cache.get(id(1))).toBeUndefined();
    expect((await readdir(dir)).filter(name => name.endsWith('.bin'))).toEqual([]);
  });
});
