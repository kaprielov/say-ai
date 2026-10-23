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
