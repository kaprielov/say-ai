import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { IngestionError } from './embeddings.js';

type Chunk = { text: string; tokenCount: number };

export function prepareChunks(text: string, signal: AbortSignal): Promise<Chunk[]> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const sourceMode = import.meta.url.endsWith('.ts');
    const path = fileURLToPath(new URL(sourceMode ? './chunk-worker.ts' : './chunk-worker.js', import.meta.url));
    const child = spawn(process.execPath, ['--max-old-space-size=768', ...(sourceMode ? ['--import', 'tsx'] : []), path], { stdio: ['pipe', 'pipe', 'ignore'] });
    let failure: Error | undefined;
    const buffers: Buffer[] = [];
    let size = 0;
    const stop = (error: Error) => { failure ??= error; child.kill('SIGKILL'); };
    const abort = () => stop(new IngestionError('ingestion_interrupted', 'Content processing was interrupted.'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    child.stdin.on('error', () => {});
    child.stdout.on('data', (bytes: Buffer) => {
      size += bytes.length;
      if (size > 64 * 1024 * 1024) stop(new IngestionError('content_too_complex', 'Content produces too many fragments. Reduce the source text.', false));
      else buffers.push(bytes);
    });
    child.on('error', () => { failure ??= new IngestionError('chunking_unavailable', 'Content processing is unavailable.'); });
    child.on('close', code => {
      signal.removeEventListener('abort', abort);
      if (failure) { reject(failure); return; }
      if (code !== 0) { reject(new IngestionError('content_too_complex', 'Content could not be split within the processing memory limit. Reduce the source text.', false)); return; }
      try { resolve(JSON.parse(Buffer.concat(buffers).toString('utf8')) as Chunk[]); }
      catch { reject(new IngestionError('chunking_failed', 'Content processing failed.')); }
    });
    child.stdin.end(text);
  });
}
