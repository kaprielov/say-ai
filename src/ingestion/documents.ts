import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { QueryError } from '../queries/errors.js';

export const documentExtensions = new Set(['.pdf', '.docx', '.doc']);
const maxTextBytes = 1024 * 1024;
let activeExtractions = 0;

export async function extractDocument(buffer: Buffer, extension: string, signal?: AbortSignal): Promise<string> {
  const signatureValid = extension === '.pdf' ? buffer.subarray(0, 5).toString() === '%PDF-'
    : extension === '.docx' ? buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
      : buffer.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'));
  if (!signatureValid) throw new QueryError(400, 'invalid_document', 'File contents do not match the document format.');
  if (activeExtractions >= 2) throw new QueryError(429, 'document_capacity_full', 'Document extraction is busy. Try again later.');
  activeExtractions++;
  try {
    return await new Promise<string>((resolve, reject) => {
      const sourceMode = import.meta.url.endsWith('.ts');
      const worker = fileURLToPath(new URL(sourceMode ? './document-worker.ts' : './document-worker.js', import.meta.url));
      const child = spawn(process.execPath, [
        '--max-old-space-size=256', ...(sourceMode ? ['--import', 'tsx'] : []), worker, extension,
      ], { stdio: ['pipe', 'pipe', 'ignore'] });
      const chunks: Buffer[] = [];
      let size = 0;
      let failure: QueryError | undefined;
      const stop = (error: QueryError) => {
        failure ??= error;
        child.kill('SIGKILL');
      };
      const abort = () => stop(new QueryError(499, 'client_disconnected', 'Client disconnected.'));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const timer = setTimeout(() => stop(new QueryError(422, 'document_timeout', 'Document extraction exceeded 15 seconds.')), 15_000);
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxTextBytes) {
          stop(new QueryError(413, 'extracted_text_too_large', 'Extracted text must not exceed 1 MiB.'));
        } else chunks.push(chunk);
      });
      // A parser may exit before consuming its input (for example, an invalid document).
      child.stdin.on('error', () => {});
      child.on('error', () => {
        failure ??= new QueryError(503, 'extraction_unavailable', 'Document extraction is unavailable.');
      });
      child.on('close', code => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (failure) reject(failure);
        else if (code !== 0) reject(new QueryError(400, 'invalid_document', 'Unable to read document. It may be damaged, encrypted, or unsupported.'));
        else {
          const text = Buffer.concat(chunks).toString('utf8');
          if (!text.trim()) reject(new QueryError(400, 'empty_document', 'Document contains no extractable text. Scanned documents require OCR.'));
          else resolve(text);
        }
      });
      child.stdin.end(buffer);
    });
  } finally {
    activeExtractions--;
  }
}
