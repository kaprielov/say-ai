import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { startPublicDevelopment } from '../scripts/dev-public.mjs';

async function harness() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const signals = new EventEmitter();
  const lifecycle = new EventEmitter();
  const children = [];
  const env = { PORT: String(port), TELEGRAM_PUBLIC_URL: 'https://old.example.com', TEST_SETTING: 'preserved' };
  function spawnProcess(command, args, options) {
    const child = new EventEmitter();
    Object.assign(child, { command, args, options, stdout: new PassThrough(), stderr: new PassThrough(), pid: 100 + children.length, exitCode: null, signalCode: null });
    child.kill = signal => {
      child.signalCode = signal;
      queueMicrotask(() => child.emit('exit', null, signal));
    };
    children.push(child); lifecycle.emit('spawn', child);
    return child;
  }
  const spawned = once(lifecycle, 'spawn');
  const completed = startPublicDevelopment({ env, spawnProcess, signals, write() {} });
  await spawned;
  return { children, signals, completed, env };
}

test('public launcher waits for a connected tunnel, injects its URL, and stops both children', async () => {
  const { children, signals, completed, env } = await harness();
  children[0].stderr.write('Open https://test-');
  children[0].stderr.write('launch.trycloudflare.com\n');
  assert.equal(children.length, 1);
  children[0].stderr.write('Registered tunnel connection\n');
  assert.equal(children.length, 2);
  assert.equal(children[1].options.env.TELEGRAM_PUBLIC_URL, 'https://test-launch.trycloudflare.com');
  assert.equal(children[1].options.env.TEST_SETTING, 'preserved');
  assert.equal(env.TELEGRAM_PUBLIC_URL, 'https://old.example.com');
  children[0].stderr.write('Registered tunnel connection\n');
  assert.equal(children.length, 2);
  signals.emit('SIGINT');
  assert.equal(await completed, 0);
  assert.ok(children.every(child => child.signalCode === 'SIGTERM'));
  assert.equal(signals.listenerCount('SIGINT'), 0);
});

test('tunnel failure ends startup without launching the backend', async () => {
  const { children, completed } = await harness();
  children[0].exitCode = 1; children[0].emit('exit', 1);
  assert.equal(await completed, 1);
  assert.equal(children.length, 1);
});

test('backend exit also stops the tunnel', async () => {
  const { children, completed } = await harness();
  children[0].stderr.write('https://test-launch.trycloudflare.com\nRegistered tunnel connection\n');
  children[1].exitCode = 2; children[1].emit('exit', 2);
  assert.equal(await completed, 2);
  assert.equal(children[0].signalCode, 'SIGTERM');
});
