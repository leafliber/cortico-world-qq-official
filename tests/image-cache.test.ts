import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ImageCache, MAX_IMAGE_CACHE_ENTRIES, type ImageCachePolicy } from '../src/image-cache.ts';

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
  it('does not rewrite an unchanged index on periodic pruning or restart', async () => {
    await cache.put(id(1), png, 'image/png');
    const original = await stat(join(dir, 'index.json'));
    await cache.prune(); await cache.prune();
    cache = new ImageCache(root, () => policy); await cache.init();
    const current = await stat(join(dir, 'index.json'));
    expect(current.ino).toBe(original.ino);
    expect(current.mtimeMs).toBe(original.mtimeMs);
  });

  it('bounds the number of small images on load and write, keeping the index reloadable', async () => {
    policy.maxBytes = 1024 * 1024 * 1024;
    await cache.put(id(1), png, 'image/png');
    const entry = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8'))[id(1)];
    const count = MAX_IMAGE_CACHE_ENTRIES + 1;
    // Missing data files are checked lazily; retain real bytes at the eviction boundary.
    await writeFile(join(dir, id(count).slice(4) + '.bin'), png);
    await writeFile(join(dir, 'index.json'), JSON.stringify(Object.fromEntries(Array.from({ length: count }, (_, i) =>
      [id(i + 1), { ...entry, savedAt: entry.savedAt - count + i }]))));
    cache = new ImageCache(root, () => policy); await cache.init();
    let index = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8'));
    expect(Object.keys(index)).toHaveLength(MAX_IMAGE_CACHE_ENTRIES);
    expect(index).not.toHaveProperty(id(1));
    expect(await readdir(dir)).not.toContain(id(1).slice(4) + '.bin');
    await cache.put(id(count + 1), png, 'image/png');
    // Replacing an existing entry does not consume another slot.
    await cache.put(id(count + 1), png, 'image/png');
    index = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8'));
    expect(Object.keys(index)).toHaveLength(MAX_IMAGE_CACHE_ENTRIES);
    expect(index).not.toHaveProperty(id(2));
    expect(index).toHaveProperty(id(3));
    expect((await stat(join(dir, 'index.json'))).size).toBeLessThan(4 * 1024 * 1024);
    cache = new ImageCache(root, () => policy); await cache.init();
    expect((await cache.get(id(count)))?.bytes).toEqual(png);
    expect((await cache.get(id(count + 1)))?.bytes).toEqual(png);
  });

  it('leaves an oversized index and its image files intact instead of deleting them as orphans', async () => {
    await cache.put(id(1), png, 'image/png');
    const index = ' '.repeat(4 * 1024 * 1024) + await readFile(join(dir, 'index.json'), 'utf8');
    await writeFile(join(dir, 'index.json'), index);
    cache = new ImageCache(root, () => policy);
    await expect(cache.init()).rejects.toThrow('Oversized image cache index');
    expect(await readFile(join(dir, 'index.json'), 'utf8')).toBe(index);
    expect(await readFile(join(dir, id(1).slice(4) + '.bin'))).toEqual(png);
  });

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
