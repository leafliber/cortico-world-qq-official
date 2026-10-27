import type { Language } from 'cortico/core/language.ts';
import type { ConfigGroup } from 'cortico/core/types.ts';
import { qqOfficialText, QQOFFICIAL_DELIVERY_LABELS, QQOFFICIAL_CACHE_LABELS } from './strings.ts';
import { integer } from './protocol.ts';

export const QQOFFICIAL_ID = 'qqofficial';
export const QQOFFICIAL_SECRET = 'CORTICO_QQOFFICIAL_APP_SECRET';

export interface QQOfficialConfigSection {
  enabled: boolean;
  appId: string;
  transport: 'websocket' | 'webhook';
  sandbox: boolean;
  intents: number;
  webhook: { host: string; port: number; path: string; maxBodyBytes: number };
  timeoutMs: number;
  reconnectMs: number;
  maxReconnectMs: number;
  maxMediaBytes: number;
  imageCacheTtlMs: number;
  imageCacheMaxBytes: number;
  autoFallback: boolean;
  proactiveIntervalMs: number;
  streamIntervalMs: number;
  streamIdleMs: number;
  ffmpegPath: string;
  modelLanguage: 'zh' | 'en';
}

export const QQOFFICIAL_DEFAULTS: QQOfficialConfigSection = {
  enabled: false, appId: '', transport: 'websocket', sandbox: false,
  intents: 1 << 25,
  webhook: { host: '127.0.0.1', port: 6196, path: '/qqofficial/callback', maxBodyBytes: 1024 * 1024 },
  timeoutMs: 20000, reconnectMs: 1000, maxReconnectMs: 30000,
  maxMediaBytes: 100 * 1024 * 1024, modelLanguage: 'zh',
  imageCacheTtlMs: 24 * 60 * 60 * 1000, imageCacheMaxBytes: 256 * 1024 * 1024,
  autoFallback: true, proactiveIntervalMs: 3000, streamIntervalMs: 500, streamIdleMs: 15000, ffmpegPath: 'ffmpeg',
};

export function validateConfig(cfg: QQOfficialConfigSection): void {
  if (!['websocket', 'webhook'].includes(cfg.transport)) throw new Error('Invalid transport');
  if (!['zh', 'en'].includes(cfg.modelLanguage)) throw new Error('Invalid modelLanguage');
  integer(cfg.intents, 'intents', 0, 0x7fffffff);
  integer(cfg.timeoutMs, 'timeoutMs', 100, 300000);
  integer(cfg.reconnectMs, 'reconnectMs', 10, 300000);
  integer(cfg.maxReconnectMs, 'maxReconnectMs', cfg.reconnectMs, 300000);
  integer(cfg.maxMediaBytes, 'maxMediaBytes', 1, 100 * 1024 * 1024);
  integer(cfg.imageCacheTtlMs, 'imageCacheTtlMs', 0, 30 * 24 * 60 * 60 * 1000);
  integer(cfg.imageCacheMaxBytes, 'imageCacheMaxBytes', 0, 1024 * 1024 * 1024);
  if (typeof cfg.autoFallback !== 'boolean') throw new Error('Invalid autoFallback');
  integer(cfg.proactiveIntervalMs, 'proactiveIntervalMs', 0, 60000);
  integer(cfg.streamIntervalMs, 'streamIntervalMs', 0, 5000);
  integer(cfg.streamIdleMs, 'streamIdleMs', 100, 120000);
  if (typeof cfg.ffmpegPath !== 'string' || !cfg.ffmpegPath.trim() || /[\r\n\0]/.test(cfg.ffmpegPath)) throw new Error('Invalid ffmpegPath');
  integer(cfg.webhook.port, 'webhook.port', 0, 65535);
  integer(cfg.webhook.maxBodyBytes, 'webhook.maxBodyBytes', 1, 10 * 1024 * 1024);
  if (!cfg.webhook.host || !/^\/[\w/-]+$/.test(cfg.webhook.path)) throw new Error('Invalid webhook address');
}

export function qqOfficialConfigGroup(language?: Language): ConfigGroup {
  const t = qqOfficialText(language);
  const k = 'worlds.qqofficial';
  const labels = QQOFFICIAL_DELIVERY_LABELS[language ?? 'zh'];
  const cacheLabels = QQOFFICIAL_CACHE_LABELS[language ?? 'zh'];
  return {
    id: 'world:qqofficial', owner: 'world:qqofficial',
    schema: { type: 'object', title: t.settings, properties: {
      [`${k}.appId`]: { type: 'string', title: t.appId, 'x-hot': false },
      [`${k}.transport`]: { type: 'string', title: t.transport, enum: ['websocket', 'webhook'], 'x-hot': false },
      [`${k}.sandbox`]: { type: 'boolean', title: t.sandbox, 'x-hot': false },
      [`${k}.intents`]: { type: 'integer', title: t.intents, minimum: 0, maximum: 0x7fffffff, 'x-hot': false },
      [`${k}.webhook.host`]: { type: 'string', title: t.host, 'x-hot': false },
      [`${k}.webhook.port`]: { type: 'integer', title: t.port, minimum: 1, maximum: 65535, 'x-hot': false },
      [`${k}.webhook.path`]: { type: 'string', title: t.path, 'x-hot': false },
      [`${k}.webhook.maxBodyBytes`]: { type: 'integer', title: t.maxBodyBytes, minimum: 1, maximum: 10 * 1024 * 1024, 'x-hot': false },
      [`${k}.timeoutMs`]: { type: 'integer', title: t.timeoutMs, minimum: 100, maximum: 300000, 'x-suffix': 'ms', 'x-hot': false },
      [`${k}.reconnectMs`]: { type: 'integer', title: t.reconnectMs, minimum: 10, maximum: 300000, 'x-suffix': 'ms', 'x-hot': false },
      [`${k}.maxReconnectMs`]: { type: 'integer', title: t.maxReconnectMs, minimum: 10, maximum: 300000, 'x-suffix': 'ms', 'x-hot': false },
      [`${k}.maxMediaBytes`]: { type: 'integer', title: t.maxMediaBytes, minimum: 1, maximum: 100 * 1024 * 1024, 'x-hot': true },
      [`${k}.imageCacheTtlMs`]: { type: 'integer', title: cacheLabels[0], minimum: 0, maximum: 30 * 24 * 60 * 60 * 1000, 'x-suffix': 'ms', 'x-hot': true },
      [`${k}.imageCacheMaxBytes`]: { type: 'integer', title: cacheLabels[1], minimum: 0, maximum: 1024 * 1024 * 1024, 'x-hot': true },
      [`${k}.autoFallback`]: { type: 'boolean', title: labels[0], 'x-hot': true },
      [`${k}.proactiveIntervalMs`]: { type: 'integer', title: labels[1], minimum: 0, maximum: 60000, 'x-suffix': 'ms', 'x-hot': true },
      [`${k}.streamIntervalMs`]: { type: 'integer', title: labels[2], minimum: 0, maximum: 5000, 'x-suffix': 'ms', 'x-hot': true },
      [`${k}.streamIdleMs`]: { type: 'integer', title: labels[3], minimum: 100, maximum: 120000, 'x-suffix': 'ms', 'x-hot': true },
      [`${k}.ffmpegPath`]: { type: 'string', title: labels[4], 'x-hot': true },
      [`${k}.modelLanguage`]: { type: 'string', title: t.modelLanguage, enum: ['zh', 'en'], 'x-hot': true },
    } },
  };
}
