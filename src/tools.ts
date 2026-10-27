import type { ToolDef, ToolOutcome } from 'cortico/core/types.ts';
import { QQOFFICIAL_MODEL_TEXT, type ModelLanguage } from './model-text.ts';
import { AttachmentError } from './attachments.ts';

const target = {
  type: 'object', additionalProperties: false, required: ['kind', 'id'],
  properties: { kind: { type: 'string', enum: ['c2c', 'group', 'channel', 'dms'] }, id: { type: 'string', minLength: 1 } },
};
const text = { type: 'string' };
const anchors = { replyTo: text, eventId: text, delivery: { type: 'string', enum: ['auto', 'reply', 'proactive', 'wakeup'] }, fallback: { type: 'boolean' } };
const format = { type: 'string', enum: ['text', 'markdown'] };
export type QQOfficialAction = 'send' | 'media' | 'stream' | 'remove' | 'history' | 'interaction' | 'read' | 'targets';
const media = { url: text, blob: text, fileType: { type: 'integer', minimum: 1, maximum: 4 }, fileName: text, content: text };

export function qqOfficialTools(language: ModelLanguage, execute: (action: QQOfficialAction, args: Record<string, unknown>, signal?: AbortSignal) => Promise<string | ToolOutcome>): ToolDef[] {
  const t = QQOFFICIAL_MODEL_TEXT[language];
  const define = (action: QQOfficialAction, name: string, properties: Record<string, unknown>, required: string[], tags: ToolDef['tags']): ToolDef => ({
    name: `qqofficial_${name}`, description: t[action], tags,
    parameters: { type: 'object', properties, required, additionalProperties: false,
      ...(action === 'read' ? { anyOf: [{ required: ['attachmentId'] }, { required: ['cursor', 'index'] }] } : {}),
    },
    handler: async (args, ctx) => {
      try { return await execute(action, args, ctx.signal); }
      catch (error) {
        if (error instanceof AttachmentError) return { text: JSON.stringify({ code: error.code, message: error.message, ...error.details }), failed: true };
        if (action === 'read') return { text: JSON.stringify({ code: ctx.signal?.aborted ? 'ATTACHMENT_READ_CANCELLED' : 'ATTACHMENT_READ_FAILED', message: error instanceof Error ? error.message : String(error) }), failed: true };
        return { text: t.failed + (error instanceof Error ? error.message : String(error)), failed: true };
      }
    },
  });
  return [
    define('send', 'send_message', { target, content: text, format, ...anchors, referenceId: text, keyboard: { type: 'object' } }, ['target', 'content'], ['speak']),
    define('media', 'send_media', { target, ...media, ...anchors, items: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'object', additionalProperties: false, properties: media, required: ['fileType'] } } }, ['target'], ['speak']),
    define('stream', 'stream_message', { target, content: text, format, ...anchors, streamId: text, finish: { type: 'boolean' }, followModel: { type: 'boolean' } }, ['target'], ['speak']),
    define('remove', 'delete_message', { target, messageId: text }, ['target', 'messageId'], ['act']),
    define('history', 'history', { target, messagesOnly: { type: 'boolean' }, beforeCursor: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, [], ['read']),
    define('read', 'read_attachment', { attachmentId: { type: 'string', pattern: '^qqa:[a-f0-9]{40}$' }, cursor: { type: 'integer', minimum: 1 }, index: { type: 'integer', minimum: 0 }, quotedIndex: { type: 'integer', minimum: 0, maximum: 100 }, quotedPath: { type: 'array', maxItems: 8, items: { type: 'integer', minimum: 0, maximum: 100 } } }, [], ['read']),
    define('targets', 'list_targets', { limit: { type: 'integer', minimum: 1, maximum: 100 } }, [], ['read']),
    define('interaction', 'ack_interaction', { interactionId: text, code: { type: 'integer', minimum: 0, maximum: 5 } }, ['interactionId', 'code'], ['act']),
  ];
}
