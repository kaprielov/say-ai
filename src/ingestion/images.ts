import { spawn } from 'node:child_process';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QueryError } from '../queries/errors.js';

export const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp']);
export const imageLimits = { pixels: 25_000_000, side: 4096, outputBytes: 10_000_000, decodeMs: 15_000, recognitionMs: 60_000 } as const;
export type ImageSource = { bytes: Buffer; filename: string };
let activeDecoders = 0;

export function isImage(filename: string) { return imageExtensions.has(extname(filename).toLowerCase()); }

// Native decoder memory is bounded by pixel/input/output limits, not just the JS heap.
export async function normalizeImage(buffer: Buffer, filename: string, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted();
  if (!isImage(filename)) throw new QueryError(415, 'unsupported_file_type', 'Unsupported file format.');
  if (!buffer.length || buffer.length > 20_000_000) throw new QueryError(400, 'invalid_image', 'Unable to read image. Use a static JPEG, PNG, or WebP image up to 25 megapixels.');
  if (activeDecoders >= 2) throw new QueryError(429, 'image_capacity_full', 'Image processing is busy. Try again later.');
  activeDecoders++;
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      const sourceMode = import.meta.url.endsWith('.ts');
      const worker = fileURLToPath(new URL(sourceMode ? './image-worker.ts' : './image-worker.js', import.meta.url));
      const child = spawn(process.execPath, ['--max-old-space-size=256', ...(sourceMode ? ['--import', 'tsx'] : []), worker, extname(filename).toLowerCase()], { stdio: ['pipe', 'pipe', 'ignore'] });
      const chunks: Buffer[] = [];
      let size = 0;
      let failure: unknown;
      const stop = (error: unknown) => { failure ??= error; child.kill('SIGKILL'); };
      const abort = () => stop(signal.reason ?? new Error('Image processing cancelled.'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      const timer = setTimeout(() => stop(new QueryError(422, 'image_timeout', 'Image processing timed out. Try a smaller image.')), imageLimits.decodeMs);
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > imageLimits.outputBytes) stop(new QueryError(413, 'image_too_large', 'The normalized image is too large. Upload a smaller image.'));
        else chunks.push(chunk);
      });
      child.stdin.on('error', () => {});
      child.on('error', () => { failure ??= new QueryError(503, 'image_unavailable', 'Image processing is unavailable. Try again later.'); });
      child.on('close', code => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        if (failure) reject(failure);
        else if (code !== 0 || !size) reject(new QueryError(400, 'invalid_image', 'Unable to read image. Use a static JPEG, PNG, or WebP image up to 25 megapixels.'));
        else resolve(Buffer.concat(chunks));
      });
      child.stdin.end(buffer);
    });
  } finally { activeDecoders--; }
}
