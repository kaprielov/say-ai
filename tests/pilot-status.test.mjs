import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { before, after, test } from 'node:test';
import pg from 'pg';
import { pilotStatus } from '../scripts/pilot-status.mjs';

const exec = promisify(execFile);
const name = `say_ai_pilot_test_${randomBytes(8).toString('hex')}`;
const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
let pool, created = false;
before(async () => {
  assert.ok(process.env.DATABASE_URL);
  await admin.query(`CREATE DATABASE "${name}"`); created = true;
  const url = new URL(process.env.DATABASE_URL); url.pathname = `/${name}`;
  await exec(process.execPath, ['node_modules/node-pg-migrate/bin/node-pg-migrate.js', 'up', '--no-verbose'], { env: { ...process.env, DATABASE_URL: url.toString() } });
  pool = new pg.Pool({ connectionString: url.toString() });
});
after(async () => { await pool?.end(); if (created) await admin.query(`DROP DATABASE "${name}"`); await admin.end(); });

test('operator snapshot exposes backlog and retry delay without content and performs no writes', async () => {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const base = (await db.query("INSERT INTO knowledge_bases(owner_id) VALUES ('private-owner') RETURNING id")).rows[0].id;
    await db.query(`INSERT INTO ingestion_tasks(knowledge_base_id,source_text,status,error_code,error_message)
      VALUES ($1,'private-source','failed','provider_unavailable','private-error'),
        ($1,'private-source','pending',NULL,NULL)`, [base]);
    await db.query(`INSERT INTO telegram_updates(bot_id,update_id,payload,done,available_at) VALUES
      (101,1,'{"text":"private-question"}',false,now()-interval '2 minutes'),
      (101,2,'{"text":"private-question"}',false,now()+interval '1 minute'),
      (101,3,NULL,true,now()-interval '1 hour')`);
    await db.query(`INSERT INTO telegram_outbox(bot_id,payload,attempts,available_at) VALUES
      (101,'{"text":"private-answer"}',2,now()+interval '1 minute')`);
    await db.query('SET TRANSACTION READ ONLY');
    const status = await pilotStatus(db);
    assert.equal(status.telegram.updates.pending, 2);
    assert.equal(status.telegram.updates.due, 1);
    assert.equal(status.telegram.updates.deferred, 1);
    assert.ok(status.telegram.updates.oldest_due_seconds >= 120);
    assert.equal(status.telegram.outbox.pending, 1);
    assert.equal(status.telegram.outbox.retrying, 1);
    assert.equal(status.telegram.outbox.due, 0);
    assert.equal(status.telegram.outbox.oldest_due_seconds, null);
    assert.equal(status.ingestion.pending, 1);
    assert.equal(status.ingestion.processing, 0);
    assert.equal(status.ingestion.failed, 1);
    assert.equal(status.ingestion.failed_last_24_hours, 1);
    assert.doesNotMatch(JSON.stringify(status), /private-|provider_unavailable|"bot_id"|"owner_id"/);
  } finally { await db.query('ROLLBACK'); db.release(); }
});

test('operator distinguishes idle queues and missing worker locks from held locks in this database', async () => {
  const db = await pool.connect();
  try {
    const idle = await pilotStatus(db);
    assert.equal(idle.telegram.updates.pending, 0);
    assert.equal(idle.telegram.outbox.pending, 0);
    assert.equal(idle.workers.ingestion_lock_held, false);
    assert.equal(idle.workers.telegram_lock_held, false);
    await db.query('SELECT pg_advisory_lock(1792627200,1), pg_advisory_lock(1792627200,2)');
    const active = await pilotStatus(pool);
    assert.equal(active.workers.ingestion_lock_held, true);
    assert.equal(active.workers.telegram_lock_held, true);
    assert.equal(active.ingestion.pending, 0);
  } finally { await db.query('SELECT pg_advisory_unlock_all()'); db.release(); }
  assert.equal((await pilotStatus(pool)).workers.telegram_lock_held, false);
});

test('CLI fails with a sanitized diagnostic instead of a connection string', async () => {
  const result = await exec(process.execPath, ['scripts/pilot-status.mjs'], {
    env: { ...process.env, DATABASE_URL: 'postgresql://private-user:private-password@127.0.0.1:1/private-db' },
  }).then(() => assert.fail('Expected a failing exit'), error => error);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).error, 'pilot_status_unavailable');
  assert.doesNotMatch(result.stderr, /private-|postgresql|stack/);
});

test('stopped, idle, deferred, stalled and resumed workers are distinguishable while the database stays available', async () => {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("INSERT INTO telegram_updates(bot_id,update_id,payload,available_at) VALUES (202,1,'{}',now()+interval '1 hour')");
    assert.equal((await pilotStatus(db)).workers.telegram.status, 'stopped');
    await db.query('SELECT pg_advisory_lock(1792627200,2)');
    assert.equal((await pilotStatus(db)).workers.telegram.status, 'unknown');
    await db.query(`INSERT INTO worker_progress(name,backend_pid,backend_start,last_progress_at)
      SELECT 'telegram',pid,backend_start,clock_timestamp() FROM pg_stat_activity WHERE pid=pg_backend_pid()`);
    assert.equal((await pilotStatus(db)).workers.telegram.status, 'idle');
    await db.query("UPDATE worker_progress SET backend_start=backend_start-interval '1 second' WHERE name='telegram'");
    assert.equal((await pilotStatus(db)).workers.telegram.status, 'unknown');
    await db.query("UPDATE worker_progress SET backend_start=(SELECT backend_start FROM pg_stat_activity WHERE pid=pg_backend_pid()) WHERE name='telegram'");
    await db.query("UPDATE telegram_updates SET available_at=now()-interval '1 minute' WHERE bot_id=202");
    assert.equal((await pilotStatus(db)).workers.telegram.status, 'working');
    await db.query("UPDATE worker_progress SET last_progress_at=now()-interval '6 minutes' WHERE name='telegram'");
    assert.equal((await db.query('SELECT 1 AS healthy')).rows[0].healthy, 1);
    const stalled = await pilotStatus(db);
    assert.equal(stalled.workers.telegram_lock_held, true);
    assert.equal(stalled.workers.telegram.status, 'stalled');
    assert.ok(stalled.workers.telegram.progress_age_seconds >= 360);
    assert.equal(stalled.attention_required, true);
    await db.query("UPDATE worker_progress SET last_progress_at=clock_timestamp() WHERE name='telegram'");
    const resumed = await pilotStatus(db);
    assert.equal(resumed.workers.telegram.status, 'working');
    assert.equal(resumed.attention_required, false);
    await db.query('SELECT pg_advisory_unlock_all()');
    const missing = await pilotStatus(db);
    assert.equal(missing.workers.telegram.status, 'missing');
    assert.equal(missing.attention_required, true);
  } finally { await db.query('ROLLBACK'); await db.query('SELECT pg_advisory_unlock_all()'); db.release(); }
});

test('progress migration rolls back and reapplies without changing queued work', async () => {
  const env = { ...process.env, DATABASE_URL: pool.options.connectionString };
  await pool.query("INSERT INTO telegram_updates(bot_id,update_id,payload) VALUES (303,1,'{}')");
  try {
    await exec(process.execPath, ['node_modules/node-pg-migrate/bin/node-pg-migrate.js', 'down', '1', '--no-verbose'], { env });
    assert.equal((await pool.query("SELECT to_regclass('worker_progress') AS name")).rows[0].name, null);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM telegram_updates WHERE bot_id=303')).rows[0].count, 1);
    await exec(process.execPath, ['node_modules/node-pg-migrate/bin/node-pg-migrate.js', 'up', '--no-verbose'], { env });
    assert.equal((await pilotStatus(pool)).workers.telegram.status, 'missing');
  } finally { await pool.query('DELETE FROM telegram_updates WHERE bot_id=303'); }
});
