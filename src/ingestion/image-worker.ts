import sharp from 'sharp';
import { imageLimits } from './images.js';

try {
  sharp.cache(false);
  sharp.concurrency(1);
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 20_000_000) throw new Error('Input limit exceeded.');
    chunks.push(Buffer.from(chunk));
  }
  const input = Buffer.concat(chunks);
  const options = { limitInputPixels: imageLimits.pixels, failOn: 'warning' as const, animated: true };
  const metadata = await sharp(input, options).metadata();
  const expected = process.argv[2] === '.jpg' || process.argv[2] === '.jpeg' ? 'jpeg' : process.argv[2]?.slice(1);
  if (metadata.format !== expected || (metadata.pages ?? 1) !== 1 || !metadata.width || !metadata.height || metadata.width * metadata.height > imageLimits.pixels) throw new Error('Invalid image.');
  const output = await sharp(input, options).autoOrient().resize({ width: imageLimits.side, height: imageLimits.side, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
  if (output.length > imageLimits.outputBytes) throw new Error('Output limit exceeded.');
  process.stdout.write(output);
} catch { process.exitCode = 1; }
