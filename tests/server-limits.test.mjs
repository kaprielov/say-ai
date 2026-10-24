import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { httpAdmission, serverLimits } from '../src/server-limits.ts';
import { webhookDelivery } from '../src/telegram/webhook-delivery.ts';

function response() {
  const value = new EventEmitter();
  value.set = (name, header) => { value[name] = header; return value; };
  value.status = code => { value.statusCode = code; return value; };
  value.json = body => { value.body = body; return value; };
  return value;
}

test('webhook delivery bounds Telegram concurrency and resolves temporary tunnel addresses', async () => {
  let calls = 0;
  const resolve = async host => { calls++; assert.equal(host, 'new.trycloudflare.com'); return ['104.16.230.132']; };
  assert.deepEqual(await webhookDelivery('https://example.com', resolve), { max_connections: 2 });
  assert.equal(calls, 0);
  assert.deepEqual(await webhookDelivery('https://new.trycloudflare.com', resolve), { max_connections: 2, ip_address: '104.16.230.132' });
  assert.equal(calls, 1);
  assert.deepEqual(await webhookDelivery('https://new.trycloudflare.com', async () => { throw new Error('DNS unavailable'); }), { max_connections: 2 });
});

test('HTTP admission bounds active handlers and releases each slot exactly once', () => {
  const gate = httpAdmission();
  let admitted = 0;
  const responses = Array.from({ length: serverLimits.httpConcurrent }, response);
  for (const res of responses) gate({}, res, () => { admitted++; });
  const rejected = response();
  gate({}, rejected, () => { admitted++; });
  assert.equal(admitted, 64); assert.equal(rejected.statusCode, 503);
  assert.equal(rejected['Retry-After'], '2');
  responses[0].emit('finish'); responses[0].emit('close');
  gate({}, response(), () => { admitted++; });
  gate({}, response(), () => { admitted++; });
  assert.equal(admitted, 65);
});

test('a rapid HTTP burst is rejected even when every handler completes immediately', () => {
  const gate = httpAdmission();
  let admitted = 0, rejected = 0;
  for (let i = 0; i < 110; i++) {
    const res = response();
    gate({}, res, () => { admitted++; res.emit('finish'); });
    if (res.statusCode === 503) rejected++;
  }
  assert.ok(admitted >= 100 && admitted < 110);
  assert.ok(rejected > 0);
});
