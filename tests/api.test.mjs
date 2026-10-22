import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { createApp } from '../src/app.ts';

const key = randomBytes(32).toString('base64url');
const ownerId = 'api-test-owner';
const databaseName = `say_ai_api_test_${randomBytes(8).toString('hex')}`;
const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
let pool;
let created = false;
const servers = [];
let baseUrl;
let otherOwnerUrl;

async function startApp(owner = ownerId) {
  const server = createApp({ pool, apiKey: key, ownerId: owner }).listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

before(async () => {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL is required.');
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  created = true;
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `/${databaseName}`;
  await promisify(execFile)(process.execPath, [
    'node_modules/node-pg-migrate/bin/node-pg-migrate.js', 'up', '--no-verbose',
  ], { env: { ...process.env, DATABASE_URL: url.toString() } });
  pool = new pg.Pool({ connectionString: url.toString(), connectionTimeoutMillis: 3000 });
  baseUrl = await startApp();
  otherOwnerUrl = await startApp('other-owner');
});

after(async () => {
  for (const server of servers) {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  if (pool) await pool.end();
  try {
    if (created) await admin.query(`DROP DATABASE "${databaseName}"`);
  } finally {
    await admin.end();
  }
});

function post(body, options = {}) {
  return fetch(`${baseUrl}/knowledge-bases`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...options.headers },
    body: options.raw ?? JSON.stringify(body),
  });
}

async function createKnowledgeBase() {
  const response = await post({ text: 'Example content' });
  assert.equal(response.status, 201);
  return response.json();
}

test('missing, invalid, or malformed credentials return 401 before parsing JSON', async () => {
  for (const authorization of ['', `Bearer ${key}wrong`, `Basic ${key}`, `Bearer ${key} extra`]) {
    const response = await post({}, { headers: { Authorization: authorization }, raw: '{invalid' });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('www-authenticate'), 'Bearer');
    assert.equal((await response.json()).error.code, 'unauthorized');
  }
  const response = await fetch(`${baseUrl}/knowledge-bases/${randomUUID()}`);
  assert.equal(response.status, 401);
});

test('creation commits source and owner atomically, ignoring client-supplied ownership', async () => {
  const text = '  Preserve the exact source.\n';
  const response = await post({ text, owner_id: 'attacker', ownerId: 'attacker' });
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.deepEqual(result, { id: result.id, status: 'pending', queryable: false });
  assert.equal(response.headers.get('location'), `/knowledge-bases/${result.id}`);
  const stored = await pool.query(`
    SELECT kb.owner_id, task.source_text, task.status, task.attempts_started
    FROM knowledge_bases kb JOIN ingestion_tasks task ON task.knowledge_base_id = kb.id WHERE kb.id = $1
  `, [result.id]);
  assert.deepEqual(stored.rows, [{ owner_id: ownerId, source_text: text, status: 'pending', attempts_started: 0 }]);
  const restartedUrl = await startApp();
  const read = await fetch(`${restartedUrl}/knowledge-bases/${result.id}`, { headers: { Authorization: `Bearer ${key}` } });
  assert.equal(read.status, 200);
  assert.deepEqual(await read.json(), result);
});

test('invalid text, JSON, media types, and oversized bodies produce explicit errors', async () => {
  for (const body of [{}, { text: '' }, { text: ' \n\t' }, { text: 1 }, { text: null }, { text: 'null\0byte' }, []]) {
    const response = await post(body);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'invalid_text');
  }
  const invalid = await post({}, { raw: '{invalid' });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, 'invalid_json');
  const plain = await post({ text: 'content' }, { headers: { 'Content-Type': 'text/plain' } });
  assert.equal(plain.status, 415);
  const oversized = await post({ text: 'x'.repeat(1024 * 1024) });
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).error.code, 'payload_too_large');
});

test('malformed IDs return 400; missing and inaccessible knowledge bases return identical 404 responses', async () => {
  const malformed = await fetch(`${baseUrl}/knowledge-bases/not-a-uuid`, { headers: { Authorization: `Bearer ${key}` } });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), {
    error: { code: 'invalid_id', message: 'Knowledge base ID must be a valid UUID.' },
  });
  const kb = await createKnowledgeBase();
  const results = [];
  for (const url of [
    `${baseUrl}/knowledge-bases/${randomUUID()}`,
    `${otherOwnerUrl}/knowledge-bases/${kb.id}`,
  ]) {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
    assert.equal(response.status, 404);
    results.push(await response.json());
  }
  assert.deepEqual(results[0], results[1]);
});

test('metadata separates latest processing status from existing query availability', async () => {
  const kb = await createKnowledgeBase();
  const task = (await pool.query('SELECT id FROM ingestion_tasks WHERE knowledge_base_id = $1', [kb.id])).rows[0];
  await pool.query("UPDATE ingestion_tasks SET status = 'ready', attempts_started = 1 WHERE id = $1", [task.id]);
  const version = await pool.query(`
    INSERT INTO content_versions
      (knowledge_base_id, ingestion_task_id, attempt_number, embedding_model, embedding_dimensions, chunking_config, status, ready_at)
    VALUES ($1, $2, 1, 'fixture-model', 3, '{}', 'ready', now()) RETURNING id
  `, [kb.id, task.id]);
  await pool.query('UPDATE knowledge_bases SET active_version_id = $1 WHERE id = $2', [version.rows[0].id, kb.id]);
  await pool.query("INSERT INTO ingestion_tasks (knowledge_base_id, source_text) VALUES ($1, 'Replacement')", [kb.id]);
  const response = await fetch(`${baseUrl}/knowledge-bases/${kb.id}`, { headers: { Authorization: `Bearer ${key}` } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: kb.id, status: 'pending', queryable: true });
});

test('failed task insertion rolls back knowledge-base creation and hides database details', async () => {
  await pool.query(`
    CREATE FUNCTION reject_test_source() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.source_text = 'force-task-failure' THEN RAISE EXCEPTION 'private database details'; END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER reject_test_source BEFORE INSERT ON ingestion_tasks FOR EACH ROW EXECUTE FUNCTION reject_test_source();
  `);
  try {
    const before = (await pool.query('SELECT count(*) FROM knowledge_bases')).rows[0].count;
    const response = await post({ text: 'force-task-failure' });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: { code: 'internal_error', message: 'An internal error occurred.' } });
    const after = (await pool.query('SELECT count(*) FROM knowledge_bases')).rows[0].count;
    assert.equal(after, before);
  } finally {
    await pool.query('DROP TRIGGER reject_test_source ON ingestion_tasks; DROP FUNCTION reject_test_source();');
  }
});

test('health remains accessible without authentication', async () => {
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).database, 'connected');
});
