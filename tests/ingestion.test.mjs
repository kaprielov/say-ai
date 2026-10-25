import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import { after, before, beforeEach, test } from 'node:test';
import pg from 'pg';
import { chunkText, countTokens } from '../src/ingestion/chunking.ts';
import { IngestionError, OpenAIEmbedder } from '../src/ingestion/embeddings.ts';
import { IngestionProcessor } from '../src/ingestion/processor.ts';
import { startIngestionWorker } from '../src/ingestion/worker.ts';
import { createApp } from '../src/app.ts';
import { pilotStatus } from '../scripts/pilot-status.mjs';
import { WorkerProgress } from '../src/worker-progress.ts';

const databaseName = `say_ai_ingestion_test_${randomBytes(8).toString('hex')}`;
const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
let created = false;
let pool;
const signal = () => new AbortController().signal;
const fakeEmbedder = (embed = async texts => texts.map(() => [1, 0, 0])) => ({ model: 'fixture-model', dimensions: 3, embed });

before(async () => {
  assert.ok(process.env.DATABASE_URL);
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  created = true;
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `/${databaseName}`;
  await promisify(execFile)(process.execPath, [
    'node_modules/node-pg-migrate/bin/node-pg-migrate.js', 'up', '--no-verbose',
  ], { env: { ...process.env, DATABASE_URL: url.toString() } });
  pool = new pg.Pool({ connectionString: url.toString(), connectionTimeoutMillis: 3000 });
});

beforeEach(async () => {
  await pool.query('TRUNCATE image_sources, upload_draft_items, upload_drafts, telegram_sessions, telegram_dialogues, telegram_visitors, telegram_security_notices, telegram_notifications, telegram_bots, chunks, content_versions, ingestion_tasks, knowledge_bases');
});

after(async () => {
  if (pool) await pool.end();
  try {
    if (created) await admin.query(`DROP DATABASE "${databaseName}"`);
  } finally {
    await admin.end();
  }
});

async function submission(text = 'Example source text.', kbId) {
  if (!kbId) kbId = (await pool.query("INSERT INTO knowledge_bases (owner_id) VALUES ('test-owner') RETURNING id")).rows[0].id;
  const task = await pool.query('INSERT INTO ingestion_tasks (knowledge_base_id, source_text) VALUES ($1, $2) RETURNING id', [kbId, text]);
  return { kbId, taskId: task.rows[0].id };
}

async function processWith(embedder, work) {
  const client = await pool.connect();
  try {
    return await work(new IngestionProcessor(client, embedder, [0, 0]));
  } finally {
    client.release();
  }
}

async function taskState(id) {
  return (await pool.query('SELECT * FROM ingestion_tasks WHERE id = $1', [id])).rows[0];
}

async function waitUntil(check) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await setTimeout(20);
  }
  throw new Error('Timed out waiting for worker.');
}

test('chunking preserves Unicode source substrings, bounds tokens, and treats special-token strings literally', () => {
  const source = 'Привет 👩🏽‍💻! 日本語 <|endoftext|> paragraph.\n'.repeat(30);
  const chunks = chunkText(source, 32, 4);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(source.includes(chunk.text));
    assert.ok(!chunk.text.includes('\ufffd'));
    assert.ok(chunk.tokenCount <= 32);
    assert.equal(chunk.tokenCount, countTokens(chunk.text));
  }
  assert.deepEqual(chunkText(source, 32, 4), chunks);
  assert.deepEqual(chunkText(' \n\t'), []);
  assert.throws(() => chunkText('text', 32, 32));
  const short = '  Preserve exact text.\n';
  assert.equal(chunkText(short)[0].text, short);
});

test('chunking keeps complete paragraphs together when they fit individually', () => {
  const paragraphs = Array.from({ length: 12 }, (_, index) =>
    `Policy ${index}: Available items wait for the last item in the order. Separate orders have independent delivery fees.\n\n`);
  const source = paragraphs.join('');
  const chunks = chunkText(source, 64, 0);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.map(chunk => chunk.text).join(''), source);
  for (const paragraph of paragraphs) assert.ok(chunks.some(chunk => chunk.text.includes(paragraph)));
  assert.equal(chunks.length, paragraphs.length, 'Short policies must not share an embedding');
  for (const chunk of chunks) assert.ok(chunk.tokenCount <= 64);
});

test('long paragraphs split at sentence boundaries and overlap uses whole sentences', () => {
  const sentences = Array.from({ length: 25 }, (_, index) => `Rule ${index} applies to every order. `);
  const source = sentences.join('');
  const chunks = chunkText(source, 36, 10);
  let covered = 0;
  for (const chunk of chunks) {
    const start = source.indexOf(chunk.text);
    assert.ok(start >= 0 && start <= covered, 'No source text may be skipped');
    assert.match(chunk.text, /^Rule \d+ applies/);
    assert.match(chunk.text, /every order\. $/);
    assert.ok(chunk.tokenCount <= 36);
    covered = start + chunk.text.length;
  }
  assert.equal(covered, source.length);
  assert.ok(chunks[0].text.endsWith(sentences[3]));
  assert.ok(chunks[1].text.startsWith(sentences[3]), 'The last complete sentence is reused');
});

test('oversized sentences fall back to bounded Unicode slices without losing source text', () => {
  const source = 'Short introduction.\n\n' + 'uninterrupted👩🏽‍💻'.repeat(100) + '\n\nFinal paragraph.';
  const chunks = chunkText(source, 32, 4);
  let covered = 0;
  for (const chunk of chunks) {
    const start = source.lastIndexOf(chunk.text, covered);
    assert.ok(start >= 0 && start <= covered);
    assert.ok(start + chunk.text.length > covered, 'Every chunk contributes new text');
    assert.ok(chunk.tokenCount <= 32);
    assert.ok(!chunk.text.includes('\ufffd'));
    covered = start + chunk.text.length;
  }
  assert.equal(covered, source.length);
});

test('OpenAI adapter uses the documented request and maps vectors by response index', async () => {
  const adapter = new OpenAIEmbedder('test-secret', 'text-embedding-3-small', 3, async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/embeddings');
    assert.equal(options.headers.Authorization, 'Bearer test-secret');
    assert.deepEqual(JSON.parse(options.body), {
      model: 'text-embedding-3-small', dimensions: 3, input: ['first', 'second'], encoding_format: 'float',
    });
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json({ data: [{ index: 1, embedding: [0, 1, 0] }, { index: 0, embedding: [1, 0, 0] }] });
  });
  assert.deepEqual(await adapter.embed(['first', 'second'], signal()), [[1, 0, 0], [0, 1, 0]]);
});

test('provider errors are sanitized, permanent errors are terminal, and invalid vectors are rejected', async () => {
  for (const [status, retryable] of [[401, false], [400, false], [429, true], [500, true]]) {
    const adapter = new OpenAIEmbedder('test', 'fixture', 3, async () => new Response('private provider error', { status }));
    await assert.rejects(adapter.embed(['text'], signal()), error => {
      assert.ok(error instanceof IngestionError);
      assert.equal(error.retryable, retryable);
      assert.ok(!error.message.includes('private'));
      return true;
    });
  }
  for (const data of [
    [{ index: 0, embedding: [1, 0] }],
    [{ index: 0, embedding: [0, 0, 0] }],
    [{ index: 1, embedding: [1, 0, 0] }],
    [{ index: 0, embedding: [1, 0, 0] }, { index: 0, embedding: [1, 0, 0] }],
  ]) {
    const adapter = new OpenAIEmbedder('test', 'fixture', 3, async () => Response.json({ data }));
    await assert.rejects(adapter.embed(['text'], signal()), { code: 'invalid_embedding_response' });
  }
});

test('provider timeout aborts the transport without an automatic retry', async () => {
  let calls = 0;
  const adapter = new OpenAIEmbedder('test', 'fixture', 3, async (_url, options) => {
    calls++;
    await setTimeout(1000, undefined, { signal: options.signal });
    throw new Error('Unexpected completion');
  }, 10);
  await assert.rejects(adapter.embed(['text'], signal()), { code: 'embedding_timeout' });
  assert.equal(calls, 1);
});

test('API-created content becomes ready with exact source, vector metadata, and a single committed attempt', async () => {
  const apiKey = randomBytes(32).toString('base64url');
  const server = createApp({ pool, apiKey, ownerId: 'test-owner' }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/knowledge-bases`;
  try {
    const source = '  Example source text.\n';
    const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: source }) });
    assert.equal(response.status, 201);
    const kb = await response.json();
    await processWith(fakeEmbedder(async texts => {
      const task = (await pool.query('SELECT status, attempts_started FROM ingestion_tasks WHERE knowledge_base_id = $1', [kb.id])).rows[0];
      assert.deepEqual(task, { status: 'processing', attempts_started: 1 });
      const version = (await pool.query('SELECT active_version_id FROM knowledge_bases WHERE id = $1', [kb.id])).rows[0];
      assert.equal(version.active_version_id, null);
      return texts.map(() => [1, 0, 0]);
    }), processor => processor.processNext(signal()));
    const metadata = await fetch(`${url}/${kb.id}`, { headers: { Authorization: `Bearer ${apiKey}` } });
    assert.deepEqual(await metadata.json(), { id: kb.id, status: 'ready', queryable: true });
    const result = await pool.query(`
      SELECT v.embedding_model, v.embedding_dimensions, c.text, c.token_count, vector_dims(c.embedding) AS dimensions
      FROM knowledge_bases kb JOIN content_versions v ON v.id = kb.active_version_id JOIN chunks c ON c.version_id = v.id WHERE kb.id = $1
    `, [kb.id]);
    assert.deepEqual(result.rows, [{ embedding_model: 'fixture-model', embedding_dimensions: 3, text: source, token_count: countTokens(source), dimensions: 3 }]);
    await processWith(fakeEmbedder(), async processor => {
      await processor.recover();
      assert.equal(await processor.processNext(signal()), false);
    });
    assert.equal((await pool.query('SELECT count(*) FROM content_versions')).rows[0].count, '1');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('a task cannot be claimed twice while an embedding request is in flight', async () => {
  const { taskId } = await submission();
  let entered;
  const embeddingStarted = new Promise(resolve => { entered = resolve; });
  let resume;
  const gate = new Promise(resolve => { resume = resolve; });
  const first = processWith(fakeEmbedder(async texts => {
    entered();
    await gate;
    return texts.map(() => [1, 0, 0]);
  }), processor => processor.processNext(signal()));
  try {
    await embeddingStarted;
    assert.equal(await processWith(fakeEmbedder(), processor => processor.processNext(signal())), false);
    assert.equal((await taskState(taskId)).attempts_started, 1);
  } finally {
    resume();
    await first;
  }
});

test('partial batches are removed before a fresh retry, with no mixed or duplicate chunks', async () => {
  const source = Array.from({ length: 4000 }, (_, i) => `word${i} `).join('');
  const expected = chunkText(source);
  assert.ok(expected.length > 16);
  const { taskId } = await submission(source);
  let calls = 0;
  await processWith(fakeEmbedder(async texts => {
    calls++;
    if (calls === 2) {
      assert.equal((await pool.query('SELECT count(*) FROM chunks')).rows[0].count, '16');
      throw new Error('private failure');
    }
    return texts.map(() => [1, 0, 0]);
  }), processor => processor.processNext(signal()));
  assert.equal((await taskState(taskId)).status, 'pending');
  assert.equal((await pool.query('SELECT count(*) FROM chunks')).rows[0].count, '0');
  await processWith(fakeEmbedder(), processor => processor.processNext(signal()));
  assert.equal((await taskState(taskId)).attempts_started, 2);
  assert.equal((await taskState(taskId)).status, 'ready');
  const stored = await pool.query('SELECT position, text FROM chunks ORDER BY position');
  assert.deepEqual(stored.rows, expected.map((chunk, position) => ({ position, text: chunk.text })));
});

test('three transient failures stop retries and preserve the previous ready version', async () => {
  const { kbId } = await submission('Old source');
  await processWith(fakeEmbedder(), processor => processor.processNext(signal()));
  const oldVersion = (await pool.query('SELECT active_version_id FROM knowledge_bases WHERE id = $1', [kbId])).rows[0].active_version_id;
  const { taskId } = await submission('Replacement source', kbId);
  await processWith(fakeEmbedder(async () => { throw new Error('private provider details'); }), async processor => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      assert.equal(await processor.processNext(signal()), true);
      const task = await taskState(taskId);
      assert.equal(task.attempts_started, attempt);
      assert.equal(task.status, attempt === 3 ? 'failed' : 'pending');
      assert.equal(task.error_message, 'Ingestion failed while processing content.');
    }
    assert.equal(await processor.processNext(signal()), false);
  });
  assert.equal((await pool.query('SELECT active_version_id FROM knowledge_bases WHERE id = $1', [kbId])).rows[0].active_version_id, oldVersion);
  assert.equal((await pool.query('SELECT count(*) FROM content_versions')).rows[0].count, '1');
});

test('retry scheduling delays the next claim and permanent provider errors fail immediately', async () => {
  const { taskId } = await submission();
  const client = await pool.connect();
  try {
    const processor = new IngestionProcessor(client, fakeEmbedder(async () => { throw new Error('Transient'); }));
    await processor.processNext(signal());
    assert.equal(await processor.processNext(signal()), false);
    const state = await taskState(taskId);
    assert.equal(state.attempts_started, 1);
    assert.ok(state.next_attempt_at > state.updated_at);
    await pool.query('UPDATE ingestion_tasks SET next_attempt_at = now() WHERE id = $1', [taskId]);
    await new IngestionProcessor(client, fakeEmbedder(async () => {
      throw new IngestionError('embedding_provider_error', 'Embedding provider returned HTTP 401.', false);
    })).processNext(signal());
    assert.equal((await taskState(taskId)).status, 'failed');
    assert.equal((await taskState(taskId)).attempts_started, 2);
  } finally {
    client.release();
  }
});

test('startup recovery removes interrupted output and preserves the persisted attempt budget', async () => {
  const { taskId, kbId } = await submission();
  await pool.query("UPDATE ingestion_tasks SET status = 'processing', attempts_started = 2 WHERE id = $1", [taskId]);
  const version = await pool.query(`
    INSERT INTO content_versions (knowledge_base_id, ingestion_task_id, attempt_number, embedding_model, embedding_dimensions, chunking_config)
    VALUES ($1, $2, 2, 'fixture-model', 3, '{}') RETURNING id
  `, [kbId, taskId]);
  await pool.query("INSERT INTO chunks (version_id, position, text, token_count, embedding_dimensions, embedding) VALUES ($1, 0, 'Partial', 1, 3, '[1,0,0]')", [version.rows[0].id]);
  await processWith(fakeEmbedder(async () => { throw new Error('failure'); }), async processor => {
    await processor.recover();
    assert.equal((await taskState(taskId)).attempts_started, 2);
    assert.equal((await taskState(taskId)).status, 'pending');
    assert.equal((await pool.query('SELECT count(*) FROM chunks')).rows[0].count, '0');
    await processor.processNext(signal());
    await processor.recover();
    assert.equal((await taskState(taskId)).attempts_started, 3);
    assert.equal((await taskState(taskId)).status, 'failed');
    assert.equal(await processor.processNext(signal()), false);
  });
});

test('an interrupted third attempt becomes terminal during recovery', async () => {
  const { taskId } = await submission();
  await pool.query("UPDATE ingestion_tasks SET status = 'processing', attempts_started = 3 WHERE id = $1", [taskId]);
  await processWith(fakeEmbedder(), async processor => {
    await processor.recover();
    assert.equal((await taskState(taskId)).status, 'failed');
    assert.equal(await processor.processNext(signal()), false);
  });
});

test('failure during activation rolls back the version switch and task completion together', async () => {
  const { taskId } = await submission();
  await pool.query(`
    CREATE FUNCTION fail_activation() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.status = 'ready' THEN RAISE EXCEPTION 'activation failure'; END IF; RETURN NEW; END;
    $$;
    CREATE TRIGGER fail_activation BEFORE UPDATE ON ingestion_tasks FOR EACH ROW EXECUTE FUNCTION fail_activation();
  `);
  try {
    await processWith(fakeEmbedder(), processor => processor.processNext(signal()));
    assert.equal((await taskState(taskId)).status, 'pending');
    assert.equal((await pool.query('SELECT active_version_id FROM knowledge_bases')).rows[0].active_version_id, null);
    assert.equal((await pool.query('SELECT count(*) FROM content_versions')).rows[0].count, '0');
  } finally {
    await pool.query('DROP TRIGGER fail_activation ON ingestion_tasks; DROP FUNCTION fail_activation();');
  }
});

test('worker rejects a second instance, cancels on shutdown, and recovers interrupted work on restart', async () => {
  const { taskId } = await submission();
  let fatal = false;
  const first = await startIngestionWorker(pool, fakeEmbedder(async (_texts, signal) => {
    await setTimeout(60_000, undefined, { signal });
    throw new Error('Unexpected completion');
  }), () => { fatal = true; });
  try {
    await waitUntil(async () => (await taskState(taskId)).status === 'processing');
    assert.equal((await pilotStatus(pool)).workers.ingestion.status, 'working');
    // Freeze the real worker inside the controlled provider, leaving its lock
    // and database connection live. A timer must not disguise this as progress.
    await pool.query("UPDATE worker_progress SET last_progress_at=clock_timestamp()-interval '6 minutes' WHERE name='ingestion'");
    const stalled = await pilotStatus(pool);
    assert.equal(stalled.workers.ingestion_lock_held, true);
    assert.equal(stalled.workers.ingestion.status, 'stalled');
    const healthServer = createApp({ pool, apiKey: 'key'.repeat(20), ownerId: 'test-owner' }).listen(0, '127.0.0.1');
    try {
      await once(healthServer, 'listening');
      const health = await fetch(`http://127.0.0.1:${healthServer.address().port}/health`);
      assert.equal(health.status, 200);
      assert.equal((await health.json()).status, 'ok');
    } finally { await new Promise(resolve => healthServer.close(resolve)); }
    await assert.rejects(startIngestionWorker(pool, fakeEmbedder(), () => {}), /Another ingestion worker/);
  } finally {
    await first.stop();
  }
  assert.equal(fatal, false);
  assert.equal((await taskState(taskId)).status, 'processing');
  assert.equal((await pilotStatus(pool)).workers.ingestion.status, 'missing');
  const second = await startIngestionWorker(pool, fakeEmbedder(), () => { fatal = true; });
  try {
    await waitUntil(async () => (await taskState(taskId)).status === 'ready');
    assert.equal((await pilotStatus(pool)).workers.ingestion.status, 'idle');
    assert.equal((await taskState(taskId)).attempts_started, 2);
  } finally {
    await second.stop();
  }
  assert.equal(fatal, false);
});

test('worker progress writes are bounded and only explicit processing progress refreshes a stale worker', async t => {
  let elapsed = 0;
  t.mock.method(performance, 'now', () => elapsed);
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(1792627200,1)');
    const progress = new WorkerProgress(db, 'ingestion');
    await progress.record();
    assert.equal((await pilotStatus(db)).workers.ingestion.status, 'idle');
    await db.query("UPDATE worker_progress SET last_progress_at=clock_timestamp()-interval '6 minutes' WHERE name='ingestion'");
    elapsed = 9999;
    await progress.record();
    assert.equal((await pilotStatus(db)).workers.ingestion.status, 'unresponsive');
    elapsed = 300_000;
    // Time passing alone must not produce a fresh heartbeat.
    assert.equal((await pilotStatus(db)).workers.ingestion.status, 'unresponsive');
    await progress.record();
    assert.equal((await pilotStatus(db)).workers.ingestion.status, 'idle');
  } finally { await db.query('ROLLBACK'); db.release(); }
});

test('loss of the worker database connection reports a fatal failure and releases the lock', async () => {
  let fatal = false;
  const worker = await startIngestionWorker(pool, fakeEmbedder(), () => { fatal = true; });
  try {
    await pool.query(`
      SELECT pg_terminate_backend(pid) FROM pg_locks
      WHERE locktype = 'advisory' AND classid = 1792627200 AND objid = 1
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
    `);
    await waitUntil(() => fatal);
  } finally {
    await worker.stop();
  }
  const replacement = await startIngestionWorker(pool, fakeEmbedder(), () => {});
  await replacement.stop();
});

test('real OpenAI embedding can activate a submitted knowledge base', {
  skip: process.env.RUN_LIVE_EMBEDDING_TEST !== 'true',
}, async () => {
  assert.ok(process.env.OPENAI_API_KEY, 'Set OPENAI_API_KEY for the opt-in live check.');
  const { taskId } = await submission('Berlin is the capital of Germany.');
  await processWith(new OpenAIEmbedder(process.env.OPENAI_API_KEY, 'text-embedding-3-small', 1536), processor => processor.processNext(signal()));
  const state = await taskState(taskId);
  assert.equal(state.status, 'ready', state.error_message ?? undefined);
  assert.equal((await pool.query('SELECT vector_dims(embedding) AS dimensions FROM chunks')).rows[0].dimensions, 1536);
});
