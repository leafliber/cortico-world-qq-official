import { createHash } from 'node:crypto';
import type { EventEnvelope } from 'cortico/core/types.ts';
import { targetKey, type JsonObject, type QQOfficialTarget } from './protocol.ts';

export class AttachmentError extends Error {
  constructor(readonly code: string, message: string, readonly details: JsonObject = {}) { super(message); }
}

export interface AttachmentEntry {
  attachmentId: string;
  index: number;
  quotedPath: number[];
  attachment: JsonObject;
}

export interface AttachmentMessage {
  cursor: number;
  messageId: string;
  target: QQOfficialTarget;
  entries: AttachmentEntry[];
}

export const ATTACHMENT_ID = /^qqa:[a-f0-9]{40}$/;
const record = (value: unknown): JsonObject | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
const pathKey = (path: number[]) => path.join('.');

/** QQ's rkey credential can rotate; keep other parameters that may select different content. */
function urlIdentity(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    const url = new URL(value.startsWith('//') ? `https:${value}` : /^[\w.-]+\.[a-z]+\//i.test(value) ? `https://${value}` : value);
    url.searchParams.delete('rkey');
    url.searchParams.sort();
    return `${url.origin}${url.pathname}${url.search}`;
  } catch { return value; }
}

function sameAttachment(a: JsonObject, b: JsonObject): boolean {
  if (typeof a.id === 'string' && typeof b.id === 'string') return a.id === b.id;
  const first = urlIdentity(a.url), second = urlIdentity(b.url);
  return !!first && first === second;
}

function collect(data: JsonObject, path: number[] = [], out: Array<{ path: number[]; index: number; attachment: JsonObject }> = []) {
  if (out.length >= 256) return out;
  if (Array.isArray(data.attachments)) data.attachments.forEach((value, index) => {
    const attachment = record(value);
    if (attachment && out.length < 256) out.push({ path, index, attachment });
  });
  if (path.length < 8 && Array.isArray(data.msg_elements)) data.msg_elements.slice(0, 101).forEach((value, index) => {
    const quoted = record(value);
    if (quoted) collect(quoted, [...path, index], out);
  });
  return out;
}

export function attachmentSummary(entry: AttachmentEntry, cursor?: number): JsonObject {
  return {
    attachmentId: entry.attachmentId, ...(cursor === undefined ? {} : { cursor }), index: entry.index,
    ...(entry.quotedPath.length ? { quotedPath: entry.quotedPath } : {}),
    ...(entry.quotedPath.length === 1 ? { quotedIndex: entry.quotedPath[0] } : {}),
    ...(typeof entry.attachment.filename === 'string' ? { filename: entry.attachment.filename } : {}),
    ...(typeof entry.attachment.content_type === 'string' ? { contentType: entry.attachment.content_type } : {}),
    hasUrl: typeof entry.attachment.url === 'string' && !!entry.attachment.url,
  };
}

/** Append-only message supplements rebuild this index; no existing event is mutated. */
export class AttachmentIndex {
  private messages = new Map<string, AttachmentMessage>();
  private cursors = new Map<number, AttachmentMessage>();
  private references = new Map<string, { message: AttachmentMessage; entry: AttachmentEntry }>();
  constructor(private readonly appId: string) {}

  private key(target: QQOfficialTarget, messageId: string): string { return JSON.stringify([this.appId, targetKey(target), messageId]); }
  find(target: QQOfficialTarget, messageId: string) { return this.messages.get(this.key(target, messageId)); }
  at(cursor: number) { return this.cursors.get(cursor); }
  ref(id: string) { return this.references.get(id); }

  merge(target: QQOfficialTarget, messageId: string, data: JsonObject, previous: AttachmentEntry[] = []): AttachmentEntry[] {
    const entries = structuredClone(previous);
    const claimed = new Set<string>();
    for (const candidate of collect(data)) {
      const group = entries.filter(e => pathKey(e.quotedPath) === pathKey(candidate.path));
      let entry = group.find(e => !claimed.has(e.attachmentId) && sameAttachment(e.attachment, candidate.attachment));
      // A partial descriptor can acquire a URL later, but a different complete image never replaces it.
      if (!entry) entry = group.find(e => !claimed.has(e.attachmentId) && e.index === candidate.index
        && !e.attachment.url && (!e.attachment.id || e.attachment.id === candidate.attachment.id)
        && (!e.attachment.filename || e.attachment.filename === candidate.attachment.filename));
      if (!entry) {
        const index = group.some(e => e.index === candidate.index) ? Math.max(...group.map(e => e.index)) + 1 : candidate.index;
        const identity = JSON.stringify([this.key(target, messageId), candidate.path, index]);
        entry = { attachmentId: `qqa:${createHash('sha256').update(identity).digest('hex').slice(0, 40)}`, index, quotedPath: candidate.path, attachment: {} };
        entries.push(entry);
      }
      claimed.add(entry.attachmentId);
      // Sparse or malformed retry fields cannot erase known locators. Object spread also keeps
      // platform-supplied keys as data rather than invoking object prototype setters.
      const fields = Object.fromEntries(Object.entries(candidate.attachment).filter(([key, value]) =>
        value !== undefined && value !== null && value !== ''
        && (!['url', 'filename', 'content_type'].includes(key) || (typeof value === 'string' && !!value.trim()))));
      entry.attachment = { ...entry.attachment, ...structuredClone(fields) };
    }
    return entries;
  }

  observe(event: EventEnvelope): void {
    if (event.source !== 'qqofficial' || event.meta?.appId !== this.appId) return;
    const meta = event.meta;
    if (event.type === 'qqofficial.message' && typeof meta.messageId === 'string' && record(meta.target) && record(meta.data)) {
      const target = meta.target as QQOfficialTarget;
      const key = this.key(target, meta.messageId);
      const message = this.messages.get(key) ?? { cursor: event.cursor, messageId: meta.messageId, target, entries: [] };
      message.entries = this.merge(target, meta.messageId, meta.data as JsonObject, message.entries);
      this.messages.set(key, message); this.cursors.set(event.cursor, message);
      this.index(message);
    } else if (event.type === 'qqofficial.attachments' && typeof meta.messageCursor === 'number' && Array.isArray(meta.entries)) {
      const message = this.cursors.get(meta.messageCursor);
      if (!message || message.messageId !== meta.messageId || !record(meta.target) || targetKey(message.target) !== targetKey(meta.target as QQOfficialTarget)) return;
      const entries = meta.entries as AttachmentEntry[];
      if (!entries.every(e => e && ATTACHMENT_ID.test(e.attachmentId) && Number.isSafeInteger(e.index) && e.index >= 0
        && Array.isArray(e.quotedPath) && e.quotedPath.length <= 8 && e.quotedPath.every(i => Number.isInteger(i) && i >= 0 && i <= 100) && record(e.attachment))) return;
      message.entries = structuredClone(entries);
      this.index(message);
    }
  }

  private index(message: AttachmentMessage) {
    for (const entry of message.entries) this.references.set(entry.attachmentId, { message, entry });
  }

  summaries(message: AttachmentMessage) { return message.entries.map(entry => attachmentSummary(entry, message.cursor)); }

  /** History exposes the current union while the original raw event stays immutable on disk. */
  view(event: EventEnvelope): EventEnvelope {
    const message = this.cursors.get(event.cursor);
    if (!message || event.type !== 'qqofficial.message') return event;
    const data = structuredClone(event.meta!.data) as JsonObject;
    for (const entry of message.entries) {
      let container = data;
      for (const index of entry.quotedPath) {
        if (!Array.isArray(container.msg_elements)) container.msg_elements = [];
        const elements = container.msg_elements as unknown[];
        if (!record(elements[index])) elements[index] = {};
        container = elements[index] as JsonObject;
      }
      if (!Array.isArray(container.attachments)) container.attachments = [];
      (container.attachments as unknown[])[entry.index] = structuredClone(entry.attachment);
    }
    return { ...event, meta: { ...event.meta, data, attachmentRefs: this.summaries(message) } };
  }
}
