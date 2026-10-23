import type { Pool, PoolClient } from 'pg';
import { QueryError } from '../queries/errors.js';
import { sourceText } from '../ingestion/source.js';

type Database = Pick<PoolClient, 'query'>;

// Call mutations inside a transaction, including when used outside the HTTP API.
export async function createKnowledgeBase(db: Database, owner: string, text: string, name = 'Knowledge base') {
  sourceText({ text });
  const result = await db.query<{ id: string }>(
    'INSERT INTO knowledge_bases (owner_id, name) VALUES ($1, $2) RETURNING id', [owner, name],
  );
  const id = result.rows[0]!.id;
  const task = await db.query<{ id: string }>(
    'INSERT INTO ingestion_tasks (knowledge_base_id, source_text) VALUES ($1, $2) RETURNING id', [id, text],
  );
  return { id, taskId: task.rows[0]!.id, queryable: false };
}

export async function replaceKnowledgeBase(db: Database, owner: string, id: string, text: string) {
  sourceText({ text });
  const result = await db.query<{ active_version_id: string | null }>(
    'SELECT active_version_id FROM knowledge_bases WHERE id = $1 AND owner_id = $2 FOR UPDATE', [id, owner],
  );
  if (!result.rows[0]) throw new QueryError(404, 'not_found', 'Knowledge base not found.');
  const task = await db.query<{ id: string }>(`
    INSERT INTO ingestion_tasks (knowledge_base_id, source_text, created_at, updated_at)
    VALUES ($1, $2, clock_timestamp(), clock_timestamp())
    ON CONFLICT (knowledge_base_id) WHERE status IN ('pending', 'processing') DO NOTHING RETURNING id
  `, [id, text]);
  if (!task.rows[0]) throw new QueryError(409, 'ingestion_in_progress', 'Content ingestion is already pending or processing.');
  await db.query('UPDATE knowledge_bases SET updated_at = clock_timestamp() WHERE id = $1', [id]);
  return { id, taskId: task.rows[0].id, queryable: result.rows[0].active_version_id !== null };
}

export async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
