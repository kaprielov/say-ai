import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractDocument } from '../src/ingestion/documents.ts';
import { wordFixture } from './helpers/documents.mjs';

test('document extraction bounds concurrency, cancels child processes, and releases capacity', async () => {
  const buffer = await wordFixture('docx');
  const first = new AbortController();
  const second = new AbortController();
  const firstResult = assert.rejects(extractDocument(buffer, '.docx', first.signal), { code: 'client_disconnected' });
  const secondResult = assert.rejects(extractDocument(buffer, '.docx', second.signal), { code: 'client_disconnected' });
  try {
    await assert.rejects(extractDocument(buffer, '.docx'), { status: 429, code: 'document_capacity_full' });
  } finally {
    first.abort();
    second.abort();
    await Promise.all([firstResult, secondResult]);
  }
  assert.ok((await extractDocument(buffer, '.docx')).includes('10 PM'));
});


test('source decoder accepts larger text and limits extracted UTF-8 bytes', async () => {
  const { decodeSource } = await import('../src/ingestion/source.ts');
  const content = 'é'.repeat(600_000);
  assert.equal(await decodeSource(Buffer.from(content), 'larger.txt'), content);
  await assert.rejects(decodeSource(Buffer.alloc(20_000_001, 120), 'oversized.txt'), { code: 'payload_too_large' });
  await assert.rejects(decodeSource(Buffer.alloc(5 * 1024 * 1024 + 1, 120), 'text.txt'), { code: 'extracted_text_too_large' });
});

test('Telegram downloads enforce metadata and streaming limits even when size is missing', async t => {
  const { TelegramClient } = await import('../src/telegram/client.ts');
  const client = new TelegramClient();
  let metadata = { file_path: 'file' }, size = 20_000_000, requests = 0;
  t.mock.method(client, 'call', async () => metadata);
  t.mock.method(globalThis, 'fetch', async () => { requests++; return new Response(Buffer.alloc(size)); });
  assert.equal((await client.download('test-token', 'file')).length, 20_000_000);
  size++;
  await assert.rejects(client.download('test-token', 'file'), { code: 'payload_too_large' });
  metadata = { file_path: 'file', file_size: size };
  await assert.rejects(client.download('test-token', 'file'), { code: 'payload_too_large' });
  assert.equal(requests, 2);
  metadata = {};
  await assert.rejects(client.download('test-token', 'file'), { code: 502 });
});
