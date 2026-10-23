import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { pathToFileURL } from 'node:url';

// cloudflared writes its generated URL to stderr, potentially across chunks.
export function readTunnelOutput(previous, chunk) {
  const text = (previous + chunk).slice(-32_768);
  return { text, url: text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/)?.[0], connected: text.includes('Registered tunnel connection') };
}

async function checkPort(port) {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', () => reject(new Error(`Port ${port} is already in use. Stop the existing backend first.`)));
    probe.listen(port, '127.0.0.1', resolve);
  });
  await new Promise(resolve => probe.close(resolve));
}

export async function startPublicDevelopment({ env = process.env, spawnProcess = spawn, write = value => process.stderr.write(value), signals = process } = {}) {
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535.');
  await checkPort(port);
  let backend;
  let stopping = false;
  let output = '';
  let publicUrl;
  const children = [];
  const tunnel = spawnProcess('cloudflared', ['tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(tunnel);

  let finish;
  const completed = new Promise(resolve => { finish = resolve; });
  function stop(code = 0) {
    if (stopping) return;
    stopping = true;
    clearTimeout(startupTimer);
    signals.removeListener('SIGINT', onInterrupt);
    signals.removeListener('SIGTERM', onInterrupt);
    let remaining = children.length;
    const deadline = setTimeout(() => {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      finish(code);
    }, 10_000);
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
        remaining--;
      } else {
        child.once('exit', () => { if (--remaining === 0) { clearTimeout(deadline); finish(code); } });
        child.kill('SIGTERM');
      }
    }
    if (remaining === 0) { clearTimeout(deadline); finish(code); }
  }
  const onInterrupt = () => stop(0);
  signals.once('SIGINT', onInterrupt);
  signals.once('SIGTERM', onInterrupt);
  const startupTimer = setTimeout(() => { write('Cloudflare Tunnel did not connect within 60 seconds.\n'); stop(1); }, 60_000);
  tunnel.once('error', () => { write('Unable to start cloudflared. Install it and ensure it is on PATH.\n'); stop(1); });
  tunnel.once('exit', code => { if (!stopping) { write('Cloudflare Tunnel stopped.\n'); stop(code || 1); } });

  const consume = chunk => {
    write(chunk.toString());
    const state = readTunnelOutput(output, chunk.toString());
    output = state.text;
    publicUrl ??= state.url;
    if (!backend && !stopping && publicUrl && state.connected) {
      clearTimeout(startupTimer);
      write(`\nPublic API: ${publicUrl}\nStarting backend with automatic Telegram webhook configuration.\n`);
      backend = spawnProcess(process.execPath, ['--env-file-if-exists=.env', '--import', 'tsx', '--watch', 'src/index.ts'], {
        env: { ...env, TELEGRAM_PUBLIC_URL: publicUrl }, stdio: 'inherit',
      });
      children.push(backend);
      backend.once('error', () => { write('Unable to start the backend.\n'); stop(1); });
      backend.once('exit', code => { if (!stopping) stop(code ?? 1); });
    }
  };
  tunnel.stdout.on('data', consume);
  tunnel.stderr.on('data', consume);
  return completed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = await startPublicDevelopment(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
