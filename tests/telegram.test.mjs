import { QueryError } from '../src/queries/errors.ts';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { createApp } from '../src/app.ts';
import { TelegramService } from '../src/telegram/service.ts';
import { encryptToken, decryptToken, TelegramError } from '../src/telegram/client.ts';
import { processUpdate, processOutbox, notifyIngestion, startTelegramWorker, refreshWebhooks } from '../src/telegram/worker.ts';

const databaseName = `say_ai_telegram_test_${randomBytes(8).toString('hex')}`;
const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const config = { token: '100:manager', managerId: '100', webhookSecret: 'secret'.repeat(8), publicUrl: 'https://example.com', encryptionKey: randomBytes(32), dailyQueries: 2 };
let pool, db, server, baseUrl, service, created = false;
let sequence = 0;
const calls = [], answers = [];
const api = {
  async call(token, method, payload) {
    calls.push({ token, method, payload });
    if (method === 'getManagedBotToken') return `${payload.user_id}:child`;
    if (method === 'getMe') return { id: Number(token.split(':')[0]), is_bot: true };
    return true;
  },
  async download() { return Buffer.from('The store opens at 9 AM.'); },
};
const questions = { async ask(kb, owner, question) {
  answers.push({ kb, owner, question });
  return { outcome: 'answered', answer: 'The store opens at 9 AM.', sources: [] };
} };

before(async () => {
  assert.ok(process.env.DATABASE_URL);
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  created = true;
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `/${databaseName}`;
  await promisify(execFile)(process.execPath, ['node_modules/node-pg-migrate/bin/node-pg-migrate.js', 'up', '--no-verbose'], { env: { ...process.env, DATABASE_URL: url.toString() } });
  pool = new pg.Pool({ connectionString: url.toString() });
  db = await pool.connect();
  await pool.query("INSERT INTO telegram_sessions (user_id, language) SELECT user_id, 'en' FROM generate_series(10, 23) user_id");
  await pool.query("INSERT INTO telegram_sessions (user_id, language) VALUES (999, 'en')");
  service = new TelegramService(pool, config, api, questions);
  server = createApp({ pool, apiKey: 'key'.repeat(20), ownerId: 'developer', telegram: service }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  db?.release();
  await pool?.end();
  if (created) await admin.query(`DROP DATABASE "${databaseName}"`);
  await admin.end();
});

function message(user, text, extra = {}) {
  return { update_id: ++sequence, message: { from: { id: user }, chat: { id: user, type: 'private' }, text, ...extra } };
}
function callback(user, data) {
  return { update_id: ++sequence, callback_query: { id: `callback${sequence}`, from: { id: user }, data, message: { chat: { id: user, type: 'private' } } } };
}
async function deliver(update, botId = '100') {
  await pool.query('INSERT INTO telegram_updates (bot_id, update_id, payload) VALUES ($1, $2, $3)', [botId, update.update_id, update]);
  assert.equal(await processUpdate(service, db), true);
}
async function makeBase(user, name = 'Store') {
  await deliver(callback(user, 'new'));
  await deliver(message(user, name));
  await deliver(message(user, undefined, { document: { file_id: 'document', file_name: 'store.md', file_size: 30 } }));
  return (await pool.query('SELECT id FROM knowledge_bases WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 1', [`telegram:${user}`])).rows[0].id;
}
async function ready(id) {
  const task = (await pool.query('SELECT id FROM ingestion_tasks WHERE knowledge_base_id = $1 ORDER BY created_at DESC LIMIT 1', [id])).rows[0].id;
  const version = (await pool.query(`INSERT INTO content_versions (knowledge_base_id, ingestion_task_id, attempt_number, embedding_model, embedding_dimensions, chunking_config, status, ready_at)
    VALUES ($1, $2, 1, 'text-embedding-3-small', 1536, '{}', 'ready', now()) RETURNING id`, [id, task])).rows[0].id;
  await pool.query("UPDATE ingestion_tasks SET status = 'ready', attempts_started = 1 WHERE id = $1", [task]);
  await pool.query('UPDATE knowledge_bases SET active_version_id = $1 WHERE id = $2', [version, id]);
}
async function managed(user, id) {
  await deliver({ update_id: ++sequence, managed_bot: { user: { id: user }, bot: { id, is_bot: true, username: `store${id}bot` } } });
}

test('tokens use authenticated encryption and reject tampering or the wrong key', () => {
  const encrypted = encryptToken('123:secret', config.encryptionKey);
  assert.equal(decryptToken(encrypted, config.encryptionKey), '123:secret');
  assert.ok(!encrypted.includes('123:secret'));
  assert.notEqual(encryptToken('123:secret', config.encryptionKey), encrypted);
  assert.throws(() => decryptToken(encrypted, randomBytes(32)));
  const bytes = Buffer.from(encrypted, 'base64'); bytes[30] ^= 1;
  assert.throws(() => decryptToken(bytes.toString('base64'), config.encryptionKey));
});

test('webhooks authenticate before parsing and durably deduplicate updates', async () => {
  const url = `${baseUrl}/telegram/webhook/100`;
  assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 401);
  const update = message(10, '/start');
  for (let index = 0; index < 2; index++) {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': config.webhookSecret }, body: JSON.stringify(update) });
    assert.equal(response.status, 200);
  }
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM telegram_updates WHERE update_id = $1', [update.update_id])).rows[0].count, 1);
  await processUpdate(service, db);
  assert.equal((await pool.query('SELECT payload FROM telegram_updates WHERE update_id = $1', [update.update_id])).rows[0].payload, null);
});

test('upload state survives service recreation and source processing is atomic', async () => {
  await deliver(callback(11, 'new'));
  await deliver(message(11, 'My store'));
  service = new TelegramService(pool, config, api, questions);
  await deliver(message(11, undefined, { document: { file_id: 'file', file_name: 'store.md' } }));
  const result = await pool.query('SELECT kb.id, kb.name, t.source_text FROM knowledge_bases kb JOIN ingestion_tasks t ON t.knowledge_base_id = kb.id WHERE kb.owner_id = $1', ['telegram:11']);
  assert.equal(result.rows[0].name, 'My store');
  assert.equal(result.rows[0].source_text, 'The store opens at 9 AM.');
  assert.equal((await pool.query('SELECT state FROM telegram_sessions WHERE user_id = 11')).rows[0].state, 'selected');
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM telegram_notifications WHERE chat_id = 11')).rows[0].count, 1);
});

test('forged callbacks cannot read, modify, test, bind, or delete another owner base', async () => {
  const id = await makeBase(12);
  const before = answers.length;
  for (const action of ['kb', 'test', 'replace', 'rename', 'create', 'confirmdelete', 'bind']) await deliver(callback(13, `${action}:${id}`));
  assert.equal(answers.length, before);
  assert.equal((await pool.query('SELECT owner_id FROM knowledge_bases WHERE id = $1', [id])).rows[0].owner_id, 'telegram:12');
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM telegram_sessions WHERE user_id = 13 AND knowledge_base_id = $1", [id])).rows[0].count, 0);
});

test('replacement preserves active content, rejects concurrent replacement, and notifications are durable', async () => {
  const id = await makeBase(14); await ready(id);
  const old = (await pool.query('SELECT active_version_id FROM knowledge_bases WHERE id = $1', [id])).rows[0].active_version_id;
  await notifyIngestion(service, db);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM telegram_notifications WHERE chat_id = 14')).rows[0].count, 0);
  await deliver(callback(14, `replace:${id}`)); await deliver(message(14, 'New opening hours.'));
  await deliver(callback(14, `replace:${id}`)); await deliver(message(14, 'Conflicting replacement.'));
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM ingestion_tasks WHERE knowledge_base_id = $1', [id])).rows[0].count, 2);
  assert.equal((await pool.query('SELECT active_version_id FROM knowledge_bases WHERE id = $1', [id])).rows[0].active_version_id, old);
  await deliver(callback(14, `confirmdelete:${id}`));
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM knowledge_bases WHERE id = $1', [id])).rows[0].count, 1);
});

test('managed bots bind to their owner base, start enabled, and answer using the registered owner', async () => {
  const id = await makeBase(15); await ready(id);
  await deliver(callback(15, `create:${id}`)); await managed(15, 200);
  let bot = (await pool.query('SELECT * FROM telegram_bots WHERE id = 200')).rows[0];
  assert.equal(bot.knowledge_base_id, id); assert.equal(bot.enabled, true);
  assert.equal(decryptToken(bot.token_ciphertext, config.encryptionKey), '200:child');
  assert.ok(calls.some(call => call.method === 'setWebhook' && call.payload.url === 'https://example.com/telegram/webhook/200'));
  const count = answers.length;
  await deliver(message(999, 'When do you open?'), '200');
  assert.equal(answers.length, count + 1);
  assert.ok(calls.some(call => call.method === 'setManagedBotAccessSettings' && call.payload.user_id === 200 && call.payload.is_access_restricted === false));
  await deliver(callback(15, 'toggle:200'));
  await managed(15, 200);
  assert.equal((await pool.query('SELECT enabled FROM telegram_bots WHERE id = 200')).rows[0].enabled, false);
  await deliver(message(999, 'A paused question'), '200');
  assert.equal(answers.length, count + 1);
  await deliver(callback(15, 'toggle:200'));
  await deliver(message(999, 'When do you open?'), '200');
  assert.deepEqual(answers.at(-1), { kb: id, owner: 'telegram:15', question: 'When do you open?' });
  await deliver(callback(999, 'toggle:200'));
  bot = (await pool.query('SELECT * FROM telegram_bots WHERE id = 200')).rows[0];
  assert.equal(bot.enabled, true);
});

test('token refresh preserves binding; owner transfer detaches and pauses the bot', async () => {
  await managed(15, 200);
  assert.equal((await pool.query('SELECT enabled FROM telegram_bots WHERE id = 200')).rows[0].enabled, true);
  await service.enqueue(db, '200', 999, 'An answer from the old owner');
  await managed(16, 200);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM telegram_outbox WHERE bot_id = 200")).rows[0].count, 0);
  const bot = (await pool.query('SELECT * FROM telegram_bots WHERE id = 200')).rows[0];
  assert.equal(bot.owner_id, 'telegram:16'); assert.equal(bot.enabled, false); assert.equal(bot.knowledge_base_id, null);
  const count = answers.length;
  await deliver(message(999, 'What is in the old base?'), '200');
  assert.equal(answers.length, count);
});

test('daily quota is shared by owner across tests and bots and includes failed provider calls', async () => {
  const id = await makeBase(17); await ready(id);
  await deliver(callback(17, `test:${id}`));
  await deliver(message(17, 'First question')); await deliver(message(17, 'Second question')); await deliver(message(17, 'Over quota'));
  assert.equal(answers.filter(answer => answer.owner === 'telegram:17').length, 2);
  await deliver(callback(17, `create:${id}`)); await managed(17, 202);
  await deliver(message(1000, 'The customer shares the same allowance'), '202');
  assert.equal(answers.filter(answer => answer.owner === 'telegram:17').length, 2);
  const failing = new TelegramService(pool, config, api, { async ask() { throw new Error('Provider failure'); } });
  await deliver(callback(18, 'new')); await deliver(message(18, 'Failing test')); await deliver(message(18, 'Test content'));
  const base = (await pool.query("SELECT id FROM knowledge_bases WHERE owner_id = 'telegram:18'")).rows[0].id;
  await deliver(callback(18, `test:${base}`));
  const original = service; service = failing;
  await deliver(message(18, 'Provider fails'));
  service = original;
  assert.equal((await pool.query("SELECT queries FROM telegram_usage WHERE owner_id = 'telegram:18'")).rows[0].queries, 1);
});

test('delete removes content and disconnects bots after processing is complete', async () => {
  const id = await makeBase(19); await ready(id);
  await deliver(callback(19, `create:${id}`)); await managed(19, 201);
  await deliver(callback(19, `confirmdelete:${id}`));
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM knowledge_bases WHERE id = $1', [id])).rows[0].count, 0);
  const bot = (await pool.query('SELECT * FROM telegram_bots WHERE id = 201')).rows[0];
  assert.equal(bot.knowledge_base_id, null); assert.equal(bot.enabled, false);
});

test('group messages and bot senders cannot consume paid queries', async () => {
  const count = answers.length;
  await deliver(message(999, 'Question', { chat: { id: -1, type: 'group' } }), '200');
  await deliver(message(999, 'Question', { from: { id: 999, is_bot: true } }), '200');
  assert.equal(answers.length, count);
});

test('outbox delivers committed responses and handles Telegram rate limits', async () => {
  await pool.query('DELETE FROM telegram_outbox');
  await service.enqueue(db, '100', 20, 'Persistent reply');
  const original = api.call;
  api.call = async () => { throw new TelegramError(429, 30); };
  await processOutbox(service, db);
  const row = (await pool.query('SELECT * FROM telegram_outbox')).rows[0];
  assert.equal(row.attempts, 1); assert.ok(row.available_at.getTime() > Date.now() + 20_000);
  api.call = original;
  await pool.query('UPDATE telegram_outbox SET available_at = now()');
  await processOutbox(service, db);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM telegram_outbox')).rows[0].count, 0);
});

test('a transient failure rolls back accepted content and retries without duplicate bases', async () => {
  await deliver(callback(21, 'new')); await deliver(message(21, 'Retry store'));
  const update = message(21, 'Content that must be committed once.');
  await pool.query('INSERT INTO telegram_updates (bot_id, update_id, payload) VALUES (100, $1, $2)', [update.update_id, update]);
  const failing = new TelegramService(pool, config, api, questions);
  failing.handle = async (...args) => {
    await service.handle(...args);
    throw new TelegramError(502);
  };
  await processUpdate(failing, db);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM knowledge_bases WHERE owner_id = 'telegram:21'")).rows[0].count, 0);
  assert.equal((await pool.query('SELECT state FROM telegram_sessions WHERE user_id = 21')).rows[0].state, 'upload');
  await pool.query('UPDATE telegram_updates SET available_at = now() WHERE update_id = $1', [update.update_id]);
  await processUpdate(service, db);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM knowledge_bases WHERE owner_id = 'telegram:21'")).rows[0].count, 1);
  assert.equal(await processUpdate(service, db), false);
});

test('worker registers Telegram hooks, enforces one worker, and releases its lock on shutdown', async () => {
  const worker = await startTelegramWorker(service, () => assert.fail('Worker failed'));
  try {
    assert.ok(calls.some(call => call.method === 'setWebhook' && call.payload.url === 'https://example.com/telegram/webhook/100' && call.payload.allowed_updates.includes('managed_bot')));
    await assert.rejects(startTelegramWorker(service, () => {}), /Another Telegram worker/);
  } finally { await worker.stop(); }
  const lock = await db.query('SELECT pg_try_advisory_lock(1792627200, 2) AS locked');
  assert.equal(lock.rows[0].locked, true);
  await db.query('SELECT pg_advisory_unlock(1792627200, 2)');
});

test('a new public URL refreshes all bot hooks, preserves secrets, and skips revoked credentials', async () => {
  const newService = new TelegramService(pool, { ...config, publicUrl: 'https://new-tunnel.trycloudflare.com' }, api, questions);
  const bots = (await pool.query('SELECT id, webhook_secret FROM telegram_bots ORDER BY id')).rows;
  const revoked = bots.at(-1);
  await pool.query('UPDATE telegram_bots SET enabled = true WHERE id = $1', [revoked.id]);
  const original = api.call;
  const refreshed = [];
  api.call = async (token, method, payload) => {
    if (method === 'setWebhook' && token === `${revoked.id}:child`) throw new TelegramError(401);
    if (method === 'setWebhook') refreshed.push({ token, payload });
    return original(token, method, payload);
  };
  try { await refreshWebhooks(newService, db); } finally { api.call = original; }
  assert.ok(refreshed.some(call => call.payload.url === 'https://new-tunnel.trycloudflare.com/telegram/webhook/100'));
  for (const bot of bots.filter(bot => bot.id !== revoked.id)) {
    const call = refreshed.find(call => call.payload.url.endsWith(`/telegram/webhook/${bot.id}`));
    assert.ok(call); assert.equal(call.payload.secret_token, bot.webhook_secret);
    assert.ok(call.payload.url.startsWith('https://new-tunnel.trycloudflare.com/'));
  }
  assert.equal((await pool.query('SELECT enabled FROM telegram_bots WHERE id = $1', [revoked.id])).rows[0].enabled, false);
});

test('bots created without a selected ready base remain paused', async () => {
  await managed(22, 203);
  const bot = (await pool.query('SELECT * FROM telegram_bots WHERE id = 203')).rows[0];
  assert.equal(bot.enabled, false);
  assert.equal(bot.knowledge_base_id, null);
  assert.ok(calls.some(call => call.method === 'setManagedBotAccessSettings' && call.payload.user_id === 203 && call.payload.is_access_restricted === true));
});

test('Telegram forwards friendly redirections and hides internal provider validation errors', async () => {
  const id = await makeBase(23); await ready(id);
  await deliver(callback(23, `test:${id}`));
  const original = service;
  const reply = 'Hi! Would you like to know about delivery or opening hours?';
  service = new TelegramService(pool, config, api, { async ask() { return { outcome: 'redirected', answer: reply, sources: [] }; } });
  try {
    await deliver(message(23, 'Hi!'));
    assert.equal((await pool.query("SELECT payload->>'text' AS text FROM telegram_outbox WHERE payload->>'chat_id' = '23' ORDER BY id DESC LIMIT 1")).rows[0].text, reply);
    service = new TelegramService(pool, config, api, { async ask() { throw new QueryError(502, 'invalid_answer_response', 'Internal provider validation detail'); } });
    await deliver(message(23, 'Another question'));
    const text = (await pool.query("SELECT payload->>'text' AS text FROM telegram_outbox WHERE payload->>'chat_id' = '23' ORDER BY id DESC LIMIT 1")).rows[0].text;
    assert.match(text, /try.*again/i); assert.ok(!text.includes('provider')); assert.ok(!text.includes('validation'));
  } finally { service = original; }
});

async function lastReply(user) {
  return (await pool.query("SELECT payload FROM telegram_outbox WHERE method = 'sendMessage' AND payload->>'chat_id' = $1 ORDER BY id DESC LIMIT 1", [String(user)])).rows[0].payload;
}

test('new users choose a language before management actions and invalid language callbacks do not advance', async () => {
  await deliver(message(30, '/start'));
  let reply = await lastReply(30);
  assert.deepEqual(reply.reply_markup.inline_keyboard[0].map(button => button.callback_data), ['lang:en', 'lang:ru']);
  await deliver(callback(30, 'new'));
  assert.equal((await lastReply(30)).text, reply.text);
  await deliver(callback(30, 'lang:de'));
  assert.equal((await pool.query('SELECT language FROM telegram_sessions WHERE user_id = 30')).rows.length, 0);
  await deliver(callback(30, 'lang:ru'));
  reply = await lastReply(30);
  assert.equal(reply.text, 'Управляйте базами знаний и Telegram-ботами.');
  assert.equal(reply.reply_markup.inline_keyboard[0][0].text, 'Создать базу знаний');
  assert.equal((await pool.query('SELECT language FROM telegram_sessions WHERE user_id = 30')).rows[0].language, 'ru');
});

test('Russian preference survives workflow changes and restart; notifications and validation are localized', async () => {
  await deliver(callback(30, 'new'));
  assert.equal((await lastReply(30)).text, 'Как назовём базу знаний?');
  await deliver(message(30, ''));
  assert.equal((await lastReply(30)).text, 'Отправьте название длиной от 1 до 80 символов.');
  await deliver(message(30, 'Language')); // User content matching an English UI label stays unchanged.
  service = new TelegramService(pool, config, api, questions);
  await deliver(message(30, 'The comic store opens at 9 AM.'));
  const kb = (await pool.query("SELECT id, name FROM knowledge_bases WHERE owner_id = 'telegram:30'")).rows[0];
  assert.equal(kb.name, 'Language');
  assert.equal((await pool.query('SELECT language FROM telegram_sessions WHERE user_id = 30')).rows[0].language, 'ru');
  await ready(kb.id); await notifyIngestion(service, db);
  let reply = await lastReply(30);
  assert.equal(reply.text, 'База «Language» готова к работе.');
  assert.equal(reply.reply_markup.inline_keyboard[0][0].text, 'Открыть базу знаний');
  await deliver(callback(30, `kb:${kb.id}`));
  assert.match((await lastReply(30)).text, /Статус: готова/);
  await deliver(callback(30, `replace:${kb.id}`));
  await deliver(message(30, undefined, { document: { file_id: 'file', file_name: 'bad.exe' } }));
  assert.equal((await lastReply(30)).text, 'Этот формат файла не поддерживается.');
  await deliver(callback(30, `create:${kb.id}`));
  reply = await lastReply(30);
  assert.equal(reply.reply_markup.keyboard[0][0].text, 'Создать Telegram-бота');
  assert.ok(reply.reply_markup.keyboard[0][0].request_managed_bot);
});

test('language can be changed from the menu or command, without affecting another user', async () => {
  await deliver(message(30, '/language'));
  assert.equal((await lastReply(30)).reply_markup.inline_keyboard[0][1].text, 'Русский');
  await deliver(callback(30, 'lang:en'));
  assert.equal((await lastReply(30)).reply_markup.inline_keyboard[0][0].text, 'Create knowledge base');
  await deliver(callback(30, 'language'));
  await deliver(callback(30, 'lang:ru'));
  await deliver(message(11, '/start'));
  assert.equal((await lastReply(11)).text, 'Manage your knowledge bases and Telegram bots.');
  assert.equal((await pool.query('SELECT language FROM telegram_sessions WHERE user_id = 11')).rows[0].language, 'en');
});
