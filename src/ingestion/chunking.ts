import { getEncoding } from 'js-tiktoken';

const encoding = getEncoding('cl100k_base');
const sentenceSegmenter = new Intl.Segmenter('und', { granularity: 'sentence' });
export const chunkingConfig = {
  encoding: 'cl100k_base', maxTokens: 512, overlapTokens: 64,
  strategy: 'paragraph-sentence-v1',
} as const;

export function countTokens(text: string) {
  // Treat strings resembling special tokens as ordinary submitted content.
  return encoding.encode(text, [], []).length;
}

function lastBoundary(boundaries: number[], minimum: number, maximum: number) {
  let low = 0;
  let high = boundaries.length - 1;
  let result: number | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const boundary = boundaries[middle]!;
    if (boundary <= maximum) {
      if (boundary > minimum) result = boundary;
      low = middle + 1;
    } else high = middle - 1;
  }
  return result;
}

export function chunkText(text: string, maxTokens = 512, overlapTokens = 64) {
  if (!Number.isInteger(maxTokens) || maxTokens < 8 || maxTokens > 8191 ||
      !Number.isInteger(overlapTokens) || overlapTokens < 0 || overlapTokens >= maxTokens) {
    throw new Error('Invalid chunk token limits.');
  }
  // Slice original Unicode code points rather than token bytes, which can split a character.
  const characters = Array.from(text);
  const offsets = new Uint32Array(text.length + 1);
  let offset = 0;
  for (const [index, character] of characters.entries()) {
    offset += character.length;
    offsets[offset] = index + 1;
  }
  const paragraphs = Array.from(text.matchAll(/(?:\r?\n[\t ]*){2,}/g), match => offsets[match.index + match[0].length]!);
  // LF is a mandatory sentence break. Segment lines independently to avoid
  // ICU repeatedly traversing a multi-megabyte input for each sentence.
  const sentences = Array.from(text.matchAll(/[^\n]*\n|[^\n]+$/gu)).flatMap(line =>
    Array.from(sentenceSegmenter.segment(line[0]), segment => offsets[line.index + segment.index + segment.segment.length]!));
  const boundaries = [...new Set([...paragraphs, ...sentences])].sort((a, b) => a - b);
  const paragraphEnds = new Set(paragraphs);
  let paragraphIndex = 0;
  let coveredEnd = 0;
  const chunks: { text: string; tokenCount: number }[] = [];
  let start = 0;
  while (start < characters.length) {
    const minimum = Math.max(start, coveredEnd);
    while (paragraphIndex < paragraphs.length && paragraphs[paragraphIndex]! <= minimum) paragraphIndex++;
    const nextParagraph = paragraphs[paragraphIndex];
    // Every UTF-8 byte can be represented by at most one ordinary token. If
    // the whole paragraph fits this byte bound, every prefix fits as well;
    // the binary search below would necessarily reach this paragraph end.
    const shortParagraph = nextParagraph !== undefined && nextParagraph - start <= maxTokens
      ? characters.slice(start, nextParagraph).join('') : undefined;
    let low = start + 1;
    let high = Math.min(characters.length, start + maxTokens * 16);
    let end = start;
    if (shortParagraph !== undefined && Buffer.byteLength(shortParagraph) <= maxTokens) {
      end = nextParagraph!;
    } else while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (countTokens(characters.slice(start, middle).join('')) <= maxTokens) {
        end = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (end === start) throw new Error('A source character exceeds the chunk budget.');
    // Keep paragraphs separate so an embedding does not mix unrelated policies.
    // Only choose a boundary beyond the preceding chunk to avoid repeating an overlap forever.
    const paragraphEnd = nextParagraph !== undefined && nextParagraph <= end ? nextParagraph : undefined;
    if (paragraphEnd !== undefined) end = paragraphEnd;
    else if (end < characters.length) {
      // Oversized paragraphs use sentences; oversized sentences retain a hard token limit.
      const sentenceEnd = lastBoundary(sentences, minimum, end);
      end = sentenceEnd ?? end;
    }
    const chunk = characters.slice(start, end).join('');
    if (chunk.trim()) chunks.push({ text: chunk, tokenCount: countTokens(chunk) });
    coveredEnd = Math.max(coveredEnd, end);
    if (end === characters.length) break;
    // Neighbor expansion supplies surrounding paragraphs at query time.
    if (paragraphEnds.has(end)) {
      start = end;
      continue;
    }

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
    // Start overlap at a complete sentence/paragraph when possible. Do not cut a
    // normal sentence solely to fill the overlap allowance. Hard splits still overlap.
    const boundary = boundaries.find(boundary => boundary >= end - overlap && boundary > start && boundary < end);
    start = boundary ?? (boundaries.includes(end) ? end : end - overlap);
  }
  return chunks;
}
