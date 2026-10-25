import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareChunks } from '../src/ingestion/prepare-chunks.ts';
import { chunkText } from '../src/ingestion/chunking.ts';

test('isolated tokenization preserves Unicode chunks, paragraph boundaries and token counts', async () => {
  const text = '# Delivery\n\nDelivery takes two days.\n\n' + '😀 Возврат товара в течение тридцати дней. '.repeat(120);
  assert.deepEqual(await prepareChunks(text, new AbortController().signal), chunkText(text));
});

test('tokenization can be interrupted while the main event loop remains responsive', async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30);
  try {
    await assert.rejects(prepareChunks('Sentence in a paragraph.\n\n'.repeat(80_000), controller.signal), { code: 'ingestion_interrupted' });
  } finally { clearTimeout(timer); }
  assert.ok((await prepareChunks('Content after cancellation.', new AbortController().signal)).length);
});
