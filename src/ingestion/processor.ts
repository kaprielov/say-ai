import type { PoolClient } from 'pg';
import { chunkText, chunkingConfig } from './chunking.js';
import { IngestionError, validateVectors, type Embedder } from './embeddings.js';

type Task = { id: string; knowledge_base_id: string; source_text: string; attempts_started: number; version_id: string };

export class IngestionProcessor {
  constructor(
    private readonly client: PoolClient,
    private readonly embedder: Embedder,
    private readonly retryDelaysMs: readonly [number, number] = [10_000, 60_000],
    private readonly ownerEmbedder?: (owner: string) => Promise<Embedder>,
    private readonly onProgress?: () => Promise<void>,
  ) {}

  private async transaction<T>(work: () => Promise<T>): Promise<T> {
    await this.client.query('BEGIN');
    try {
      const result = await work();
      await this.client.query('COMMIT');
      return result;
    } catch (error) {
      await this.client.query('ROLLBACK');
      throw error;
    }
  }

  // Run only while holding the worker's exclusive advisory lock.
  async recover() {
    await this.transaction(async () => {
      await this.client.query(`
        DELETE FROM content_versions v USING ingestion_tasks t
        WHERE v.ingestion_task_id = t.id AND t.status = 'processing' AND v.status = 'building'
          AND NOT EXISTS (SELECT 1 FROM knowledge_bases kb WHERE kb.active_version_id = v.id)
      `);
      await this.client.query(`
        UPDATE ingestion_tasks
        SET status = CASE WHEN attempts_started < 3 THEN 'pending' ELSE 'failed' END,
            next_attempt_at = now(), error_code = 'ingestion_interrupted',
            error_message = 'Ingestion was interrupted before completion.', updated_at = now()
        WHERE status = 'processing'
      `);
    });
  }

  private async claim(): Promise<Task | undefined> {
    return this.transaction(async () => {
      const result = await this.client.query<Omit<Task, 'version_id'>>(`
        WITH next AS (
          SELECT id FROM ingestion_tasks
          WHERE status = 'pending' AND attempts_started < 3 AND next_attempt_at <= now()
          ORDER BY next_attempt_at, created_at, id FOR UPDATE SKIP LOCKED LIMIT 1
        )
        UPDATE ingestion_tasks t
        SET status = 'processing', attempts_started = attempts_started + 1,
            error_code = NULL, error_message = NULL, updated_at = now()
        FROM next WHERE t.id = next.id RETURNING t.*
      `);
      const task = result.rows[0];
      if (!task) return undefined;
      const version = await this.client.query<{ id: string }>(`
        INSERT INTO content_versions
          (knowledge_base_id, ingestion_task_id, attempt_number, embedding_model, embedding_dimensions, chunking_config)
        VALUES ($1, $2, $3, $4, $5, $6) RETURNING id
      `, [task.knowledge_base_id, task.id, task.attempts_started, this.embedder.model, this.embedder.dimensions, chunkingConfig]);
      return { ...task, version_id: version.rows[0]!.id };
    });
  }

  private async fail(task: Task, error: unknown) {
    const failure = error instanceof IngestionError
      ? error : new IngestionError('ingestion_failed', 'Ingestion failed while processing content.');
    await this.transaction(async () => {
      const current = await this.client.query('SELECT status FROM ingestion_tasks WHERE id = $1 FOR UPDATE', [task.id]);
      // A committed activation must never be undone after a lost commit acknowledgement.
      if (current.rows[0]?.status !== 'processing') return;
      await this.client.query(`
        DELETE FROM content_versions v WHERE v.id = $1 AND v.status = 'building'
          AND NOT EXISTS (SELECT 1 FROM knowledge_bases kb WHERE kb.active_version_id = v.id)
      `, [task.version_id]);
      const retry = failure.retryable && task.attempts_started < 3;
      const delay = this.retryDelaysMs[task.attempts_started - 1] ?? 0;
      await this.client.query(`
        UPDATE ingestion_tasks SET status = $2, next_attempt_at = now() + $3 * interval '1 millisecond',
          error_code = $4, error_message = $5, updated_at = now() WHERE id = $1
      `, [task.id, retry ? 'pending' : 'failed', delay, failure.code, failure.message]);
    });
  }

  async processNext(signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    const task = await this.claim();
    if (!task) return false;
    const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)]);
    try {
      const owner = this.ownerEmbedder ? (await this.client.query<{ owner_id: string }>(
        'SELECT owner_id FROM knowledge_bases WHERE id = $1', [task.knowledge_base_id],
      )).rows[0]!.owner_id : undefined;
      const embedder = owner ? await this.ownerEmbedder!(owner) : this.embedder;
      if (embedder.model !== this.embedder.model || embedder.dimensions !== this.embedder.dimensions) {
        throw new IngestionError('embedding_configuration_mismatch', 'Owner embedding configuration does not match the content version.', false);
      }
      const chunks = chunkText(task.source_text);
      if (chunks.length === 0) throw new IngestionError('empty_content', 'Source contains no usable content.', false);
      for (let offset = 0; offset < chunks.length; offset += 16) {
        attemptSignal.throwIfAborted();
        const batch = chunks.slice(offset, offset + 16);
        const vectors = await embedder.embed(batch.map(chunk => chunk.text), attemptSignal);
        validateVectors(vectors, batch.length, embedder.dimensions);
        attemptSignal.throwIfAborted();
        await this.transaction(async () => {
          for (let index = 0; index < batch.length; index++) {
            const chunk = batch[index]!;
            await this.client.query(`
              INSERT INTO chunks (version_id, position, text, token_count, embedding_dimensions, embedding)
              VALUES ($1, $2, $3, $4, $5, $6::vector)
            `, [task.version_id, offset + index, chunk.text, chunk.tokenCount, this.embedder.dimensions, JSON.stringify(vectors[index])]);
          }
        });
        await this.onProgress?.();
      }
      attemptSignal.throwIfAborted();
      await this.transaction(async () => {
        await this.client.query("UPDATE content_versions SET status = 'ready', ready_at = now() WHERE id = $1", [task.version_id]);
        await this.client.query('UPDATE knowledge_bases SET active_version_id = $1, updated_at = now() WHERE id = $2', [task.version_id, task.knowledge_base_id]);
        await this.client.query("UPDATE ingestion_tasks SET status = 'ready', updated_at = now() WHERE id = $1", [task.id]);
      });
    } catch (error) {
      // Leave interrupted work durable; startup recovery counts this attempt.
      if (signal.aborted) throw error;
      await this.fail(task, attemptSignal.aborted
        ? new IngestionError('ingestion_timeout', 'Ingestion attempt exceeded its deadline.') : error);
    }
    return true;
  }
}
