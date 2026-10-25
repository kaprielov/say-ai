import { extname } from 'node:path';
import type { PoolClient } from 'pg';
import { QueryError } from '../queries/errors.js';
import { sourceText, validateSourceFilename } from '../ingestion/source.js';
import { uploadLimits } from '../ingestion/limits.js';
import type { TelegramService } from './service.js';

type Draft = { id: string; user_id: string; knowledge_base_id: string | null; name: string; status: string; task_id: string | null; attempts: number };
export type DraftItem = { id: string; filename: string; file_id: string | null; source_text: string | null; actual_bytes: number | null; error_message: string | null };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const owner = (user: number | string) => `telegram:${user}`;
const markup = (rows: [string, string][][]) => ({ inline_keyboard: rows.map(row => row.map(([text, callback_data]) => ({ text, callback_data }))) });

export class UploadDrafts {
  constructor(private readonly service: TelegramService) {}

  async start(db: PoolClient, user: number, name: string, base: string | null = null) {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 17))', [owner(user)]);
    const busy = await db.query("SELECT 1 FROM upload_drafts WHERE user_id=$1 AND status IN ('queued','preparing')", [user]);
    if (busy.rowCount) throw new QueryError(409, 'upload_busy', 'Your files are already being prepared. Wait for the result.');
    await db.query("DELETE FROM upload_drafts WHERE user_id=$1 AND status='collecting'", [user]);
    if (base) await this.service.base(db, user, base);
    const draft = (await db.query<Draft>('INSERT INTO upload_drafts(user_id,name,knowledge_base_id) VALUES ($1,$2,$3) RETURNING *', [user, name, base])).rows[0]!;
    await this.service.session(db, user, base ? 'replace' : 'upload', base, name);
    await db.query('UPDATE telegram_sessions SET upload_draft_id=$2 WHERE user_id=$1', [user, draft.id]);
    return this.show(db, user, draft.id);
  }

  async get(db: PoolClient, user: number, id: string) {
    if (!uuid.test(id)) throw new QueryError(409, 'expired_upload', 'This upload draft has expired. Start a new upload.');
    const draft = (await db.query<Draft>('SELECT * FROM upload_drafts WHERE id=$1 AND user_id=$2 AND (expires_at>now() OR status IN (\'queued\',\'preparing\',\'submitted\')) FOR UPDATE', [id, user])).rows[0];
    if (!draft || draft.status === 'cancelled') throw new QueryError(409, 'expired_upload', 'This upload draft has expired. Start a new upload.');
    if (draft.knowledge_base_id) await this.service.base(db, user, draft.knowledge_base_id);
    return draft;
  }

  async show(db: PoolClient, user: number, id: string) {
    const draft = await this.get(db, user, id);
    const t = await this.service.locale(db, user);
    if (draft.status === 'submitted') {
      const task = (await db.query<{ knowledge_base_id: string }>('SELECT knowledge_base_id FROM ingestion_tasks WHERE id=$1', [draft.task_id])).rows[0];
      if (task) return this.service.showBase(db, user, task.knowledge_base_id);
    }
    if (draft.status !== 'collecting') return this.service.enqueue(db, this.service.config.managerId, user, t('Your files are already being prepared. Wait for the result.'), markup([[[t('Cancel upload'), `ux:${id}`]], [[t('Main menu'), 'menu']]]));
    await this.service.session(db, user, draft.knowledge_base_id ? 'replace' : 'upload', draft.knowledge_base_id, draft.name);
    await db.query('UPDATE telegram_sessions SET upload_draft_id=$2 WHERE user_id=$1', [user, id]);
    const items = (await db.query<DraftItem>('SELECT * FROM upload_draft_items WHERE draft_id=$1 ORDER BY message_id,id', [id])).rows;
    const rows: [string, string][][] = items.map((item, index) => [[t('Remove {number}', { number: String(index + 1) }), `ur:${id}:${item.id}`]]);
    if (items.length) rows.push([[t('Done'), `ud:${id}`]]);
    rows.push([[t('Supported files'), 'hf:base']], [[t('Cancel upload'), `ux:${id}`], [t('Main menu'), 'menu']]);
    const summary = (draft.knowledge_base_id ? t('This replaces the complete content. The previous ready version stays available during processing.') + '\n' : '') + t('Send up to 10 files, together or separately, then tap Done. Each file: 20 MB; total files: 50 MB; extracted text: 5 MiB. Scans require OCR.');
    const list = items.map((item, index) => `${index + 1}. ${item.file_id ? item.filename : t('Text')}${item.error_message ? ` — ${t(item.error_message)}` : ''}`).join('\n');
    await this.service.enqueue(db, this.service.config.managerId, user, `${draft.name}\n${summary}\n${t('Files collected: {count}', { count: String(items.length) })}${list ? `\n${list}` : ''}`, markup(rows));
  }

  async add(db: PoolClient, user: number, draftId: string, messageId: number, file?: { file_id: string; file_name?: string; file_size?: number }, text?: string) {
    const draft = await this.get(db, user, draftId);
    if (draft.status !== 'collecting') throw new QueryError(409, 'upload_closed', 'This upload is closed. Wait for the result, then start another upload.');
    const duplicate = await db.query('SELECT 1 FROM upload_draft_items WHERE draft_id=$1 AND message_id=$2', [draftId, messageId]);
    if (duplicate.rowCount) return this.show(db, user, draftId);
    const count = (await db.query('SELECT count(*)::int AS count, COALESCE(sum(COALESCE(actual_bytes,declared_bytes,0)),0)::int AS bytes FROM upload_draft_items WHERE draft_id=$1', [draftId])).rows[0];
    if (count.count >= uploadLimits.items) throw new QueryError(413, 'upload_item_limit', 'An upload can contain at most 10 files or text messages.');
    let content: string | null = null;
    const originalName = file?.file_name ?? '';
    const cleanName = originalName.replace(/[\x00-\x1f\x7f]/g, '');
    const filename = file ? (cleanName.length <= 120 ? cleanName : cleanName.slice(0, 100) + extname(originalName).toLowerCase()) : 'Text';
    if (file) {
      validateSourceFilename(originalName);
      if (file.file_size !== undefined && (!Number.isSafeInteger(file.file_size) || file.file_size < 0 || file.file_size > uploadLimits.fileBytes)) throw new QueryError(413, 'payload_too_large', 'File must not exceed 20 MB.');
    } else content = sourceText({ text });
    const bytes = file?.file_size ?? (content ? Buffer.byteLength(content) : null);
    if (count.bytes + (bytes ?? 0) > uploadLimits.batchBytes) throw new QueryError(413, 'batch_too_large', 'Files in one upload must not exceed 50 MB in total.');
    const texts = (await db.query('SELECT COALESCE(sum(octet_length(source_text)),0)::int AS bytes FROM upload_draft_items WHERE draft_id=$1', [draftId])).rows[0].bytes;
    if (content && texts + Buffer.byteLength(content) + count.count * 2 > uploadLimits.textBytes) throw new QueryError(413, 'extracted_text_too_large', 'Extracted text must not exceed 5 MiB.');
    await db.query('INSERT INTO upload_draft_items(draft_id,message_id,filename,file_id,declared_bytes,actual_bytes,source_text) VALUES ($1,$2,$3,$4,$5,$6,$7)', [draftId, messageId, filename, file?.file_id ?? null, bytes, content ? bytes : null, content]);
    await db.query("UPDATE upload_drafts SET expires_at=now()+$2*interval '1 hour' WHERE id=$1", [draftId, uploadLimits.draftHours]);
    return this.show(db, user, draftId);
  }

  async action(db: PoolClient, user: number, data: string) {
    const [action, id = '', item = ''] = data.split(':');
    if (!['up', 'ud', 'ur', 'ux'].includes(action!)) return false;
    const draft = await this.get(db, user, id);
    if (action === 'up') { await this.show(db, user, id); return true; }
    if (action === 'ux' && draft.status !== 'submitted') {
      await db.query('DELETE FROM upload_drafts WHERE id=$1', [id]);
      if (draft.knowledge_base_id) await this.service.showBase(db, user, draft.knowledge_base_id);
      else await this.service.menu(db, user);
    } else if (draft.status !== 'collecting') { await this.show(db, user, id);
    } else if (action === 'ur') {
      if (!/^\d{1,20}$/.test(item)) throw new QueryError(400, 'invalid_upload', 'Choose a file from this upload.');
      await db.query('DELETE FROM upload_draft_items WHERE draft_id=$1 AND id=$2', [id, item]);
      await this.show(db, user, id);
    } else {
      const count = (await db.query('SELECT count(*)::int AS count FROM upload_draft_items WHERE draft_id=$1', [id])).rows[0].count;
      if (!count) throw new QueryError(400, 'empty_upload', 'Send at least one file or text message first.');
      // Serialize admission independently of per-draft locks.
      await db.query('SELECT pg_advisory_xact_lock(1793404800, 1)');
      const queued = (await db.query("SELECT count(*)::int AS count FROM upload_drafts WHERE status IN ('queued','preparing')")).rows[0].count;
      if (queued >= uploadLimits.preparationJobs) throw new QueryError(429, 'upload_capacity_full', 'File upload capacity is full. Try again later.');
      await db.query("UPDATE upload_drafts SET status='queued',attempts=0,available_at=now() WHERE id=$1", [id]);
      await this.show(db, user, id);
    }
    return true;
  }
}

export async function cleanupUploadDrafts(db: PoolClient) {
  await db.query(`DELETE FROM upload_drafts WHERE id IN (
    SELECT id FROM upload_drafts WHERE status IN ('collecting','submitted','cancelled') AND expires_at<=now()
    ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED)`);
}
