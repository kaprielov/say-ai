import { startTyping } from '../src/telegram/typing.ts';
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
import { managerIntroduction, managerHelp, russianManagerIntroduction, russianManagerHelp } from '../src/telegram/guide.ts';
import { encryptToken, decryptToken, TelegramError } from '../src/telegram/client.ts';
import { processUpdate, processOutbox, notifyIngestion, notifySecurity, cleanupTelegram, startTelegramWorker, refreshWebhooks } from '../src/telegram/worker.ts';
import { ownerAdmission, protectionSettings, visitorAdmission } from '../src/telegram/protection.ts';
import { helpSummaries } from '../src/telegram/manager-ui.ts';
import { translator } from '../src/telegram/i18n.ts';
import { pilotStatus } from '../scripts/pilot-status.mjs';

const databaseName = `say_ai_telegram_test_${randomBytes(8).toString('hex')}`;
const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const config = { token: '100:manager', managerId: '100', webhookSecret: 'secret'.repeat(8), publicUrl: 'https://example.com', encryptionKey: randomBytes(32), dailyQueries: 2 };
let pool, db, server, baseUrl, service, created = false;
let sequence = 0;
const calls = [], answers = [], answerRuns = [];
const api = {
  async call(token, method, payload) {
    calls.push({ token, method, payload });
    if (method === 'getManagedBotToken') return `${payload.user_id}:child`;
    if (method === 'getMe') return { id: Number(token.split(':')[0]), is_bot: true };
    return true;
  },
  async download() { return Buffer.from('The store opens at 9 AM.'); },
};
const questions = { async ask(kb, owner, question, _signal, run) {
  answers.push({ kb, owner, question });
  answerRuns.push(run);
  return { outcome: 'answered', answer: 'The store opens at 9 AM.', sources: [], ...(run?.inspect ? { debug: { revision: run.revision, contentVersion: 'test-version', elapsedMs: 12, safety: { topic: 'related', review: 'supported' }, context: [{ id: 'test-chunk', text: 'The store opens at 9 AM.' }], request: { instructions: run.settings.instructions } } } : {}) };
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
  await pool.query("UPDATE telegram_bots SET answer_settings=jsonb_set(answer_settings,'{draft}', '{\"instructions\":\"Private old-owner instructions\",\"detail\":\"standard\",\"language\":\"auto\",\"retrieval\":\"balanced\"}'::jsonb) WHERE id=200");
  await service.enqueue(db, '200', 999, 'An answer from the old owner');
  await managed(16, 200);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM telegram_outbox WHERE bot_id = 200")).rows[0].count, 0);
  const bot = (await pool.query('SELECT * FROM telegram_bots WHERE id = 200')).rows[0];
  assert.equal(bot.answer_settings.draft, null);
  assert.equal(bot.answer_settings.published.settings.instructions, '');
  assert.deepEqual(bot.answer_settings.history, []);
  assert.equal(bot.owner_id, 'telegram:16'); assert.equal(bot.enabled, false); assert.equal(bot.knowledge_base_id, null);
  const count = answers.length;
  await deliver(message(999, 'What is in the old base?'), '200');
  assert.equal(answers.length, count);
});

test('configured daily quotas separate tests from customers and include failed provider calls', async () => {
  await pool.query("INSERT INTO telegram_owner_limits(owner_id,testing,daily) VALUES ('telegram:17',2,2)");
  const id = await makeBase(17); await ready(id);
  await deliver(callback(17, `test:${id}`));
  await deliver(message(17, 'First question')); await deliver(message(17, 'Second question')); await deliver(message(17, 'Over quota'));
  assert.equal(answers.filter(answer => answer.owner === 'telegram:17').length, 2);
  await deliver(callback(17, `create:${id}`)); await managed(17, 202);
  await deliver(message(1000, 'The customer has a separate allowance'), '202');
  assert.equal(answers.filter(answer => answer.owner === 'telegram:17').length, 3);
  const failing = new TelegramService(pool, config, api, { async ask() { throw new Error('Provider failure'); } });
  await deliver(callback(18, 'new')); await deliver(message(18, 'Failing test')); await deliver(message(18, 'Test content'));
  const base = (await pool.query("SELECT id FROM knowledge_bases WHERE owner_id = 'telegram:18'")).rows[0].id;
  await deliver(callback(18, `test:${base}`));
  const original = service; service = failing;
  await deliver(message(18, 'Provider fails'));
  service = original;
  assert.equal((await pool.query("SELECT test_queries FROM telegram_usage WHERE owner_id = 'telegram:18'")).rows[0].test_queries, 1);
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
    const status = await pilotStatus(pool);
    assert.equal(status.workers.telegram_lock_held, true);
    assert.ok(status.workers.telegram.progress_age_seconds < 30);
    assert.ok(['idle', 'working'].includes(status.workers.telegram.status));
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
  assert.deepEqual(reply.reply_markup.inline_keyboard[0].map(button => button.callback_data), ['lang:ru', 'lang:en']);
  await deliver(callback(30, 'new'));
  assert.equal((await lastReply(30)).text, reply.text);
  await deliver(callback(30, 'lang:de'));
  assert.equal((await pool.query('SELECT language FROM telegram_sessions WHERE user_id = 30')).rows.length, 0);
  await deliver(callback(30, 'lang:ru'));
  reply = await lastReply(30);
  assert.equal(reply.text, 'Управляйте базами знаний и Telegram-ботами.');
  assert.equal(reply.reply_markup.inline_keyboard[0][0].text, 'Мои боты');
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
  assert.equal((await lastReply(30)).reply_markup.inline_keyboard[0][0].text, 'Русский');
  await deliver(callback(30, 'lang:en'));
  assert.equal((await lastReply(30)).reply_markup.inline_keyboard[0][0].text, 'My bots');
  await deliver(callback(30, 'language'));
  await deliver(callback(30, 'lang:ru'));
  await deliver(message(11, '/start'));
  assert.equal((await lastReply(11)).text, 'Manage your knowledge bases and Telegram bots.');
  assert.equal((await pool.query('SELECT language FROM telegram_sessions WHERE user_id = 11')).rows[0].language, 'en');
});


test('help is available without a key, preserves input state, and routes each topic', async () => {
  const original = service;
  service = new TelegramService(pool, config, api, questions, {
    async available() { return false; },
    async stored() { return false; },
  });
  try {
    await deliver(message(11, '/start'));
    const replies = (await pool.query("SELECT payload FROM telegram_outbox WHERE payload->>'chat_id' = '11' ORDER BY id DESC LIMIT 2")).rows;
    assert.match(replies[0].payload.text, /Connect your OpenAI/);
    assert.equal(replies[1].payload.text, managerIntroduction);
    assert.equal(replies[1].payload.reply_markup, undefined);
    assert.ok(!replies[0].payload.reply_markup.inline_keyboard.flat().some(button => button.callback_data === 'new'));
    await service.session(db, 11, 'upload', null, 'Draft to keep');
    await deliver(message(11, '/help'));
    assert.equal((await lastReply(11)).text, helpSummaries.menu);
    for (const topic of Object.keys(managerHelp)) {
      await deliver(callback(11, `help:${topic}`));
      const reply = await lastReply(11);
      assert.equal(reply.text, helpSummaries[topic]);
      await deliver(callback(11, `hf:${topic}`));
      assert.equal((await lastReply(11)).text, managerHelp[topic]);
      assert.ok(reply.text.length < 4000);
      assert.ok(reply.reply_markup.inline_keyboard.flat().some(button => button.callback_data === 'menu'));
    }
    await deliver(callback(11, 'help:unknown'));
    assert.equal((await lastReply(11)).text, helpSummaries.menu);
    const session = (await pool.query('SELECT state, draft_name FROM telegram_sessions WHERE user_id = 11')).rows[0];
    assert.deepEqual(session, { state: 'upload', draft_name: 'Draft to keep' });
    await deliver(callback(11, 'new'));
    assert.match((await lastReply(11)).text, /Connect your OpenAI/);
    await deliver(message(11, '/cancel'));
    assert.equal((await pool.query('SELECT state FROM telegram_sessions WHERE user_id = 11')).rows[0].state, 'menu');
  } finally { service = original; }
});

test('knowledge base and bot cards offer the matching help topic', async () => {
  const base = (await pool.query("SELECT id FROM knowledge_bases WHERE owner_id = 'telegram:15' LIMIT 1")).rows[0];
  await deliver(callback(15, `kb:${base.id}`));
  assert.ok((await lastReply(15)).reply_markup.inline_keyboard.flat().some(button => button.callback_data === `help:base:${base.id}`));
  await deliver(callback(16, 'bot:200'));
  assert.ok((await lastReply(16)).reply_markup.inline_keyboard.flat().some(button => button.callback_data === 'help:bot:200'));
});


test('manager introduction and every help topic follow the selected language', async () => {
  for (const language of ['ru', 'en']) {
    await deliver(callback(30, `lang:${language}`));
    const menu = await lastReply(30);
    assert.equal(menu.text, language === 'ru' ? 'Управляйте базами знаний и Telegram-ботами.' : 'Manage your knowledge bases and Telegram bots.');
    const welcome = (await pool.query("SELECT payload FROM telegram_outbox WHERE method = 'sendMessage' AND payload->>'chat_id' = '30' ORDER BY id DESC LIMIT 1 OFFSET 1")).rows[0].payload;
    assert.equal(welcome.text, language === 'ru' ? russianManagerIntroduction : managerIntroduction);
    assert.equal(welcome.reply_markup, undefined);
    assert.equal(menu.reply_markup.inline_keyboard.at(-1).at(-1).text, language === 'ru' ? 'Справка' : 'Help');
    await service.session(db, 30, 'name');
    for (const topic of Object.keys(managerHelp)) {
      await deliver(callback(30, `help:${topic}`));
      const reply = await lastReply(30);
      assert.equal(reply.text, translator(language)(helpSummaries[topic]));
      assert.ok(reply.text.length < 4000);
      assert.equal(reply.reply_markup.inline_keyboard[0][0].text, language === 'ru' ? 'Полная инструкция' : 'Full guide');
      await deliver(callback(30, `hf:${topic}`));
      assert.equal((await lastReply(30)).text, language === 'ru' ? russianManagerHelp[topic] : managerHelp[topic]);
    }
    assert.equal((await pool.query('SELECT state FROM telegram_sessions WHERE user_id = 30')).rows[0].state, 'name');
  }
});

test('manager defaults to Russian when no language preference has been saved', async () => {
  const t = await service.locale(db, 987654);
  assert.equal(t(managerIntroduction), russianManagerIntroduction);
  assert.equal((await service.localeFromPool(987654))('Help'), 'Справка');
});


test('typing refreshes during a slow answer and stops after completion', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const actions = [];
  const transport = { async call(...args) { actions.push(args); } };
  const stop = startTyping(transport, Promise.resolve('200:child'), 999);
  await new Promise(setImmediate);
  assert.deepEqual(actions, [['200:child', 'sendChatAction', { chat_id: 999, action: 'typing' }]]);
  t.mock.timers.tick(4000);
  await new Promise(setImmediate);
  assert.equal(actions.length, 2);
  stop();
  t.mock.timers.tick(12000);
  await new Promise(setImmediate);
  assert.equal(actions.length, 2);
});

test('typing errors are ignored and stopped actions do not send late or overlap', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let count = 0;
  const stopFailed = startTyping({ async call() { count++; throw new TelegramError(429, 30); } }, Promise.resolve('100:manager'), 10);
  await new Promise(setImmediate);
  t.mock.timers.tick(40000);
  await new Promise(setImmediate);
  assert.equal(count, 1);
  stopFailed();

  let resolveToken;
  const stopPending = startTyping({ async call() { count++; } }, new Promise(resolve => { resolveToken = resolve; }), 10);
  stopPending();
  resolveToken('100:manager');
  await new Promise(setImmediate);
  assert.equal(count, 1);

  let finish;
  const stopSlow = startTyping({ async call() { count++; await new Promise(resolve => { finish = resolve; }); } }, Promise.resolve('100:manager'), 10);
  await new Promise(setImmediate);
  t.mock.timers.tick(12000);
  assert.equal(count, 2);
  stopSlow();
  finish();
  await new Promise(setImmediate);
  t.mock.timers.tick(12000);
  await new Promise(setImmediate);
  assert.equal(count, 2);
});

async function protectionBot(user, bot) {
  await pool.query("INSERT INTO telegram_sessions(user_id,language) VALUES ($1,'en') ON CONFLICT DO NOTHING", [user]);
  const id = await makeBase(user); await ready(id);
  await deliver(callback(user, `create:${id}`)); await managed(user, bot);
  await pool.query('INSERT INTO telegram_owner_limits(owner_id) VALUES ($1) ON CONFLICT DO NOTHING', [`telegram:${user}`]);
  return id;
}

test('protection settings persist, validate values, respect ownership, and localize the manager UI', async () => {
  await protectionBot(30, 300);
  await deliver(callback(30, 'protect:300'));
  const card = (await pool.query("SELECT payload FROM telegram_outbox WHERE payload->>'chat_id'='30' ORDER BY id DESC LIMIT 1")).rows[0].payload;
  assert.match(card.text, /Spam protection/);
  assert.ok(card.reply_markup.inline_keyboard.flat().some(button => button.callback_data === 'pg:300:topic'));
  await deliver(callback(30, 'pg:300:topic'));
  assert.ok((await lastReply(30)).reply_markup.inline_keyboard.flat().some(button => button.text.includes('6')));
  await deliver(callback(30, 'ps:300:repeatHours'));
  await deliver(message(30, '8'));
  assert.equal((await pool.query('SELECT protection FROM telegram_bots WHERE id=300')).rows[0].protection.repeatHours, 8);
  await deliver(callback(30, 'ps:300:perMinute'));
  await deliver(message(30, '31'));
  assert.equal((await pool.query('SELECT protection FROM telegram_bots WHERE id=300')).rows[0].protection.perMinute, undefined);
  await deliver(callback(31, 'ps:300:repeatHours'));
  assert.equal((await pool.query('SELECT protection FROM telegram_bots WHERE id=300')).rows[0].protection.repeatHours, 8);
  await deliver(callback(30, 'ol:testing')); await deliver(message(30, '12'));
  assert.equal((await pool.query("SELECT testing FROM telegram_owner_limits WHERE owner_id='telegram:30'")).rows[0].testing, 12);
  await deliver(callback(30, 'lang:ru'));
  await deliver(callback(30, 'protect:300'));
  assert.match((await pool.query("SELECT payload->>'text' AS text FROM telegram_outbox WHERE payload->>'chat_id'='30' ORDER BY id DESC LIMIT 1")).rows[0].text, /Защита от спама/);
});

test('only clear off-topic requests escalate; repeated abuse pauses for six hours and notices are coalesced', async () => {
  await protectionBot(32, 302);
  await pool.query(`UPDATE telegram_bots SET protection='{"perMinute":0,"perDay":0,"duplicateSeconds":0}' WHERE id=302`);
  const original = service;
  let calls = 0;
  service = new TelegramService(pool, config, api, { async ask(_kb, _owner, question) {
    calls++;
    return { outcome: 'redirected', answer: 'Try asking about opening hours.', sources: [], topic: question.startsWith('off') ? 'off_topic' : question };
  } });
  try {
    for (const topic of ['social', 'missing_information', 'uncertain', 'related']) await deliver(message(3200, topic), '302');
    assert.equal((await pool.query('SELECT strikes FROM telegram_visitors WHERE bot_id=302 AND user_id=3200')).rows[0].strikes, 0);
    for (let i = 0; i < 3; i++) await deliver(message(3200, `off ${i}`), '302');
    let state = (await pool.query('SELECT * FROM telegram_visitors WHERE bot_id=302 AND user_id=3200')).rows[0];
    assert.ok(state.warning_at); assert.equal(state.blocked_until, null);
    await deliver(message(3200, 'off 3'), '302');
    state = (await pool.query('SELECT * FROM telegram_visitors WHERE bot_id=302 AND user_id=3200')).rows[0];
    assert.ok(new Date(state.blocked_until).getTime() - Date.now() > 14 * 60000);
    const before = calls, until = state.blocked_until;
    await deliver(message(3200, 'off blocked'), '302');
    assert.equal(calls, before);
    assert.deepEqual((await pool.query('SELECT blocked_until FROM telegram_visitors WHERE bot_id=302 AND user_id=3200')).rows[0].blocked_until, until);
    await pool.query("UPDATE telegram_visitors SET blocked_until=now()-interval '1 second' WHERE bot_id=302 AND user_id=3200");
    for (let i = 0; i < 4; i++) await deliver(message(3200, `off again ${i}`), '302');
    // The restriction is set by PostgreSQL; compare against the same clock even
    // when the database runs in a VM with a small offset from the Node host.
    state = (await pool.query(`SELECT *, EXTRACT(EPOCH FROM blocked_until-clock_timestamp()) AS remaining_seconds
      FROM telegram_visitors WHERE bot_id=302 AND user_id=3200`)).rows[0];
    assert.ok(Number(state.remaining_seconds) > 359 * 60);
    assert.ok(Number(state.remaining_seconds) <= 360 * 60);
    await notifySecurity(service, db);
    let notifications = (await pool.query("SELECT count(*)::int AS count FROM telegram_outbox WHERE payload->>'chat_id'='32' AND payload->>'text' LIKE '%repeated-abuse%'")).rows[0].count;
    assert.equal(notifications, 1);
    await pool.query('UPDATE telegram_security_notices SET pending=2 WHERE bot_id=302');
    await notifySecurity(service, db);
    assert.equal((await pool.query('SELECT pending FROM telegram_security_notices WHERE bot_id=302')).rows[0].pending, 2);
    await deliver(callback(30, 'unblock:302:3200'));
    assert.ok((await pool.query('SELECT blocked_until>now() AS blocked FROM telegram_visitors WHERE bot_id=302 AND user_id=3200')).rows[0].blocked);
    await deliver(callback(32, 'unblock:302:3200'));
    state = (await pool.query('SELECT * FROM telegram_visitors WHERE bot_id=302 AND user_id=3200')).rows[0];
    assert.equal(state.blocked_until, null); assert.equal(state.repeat_until, null);
  } finally { service = original; }
});

test('visitor defaults suppress duplicates and quotas while mandatory server caps survive disabled rules', async () => {
  const defaults = protectionSettings();
  assert.equal(defaults.perMinute, 5); assert.equal(defaults.perDay, 30); assert.equal(defaults.repeatHours, 6);
  await db.query('BEGIN');
  try {
    assert.equal((await visitorAdmission(db, '302', 3300, 'Hello', defaults)).allowed, true);
    assert.equal((await visitorAdmission(db, '302', 3300, ' hello  ', defaults)).allowed, false);
    for (let i = 0; i < 4; i++) assert.equal((await visitorAdmission(db, '302', 3300, `Question ${i}`, defaults)).allowed, true);
    assert.equal((await visitorAdmission(db, '302', 3300, 'One too many', defaults)).allowed, false);
    const disabled = protectionSettings({ perMinute: 0, perDay: 0, duplicateSeconds: 0 });
    for (let i = 0; i < 30; i++) assert.equal((await visitorAdmission(db, '302', 3301, `Question ${i}`, disabled)).allowed, true);
    assert.equal((await visitorAdmission(db, '302', 3301, 'Beyond hard cap', disabled)).allowed, false);
    for (let i = 0; i < 120; i++) assert.equal(await ownerAdmission(db, 'telegram:server-cap-test'), true);
    assert.equal(await ownerAdmission(db, 'telegram:server-cap-test'), false);
  } finally { await db.query('ROLLBACK'); }
});

test('webhook admission bounds visitor and bot backlog and still acknowledges duplicate deliveries', async () => {
  const post = async update => fetch(`${baseUrl}/telegram/webhook/302`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': (await pool.query('SELECT webhook_secret FROM telegram_bots WHERE id=302')).rows[0].webhook_secret }, body: JSON.stringify(update),
  });
  const updates = Array.from({ length: 6 }, () => message(3400, 'Queued question'));
  try {
    for (const update of updates.slice(0, 5)) assert.equal((await post(update)).status, 200);
    assert.equal((await post(updates[5])).status, 503);
    assert.equal((await post(updates[0])).status, 200);
    await pool.query(`INSERT INTO telegram_updates(bot_id,update_id,payload)
      SELECT 302,900000+n,'{}' FROM generate_series(1,95) n`);
    assert.equal((await post(message(3401, 'Another visitor'))).status, 503);
  } finally { await pool.query('DELETE FROM telegram_updates WHERE bot_id=302 AND NOT done'); }
});

test('a delayed bot retry does not hold up another bot and cleanup retains live restrictions', async () => {
  const slow = message(3400, '/start'), fast = message(3401, '/start');
  await pool.query("INSERT INTO telegram_updates(bot_id,update_id,payload,available_at) VALUES (302,$1,$2,now()+interval '1 hour')", [slow.update_id, slow]);
  await pool.query('INSERT INTO telegram_updates(bot_id,update_id,payload) VALUES (300,$1,$2)', [fast.update_id, fast]);
  try {
    assert.equal(await processUpdate(service, db), true);
    assert.equal((await pool.query('SELECT done FROM telegram_updates WHERE update_id=$1 AND bot_id=300', [fast.update_id])).rows[0].done, true);
    await pool.query("UPDATE telegram_visitors SET updated_at=now()-interval '31 days',blocked_until=now()+interval '1 hour' WHERE bot_id=302 AND user_id=3200");
    await cleanupTelegram(db);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM telegram_visitors WHERE bot_id=302 AND user_id=3200')).rows[0].count, 1);
  } finally { await pool.query('DELETE FROM telegram_updates WHERE bot_id=302 AND NOT done'); }
});

test('a full outbox defers security notices and continues draining instead of stopping the worker', async () => {
  await pool.query('DELETE FROM telegram_outbox');
  await pool.query("UPDATE telegram_security_notices SET pending=2,available_at=now()-interval '1 second' WHERE bot_id=302");
  await pool.query(`INSERT INTO telegram_outbox(bot_id,payload)
    SELECT 100,'{"chat_id":32,"text":"Capacity test"}'::jsonb FROM generate_series(1,5000)`);
  try {
    await assert.rejects(service.enqueue(db, '100', 32, 'Beyond capacity'), error => error.code === 'outbox_full');
    await notifySecurity(service, db);
    assert.equal((await pool.query('SELECT pending FROM telegram_security_notices WHERE bot_id=302')).rows[0].pending, 2);
    assert.equal(await processOutbox(service, db), true);
    await notifySecurity(service, db);
    assert.equal((await pool.query('SELECT pending FROM telegram_security_notices WHERE bot_id=302')).rows[0].pending, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM telegram_outbox')).rows[0].count, 5000);
  } finally { await pool.query('DELETE FROM telegram_outbox'); }
});

async function lastPanel(user) {
  return (await pool.query("SELECT method,payload FROM telegram_outbox WHERE method IN ('sendMessage','editMessageText') AND payload->>'chat_id'=$1 ORDER BY id DESC LIMIT 1", [String(user)])).rows[0];
}

test('grouped protection offers concise localized hints, optional details, and owner-scoped quick values', async () => {
  await protectionBot(40, 400);
  await pool.query("INSERT INTO telegram_sessions(user_id,language) VALUES (41,'en') ON CONFLICT DO NOTHING");
  for (const language of ['ru', 'en']) {
    await deliver(callback(40, `lang:${language}`));
    await deliver(callback(40, 'protect:400'));
    const root = await lastReply(40);
    assert.equal(root.reply_markup.inline_keyboard.length, 5);
    assert.ok(!root.reply_markup.inline_keyboard.flat().some(button => button.callback_data.startsWith('ps:')));
    await deliver(callback(40, 'pg:400:messages'));
    assert.equal((await lastReply(40)).reply_markup.inline_keyboard.length, 4);
    await deliver(callback(40, 'ps:400:duplicateSeconds'));
    const summary = await lastReply(40);
    assert.ok(summary.text.length < 600);
    assert.match(summary.text, language === 'ru' ? /Игнорировать/ : /Ignore/);
    assert.ok(summary.reply_markup.inline_keyboard.flat().some(button => button.callback_data === 'pv:400:duplicateSeconds:60'));
    await deliver(callback(40, 'ph:400:duplicateSeconds'));
    const details = await lastReply(40);
    assert.ok(details.text.length > summary.text.length);
    assert.ok(details.reply_markup.inline_keyboard.flat().some(button => button.callback_data === 'ps:400:duplicateSeconds'));
    await deliver(callback(40, 'pv:400:duplicateSeconds:120'));
    assert.equal((await pool.query('SELECT protection FROM telegram_bots WHERE id=400')).rows[0].protection.duplicateSeconds, 120);
    assert.ok((await lastReply(40)).reply_markup.inline_keyboard.flat().some(button => button.callback_data === 'ps:400:duplicateSeconds' && button.text.includes('120')));
  }
  await deliver(callback(41, 'pv:400:duplicateSeconds:0'));
  assert.equal((await pool.query('SELECT protection FROM telegram_bots WHERE id=400')).rows[0].protection.duplicateSeconds, 120);
  await deliver(callback(40, 'pv:400:perMinute:31'));
  assert.equal((await pool.query('SELECT protection FROM telegram_bots WHERE id=400')).rows[0].protection.perMinute, undefined);
});

test('callback navigation edits the current panel and help resumes input without leaving edit state behind', async () => {
  const click = async data => {
    const update = callback(40, data);
    update.callback_query.message.message_id = 740;
    await deliver(update);
  };
  await click('settings');
  let panel = await lastPanel(40);
  assert.equal(panel.method, 'editMessageText'); assert.equal(panel.payload.message_id, 740);
  assert.ok(panel.payload.reply_markup.inline_keyboard.flat().some(button => button.callback_data === 'limits'));
  await service.session(db, 40, 'name');
  await click('help:base');
  assert.equal((await pool.query('SELECT state FROM telegram_sessions WHERE user_id=40')).rows[0].state, 'name');
  await click('continue');
  panel = await lastPanel(40);
  assert.equal(panel.method, 'editMessageText');
  assert.match(panel.payload.text, /name/);
  await service.enqueue(db, '100', 40, 'Independent notification');
  assert.equal((await lastPanel(40)).method, 'sendMessage');
  await click('lang:en');
  panel = await lastPanel(40);
  assert.equal(panel.method, 'sendMessage');
  assert.equal(panel.payload.text, 'Manage your knowledge bases and Telegram bots.');
});

test('five-item pages preserve binding targets and normal lists do not inherit hidden bind state', async () => {
  await protectionBot(42, 402);
  for (let i = 0; i < 5; i++) await makeBase(42, `Page item ${i}`);
  await managed(42, 403);
  await deliver(callback(42, 'choose:402'));
  await deliver(callback(42, 'bases:1'));
  let panel = await lastReply(42);
  assert.ok(panel.reply_markup.inline_keyboard.flat().some(button => button.callback_data.startsWith('kb:')));
  assert.ok(!panel.reply_markup.inline_keyboard.flat().some(button => button.callback_data.startsWith('bind:')));
  await deliver(callback(42, 'pick:402:1'));
  panel = await lastReply(42);
  assert.match(panel.text, /2\/2/);
  const bind = panel.reply_markup.inline_keyboard.flat().find(button => button.callback_data.startsWith('bind:402:')).callback_data;
  await deliver(callback(42, 'choose:403'));
  await deliver(callback(42, bind));
  const bots = (await pool.query('SELECT id,knowledge_base_id FROM telegram_bots WHERE id IN (402,403) ORDER BY id')).rows;
  assert.equal(bots[0].knowledge_base_id, bind.split(':')[2]);
  assert.equal(bots[1].knowledge_base_id, null);
  await deliver(callback(42, `kb:${bots[0].knowledge_base_id}:1`));
  assert.ok((await lastReply(42)).reply_markup.inline_keyboard.flat().some(button => button.callback_data === 'bases:1'));
});

test('uneditable panels recover as new messages while unchanged edits do not duplicate messages', async () => {
  await pool.query('DELETE FROM telegram_outbox');
  const original = api.call;
  const insert = () => pool.query("INSERT INTO telegram_outbox(bot_id,method,payload) VALUES (100,'editMessageText',$1)", [{ chat_id: 40, message_id: 740, text: 'Updated panel', reply_markup: { inline_keyboard: [] } }]);
  try {
    await insert();
    api.call = async () => { throw new TelegramError(400, 10, 'not_modified'); };
    assert.equal(await processOutbox(service, db), true);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM telegram_outbox')).rows[0].count, 0);
    await insert();
    api.call = async () => { throw new TelegramError(400); };
    assert.equal(await processOutbox(service, db), true);
    const row = (await pool.query('SELECT method,payload FROM telegram_outbox')).rows[0];
    assert.equal(row.method, 'sendMessage'); assert.equal(row.payload.message_id, undefined);
    api.call = original;
    assert.equal(await processOutbox(service, db), true);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM telegram_outbox')).rows[0].count, 0);
  } finally { api.call = original; await pool.query('DELETE FROM telegram_outbox'); }
});

test('restriction pages retain their page after unblocking and all callback payloads fit Telegram limits', async () => {
  await pool.query(`INSERT INTO telegram_visitors(bot_id,user_id,blocked_until)
    SELECT 400,n,now()+interval '6 hours' FROM generate_series(6000,6006) n`);
  await deliver(callback(40, 'restricted:400:1'));
  let panel = await lastReply(40);
  assert.match(panel.text, /2\/2/);
  const choices = panel.reply_markup.inline_keyboard.flat();
  const unblock = choices.find(button => button.callback_data.startsWith('unblock:400:'));
  assert.ok(unblock.callback_data.endsWith(':1'));
  assert.equal(choices.filter(button => button.callback_data.startsWith('unblock:')).length, 2);
  await deliver(callback(40, unblock.callback_data));
  panel = await lastReply(40);
  assert.match(panel.text, /2\/2/);
  assert.equal(panel.reply_markup.inline_keyboard.flat().filter(button => button.callback_data.startsWith('unblock:')).length, 1);
  const payloads = (await pool.query('SELECT payload FROM telegram_outbox')).rows;
  for (const { payload } of payloads) {
    for (const button of payload.reply_markup?.inline_keyboard?.flat() ?? []) {
      if (button.callback_data) assert.ok(Buffer.byteLength(button.callback_data) <= 64);
    }
  }
});


test('owner bot settings support draft tests, publication, rollback, stale controls and scoped details', async () => {
  const user = 91, target = '9101';
  await pool.query("INSERT INTO telegram_sessions(user_id,language) VALUES (91,'en'),(92,'ru')");
  const kb = await makeBase(user, 'Owner settings fixture');
  await ready(kb); await managed(user, Number(target));
  await deliver(callback(user, `bind:${target}:${kb}`));
  await deliver(callback(user, `toggle:${target}`));
  const state = async () => (await pool.query('SELECT answer_settings FROM telegram_bots WHERE id=$1', [target])).rows[0].answer_settings;
  const initial = await state();
  await deliver(callback(user, `bi:${target}:${initial.version}`));
  await deliver(message(user, '/help'));
  await deliver(callback(user, 'continue'));
  assert.equal((await pool.query('SELECT state FROM telegram_sessions WHERE user_id=91')).rows[0].state, 'bot_instructions');
  await deliver(message(user, 'x'.repeat(4001)));
  assert.equal((await state()).draft, null);
  await deliver(message(user, 'Use welcoming, short sentences.'));
  let current = await state();
  assert.equal(current.draft.instructions, 'Use welcoming, short sentences.');
  assert.equal(current.published.settings.instructions, '');
  await deliver(message(93, 'When does the store open?'), target);
  assert.equal(answerRuns.at(-1).settings.instructions, '');
  await deliver(callback(user, `bq:${target}:draft`));
  await deliver(message(user, 'When does the store open?'));
  assert.equal(answerRuns.at(-1).settings.instructions, current.draft.instructions);
  assert.equal(answerRuns.at(-1).inspect, true);
  const quota = (await pool.query("SELECT queries,test_queries FROM telegram_usage WHERE owner_id='telegram:91' AND day=CURRENT_DATE")).rows[0];
  assert.deepEqual(quota, { queries: 1, test_queries: 1 });
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM telegram_visitors WHERE bot_id=$1 AND user_id=91', [target])).rows[0].n, 0);
  await deliver(callback(user, `bv:${target}:c:0`));
  assert.ok((await pool.query("SELECT payload->>'text' AS text FROM telegram_outbox WHERE payload->>'chat_id'='91' ORDER BY id DESC LIMIT 1")).rows[0].text.includes('test-chunk'));
  const otherBefore = answers.length;
  for (const action of [`bs:${target}`, `bp:${target}:${current.version}`, `bq:${target}:draft`, `bv:${target}:p:0`]) await deliver(callback(92, action));
  assert.equal(answers.length, otherBefore);
  assert.deepEqual(await state(), current);
  await deliver(callback(user, `bp:${target}:${current.version}`));
  const published = await state();
  assert.equal(published.published.settings.instructions, current.draft.instructions);
  assert.equal(published.draft, null);
  await deliver(callback(user, `bi:${target}:${current.version}`));
  assert.deepEqual(await state(), published);
  await deliver(callback(user, `br:${target}:${published.version}`));
  assert.equal((await state()).published.settings.instructions, '');
  const rolledBack = await state();
  await deliver(callback(user, `bi:${target}:${rolledBack.version}`));
  await deliver(message(user, 'An unpublished edit to discard.'));
  const toDiscard = await state();
  await deliver(callback(user, `bc:${target}:${toDiscard.version}`));
  assert.deepEqual(await state(), toDiscard);
  await deliver(callback(user, `bcc:${target}:${toDiscard.version}`));
  assert.equal((await state()).draft, null);
  assert.equal((await pool.query('SELECT tuning_result FROM telegram_sessions WHERE user_id=91')).rows[0].tuning_result, null);
  const payloads = (await pool.query('SELECT payload FROM telegram_outbox')).rows.map(row => row.payload);
  for (const payload of payloads) for (const row of payload.reply_markup?.inline_keyboard ?? []) for (const item of row) {
    if (item.callback_data) assert.ok(Buffer.byteLength(item.callback_data) <= 64);
  }
});


test('confirmed off-topic classification applies after a withheld answer but never to manager tests', async () => {
  const kb = await protectionBot(94, 9401);
  const original = service;
  service = new TelegramService(pool, config, api, { async ask() {
    return { outcome: 'insufficient_context', answer: null, sources: [], topic: 'off_topic' };
  } });
  try {
    await deliver(message(9400, 'An unrelated visitor question'), '9401');
    assert.equal((await pool.query('SELECT strikes FROM telegram_visitors WHERE bot_id=9401 AND user_id=9400')).rows[0].strikes, 1);
    await deliver(callback(94, `test:${kb}`));
    await deliver(message(94, 'An unrelated owner test question'));
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM telegram_visitors WHERE bot_id=9401 AND user_id=94')).rows[0].n, 0);
  } finally { service = original; }
});

test('dialogue memory isolates visitors, bots and manager tests; bounded pairs expire and reset', async () => {
  const owner = 810, visitor = 811;
  await pool.query("INSERT INTO telegram_sessions(user_id,language) VALUES (810,'en')");
  const kb = await makeBase(owner, 'Dialogue memory');
  await ready(kb);
  await managed(owner, 8100);
  await managed(owner, 8101);
  await pool.query(`UPDATE telegram_bots SET enabled=true,knowledge_base_id=$1,
    protection='{"perMinute":30,"perDay":0,"duplicateSeconds":0}',memory_pairs=2 WHERE id IN (8100,8101)`, [kb]);
  await pool.query('INSERT INTO telegram_owner_limits(owner_id,daily,testing) VALUES ($1,0,0) ON CONFLICT(owner_id) DO UPDATE SET daily=0,testing=0', [`telegram:${owner}`]);
  const latest = () => answerRuns.at(-1)?.history;
  await deliver(message(visitor, 'Delivery options?'), '8100');
  assert.deepEqual(latest(), []);
  await deliver(message(visitor, 'And pickup?'), '8100');
  assert.deepEqual(latest().map(p => p.question), ['Delivery options?']);
  await deliver(message(visitor, 'How much?'), '8100');
  assert.equal(latest().length, 2);
  let row = (await pool.query("SELECT * FROM telegram_dialogues WHERE bot_id=8100 AND user_id=$1 AND scope='visitor'", [visitor])).rows[0];
  assert.deepEqual(row.pairs.map(p => p.question), ['And pickup?', 'How much?']);
  await deliver(message(812, 'Other visitor'), '8100');
  assert.deepEqual(latest(), []);
  await deliver(message(visitor, 'Other bot'), '8101');
  assert.deepEqual(latest(), []);
  await deliver(callback(owner, 'bq:8100:published'));
  await deliver(message(owner, 'Manager test'));
  assert.deepEqual(latest(), []);
  await deliver(message(owner, 'Manager follow-up'));
  assert.equal(latest()[0].question, 'Manager test');
  await deliver(message(owner, '/reset'));
  await deliver(message(owner, 'Fresh manager test'));
  assert.deepEqual(latest(), []);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM telegram_dialogues WHERE bot_id=8100 AND scope='visitor'")).rows[0].n, 2);
  const callsBeforeReset = answers.length;
  await deliver(message(visitor, '/reset@store8100bot'), '8100');
  assert.equal(answers.length, callsBeforeReset);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM telegram_dialogues WHERE bot_id=8100 AND user_id=$1', [visitor])).rows[0].n, 0);
  await deliver(message(visitor, 'Fresh visitor question'), '8100');
  assert.deepEqual(latest(), []);
  await pool.query("UPDATE telegram_dialogues SET expires_at=now()-interval '1 second' WHERE bot_id=8100 AND user_id=$1", [visitor]);
  await deliver(message(visitor, 'After expiry'), '8100');
  assert.deepEqual(latest(), []);
  await pool.query("UPDATE telegram_bots SET answer_settings=jsonb_set(answer_settings,'{published,id}',to_jsonb(gen_random_uuid()::text)) WHERE id=8100");
  await deliver(message(visitor, 'After publication'), '8100');
  assert.deepEqual(latest(), []);
  await deliver(callback(owner, 'mp:8100:0'));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM telegram_dialogues WHERE bot_id=8100')).rows[0].n, 0);
  await deliver(message(visitor, 'Disabled question'), '8100');
  await deliver(message(visitor, 'Disabled follow-up'), '8100');
  assert.deepEqual(latest(), []);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM telegram_dialogues WHERE bot_id=8100')).rows[0].n, 0);
});

test('memory controls enforce ownership, validate custom values, preserve help and confirm clearing', async () => {
  const user = 820;
  await pool.query("INSERT INTO telegram_sessions(user_id,language) VALUES (820,'en')");
  await managed(user, 8200);
  await deliver(callback(user, 'memory:8200'));
  let reply = await lastReply(user);
  assert.ok(reply.reply_markup.inline_keyboard.flat().some(b => b.callback_data === 'mn:8200'));
  assert.ok(reply.reply_markup.inline_keyboard.flat().every(b => Buffer.byteLength(b.callback_data) <= 64));
  await assert.rejects(service.memoryAction(db, 821, 'mcc:8200'), { code: 'not_found' });
  await deliver(callback(user, 'me:8200:pairs'));
  await deliver(message(user, '21'));
  assert.equal((await pool.query('SELECT memory_pairs FROM telegram_bots WHERE id=8200')).rows[0].memory_pairs, 5);
  await deliver(message(user, '/help'));
  await deliver(callback(user, 'continue'));
  assert.equal((await pool.query('SELECT state FROM telegram_sessions WHERE user_id=$1', [user])).rows[0].state, 'memory_value');
  await deliver(message(user, '7'));
  assert.equal((await pool.query('SELECT memory_pairs FROM telegram_bots WHERE id=8200')).rows[0].memory_pairs, 7);
  await deliver(callback(user, 'me:8200:idle'));
  await deliver(message(user, '4'));
  assert.equal((await pool.query('SELECT memory_idle_minutes FROM telegram_bots WHERE id=8200')).rows[0].memory_idle_minutes, 60);
  await deliver(message(user, '120'));
  assert.equal((await pool.query('SELECT memory_idle_minutes FROM telegram_bots WHERE id=8200')).rows[0].memory_idle_minutes, 120);
  await pool.query("INSERT INTO telegram_dialogues VALUES (8200,821,'visitor','test','[]',now()+interval '1 hour')");
  await deliver(callback(user, 'mc:8200'));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM telegram_dialogues WHERE bot_id=8200')).rows[0].n, 1);
  reply = await lastReply(user);
  assert.ok(reply.reply_markup.inline_keyboard.flat().some(b => b.callback_data === 'mcc:8200'));
  await deliver(callback(user, 'mcc:8200'));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM telegram_dialogues WHERE bot_id=8200')).rows[0].n, 0);
});

test('failed requests preserve prior memory, expired rows are removed, and reset works while paused', async () => {
  await pool.query("INSERT INTO telegram_sessions(user_id,language) VALUES (830,'en')");
  const kb = await makeBase(830, 'Memory failures');
  await ready(kb);
  await managed(830, 8300);
  await pool.query('UPDATE telegram_bots SET enabled=true,knowledge_base_id=$1 WHERE id=8300', [kb]);
  await deliver(message(831, 'Original question'), '8300');
  const before = (await pool.query('SELECT * FROM telegram_dialogues WHERE bot_id=8300')).rows[0];
  const failing = new TelegramService(pool, config, api, { ask: async () => { throw new Error('Provider failure'); } });
  await db.query('BEGIN');
  try { await failing.handle(db, '8300', message(831, 'A failed follow-up')); await db.query('COMMIT'); }
  catch (error) { await db.query('ROLLBACK'); throw error; }
  assert.deepEqual((await pool.query('SELECT * FROM telegram_dialogues WHERE bot_id=8300')).rows[0], before);
  await pool.query('UPDATE telegram_bots SET enabled=false WHERE id=8300');
  const paid = answers.length;
  await deliver(message(831, '/reset'), '8300');
  assert.equal(answers.length, paid);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM telegram_dialogues WHERE bot_id=8300')).rows[0].n, 0);
  assert.equal((await pool.query('SELECT last_hash FROM telegram_visitors WHERE bot_id=8300 AND user_id=831')).rows[0].last_hash, null);
  await pool.query("INSERT INTO telegram_dialogues VALUES (8300,831,'visitor','test','[]',now()-interval '1 second')");
  await cleanupTelegram(db);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM telegram_dialogues WHERE bot_id=8300')).rows[0].n, 0);
});

test('dialogue migration rolls back and reapplies on the disposable database', async () => {
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `/${databaseName}`;
  const run = (...args) => promisify(execFile)(process.execPath, ['node_modules/node-pg-migrate/bin/node-pg-migrate.js', ...args, '--no-verbose'], { env: { ...process.env, DATABASE_URL: url.toString() } });
  await run('down', '1');
  assert.equal((await pool.query("SELECT to_regclass('telegram_dialogues') AS name")).rows[0].name, null);
  await run('up');
  assert.equal((await pool.query("SELECT memory_pairs,memory_idle_minutes FROM telegram_bots WHERE id=8300")).rows[0].memory_pairs, 5);
});
