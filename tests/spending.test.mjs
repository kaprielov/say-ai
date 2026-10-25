import assert from 'node:assert/strict';
import { test } from 'node:test';
import { priceUsage, spendingAmount, spendingTransport } from '../src/providers/spending.ts';

const body = {
  model: 'gpt-6-luna-2026-10-01', service_tier: 'default',
  usage: { input_tokens: 12000, output_tokens: 1000,
    input_tokens_details: { cached_tokens: 4000, cache_write_tokens: 7000,
      cache_write_tokens_details: { ttl_30m_tokens: 6000, ttl_12h_tokens: 1000 } },
    output_tokens_details: { reasoning_tokens: 200 } },
};

test('USD estimates separate ordinary input, cache reads, writes by lifetime and output without double charging reasoning', () => {
  const priced = priceUsage('responses', 'gpt-6-luna', body);
  assert.equal(priced.cost, '0.001640000000');
  assert.equal(priced.model, body.model);
  assert.equal(priced.reasoning, 200);
  assert.equal(priced.rates.version, 'openai-2026-10-25');
  assert.equal(priceUsage('embeddings', 'text-embedding-3-small', { usage: { prompt_tokens: 1000, total_tokens: 1000 } }).cost, '0.000020000000');
  assert.equal(priceUsage('embeddings', 'text-embedding-3-large', { usage: { total_tokens: 1000 } }).cost, '0.000130000000');
  assert.equal(spendingAmount('0.00000001'), '<$0.0001');
});

test('missing usage, invalid counts, unknown rates and processing tiers never become zero-cost calls', () => {
  const variants = [
    {}, { ...body, usage: undefined }, { ...body, model: 'unpriced-model' }, { ...body, service_tier: 'priority' },
    { ...body, usage: { ...body.usage, output_tokens: -1 } },
    { ...body, usage: { ...body.usage, input_tokens: 1.1 } },
    { ...body, usage: { ...body.usage, input_tokens: 300000 } },
    { ...body, usage: { ...body.usage, input_tokens_details: { cached_tokens: 13000, cache_write_tokens: 0 } } },
    { ...body, usage: { ...body.usage, input_tokens_details: { cached_tokens: 0 } } },
    { ...body, usage: { ...body.usage, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 7000 } } },
  ];
  for (const variant of variants) assert.equal(priceUsage('responses', 'gpt-6-luna', variant).cost, null);
  assert.equal(priceUsage('embeddings', 'unpriced-model', { usage: { total_tokens: 100 } }).cost, null);
  assert.equal(priceUsage('embeddings', 'toString', { usage: { total_tokens: 100 } }).cost, null);
});

test('an unavailable ledger suppresses the paid call', async () => {
  let calls = 0;
  const request = spendingTransport({ async query() { throw new Error('Ledger unavailable'); } }, async () => { calls++; }, 'telegram:1', { purpose: 'answers' });
  await assert.rejects(request('https://api.openai.com/v1/responses', { body: JSON.stringify({ model: 'gpt-6-luna' }) }), /Ledger unavailable/);
  assert.equal(calls, 0);
});
