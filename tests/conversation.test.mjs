import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answerRequest, OpenAIAnswerer } from '../src/queries/answerer.ts';

test('answer requests carry bounded dialogue as untrusted data, separate from evidence', () => {
  const history = [{ question: 'Which delivery options exist?', answer: 'Courier and pickup.' }];
  const request = answerRequest('How much is the second?', [{ id: '1', text: 'Pickup costs 5.' }], undefined, history);
  const input = JSON.parse(request.input[0].content);
  assert.deepEqual(input.history, history);
  assert.match(request.instructions, /history.*not evidence/i);
  assert.deepEqual(input.context, [{ id: '1', text: 'Pickup costs 5.' }]);
});

test('follow-up resolution uses an isolated structured request and validates its output', async () => {
  let request;
  const adapter = new OpenAIAnswerer('test', async (_url, options) => {
    request = JSON.parse(options.body);
    return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ question: 'How much does pickup cost?' }) }] }] });
  });
  const history = [{ question: 'Delivery?', answer: 'Courier and pickup.' }];
  assert.equal(await adapter.resolveQuestion('How much is the second?', history, new AbortController().signal), 'How much does pickup cost?');
  assert.deepEqual(JSON.parse(request.input[0].content).history, history);
  assert.equal(request.store, false);
  assert.match(request.instructions, /untrusted/i);
  const invalid = new OpenAIAnswerer('test', async () => Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"question":""}' }] }] }));
  await assert.rejects(invalid.resolveQuestion('And?', history, new AbortController().signal), { code: 'answer_generation_failed' });
});

test('history preserves complete newest pairs within pair and token limits', async () => {
  const { boundHistory } = await import('../src/telegram/memory.ts');
  const pairs = Array.from({ length: 25 }, (_, n) => ({ question: String(n), answer: 'Answer' }));
  assert.deepEqual(boundHistory(pairs, 0), []);
  assert.deepEqual(boundHistory(pairs, 2), pairs.slice(-2));
  assert.equal(boundHistory(pairs, 100).length, 20);
  const oversized = { question: 'long '.repeat(7000), answer: 'Answer' };
  assert.deepEqual(boundHistory([oversized, pairs[0]], 2), [pairs[0]]);
  assert.deepEqual(boundHistory([pairs[0], oversized], 2), []);
});
