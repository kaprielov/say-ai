import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import pg from 'pg';

assert.ok(process.env.DATABASE_URL, 'Set DATABASE_URL or copy .env.example to .env.');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 3000 });
after(() => pool.end());

// Each test rolls back its fixtures, including when an expected constraint fails.
async function withTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await work(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

async function knowledgeBase(client) {
  const result = await client.query("INSERT INTO knowledge_bases (owner_id) VALUES ('schema-test') RETURNING id");
  return result.rows[0].id;
}

async function task(client, kbId) {
  const result = await client.query(
    "INSERT INTO ingestion_tasks (knowledge_base_id, source_text) VALUES ($1, 'Example source') RETURNING id",
    [kbId],
  );
  return result.rows[0].id;
}

async function version(client, kbId, taskId) {
  const result = await client.query(`
    INSERT INTO content_versions
      (knowledge_base_id, ingestion_task_id, attempt_number, embedding_model, embedding_dimensions, chunking_config)
    VALUES ($1, $2, 1, 'test-model', 3, '{"size": 100, "overlap": 10}') RETURNING id
  `, [kbId, taskId]);
  return result.rows[0].id;
}

test('pgvector stores and retrieves chunk text by cosine similarity', () => withTransaction(async (client) => {
  const kbId = await knowledgeBase(client);
  const versionId = await version(client, kbId, await task(client, kbId));
  await client.query(`
    INSERT INTO chunks (version_id, position, text, token_count, embedding_dimensions, embedding)
    VALUES ($1, 0, 'Example source', 2, 3, '[1,0,0]'), ($1, 1, 'Other text', 2, 3, '[0,1,0]')
  `, [versionId]);
  const result = await client.query(`
    SELECT text FROM chunks WHERE version_id = $1 ORDER BY embedding <=> '[1,0,0]'::vector LIMIT 1
  `, [versionId]);
  assert.equal(result.rows[0].text, 'Example source');
}));

test('one unfinished ingestion task per knowledge base, including processing tasks', () => withTransaction(async (client) => {
  const kbId = await knowledgeBase(client);
  const taskId = await task(client, kbId);
  await client.query('SAVEPOINT pending_task');
  await assert.rejects(task(client, kbId), { code: '23505', constraint: 'ingestion_tasks_one_unfinished_per_kb' });
  await client.query('ROLLBACK TO SAVEPOINT pending_task');
  await client.query("UPDATE ingestion_tasks SET status = 'processing', attempts_started = 1 WHERE id = $1", [taskId]);
  await client.query('SAVEPOINT processing_task');
  await assert.rejects(task(client, kbId), { code: '23505', constraint: 'ingestion_tasks_one_unfinished_per_kb' });
  await client.query('ROLLBACK TO SAVEPOINT processing_task');
  await client.query("UPDATE ingestion_tasks SET status = 'failed' WHERE id = $1", [taskId]);
  await task(client, kbId);
}));

test('attempt count cannot exceed three', () => withTransaction(async (client) => {
  const kbId = await knowledgeBase(client);
  const taskId = await task(client, kbId);
  await assert.rejects(client.query('UPDATE ingestion_tasks SET attempts_started = 4 WHERE id = $1', [taskId]), { code: '23514' });
}));

test('a version cannot use an ingestion task from another knowledge base', () => withTransaction(async (client) => {
  const firstKb = await knowledgeBase(client);
  const secondKb = await knowledgeBase(client);
  await assert.rejects(version(client, secondKb, await task(client, firstKb)), { code: '23503' });
}));

test('an active version must belong to its knowledge base', () => withTransaction(async (client) => {
  const firstKb = await knowledgeBase(client);
  const secondKb = await knowledgeBase(client);
  const versionId = await version(client, firstKb, await task(client, firstKb));
  await assert.rejects(client.query('UPDATE knowledge_bases SET active_version_id = $1 WHERE id = $2', [versionId, secondKb]), { code: '23503' });
}));

test('chunk dimensions must match the vector and content version', () => withTransaction(async (client) => {
  const kbId = await knowledgeBase(client);
  const versionId = await version(client, kbId, await task(client, kbId));
  await client.query('SAVEPOINT vector_size');
  await assert.rejects(client.query(`
    INSERT INTO chunks (version_id, position, text, token_count, embedding_dimensions, embedding)
    VALUES ($1, 0, 'Text', 1, 3, '[1,0]')
  `, [versionId]), { code: '23514' });
  await client.query('ROLLBACK TO SAVEPOINT vector_size');
  await assert.rejects(client.query(`
    INSERT INTO chunks (version_id, position, text, token_count, embedding_dimensions, embedding)
    VALUES ($1, 0, 'Text', 1, 2, '[1,0]')
  `, [versionId]), { code: '23503' });
}));
