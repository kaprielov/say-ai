import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const name = `say_ai_catalog_${randomBytes(8).toString('hex')}`;
const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
let pool, url, created = false;
const migrate = (...args) => promisify(execFile)(process.execPath,
  ['node_modules/node-pg-migrate/bin/node-pg-migrate.js', ...args, '--no-verbose'],
  { env: { ...process.env, DATABASE_URL: url.toString() } });

before(async () => {
  await admin.query(`CREATE DATABASE "${name}"`);
  created = true;
  url = new URL(process.env.DATABASE_URL);
  url.pathname = `/${name}`;
  await migrate('up');
  pool = new pg.Pool({ connectionString: url.toString() });
});

after(async () => {
  if (pool) await pool.end();
  try { if (created) await admin.query(`DROP DATABASE "${name}"`); }
  finally { await admin.end(); }
});

test('catalog migration supports an empty installation', async () => {
  const result = await pool.query("SELECT to_regclass('public.listings') IS NOT NULL AS ready");
  assert.equal(result.rows[0].ready, true, 'Catalog tables must be created by migrations');
});

test('pilot import preserves stock and measurements; ownership and selections remain isolated', async () => {
  await migrate('down', '1');
  await pool.query(`INSERT INTO telegram_bots(id,owner_id,username,token_ciphertext,webhook_secret)
    VALUES (8785889729,'telegram:264147129','antontest111bot123bot','fixture','fixture'),
           (100,'other-owner','otherbot','fixture','fixture')`);
  await pool.query(await readFile(new URL('../scripts/fixtures/avito-test-catalog.sql', import.meta.url), 'utf8'));
  const original = (await pool.query('SELECT external_id,size,stock,measurements_cm FROM test_catalog.listing_variants ORDER BY external_id,size')).rows;
  await migrate('up');
  assert.deepEqual((await pool.query('SELECT external_id,size,stock,measurements_cm FROM listing_variants ORDER BY external_id,size')).rows, original);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM listings')).rows[0].n, 2);
  await assert.rejects(pool.query("UPDATE listings SET owner_id='other-owner' WHERE external_id='8196709817'"), { code: '23503' });
  await assert.rejects(pool.query("UPDATE listing_variants SET stock=-1 WHERE size='M'"), { code: '23514' });
  await assert.rejects(pool.query(`INSERT INTO telegram_listing_selections(bot_id,user_id,owner_id,external_id)
    VALUES (100,7,'other-owner','8196709817')`), { code: '23503' });
  await pool.query(`INSERT INTO telegram_listing_selections(bot_id,user_id,owner_id,external_id)
    VALUES (8785889729,7,'telegram:264147129','8196709817'),
           (8785889729,8,'telegram:264147129','8228360596')`);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM telegram_listing_selections')).rows[0].n, 2);
  await pool.query("UPDATE telegram_bots SET owner_id='new-owner' WHERE id=8785889729");
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM listings')).rows[0].n, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM listing_variants')).rows[0].n, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM telegram_listing_selections')).rows[0].n, 0);
});
