import { setTimeout } from 'node:timers/promises';
import { transaction, createKnowledgeBase, replaceKnowledgeBase } from '../knowledge-bases/service.js';
import { decodeSource, sourceText } from '../ingestion/source.js';
import { uploadLimits } from '../ingestion/limits.js';
import { QueryError } from '../queries/errors.js';
import { TelegramError } from './client.js';
import type { TelegramService } from './service.js';
import type { DraftItem } from './uploads.js';

type Job = { id: string; user_id: string; name: string; knowledge_base_id: string | null; attempts: number };

// The caller owns the preparation worker advisory lock. Network work never holds a transaction.
export async function processUploadNext(service: TelegramService, signal = new AbortController().signal) {
  signal.throwIfAborted();
  const job = await transaction(service.pool, async db => (await db.query<Job>(`
    UPDATE upload_drafts SET status='preparing',attempts=attempts+1 WHERE id=(
      SELECT id FROM upload_drafts WHERE status='queued' AND available_at<=now()
      ORDER BY available_at,created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`)).rows[0]);
  if (!job) return false;
  let current: DraftItem | undefined;
  try {
    if (job.attempts > 3) throw new QueryError(503, 'upload_interrupted', 'Upload preparation was interrupted too many times. Review the draft and try again.');
    const items = (await service.pool.query<DraftItem>('SELECT * FROM upload_draft_items WHERE draft_id=$1 ORDER BY message_id,id', [job.id])).rows;
    if (!items.length) throw new QueryError(400, 'empty_upload', 'Send at least one file or text message first.');
    for (const item of items) {
      signal.throwIfAborted();
      current = item;
      if (item.source_text !== null) continue;
      const bytes = await service.api.download(service.config.token, item.file_id!, signal);
      signal.throwIfAborted();
      if (bytes.length > uploadLimits.fileBytes) throw new QueryError(413, 'payload_too_large', 'File must not exceed 20 MB.');
      const actualBytes = items.reduce((sum, other) => sum + (other.id === item.id ? bytes.length : other.actual_bytes ?? 0), 0);
      if (actualBytes > uploadLimits.batchBytes) throw new QueryError(413, 'batch_too_large', 'Files in one upload must not exceed 50 MB in total.');
      const text = await decodeSource(bytes, item.filename, signal);
      const textBytes = items.reduce((sum, other) => sum + (other.id === item.id ? Buffer.byteLength(text) : Buffer.byteLength(other.source_text ?? '')), 0) + (items.length - 1) * 2;
      if (textBytes > uploadLimits.textBytes) throw new QueryError(413, 'extracted_text_too_large', 'Extracted text must not exceed 5 MiB.');
      const saved = await service.pool.query(`UPDATE upload_draft_items SET source_text=$3,actual_bytes=$4,error_message=NULL
        WHERE id=$1 AND draft_id=$2 AND EXISTS (SELECT 1 FROM upload_drafts WHERE id=$2 AND status='preparing')`, [item.id, job.id, text, bytes.length]);
      if (!saved.rowCount) return true; // The owner cancelled or deleted the target during download.
      item.source_text = text;
      item.actual_bytes = bytes.length;
    }
    signal.throwIfAborted();
    const content = sourceText({ text: items.map(item => item.source_text).join('\n\n') });
    const owner = `telegram:${job.user_id}`;
    if (service.credentials && !(await service.credentials.available(owner))) throw new QueryError(503, 'openai_key_required', 'Connect your OpenAI API key in the manager to continue.');
    await transaction(service.pool, async db => {
      const active = (await db.query("SELECT * FROM upload_drafts WHERE id=$1 AND status='preparing' FOR UPDATE", [job.id])).rows[0];
      if (!active) return;
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 17))', [owner]);
      if (!job.knowledge_base_id) {
        const count = (await db.query('SELECT count(*)::int AS count FROM knowledge_bases WHERE owner_id=$1', [owner])).rows[0].count;
        if (count >= 20) throw new QueryError(429, 'base_limit', 'You can create up to 20 knowledge bases.');
      }
      const result = job.knowledge_base_id
        ? await replaceKnowledgeBase(db, owner, job.knowledge_base_id, content)
        : await createKnowledgeBase(db, owner, content, job.name);
      await db.query('INSERT INTO telegram_notifications(task_id,chat_id) VALUES ($1,$2)', [result.taskId, job.user_id]);
      await db.query("UPDATE upload_drafts SET status='submitted',task_id=$2,expires_at=now()+interval '24 hours' WHERE id=$1", [job.id, result.taskId]);
      await db.query('DELETE FROM upload_draft_items WHERE draft_id=$1', [job.id]);
      await db.query("UPDATE telegram_sessions SET state='selected',knowledge_base_id=$3,upload_draft_id=NULL WHERE user_id=$1 AND upload_draft_id=$2", [job.user_id, job.id, result.id]);
      const t = await service.locale(db, job.user_id);
      await service.enqueue(db, service.config.managerId, Number(job.user_id), t('Content accepted. Processing will continue in the background; you will receive a notification.'),
        { inline_keyboard: [[{ text: t('View knowledge base'), callback_data: `kb:${result.id}` }]] });
    });
  } catch (error) {
    // Leave preparation durable for startup recovery on shutdown or lost database connectivity.
    if (signal.aborted) throw error;
    const permanent = error instanceof QueryError && error.code !== 'outbox_full';
    const outboxFull = error instanceof QueryError && error.code === 'outbox_full';
    const retry = outboxFull || (!permanent && job.attempts < 3 && !(error instanceof TelegramError && [400,401,403,404].includes(error.code)));
    await transaction(service.pool, async db => {
      const active = (await db.query("SELECT 1 FROM upload_drafts WHERE id=$1 AND status='preparing' FOR UPDATE", [job.id])).rowCount;
      if (!active) return;
      if (retry) {
        const delay = error instanceof TelegramError ? Math.max(error.retryAfter, job.attempts === 1 ? 10 : 60) : job.attempts === 1 ? 10 : 60;
        await db.query("UPDATE upload_drafts SET status='queued',attempts=GREATEST(0,attempts-$3),available_at=now()+$2*interval '1 second' WHERE id=$1", [job.id, delay, outboxFull ? 1 : 0]);
        return;
      }
      const reason = error instanceof QueryError ? error.message : 'Unable to download this file. Remove it or try again.';
      if (current) await db.query('UPDATE upload_draft_items SET error_message=$3 WHERE draft_id=$1 AND id=$2', [job.id, current.id, reason]);
      await db.query("UPDATE upload_drafts SET status='collecting',expires_at=now()+interval '24 hours' WHERE id=$1", [job.id]);
      const t = await service.locale(db, job.user_id);
      await service.enqueue(db, service.config.managerId, Number(job.user_id),
        t('Upload failed for {file}: {reason} Review the draft, remove the problem file, or try again.', { file: current ? (current.file_id ? current.filename : t('Text')) : job.name, reason: t(reason) }),
        { inline_keyboard: [[{ text: t('Review upload'), callback_data: `up:${job.id}` }]] });
    }).catch(async noticeError => {
      if (!(noticeError instanceof QueryError) || noticeError.code !== 'outbox_full') throw noticeError;
      await service.pool.query(`UPDATE upload_drafts SET status='queued',attempts=GREATEST(0,attempts-1),
        available_at=now()+interval '10 seconds' WHERE id=$1 AND status='preparing'`, [job.id]);
    });
  }
  return true;
}

export async function startUploadWorker(service: TelegramService, onFailure: () => void) {
  const db = await service.pool.connect();
  const controller = new AbortController();
  let failed = false;
  const connectionError = () => { failed = true; controller.abort(); };
  db.on('error', connectionError);
  let locked = false;
  try {
    locked = (await db.query('SELECT pg_try_advisory_lock(1793404800, 2) AS locked')).rows[0].locked;
    if (!locked) throw new Error('Another upload preparation worker is running.');
    await db.query("UPDATE upload_drafts SET status='queued',available_at=now() WHERE status='preparing'");
  } catch (error) {
    db.removeListener('error', connectionError);
    db.release(true);
    throw error;
  }
  const running = (async () => {
    try {
      while (!controller.signal.aborted) {
        const worked = await processUploadNext(service, controller.signal);
        await setTimeout(worked ? 50 : 500, undefined, { signal: controller.signal });
      }
    } catch { if (!controller.signal.aborted) failed = true; }
    finally {
      try { await db.query('SELECT pg_advisory_unlock(1793404800, 2)'); } catch { failed = true; }
      db.removeListener('error', connectionError);
      db.release(failed);
    }
    if (failed) onFailure();
  })();
  return { async stop() { controller.abort(); await running; } };
}
