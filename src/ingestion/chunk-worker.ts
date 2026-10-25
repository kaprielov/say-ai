// Keep CPU-heavy tokenization outside the API process without changing chunk semantics.
import { chunkText } from './chunking.js';
import { uploadLimits } from './limits.js';

try {
  const buffers: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > uploadLimits.textBytes) throw new Error('Source text exceeds the processing limit.');
    buffers.push(Buffer.from(chunk));
  }
  process.stdout.write(JSON.stringify(chunkText(Buffer.concat(buffers).toString('utf8'))));
} catch {
  process.exitCode = 1;
}
