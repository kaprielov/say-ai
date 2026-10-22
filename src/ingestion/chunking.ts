import { getEncoding } from 'js-tiktoken';

const encoding = getEncoding('cl100k_base');
export const chunkingConfig = { encoding: 'cl100k_base', maxTokens: 512, overlapTokens: 64 } as const;

export function countTokens(text: string) {
  // Treat strings resembling special tokens as ordinary submitted content.
  return encoding.encode(text, [], []).length;
}

export function chunkText(text: string, maxTokens = 512, overlapTokens = 64) {
  if (!Number.isInteger(maxTokens) || maxTokens < 8 || maxTokens > 8191 ||
      !Number.isInteger(overlapTokens) || overlapTokens < 0 || overlapTokens >= maxTokens) {
    throw new Error('Invalid chunk token limits.');
  }
  // Slice original Unicode code points rather than token bytes, which can split a character.
  const characters = Array.from(text);
  const chunks: { text: string; tokenCount: number }[] = [];
  let start = 0;
  while (start < characters.length) {
    let low = start + 1;
    let high = Math.min(characters.length, start + maxTokens * 16);
    let end = start;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (countTokens(characters.slice(start, middle).join('')) <= maxTokens) {
        end = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (end === start) throw new Error('A source character exceeds the chunk budget.');
    const chunk = characters.slice(start, end).join('');
    if (chunk.trim()) chunks.push({ text: chunk, tokenCount: countTokens(chunk) });
    if (end === characters.length) break;

    // Keep a suffix within the overlap budget while guaranteeing forward progress.
    low = 0;
    high = end - start - 1;
    let overlap = 0;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (countTokens(characters.slice(end - middle, end).join('')) <= overlapTokens) {
        overlap = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    start = end - overlap;
  }
  return chunks;
}
