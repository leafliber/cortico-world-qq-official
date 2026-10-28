import { afterEach, describe, expect, it } from 'vitest';
import { AttachmentDownloadError, readAttachment } from '../src/media.ts';
import { httpServer } from './helpers.ts';
import { publicAddress, publicMedia, mediaBlobHandle } from '../src/media-source.ts';

let server: Awaited<ReturnType<typeof httpServer>> | undefined;
afterEach(async () => { await server?.close(); server = undefined; });
const options = () => ({ maxBytes: 8, timeoutMs: 1000, signal: new AbortController().signal, testOrigin: server?.url });

describe('attachment transport', () => {
  it('normalizes scheme-less QQ attachment URLs', async () => {
    server = await httpServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end('image'); });
    expect((await readAttachment('qpic.cn/image', options())).bytes.toString()).toBe('image');
  });
  it('rejects private, credential-bearing and deceptive hosts before making a request', async () => {
    const urls = ['http://qpic.cn/a', 'https://127.0.0.1/a', 'https://qpic.cn.example.invalid/a', 'https://user:password@qpic.cn/a', 'https://qpic.cn:8080/a'];
    for (const url of [...urls, 'not a URL']) {
      const result = readAttachment(url, options());
      await expect(result).rejects.toBeInstanceOf(AttachmentDownloadError);
      await expect(result).rejects.toMatchObject({ code: 'URL_REJECTED' });
    }
  });

  it('follows CDN redirects and refuses redirects to a private host', async () => {
    server = await httpServer((req, res) => {
      if (req.url === '/image') { res.writeHead(200, { 'Content-Type': 'image/png; charset=binary' }); res.end('image'); }
      else { res.writeHead(302, { Location: req.url === '/safe' ? 'https://qpic.cn/image' : 'https://127.0.0.1/private' }); res.end(); }
    });
    expect(await readAttachment('https://qpic.cn/safe', options())).toEqual({ bytes: Buffer.from('image'), mime: 'image/png' });
    await expect(readAttachment('https://qpic.cn/unsafe', options())).rejects.toMatchObject({ code: 'URL_REJECTED' });
  });

  it('enforces size limits for declared and chunked bodies and bounds redirect loops', async () => {
    server = await httpServer((req, res) => {
      if (req.url === '/loop') { res.writeHead(302, { Location: '/loop' }); res.end(); }
      else if (req.url === '/declared') { res.writeHead(200, { 'Content-Length': '9' }); res.end('123456789'); }
      else { res.writeHead(200); res.write('12345'); res.end('6789'); }
    });
    for (const path of ['/declared', '/chunked']) await expect(readAttachment(`https://qpic.cn${path}`, options())).rejects.toMatchObject({ code: 'TOO_LARGE' });
    await expect(readAttachment('https://qpic.cn/loop', options())).rejects.toMatchObject({ code: 'REDIRECT_ERROR' });
  });

  it('returns typed HTTP, malformed redirect and empty-response errors', async () => {
    server = await httpServer((req, res) => {
      if (req.url === '/expired') res.writeHead(403);
      else if (req.url === '/empty') res.writeHead(204);
      else if (req.url === '/bad-location') res.writeHead(302, { Location: 'http://[' });
      else res.writeHead(302);
      res.end();
    });
    await expect(readAttachment('https://qpic.cn/expired', options())).rejects.toMatchObject({ code: 'HTTP_ERROR', httpStatus: 403 });
    await expect(readAttachment('https://qpic.cn/empty', options())).rejects.toMatchObject({ code: 'EMPTY_RESPONSE' });
    await expect(readAttachment('https://qpic.cn/bad-location', options())).rejects.toMatchObject({ code: 'URL_REJECTED' });
    await expect(readAttachment('https://qpic.cn/no-location', options())).rejects.toMatchObject({ code: 'REDIRECT_ERROR' });
  });
});

describe('host attachments and public media sources', () => {
  it('rejects local, mapped, link-local and private addresses before download', async () => {
    for (const ip of ['127.0.0.1', '10.1.1.1', '169.254.169.254', '172.16.1.1', '192.168.1.1', '::1', '::ffff:127.0.0.1', 'fd00::1', 'fe80::1']) expect(publicAddress(ip)).toBe(false);
    expect(publicAddress('8.8.8.8')).toBe(true);
    expect(publicAddress('2606:4700:4700::1111')).toBe(true);
    await expect(publicMedia('http://127.0.0.1/secret', 100, 1000, new AbortController().signal)).rejects.toThrow('non-public');
  });
  it('accepts host attachment identifiers without interpreting them as local paths', () => {
    for (const handle of ['log:12345678', 'log:0123456789abcdef0123.png', 'mem:voice', 'mem:images/abc-123.png']) {
      expect(mediaBlobHandle(handle)).toBe(handle);
    }
  });
});
