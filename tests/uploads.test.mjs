import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import { TelegramService } from '../src/telegram/service.ts';
import { processUploadNext, startUploadWorker } from '../src/telegram/upload-worker.ts';
import { cleanupUploadDrafts } from '../src/telegram/uploads.ts';
import { transaction } from '../src/knowledge-bases/service.ts';
import { TelegramError } from '../src/telegram/client.ts';

const name = `say_ai_uploads_test_${randomBytes(8).toString('hex')}`;
const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const config = { token: '100:manager', managerId: '100', encryptionKey: randomBytes(32) };
let pool, created = false, nextUser = 1000;
before(async () => {
  assert.ok(process.env.DATABASE_URL);
  await admin.query(`CREATE DATABASE "${name}"`); created = true;
  const url = new URL(process.env.DATABASE_URL); url.pathname = `/${name}`;
  await promisify(execFile)(process.execPath, ['node_modules/node-pg-migrate/bin/node-pg-migrate.js', 'up', '--no-verbose'], { env: { ...process.env, DATABASE_URL: url.toString() } });
  pool = new pg.Pool({ connectionString: url.toString() });
});
after(async () => {
  await pool?.end();
  if (created) await admin.query(`DROP DATABASE "${name}"`);
  await admin.end();
});
async function fixture(download = async (_token, id) => Buffer.from(`Content ${id}.`)) {
  const user = ++nextUser;
  await pool.query("INSERT INTO telegram_sessions(user_id,language) VALUES ($1,'en')", [user]);
  const service = new TelegramService(pool, config, { async call() { return true; }, download });
  await transaction(pool, db => service.uploads.start(db, user, 'Documents'));
  const id = (await pool.query("SELECT id FROM upload_drafts WHERE user_id=$1 AND status='collecting'", [user])).rows[0].id;
  return { user, service, id };
}
async function add(f, messageId, filename = 'document.md', fileId = String(messageId), fileSize) {
  await transaction(pool, db => f.service.uploads.add(db, f.user, f.id, messageId, { file_id: fileId, file_name: filename, file_size: fileSize }));
}
async function action(f, prefix = 'ud', suffix = '') {
  return transaction(pool, db => f.service.uploads.action(db, f.user, `${prefix}:${f.id}${suffix}`));
}
async function state(f) { return (await pool.query('SELECT * FROM upload_drafts WHERE id=$1', [f.id])).rows[0]; }
async function source(f) { return (await pool.query('SELECT source_text FROM ingestion_tasks WHERE id=$1', [(await state(f)).task_id])).rows[0].source_text; }

// Every case owns its owner, draft and external transport.
test('explicit completion combines all files in message order and is idempotent', async () => {
  const f = await fixture();
  await add(f, 3, 'same.md'); await add(f, 1, 'same.md'); await add(f, 2);
  await add(f, 2); // Re-delivery does not add an item.
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM upload_draft_items WHERE draft_id=$1', [f.id])).rows[0].count, 3);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM knowledge_bases WHERE owner_id=$1', [`telegram:${f.user}`])).rows[0].count, 0);
  await action(f); await action(f);
  assert.equal(await processUploadNext(f.service), true);
  assert.equal(await source(f), 'Content 1.\n\nContent 2.\n\nContent 3.');
  await action(f);
  assert.equal(await processUploadNext(f.service), false);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM knowledge_bases WHERE owner_id=$1', [`telegram:${f.user}`])).rows[0].count, 1);
  await assert.rejects(add(f, 4), { code: 'upload_closed' });
});

test('draft controls enforce ownership, generation identity, removal and cancellation', async () => {
  const f = await fixture(); await add(f, 1);
  await assert.rejects(transaction(pool, db => f.service.uploads.action(db, f.user, `ud:${'-'.repeat(36)}`)), { code: 'expired_upload' });
  await assert.rejects(transaction(pool, db => f.service.uploads.action(db, f.user + 10000, `ud:${f.id}`)), { code: 'expired_upload' });
  const item = (await pool.query('SELECT id FROM upload_draft_items WHERE draft_id=$1', [f.id])).rows[0].id;
  await action(f, 'ur', `:${item}`);
  await assert.rejects(action(f), { code: 'empty_upload' });
  await add(f, 2); await action(f); await action(f, 'ux');
  assert.equal(await state(f), undefined);
  assert.equal(await processUploadNext(f.service), false);
  await transaction(pool, db => f.service.uploads.start(db, f.user, 'New generation'));
  await assert.rejects(action(f), { code: 'expired_upload' });
});

test('metadata limits and file count reject before downloading; exact limits are admissible', async () => {
  let downloads = 0;
  const f = await fixture(async () => { downloads++; return Buffer.from('text'); });
  await assert.rejects(add(f, 1, 'file.exe'), { code: 'unsupported_file_type' });
  await assert.rejects(add(f, 1, 'file.md', '1', 20_000_001), { code: 'payload_too_large' });
  await add(f, 1, 'one.md', '1', 20_000_000);
  await add(f, 2, 'two.md', '2', 20_000_000);
  await add(f, 3, 'three.md', '3', 10_000_000);
  await assert.rejects(add(f, 4, 'four.md', '4', 1), { code: 'batch_too_large' });
  assert.equal(downloads, 0);
  await action(f, 'ux');
  const many = await fixture();
  for (let i = 1; i <= 10; i++) await add(many, i);
  await assert.rejects(add(many, 11), { code: 'upload_item_limit' });
});

test('a bad document preserves valid items and creates no ingestion task until corrected', async () => {
  const f = await fixture(async (_token, id) => Buffer.from(id === 'bad' ? 'not a PDF' : 'Valid content.'));
  await add(f, 1); await add(f, 2, 'broken.pdf', 'bad'); await action(f);
  await processUploadNext(f.service);
  assert.equal((await state(f)).status, 'collecting');
  assert.equal((await state(f)).task_id, null);
  const items = (await pool.query('SELECT * FROM upload_draft_items WHERE draft_id=$1 ORDER BY message_id', [f.id])).rows;
  assert.equal(items[0].source_text, 'Valid content.'); assert.ok(items[1].error_message);
  await action(f, 'ur', `:${items[1].id}`); await action(f);
  await processUploadNext(f.service);
  assert.equal(await source(f), 'Valid content.');
});

test('combined text accounts for UTF-8 and separators and fails before ingestion', async () => {
  const f = await fixture(async () => Buffer.from('é'.repeat(1_310_720)));
  await add(f, 1); await add(f, 2); await action(f); await processUploadNext(f.service);
  assert.equal((await state(f)).status, 'collecting');
  assert.equal((await state(f)).task_id, null);
  const error = (await pool.query('SELECT error_message FROM upload_draft_items WHERE draft_id=$1 AND message_id=2', [f.id])).rows[0].error_message;
  assert.equal(error, 'Extracted text must not exceed 5 MiB.');
  await action(f, 'ux');
});

test('actual bytes override absent or understated metadata for total batch limits', async () => {
  const { docxFixture } = await import('./helpers/documents.mjs');
  const original = await docxFixture('Small text in a large file.');
  // ZIP readers tolerate trailing bytes; the original archive still holds the document.
  const bytes = Buffer.concat([original, Buffer.alloc(20_000_000 - original.length)]);
  const f = await fixture(async () => bytes);
  for (let i = 1; i <= 3; i++) await add(f, i, 'large.docx', String(i), 1);
  await action(f); await processUploadNext(f.service);
  assert.equal((await state(f)).status, 'collecting');
  const items = (await pool.query('SELECT * FROM upload_draft_items WHERE draft_id=$1 ORDER BY message_id', [f.id])).rows;
  assert.equal(items[0].actual_bytes, 20_000_000);
  assert.equal(items[1].actual_bytes, 20_000_000);
  assert.equal(items[2].error_message, 'Files in one upload must not exceed 50 MB in total.');
  assert.equal((await state(f)).task_id, null);
});

test('transient download failure retries without re-downloading already staged files', async () => {
  const calls = [];
  const f = await fixture(async (_token, id) => {
    calls.push(id);
    if (id === '2' && calls.filter(call => call === '2').length === 1) throw new TelegramError(502);
    return Buffer.from(`Content ${id}.`);
  });
  await add(f, 1); await add(f, 2); await action(f); await processUploadNext(f.service);
  assert.equal((await state(f)).status, 'queued');
  assert.equal((await state(f)).task_id, null);
  await pool.query('UPDATE upload_drafts SET available_at=now() WHERE id=$1', [f.id]);
  await processUploadNext(f.service);
  assert.deepEqual(calls, ['1','2','2']);
  assert.equal(await source(f), 'Content 1.\n\nContent 2.');
});

test('expiry releases draft ownership but cleanup leaves queued and preparing work alone', async () => {
  const expired = await fixture(); await add(expired, 1);
  const queued = await fixture(); await add(queued, 1); await action(queued);
  await pool.query("UPDATE upload_drafts SET expires_at=now()-interval '1 second' WHERE id=ANY($1::uuid[])", [[expired.id, queued.id]]);
  await transaction(pool, cleanupUploadDrafts);
  assert.equal(await state(expired), undefined); assert.equal((await state(queued)).status, 'queued');
  await processUploadNext(queued.service);
});

test('cancellation during a download prevents creating a base and frees admission', async () => {
  let release, started;
  const waiting = new Promise(resolve => { started = resolve; });
  const f = await fixture(async () => { started(); return new Promise(resolve => { release = resolve; }); });
  await add(f, 1); await action(f);
  const processing = processUploadNext(f.service);
  await waiting;
  // A different manager interaction completes while the download is still waiting.
  await transaction(pool, db => f.service.menu(db, f.user));
  await action(f, 'ux');
  release(Buffer.from('Downloaded text.')); await processing;
  assert.equal(await state(f), undefined);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM knowledge_bases WHERE owner_id=$1', [`telegram:${f.user}`])).rows[0].count, 0);
});

test('startup recovers interrupted preparation and enforces an exclusive worker', async () => {
  const f = await fixture(); await add(f, 1); await action(f);
  await pool.query("UPDATE upload_drafts SET status='preparing' WHERE id=$1", [f.id]);
  let resolve;
  const downloaded = new Promise(done => { resolve = done; });
  const original = f.service.api.download;
  f.service.api.download = async (...args) => { resolve(); return original(...args); };
  const worker = await startUploadWorker(f.service, () => assert.fail('Upload worker failed'));
  try {
    await assert.rejects(startUploadWorker(f.service, () => {}), /Another upload preparation worker/);
    await downloaded;
  } finally { await worker.stop(); }
  // Shutdown may interrupt after download, leaving durable work for the next startup.
  const recovered = await startUploadWorker(f.service, () => assert.fail('Upload worker failed'));
  try {
    for (let i = 0; i < 100 && (await state(f)).status !== 'submitted'; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal((await state(f)).status, 'submitted');
  } finally { await recovered.stop(); }
});

test('full outbox defers submission without duplicate tasks or stopping preparation', async () => {
  const { QueryError } = await import('../src/queries/errors.ts');
  const f = await fixture(); await add(f, 1); await action(f);
  const original = f.service.enqueue;
  f.service.enqueue = async () => { throw new QueryError(503, 'outbox_full', 'Server capacity is full. Try again later.'); };
  await processUploadNext(f.service);
  assert.equal((await state(f)).status, 'queued');
  assert.equal((await state(f)).task_id, null);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM knowledge_bases WHERE owner_id=$1', [`telegram:${f.user}`])).rows[0].count, 0);
  f.service.enqueue = original;
  await pool.query('UPDATE upload_drafts SET available_at=now() WHERE id=$1', [f.id]);
  await processUploadNext(f.service);
  assert.equal(await source(f), 'Content 1.');
});

test('full outbox also defers a file error notice while preserving editable content', async () => {
  const { QueryError } = await import('../src/queries/errors.ts');
  const f = await fixture(async () => Buffer.from('Invalid PDF.'));
  await add(f, 1, 'broken.pdf'); await action(f);
  const original = f.service.enqueue;
  f.service.enqueue = async () => { throw new QueryError(503, 'outbox_full', 'Server capacity is full. Try again later.'); };
  await processUploadNext(f.service);
  assert.equal((await state(f)).status, 'queued');
  f.service.enqueue = original;
  await pool.query('UPDATE upload_drafts SET available_at=now() WHERE id=$1', [f.id]);
  await processUploadNext(f.service);
  assert.equal((await state(f)).status, 'collecting');
  assert.equal((await state(f)).task_id, null);
});

test('global queue admission accepts its last slot and rejects one more without closing the draft', async () => {
  const f = await fixture(); await add(f, 1);
  const other = await fixture(); await add(other, 1);
  const jobs = (await pool.query(`INSERT INTO upload_drafts(user_id,name,status)
    SELECT 100000+number,'Queued fixture','queued' FROM generate_series(1,99) number RETURNING id`)).rows.map(row => row.id);
  try {
    await action(f);
    await assert.rejects(action(other), { code: 'upload_capacity_full' });
    assert.equal((await state(other)).status, 'collecting');
    await action(f, 'ux');
    await action(other);
    assert.equal((await state(other)).status, 'queued');
  } finally {
    await pool.query('DELETE FROM upload_drafts WHERE id=ANY($1::uuid[])', [jobs]);
    await action(other, 'ux');
  }
});

test('credentials are rechecked before creating an ingestion task', async () => {
  const f = await fixture(); await add(f, 1); await action(f);
  const service = new TelegramService(pool, config, f.service.api, undefined, { async available() { return false; } });
  await processUploadNext(service);
  assert.equal((await state(f)).status, 'collecting');
  assert.equal((await state(f)).task_id, null);
});

test('an exhausted interrupted job returns to its draft without another download', async () => {
  let downloads = 0;
  const f = await fixture(async () => { downloads++; return Buffer.from('text'); });
  await add(f, 1); await action(f);
  // Startup recovery requeues preparation while retaining its consumed attempts.
  await pool.query("UPDATE upload_drafts SET attempts=3,status='queued' WHERE id=$1", [f.id]);
  await processUploadNext(f.service);
  assert.equal(downloads, 0);
  assert.equal((await state(f)).status, 'collecting');
  assert.equal((await state(f)).task_id, null);
});

test('upload draft migration rolls back and reapplies in the disposable database', async () => {
  const url = new URL(process.env.DATABASE_URL); url.pathname = `/${name}`;
  const run = (...args) => promisify(execFile)(process.execPath, ['node_modules/node-pg-migrate/bin/node-pg-migrate.js', ...args, '--no-verbose'], { env: { ...process.env, DATABASE_URL: url.toString() } });
  const rollbackCount = (await pool.query("SELECT count(*)::int AS count FROM pgmigrations WHERE id >= (SELECT id FROM pgmigrations WHERE name='1793404800000_upload_drafts')")).rows[0].count;
  await run('down', String(rollbackCount));
  assert.equal((await pool.query("SELECT to_regclass('upload_drafts') AS name")).rows[0].name, null);
  await run('up');
  await fixture();
});
