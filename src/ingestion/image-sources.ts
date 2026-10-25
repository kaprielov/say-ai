import { extname } from 'node:path';
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { QueryError } from '../queries/errors.js';
import { IngestionError } from './embeddings.js';
import { normalizeImage } from './images.js';
import { imageEvidenceText, imagePromptRevision, recognizeImage, type ImageRecognizer } from './image-recognition.js';

type Database = Pick<PoolClient, 'query'>;
export type StoredImage = { id: string; owner_id: string; filename: string; caption: string; original_bytes: Buffer | null; source_text: string | null; attempts: number };
export function imageStorageError(error: unknown): never {
  if ((error as { code?: string })?.code === 'P2001') throw new QueryError(413, 'image_storage_full', 'Image storage is full. Remove an unused knowledge base or contact the operator.');
  throw error;
}
export async function addImageSource(db: Database, owner: string, filename: string, target: { task?: string; item?: string }, bytes?: Buffer, caption = '', declaredBytes?: number) {
  const cleanName = filename.replace(/[\x00-\x1f\x7f]/g, '');
  filename = cleanName.length <= 120 ? cleanName : cleanName.slice(0,100) + extname(cleanName).toLowerCase();
  try {
    const row = await db.query<{ id: string }>(`INSERT INTO image_sources(owner_id,ingestion_task_id,draft_item_id,filename,caption,original_bytes,reserved_bytes,sha256)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [owner, target.task ?? null, target.item ?? null, filename, caption, bytes ?? null,
      bytes?.length ?? declaredBytes ?? 20_000_000, bytes ? createHash('sha256').update(bytes).digest('hex') : null]);
    return row.rows[0]!.id;
  } catch (error) { imageStorageError(error); }
}
export async function saveImageBytes(db: Database, id: string, bytes: Buffer) {
  try {
    return await db.query('UPDATE image_sources SET original_bytes=$2,reserved_bytes=$3,sha256=$4 WHERE id=$1 AND original_bytes IS NULL RETURNING id', [id, bytes, bytes.length, createHash('sha256').update(bytes).digest('hex')]);
  } catch (error) { imageStorageError(error); }
}

// The existence predicates prevent a cancelled draft from starting a paid call.
export async function prepareImage(pool: Pool, id: string, provider: (owner: string, knowledgeBaseId?: string) => Promise<ImageRecognizer>, signal: AbortSignal) {
  const get = async () => (await pool.query<StoredImage & { knowledge_base_id: string | null }>(`SELECT s.*,COALESCE(t.knowledge_base_id,d.knowledge_base_id) AS knowledge_base_id
    FROM image_sources s LEFT JOIN ingestion_tasks t ON t.id=s.ingestion_task_id
    LEFT JOIN upload_draft_items i ON i.id=s.draft_item_id LEFT JOIN upload_drafts d ON d.id=i.draft_id
    WHERE s.id=$1 AND (t.status='processing' OR d.status='preparing')`, [id])).rows[0];
  const source = await get();
  if (!source) throw new IngestionError('image_cancelled', 'Image upload was cancelled.', false);
  if (source.source_text !== null) return source.source_text;
  if (!source.original_bytes) throw new IngestionError('image_missing', 'Image upload is incomplete.', false);
  const normalized = await normalizeImage(source.original_bytes, source.filename, signal);
  let recognizer = await provider(source.owner_id, source.knowledge_base_id ?? undefined);
  const counted = await pool.query(`UPDATE image_sources s SET attempts=attempts+1 WHERE id=$1 AND attempts<3 AND source_text IS NULL
    AND (EXISTS(SELECT 1 FROM ingestion_tasks t WHERE t.id=s.ingestion_task_id AND t.status='processing')
      OR EXISTS(SELECT 1 FROM upload_draft_items i JOIN upload_drafts d ON d.id=i.draft_id WHERE i.id=s.draft_item_id AND d.status='preparing')) RETURNING id`, [id]);
  if (!counted.rowCount) throw new IngestionError('image_attempts_exhausted', 'Image recognition was interrupted too many times. Upload the image again.', false);
  signal.throwIfAborted();
  const evidence = await recognizeImage({ model: recognizer.model, async recognize(image, activeSignal) {
    // Check again after waiting for another recognition request to finish.
    if (!(await get())) throw new IngestionError('image_cancelled', 'Image upload was cancelled.', false);
    recognizer = await provider(source.owner_id, source.knowledge_base_id ?? undefined);
    return recognizer.recognize(image, activeSignal);
  } }, normalized, signal);
  const text = imageEvidenceText(evidence, `${source.id}: ${source.filename}`, source.caption);
  signal.throwIfAborted();
  const saved = await pool.query(`UPDATE image_sources s SET evidence=$2,source_text=$3,model=$4,prompt_revision=$5 WHERE id=$1
    AND (EXISTS(SELECT 1 FROM ingestion_tasks t WHERE t.id=s.ingestion_task_id AND t.status='processing')
      OR EXISTS(SELECT 1 FROM upload_draft_items i JOIN upload_drafts d ON d.id=i.draft_id WHERE i.id=s.draft_item_id AND d.status='preparing'))`,
  [id, evidence, text, recognizer.model, imagePromptRevision]);
  if (!saved.rowCount) throw new IngestionError('image_cancelled', 'Image upload was cancelled.', false);
  return text;
}
