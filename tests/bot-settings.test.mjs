import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { before, after, test } from 'node:test';
import pg from 'pg';
import { BotSettings, defaultBotSettings, validateBotSettings } from '../src/bots/settings.ts';

const name = `say_ai_settings_test_${randomBytes(8).toString('hex')}`;
const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
let pool, created = false;
before(async () => {
  assert.ok(process.env.DATABASE_URL);
  await admin.query(`CREATE DATABASE "${name}"`); created = true;
  const url = new URL(process.env.DATABASE_URL); url.pathname = `/${name}`;
  await promisify(execFile)(process.execPath, ['node_modules/node-pg-migrate/bin/node-pg-migrate.js', 'up', '--no-verbose'], { env: { ...process.env, DATABASE_URL: url.toString() } });
  pool = new pg.Pool({ connectionString: url.toString() });
});
after(async () => { await pool?.end(); if (created) await admin.query(`DROP DATABASE "${name}"`); await admin.end(); });

test('bot settings reject invalid instructions and unsupported profiles', () => {
  assert.deepEqual(validateBotSettings(defaultBotSettings), defaultBotSettings);
  for (const patch of [{ instructions: 'x'.repeat(4001) }, { instructions: '\0' }, { detail: 'unlimited' }, { language: 'xx' }, { retrieval: 'everything' }]) {
    assert.throws(() => validateBotSettings({ ...defaultBotSettings, ...patch }));
  }
});

test('drafts are isolated, stale updates fail, publication and rollback retain immutable versions', async () => {
  await pool.query(`INSERT INTO telegram_bots(id,owner_id,username,token_ciphertext,webhook_secret) VALUES (901,'telegram:91','one','cipher','secret'),(902,'telegram:91','two','cipher','secret')`);
  const settings = new BotSettings();
  const initial = await settings.read(pool, '901', 'telegram:91');
  await assert.rejects(settings.read(pool, '901', 'telegram:92'), { code: 'not_found' });
  const edited = { ...defaultBotSettings, instructions: 'Use a friendly tone.', detail: 'detailed' };
  const draft = await settings.save(pool, '901', 'telegram:91', initial.version, edited);
  assert.deepEqual(draft.published.settings, defaultBotSettings);
  assert.deepEqual(draft.draft, edited);
  await assert.rejects(settings.save(pool, '901', 'telegram:91', initial.version, edited), { code: 'stale_settings' });
  await assert.rejects(settings.publish(pool, '901', 'telegram:92', draft.version), { code: 'not_found' });
  const published = await settings.publish(pool, '901', 'telegram:91', draft.version);
  assert.deepEqual(published.published.settings, edited);
  assert.equal(published.draft, null);
  assert.deepEqual((await settings.read(pool, '902', 'telegram:91')).published.settings, defaultBotSettings);
  const rolled = await settings.rollback(pool, '901', 'telegram:91', published.version);
  assert.deepEqual(rolled.published.settings, defaultBotSettings);
  assert.deepEqual(rolled.history.find(r => r.id === published.published.id).settings, edited);
  assert.deepEqual(draft.published.settings, defaultBotSettings);
});

test('concurrent draft writes use compare-and-swap and publishing leaves a paused bot paused', async () => {
  await pool.query("INSERT INTO telegram_bots(id,owner_id,username,token_ciphertext,webhook_secret) VALUES (903,'telegram:93','three','cipher','secret')");
  const settings = new BotSettings();
  const original = await settings.read(pool, '903', 'telegram:93');
  const writes = await Promise.allSettled(['First', 'Second'].map(instructions => settings.save(pool, '903', 'telegram:93', original.version, { ...defaultBotSettings, instructions })));
  assert.equal(writes.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(writes.find(r => r.status === 'rejected').reason.code, 'stale_settings');
  const latest = await settings.read(pool, '903', 'telegram:93');
  await settings.publish(pool, '903', 'telegram:93', latest.version);
  assert.equal((await pool.query('SELECT enabled FROM telegram_bots WHERE id=903')).rows[0].enabled, false);
});
