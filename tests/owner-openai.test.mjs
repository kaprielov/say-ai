import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { before, after, test } from 'node:test';
import pg from 'pg';
import { OwnerOpenAI } from '../src/providers/owner-openai.ts';
import { TelegramService } from '../src/telegram/service.ts';
import { createApp } from '../src/app.ts';
import { verifyWebAppUser } from '../src/telegram/webapp-auth.ts';
import { transaction, createKnowledgeBase } from '../src/knowledge-bases/service.ts';
import { IngestionProcessor } from '../src/ingestion/processor.ts';
import { OpenAIEmbedder } from '../src/ingestion/embeddings.ts';
import { QuestionAnswering } from '../src/queries/service.ts';
import { processUpdate } from '../src/telegram/worker.ts';

const databaseName = `say_ai_keys_test_${randomBytes(8).toString('hex')}`;
const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const config = { token: '100:manager', managerId: '100', webhookSecret: 'secret'.repeat(8), publicUrl: 'https://example.com', encryptionKey: randomBytes(32), dailyQueries: 100 };
const alpha = 'sk-test-owner-alpha-1234567890', beta = 'sk-test-owner-beta-1234567890', invalid = 'sk-test-invalid-1234567890';
let pool, db, server, url, keys, service, created = false, seq = 0;
const requests = [];
const provider = async (target, options) => {
  const body = JSON.parse(options.body);
  requests.push({ target, key: options.headers.Authorization, body });
  if (options.headers.Authorization === `Bearer ${invalid}`) return Response.json({ error: {} }, { status: 401 });
  if (options.headers.Authorization === 'Bearer sk-test-limited-1234567890') return Response.json({ error: {} }, { status: 429 });
  if (target.endsWith('/embeddings')) {
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    return Response.json({ data: inputs.map((_input, index) => ({ index, embedding: [1, ...Array(body.dimensions - 1).fill(0)] })) });
  }
  if (body.input === 'Reply OK.') return Response.json({ status: 'completed', output: [] });
  if (body.text?.format?.name === 'question_topic') return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ topic: 'related' }) }] }] });
  if (body.text?.format?.name === 'answer_support') return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ supported: true }) }] }] });
  const input = JSON.parse(body.input[0].content);
  return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ outcome: 'answered', answer: 'The shop opens at 9 AM.', chunk_ids: [input.context[0].id] }) }] }] });
};
function signed(user, timestamp = Math.floor(Date.now() / 1000)) {
  const params = new URLSearchParams({ user: JSON.stringify({ id: user, first_name: 'Test' }), auth_date: String(timestamp), query_id: 'test-query' });
  const data = [...params.entries()].sort(([a], [b]) => a < b ? -1 : 1).map(([name, value]) => `${name}=${value}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(config.token).digest();
  params.set('hash', createHmac('sha256', secret).update(data).digest('hex'));
  return params.toString();
}
async function submit(user, key, options = {}) {
  return fetch(`${url}/telegram/openai-key`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://example.com', ...options.headers }, body: JSON.stringify({ initData: options.initData ?? signed(user), key, owner_id: 'telegram:999' }) });
}
async function message(user, text) {
  await pool.query('INSERT INTO telegram_updates (bot_id, update_id, payload) VALUES (100, $1, $2)', [++seq, { update_id: seq, message: { from: { id: user }, chat: { id: user, type: 'private' }, text } }]);
  await processUpdate(service, db);
}
before(async () => {
  await admin.query(`CREATE DATABASE "${databaseName}"`); created = true;
  const connection = new URL(process.env.DATABASE_URL); connection.pathname = `/${databaseName}`;
  await promisify(execFile)(process.execPath, ['node_modules/node-pg-migrate/bin/node-pg-migrate.js', 'up', '--no-verbose'], { env: { ...process.env, DATABASE_URL: connection.toString() } });
  pool = new pg.Pool({ connectionString: connection.toString() }); db = await pool.connect();
  keys = new OwnerOpenAI(pool, config.encryptionKey, 'developer-only-key', 'text-embedding-3-small', 3, provider);
  service = new TelegramService(pool, config, { async call() { return true; }, async download() { return Buffer.from('source'); } }, undefined, keys);
  server = createApp({ pool, apiKey: 'test'.repeat(16), ownerId: 'developer', telegram: service }).listen(0, '127.0.0.1');
  await once(server, 'listening'); url = `http://127.0.0.1:${server.address().port}`;
  await pool.query("INSERT INTO telegram_sessions (user_id, language) VALUES (1, 'en'), (2, 'ru'), (3, 'en'), (4, 'en')");
});
after(async () => {
  if (server) await new Promise(resolve => server.close(resolve)); db?.release(); await pool?.end();
  if (created) await admin.query(`DROP DATABASE "${databaseName}"`); await admin.end();
});

test('Mini App authentication rejects forgery, replay expiry, duplicate fields, and another manager token', () => {
  assert.equal(verifyWebAppUser(signed(1), config.token), 1);
  assert.throws(() => verifyWebAppUser(signed(1).replace('test-query', 'changed'), config.token), { status: 401 });
  assert.throws(() => verifyWebAppUser(signed(1, Math.floor(Date.now() / 1000) - 601), config.token), { status: 401 });
  assert.throws(() => verifyWebAppUser(signed(1, Math.floor(Date.now() / 1000) + 60), config.token), { status: 401 });
  assert.throws(() => verifyWebAppUser(signed(1) + '&auth_date=1', config.token), { status: 401 });
  assert.throws(() => verifyWebAppUser(signed(1), '200:other'), { status: 401 });
});

test('form uses password input, CSP, no-store, and sends directly to the backend', async () => {
  const response = await fetch(`${url}/telegram/openai-key?lang=ru`);
  const html = await response.text();
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.ok(response.headers.get('content-security-policy').includes("default-src 'none'"));
  assert.ok(!response.headers.get('content-security-policy').includes('unsafe-inline'));
  assert.match(html, /type="password"/); assert.match(html, /Подключите свой ключ/);
  assert.ok(!html.includes('sendData(')); assert.ok(!html.includes('localStorage'));
});

test('manager introduces its purpose before requiring a key and blocks sources without a key', async () => {
  await message(1, '/start');
  let last = (await pool.query("SELECT payload FROM telegram_outbox WHERE payload->>'chat_id' = '1' ORDER BY id DESC LIMIT 1")).rows[0].payload;
  assert.match(last.text, /Connect your OpenAI/);
  assert.equal(last.reply_markup.inline_keyboard[0][0].web_app.url, 'https://example.com/telegram/openai-key?lang=en');
  await message(1, 'Source content before connecting');
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM knowledge_bases WHERE owner_id = 'telegram:1'")).rows[0].count, 0);
});

test('the form binds to the signed owner, validates both capabilities, and encrypts the saved key', async () => {
  assert.equal((await submit(1, alpha, { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await submit(1, alpha, { initData: signed(2).replace('Test', 'Forged') })).status, 401);
  const initial = requests.length;
  const response = await submit(1, alpha);
  assert.equal(response.status, 200);
  assert.equal(requests.length, initial + 2);
  assert.ok(await keys.available('telegram:1')); assert.ok(!(await keys.available('telegram:999')));
  assert.equal((await submit(2, beta)).status, 200);
  const stored = (await pool.query('SELECT * FROM owner_openai_keys')).rows;
  assert.ok(!JSON.stringify(stored).includes(alpha)); assert.ok(!JSON.stringify(stored).includes(beta));
  const queues = await pool.query('SELECT payload FROM telegram_updates UNION ALL SELECT payload FROM telegram_outbox');
  assert.ok(!JSON.stringify(queues.rows).includes(alpha)); assert.ok(!JSON.stringify(queues.rows).includes(beta));
  assert.match((await pool.query("SELECT payload->>'text' AS text FROM telegram_outbox WHERE payload->>'chat_id' = '2' ORDER BY id DESC LIMIT 1")).rows[0].text, /Управляйте базами знаний/);
});

test('invalid replacement preserves the previous key and validation is rate limited', async () => {
  assert.equal((await submit(1, invalid)).status, 400);
  assert.ok(await keys.available('telegram:1'));
  const resolved = await keys.providers('telegram:1');
  await resolved.embedder.embed(['Verify old key'], new AbortController().signal);
  assert.equal(requests.at(-1).key, `Bearer ${alpha}`);
  assert.equal((await submit(1, beta)).status, 200);
  assert.equal((await submit(1, alpha)).status, 429);
});

test('owner resolution never falls back to the developer key and revoked old requests cannot invalidate replacements', async () => {
  await assert.rejects(keys.providers('telegram:3'), { code: 'openai_key_required' });
  await keys.save('telegram:3', invalid);
  const stale = await keys.providers('telegram:3');
  await keys.save('telegram:3', alpha);
  await assert.rejects(stale.embedder.embed(['Old request'], new AbortController().signal));
  assert.ok(await keys.available('telegram:3'));
  await keys.save('telegram:4', invalid);
  const revoked = await keys.providers('telegram:4');
  await assert.rejects(revoked.embedder.embed(['Revoked request'], new AbortController().signal));
  assert.ok(!(await keys.available('telegram:4')));
});

test('indexing and answering use the base owner key rather than the global key or a different owner key', async () => {
  const kb = await transaction(pool, client => createKnowledgeBase(client, 'telegram:2', 'The shop opens at 9 AM.', 'Shop'));
  const processor = new IngestionProcessor(db, new OpenAIEmbedder('must-not-be-used', 'text-embedding-3-small', 3), undefined,
    owner => keys.ingestionEmbedder(owner, 'text-embedding-3-small', 3));
  const before = requests.length;
  await processor.processNext(new AbortController().signal);
  const answers = new QuestionAnswering({ pool, embedder() { throw new Error('Global provider was used'); }, answerer: { async answer() { throw new Error('Global provider was used'); } },
    providers: (owner, model, dimensions) => keys.providers(owner, model, dimensions) });
  const response = await answers.ask(kb.id, 'telegram:2', 'When does the shop open?', new AbortController().signal);
  assert.equal(response.outcome, 'answered');
  assert.ok(requests.slice(before).length >= 3);
  assert.ok(requests.slice(before).every(request => request.key === `Bearer ${beta}`));
  assert.equal(requests.slice(before).filter(request => request.target.endsWith('/responses')).length, 1);
  assert.ok(!requests.slice(before).some(request => ['question_topic', 'answer_support'].includes(request.body.text?.format?.name)));
  await keys.remove('telegram:2');
  await assert.rejects(answers.ask(kb.id, 'telegram:2', 'When?', new AbortController().signal), { code: 'openai_key_required' });
});

test('a mistakenly pasted key is redacted before the update queue and scheduled for deletion', async () => {
  const response = await fetch(`${url}/telegram/webhook/100`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': config.webhookSecret }, body: JSON.stringify({ update_id: ++seq, message: { message_id: 123, from: { id: 1 }, chat: { id: 1, type: 'private' }, text: alpha } }) });
  assert.equal(response.status, 200);
  const row = (await pool.query('SELECT payload FROM telegram_updates WHERE update_id = $1', [seq])).rows[0];
  assert.equal(row.payload.message.text, '/openai'); assert.ok(!JSON.stringify(row).includes(alpha));
  await processUpdate(service, db);
  assert.ok((await pool.query("SELECT 1 FROM telegram_outbox WHERE method = 'deleteMessage' AND payload->>'message_id' = '123'")).rows.length);
});

test('a missing owner key fails ingestion without any global provider request', async () => {
  const kb = await transaction(pool, client => createKnowledgeBase(client, 'telegram:4', 'Source for missing owner key.'));
  const before = requests.length;
  await new IngestionProcessor(db, new OpenAIEmbedder('must-not-be-used', 'text-embedding-3-small', 3), undefined,
    owner => keys.ingestionEmbedder(owner, 'text-embedding-3-small', 3)).processNext(new AbortController().signal);
  const task = (await pool.query('SELECT status, error_code FROM ingestion_tasks WHERE knowledge_base_id = $1', [kb.id])).rows[0];
  assert.equal(task.status, 'failed'); assert.equal(task.error_code, 'owner_key_unavailable');
  assert.equal(requests.length, before);
});

test('quota errors are localized and an invalid stored key can still be removed from settings', async () => {
  const limited = await submit(2, 'sk-test-limited-1234567890');
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).error.code, 'key_quota');
  await message(4, '/openai');
  const settings = (await pool.query("SELECT payload FROM telegram_outbox WHERE payload->>'chat_id' = '4' ORDER BY id DESC LIMIT 1")).rows[0].payload;
  assert.ok(settings.reply_markup.inline_keyboard.some(row => row.some(button => button.callback_data === 'remove_key')));
  await pool.query('INSERT INTO telegram_updates (bot_id, update_id, payload) VALUES (100, $1, $2)', [++seq, { update_id: seq, callback_query: { id: 'remove-key', from: { id: 4 }, message: { chat: { id: 4, type: 'private' } }, data: 'confirm_remove_key' } }]);
  await processUpdate(service, db);
  assert.equal(await keys.stored('telegram:4'), false);
  assert.equal(await keys.available('telegram:3'), true);
});

test('Telegram provider routing works without a server OpenAI key', async () => {
  const withoutServerKey = new OwnerOpenAI(pool, config.encryptionKey, undefined, 'text-embedding-3-small', 3, provider);
  const owner = await withoutServerKey.providers('telegram:3');
  await owner.embedder.embed(['Owner key only'], new AbortController().signal);
  assert.equal(requests.at(-1).key, `Bearer ${alpha}`);
  await assert.rejects(withoutServerKey.providers('developer'), { status: 503 });
});
