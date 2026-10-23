import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import { after, before, beforeEach, test } from 'node:test';
import pg from 'pg';
import { createApp } from '../src/app.ts';
import { IngestionError } from '../src/ingestion/embeddings.ts';
import { IngestionProcessor } from '../src/ingestion/processor.ts';
import { QuestionAnswering } from '../src/queries/service.ts';
import { QueryLimits } from '../src/queries/limits.ts';

const databaseName = `say_ai_replacement_test_${randomBytes(8).toString('hex')}`;
const key = randomBytes(32).toString('base64url');
const ownerId = 'replacement-test-owner';
const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const fakeEmbedder = (embed = async texts => texts.map(() => [1, 0, 0])) => ({
  model: 'text-embedding-3-small', dimensions: 3, embed,
});
let pool;
let server;
let url;
let created = false;

before(async () => {
  assert.ok(process.env.DATABASE_URL);
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  created = true;
  const databaseUrl = new URL(process.env.DATABASE_URL);
  databaseUrl.pathname = `/${databaseName}`;
  await promisify(execFile)(process.execPath, ['node_modules/node-pg-migrate/bin/node-pg-migrate.js', 'up', '--no-verbose'], {
    env: { ...process.env, DATABASE_URL: databaseUrl.toString() },
  });
  pool = new pg.Pool({ connectionString: databaseUrl.toString(), connectionTimeoutMillis: 3000 });
  const questions = new QuestionAnswering({
    pool, limits: new QueryLimits(), embedder: () => fakeEmbedder(),
    answerer: { answer: async (_question, context) => ({ outcome: 'answered', answer: context[0].text, chunk_ids: [context[0].id] }) },
  });
  server = createApp({ pool, apiKey: key, ownerId, questions }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  url = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(async () => {
  await pool.query('TRUNCATE chunks, content_versions, ingestion_tasks, knowledge_bases');
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (pool) await pool.end();
  try {
    if (created) await admin.query(`DROP DATABASE "${databaseName}"`);
  } finally {
    await admin.end();
  }
});

async function createKnowledgeBase() {
  const response = await fetch(`${url}/knowledge-bases`, { method: 'POST', headers, body: JSON.stringify({ text: 'Our shop closes at 6 PM.' }) });
  assert.equal(response.status, 201);
  return response.json();
}

async function processWith(embedder = fakeEmbedder(), work = processor => processor.processNext(new AbortController().signal)) {
  const client = await pool.connect();
  try {
    return await work(new IngestionProcessor(client, embedder, [0, 0]));
  } finally {
    client.release();
  }
}

async function createReady() {
  const kb = await createKnowledgeBase();
  await processWith();
  return kb;
}

function replace(id, text = 'Our shop now closes at 9 PM.', options = {}) {
  return fetch(`${url}/knowledge-bases/${id}/content`, {
    method: 'PUT', headers: { ...headers, ...options.headers }, body: options.raw ?? JSON.stringify({ text }),
  });
}

async function metadata(id) {
  const response = await fetch(`${url}/knowledge-bases/${id}`, { headers });
  assert.equal(response.status, 200);
  return response.json();
}

function question(id) {
  return fetch(`${url}/knowledge-bases/${id}/queries`, {
    method: 'POST', headers, body: JSON.stringify({ question: 'When does the shop close?' }),
  });
}

test('replacement keeps old answers while pending and processing, then atomically switches to new content', async () => {
  const kb = await createReady();
  const text = '  Our shop now closes at 9 PM.\n';
  const response = await replace(kb.id, text);
  assert.equal(response.status, 202);
  assert.equal(response.headers.get('location'), `/knowledge-bases/${kb.id}`);
  assert.deepEqual(await response.json(), { id: kb.id, status: 'pending', queryable: true });
  assert.deepEqual(await metadata(kb.id), { id: kb.id, status: 'pending', queryable: true });
  assert.equal((await (await question(kb.id)).json()).answer, 'Our shop closes at 6 PM.');
  const stored = await pool.query("SELECT source_text, attempts_started FROM ingestion_tasks WHERE status = 'pending'");
  assert.deepEqual(stored.rows, [{ source_text: text, attempts_started: 0 }]);

  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let resume;
  const gate = new Promise(resolve => { resume = resolve; });
  const processing = processWith(fakeEmbedder(async texts => {
    entered();
    await gate;
    return texts.map(() => [1, 0, 0]);
  }));
  try {
    await started;
    assert.deepEqual(await metadata(kb.id), { id: kb.id, status: 'processing', queryable: true });
    assert.equal((await (await question(kb.id)).json()).answer, 'Our shop closes at 6 PM.');
    assert.equal((await replace(kb.id, 'Overlapping content')).status, 409);
  } finally {
    resume();
    await processing;
  }
  assert.deepEqual(await metadata(kb.id), { id: kb.id, status: 'ready', queryable: true });
  const answer = await (await question(kb.id)).json();
  assert.equal(answer.answer, text);
  assert.deepEqual(answer.sources.map(source => source.text), [text]);
  assert.equal((await pool.query('SELECT count(*) FROM content_versions')).rows[0].count, '2');
});

test('an in-flight question keeps its captured version after a replacement activates', async () => {
  const kb = await createReady();
  assert.equal((await replace(kb.id)).status, 202);
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let resume;
  const gate = new Promise(resolve => { resume = resolve; });
  const questions = new QuestionAnswering({
    pool, limits: new QueryLimits(),
    embedder: () => fakeEmbedder(async texts => {
      entered();
      await gate;
      return texts.map(() => [1, 0, 0]);
    }),
    answerer: { answer: async (_question, context) => ({ outcome: 'answered', answer: context[0].text, chunk_ids: [context[0].id] }) },
  });
  const inFlightServer = createApp({ pool, apiKey: key, ownerId, questions }).listen(0, '127.0.0.1');
  await once(inFlightServer, 'listening');
  const pending = fetch(`http://127.0.0.1:${inFlightServer.address().port}/knowledge-bases/${kb.id}/queries`, {
    method: 'POST', headers, body: JSON.stringify({ question: 'When does the shop close?' }),
  });
  try {
    await started;
    await processWith();
    assert.equal((await (await question(kb.id)).json()).answer, 'Our shop now closes at 9 PM.');
  } finally {
    resume();
    const response = await pending;
    assert.equal(response.status, 200);
    assert.equal((await response.json()).answer, 'Our shop closes at 6 PM.');
    await new Promise(resolve => inFlightServer.close(resolve));
  }
});

test('simultaneous replacements accept one submission and return 409 for the other', async () => {
  const kb = await createReady();
  const texts = ['First replacement', 'Second replacement'];
  const responses = await Promise.all(texts.map(text => replace(kb.id, text)));
  assert.deepEqual(responses.map(response => response.status).sort(), [202, 409]);
  const accepted = responses.findIndex(response => response.status === 202);
  const rejected = responses.find(response => response.status === 409);
  assert.equal((await rejected.json()).error.code, 'ingestion_in_progress');
  const tasks = await pool.query("SELECT source_text FROM ingestion_tasks WHERE status IN ('pending', 'processing')");
  assert.deepEqual(tasks.rows, [{ source_text: texts[accepted] }]);
  assert.equal((await pool.query('SELECT count(*) FROM ingestion_tasks')).rows[0].count, '2');
});

test('replacement is rejected while the initial submission is pending', async () => {
  const kb = await createKnowledgeBase();
  const response = await replace(kb.id);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'ingestion_in_progress');
  assert.equal((await pool.query('SELECT count(*) FROM ingestion_tasks')).rows[0].count, '1');
});

test('failed initial ingestion can be replaced, but queries remain unavailable until it succeeds', async () => {
  const kb = await createKnowledgeBase();
  await processWith(fakeEmbedder(async () => { throw new IngestionError('invalid_input', 'Permanent failure.', false); }));
  assert.deepEqual(await metadata(kb.id), { id: kb.id, status: 'failed', queryable: false });
  const response = await replace(kb.id);
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { id: kb.id, status: 'pending', queryable: false });
  assert.equal((await question(kb.id)).status, 409);
  await processWith();
  assert.equal((await (await question(kb.id)).json()).answer, 'Our shop now closes at 9 PM.');
});

test('terminal replacement failure preserves old answers and allows a fresh submission with a new attempt budget', async () => {
  const kb = await createReady();
  assert.equal((await replace(kb.id)).status, 202);
  await processWith(fakeEmbedder(async () => { throw new Error('Transient provider failure'); }), async processor => {
    for (let i = 0; i < 3; i++) await processor.processNext(new AbortController().signal);
  });
  assert.deepEqual(await metadata(kb.id), { id: kb.id, status: 'failed', queryable: true });
  assert.equal((await (await question(kb.id)).json()).answer, 'Our shop closes at 6 PM.');
  assert.equal((await replace(kb.id, 'A fresh submission.')).status, 202);
  const tasks = await pool.query('SELECT status, attempts_started FROM ingestion_tasks ORDER BY created_at');
  assert.deepEqual(tasks.rows, [
    { status: 'ready', attempts_started: 1 }, { status: 'failed', attempts_started: 3 }, { status: 'pending', attempts_started: 0 },
  ]);
  await processWith();
  assert.equal((await (await question(kb.id)).json()).answer, 'A fresh submission.');
});

test('interrupted replacement is recovered from its durable source without losing the old version or resetting attempts', async () => {
  const kb = await createReady();
  assert.equal((await replace(kb.id)).status, 202);
  const controller = new AbortController();
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const processing = processWith(fakeEmbedder(async (_texts, signal) => {
    entered();
    await setTimeout(60_000, undefined, { signal });
    throw new Error('Unexpected completion');
  }), processor => processor.processNext(controller.signal));
  const interrupted = assert.rejects(processing);
  await started;
  controller.abort();
  await interrupted;
  assert.deepEqual(await metadata(kb.id), { id: kb.id, status: 'processing', queryable: true });
  assert.equal((await (await question(kb.id)).json()).answer, 'Our shop closes at 6 PM.');
  await processWith(fakeEmbedder(), async processor => {
    await processor.recover();
    assert.deepEqual(await metadata(kb.id), { id: kb.id, status: 'pending', queryable: true });
    await processor.processNext(new AbortController().signal);
  });
  const task = await pool.query('SELECT attempts_started FROM ingestion_tasks ORDER BY created_at DESC LIMIT 1');
  assert.equal(task.rows[0].attempts_started, 2);
  assert.equal((await (await question(kb.id)).json()).answer, 'Our shop now closes at 9 PM.');
});

test('replacement validates authentication, ownership, IDs, and content without creating tasks', async () => {
  const kb = await createReady();
  const count = async () => (await pool.query('SELECT count(*) FROM ingestion_tasks')).rows[0].count;
  const initial = await count();
  for (const authorization of ['', 'Bearer invalid']) {
    assert.equal((await replace(kb.id, 'text', { headers: { Authorization: authorization }, raw: '{invalid' })).status, 401);
  }
  assert.equal((await replace('not-a-uuid')).status, 400);
  const other = (await pool.query("INSERT INTO knowledge_bases (owner_id) VALUES ('other-owner') RETURNING id")).rows[0].id;
  const absent = await replace(randomUUID());
  const inaccessible = await replace(other);
  assert.equal(absent.status, 404);
  assert.equal(inaccessible.status, 404);
  assert.deepEqual(await absent.json(), await inaccessible.json());
  for (const text of ['', ' \n', null, 2, 'null\0byte']) {
    const response = await replace(kb.id, text);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'invalid_text');
  }
  assert.equal((await replace(kb.id, 'text', { raw: '{}' })).status, 400);
  assert.equal((await replace(kb.id, 'text', { raw: '{invalid' })).status, 400);
  assert.equal((await replace(kb.id, 'text', { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await replace(kb.id, 'x'.repeat(1024 * 1024))).status, 413);
  assert.equal(await count(), initial);
});

test('database failure before acceptance rolls back all replacement writes and returns a sanitized error', async () => {
  const kb = await createReady();
  const before = (await pool.query('SELECT active_version_id, updated_at FROM knowledge_bases WHERE id = $1', [kb.id])).rows[0];
  await pool.query(`
    CREATE FUNCTION reject_replacement() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'private database details'; END;
    $$;
    CREATE TRIGGER reject_replacement BEFORE INSERT ON ingestion_tasks FOR EACH ROW EXECUTE FUNCTION reject_replacement();
  `);
  try {
    const response = await replace(kb.id);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: { code: 'internal_error', message: 'An internal error occurred.' } });
    assert.equal((await pool.query('SELECT count(*) FROM ingestion_tasks')).rows[0].count, '1');
    const after = (await pool.query('SELECT active_version_id, updated_at FROM knowledge_bases WHERE id = $1', [kb.id])).rows[0];
    assert.deepEqual(after, before);
    assert.equal((await (await question(kb.id)).json()).answer, 'Our shop closes at 6 PM.');
  } finally {
    await pool.query('DROP TRIGGER reject_replacement ON ingestion_tasks; DROP FUNCTION reject_replacement();');
  }
  assert.equal((await replace(kb.id)).status, 202);
});
