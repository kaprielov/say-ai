import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import { after, before, beforeEach, afterEach, test } from 'node:test';
import pg from 'pg';
import { createApp } from '../src/app.ts';
import { countTokens } from '../src/ingestion/chunking.ts';
import { OpenAIEmbedder } from '../src/ingestion/embeddings.ts';
import { OpenAIAnswerer } from '../src/queries/answerer.ts';
import { QuestionAnswering } from '../src/queries/service.ts';
import { QueryLimits } from '../src/queries/limits.ts';

const databaseName = `say_ai_queries_test_${randomBytes(8).toString('hex')}`;
const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const apiKey = randomBytes(32).toString('base64url');
const ownerId = 'query-test-owner';
const servers = [];
let pool;
let created = false;

before(async () => {
  assert.ok(process.env.DATABASE_URL);
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  created = true;
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `/${databaseName}`;
  await promisify(execFile)(process.execPath, ['node_modules/node-pg-migrate/bin/node-pg-migrate.js', 'up', '--no-verbose'], {
    env: { ...process.env, DATABASE_URL: url.toString() },
  });
  pool = new pg.Pool({ connectionString: url.toString(), connectionTimeoutMillis: 3000 });
});

beforeEach(async () => {
  await pool.query('TRUNCATE chunks, content_versions, ingestion_tasks, knowledge_bases');
});

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise(resolve => server.close(resolve));
});

after(async () => {
  if (pool) await pool.end();
  try {
    if (created) await admin.query(`DROP DATABASE "${databaseName}"`);
  } finally {
    await admin.end();
  }
});

async function readyKnowledgeBase({ owner = ownerId, text = 'Velora retains audit logs for 37 days.', vector = [1, 0, 0], kbId } = {}) {
  if (!kbId) kbId = (await pool.query('INSERT INTO knowledge_bases (owner_id) VALUES ($1) RETURNING id', [owner])).rows[0].id;
  const taskId = (await pool.query(`
    INSERT INTO ingestion_tasks (knowledge_base_id, source_text, status, attempts_started)
    VALUES ($1, $2, 'ready', 1) RETURNING id
  `, [kbId, text])).rows[0].id;
  const versionId = (await pool.query(`
    INSERT INTO content_versions
      (knowledge_base_id, ingestion_task_id, attempt_number, embedding_model, embedding_dimensions, chunking_config, status, ready_at)
    VALUES ($1, $2, 1, 'text-embedding-3-small', $3, '{}', 'ready', now()) RETURNING id
  `, [kbId, taskId, vector.length])).rows[0].id;
  const chunkId = (await pool.query(`
    INSERT INTO chunks (version_id, position, text, token_count, embedding_dimensions, embedding)
    VALUES ($1, 0, $2, $3, $4, $5::vector) RETURNING id
  `, [versionId, text, countTokens(text), vector.length, JSON.stringify(vector)])).rows[0].id;
  await pool.query('UPDATE knowledge_bases SET active_version_id = $1 WHERE id = $2', [versionId, kbId]);
  return { kbId, versionId, chunkId };
}

const groundedAnswer = { answer: async (_question, context) => ({
  outcome: 'answered', answer: 'Velora retains audit logs for 37 days.', chunk_ids: [context[0].id],
}) };

function service(options = {}) {
  return new QuestionAnswering({
    pool, limits: new QueryLimits(),
    embedder: (model, dimensions) => {
      assert.equal(model, 'text-embedding-3-small');
      assert.equal(dimensions, 3);
      return { model, dimensions, embed: async () => [[1, 0, 0]] };
    },
    answerer: groundedAnswer,
    ...options,
  });
}

async function startApp(questions = service()) {
  const server = createApp({ pool, apiKey, ownerId, questions }).listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

function query(url, kbId, body = { question: 'How long are audit logs retained?' }, options = {}) {
  return fetch(`${url}/knowledge-bases/${kbId}/queries`, {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...options.headers },
    body: options.raw ?? JSON.stringify(body), signal: options.signal,
  });
}

async function waitUntil(check) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await setTimeout(10);
  }
  throw new Error('Timed out waiting for test operation.');
}

test('authenticated query retrieves only active-version content from the owned knowledge base', async () => {
  const old = await readyKnowledgeBase({ text: 'Old version: 12 days.' });
  const current = await readyKnowledgeBase({ kbId: old.kbId });
  await readyKnowledgeBase({ owner: 'another-owner', text: 'Private unrelated content.' });
  const url = await startApp(service({ answerer: { answer: async (question, context) => {
    assert.equal(question, 'How long are audit logs retained?');
    assert.deepEqual(context, [{ id: current.chunkId, text: 'Velora retains audit logs for 37 days.' }]);
    return groundedAnswer.answer(question, context);
  } } }));
  const response = await query(url, current.kbId);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    outcome: 'answered', answer: 'Velora retains audit logs for 37 days.',
    sources: [{ chunk_id: current.chunkId, text: 'Velora retains audit logs for 37 days.' }],
  });
});

test('authentication, UUID, question, JSON, content type, and length are validated', async () => {
  const url = await startApp();
  const kb = await readyKnowledgeBase();
  assert.equal((await query(url, kb.kbId, {}, { headers: { Authorization: '' } })).status, 401);
  assert.equal((await query(url, 'not-a-uuid')).status, 400);
  for (const question of ['', ' \n', null, 2, 'bad\0text']) {
    const response = await query(url, kb.kbId, { question });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'invalid_question');
  }
  for (const question of ['x'.repeat(4097), '日本語'.repeat(600)]) {
    const response = await query(url, kb.kbId, { question });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'question_too_long');
  }
  assert.equal((await query(url, kb.kbId, {}, { raw: '{invalid' })).status, 400);
  assert.equal((await query(url, kb.kbId, {}, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
});

test('missing and inaccessible knowledge bases return identical 404; pending knowledge bases return 409', async () => {
  let calls = 0;
  const url = await startApp(service({ embedder: () => { calls++; throw new Error('Must not embed'); } }));
  const other = await readyKnowledgeBase({ owner: 'another-owner' });
  const missing = await query(url, randomUUID());
  const inaccessible = await query(url, other.kbId);
  assert.equal(missing.status, 404);
  assert.equal(inaccessible.status, 404);
  assert.deepEqual(await missing.json(), await inaccessible.json());
  const pending = (await pool.query('INSERT INTO knowledge_bases (owner_id) VALUES ($1) RETURNING id', [ownerId])).rows[0].id;
  const response = await query(url, pending);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'knowledge_base_not_ready');
  assert.equal(calls, 0);
});

test('empty retrieval declines without generation; low-similarity context reaches the model and can be declined', async () => {
  const kb = await readyKnowledgeBase({ vector: [0, 1, 0] });
  await pool.query('DELETE FROM chunks WHERE version_id = $1', [kb.versionId]);
  let calls = 0;
  const url = await startApp(service({ answerer: { answer: async () => { calls++; return { outcome: 'insufficient_context', answer: null, chunk_ids: [] }; } } }));
  const empty = await query(url, kb.kbId);
  assert.deepEqual(await empty.json(), { outcome: 'insufficient_context', answer: null, sources: [] });
  assert.equal(calls, 0);
  const matching = await readyKnowledgeBase({ vector: [0, 1, 0] });
  const unsupported = await query(url, matching.kbId, { question: 'What is the subscription price?' });
  assert.deepEqual(await unsupported.json(), { outcome: 'insufficient_context', answer: null, sources: [] });
  assert.equal(calls, 1);
});

test('opening-hours evidence below the former cutoff reaches the answering model', async () => {
  const source = 'Our shop opens at 9 AM and closes at 6 PM.';
  const kb = await readyKnowledgeBase({ text: source, vector: [0.37, Math.sqrt(1 - 0.37 ** 2), 0] });
  const url = await startApp(service({ answerer: { answer: async (question, context) => {
    assert.equal(question, 'Can I come after 7 p.m?');
    assert.deepEqual(context, [{ id: kb.chunkId, text: source }]);
    return { outcome: 'answered', answer: 'No, the shop closes at 6 PM.', chunk_ids: [kb.chunkId] };
  } } }));
  const response = await query(url, kb.kbId, { question: 'Can I come after 7 p.m?' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).answer, 'No, the shop closes at 6 PM.');
});

test('retrieval pins one version even if a replacement activates while the question is embedding', async () => {
  const original = await readyKnowledgeBase({ text: 'Original version.' });
  const url = await startApp(service({
    embedder: () => ({ embed: async () => {
      await readyKnowledgeBase({ kbId: original.kbId, text: 'Replacement version.' });
      return [[1, 0, 0]];
    } }),
    answerer: { answer: async (_question, context) => {
      assert.deepEqual(context, [{ id: original.chunkId, text: 'Original version.' }]);
      return { outcome: 'answered', answer: 'Original version.', chunk_ids: [original.chunkId] };
    } },
  }));
  assert.equal((await query(url, original.kbId)).status, 200);
});

test('context selection fits a token budget and invalid model citations are rejected', async () => {
  const kb = await readyKnowledgeBase({ text: 'word '.repeat(450) });
  for (let position = 1; position < 8; position++) {
    const text = `Chunk ${position}: ` + 'word '.repeat(450);
    await pool.query(`INSERT INTO chunks (version_id, position, text, token_count, embedding_dimensions, embedding)
      VALUES ($1, $2, $3, $4, 3, '[1,0,0]')`, [kb.versionId, position, text, countTokens(text)]);
  }
  const url = await startApp(service({ answerer: { answer: async (_question, context) => {
    assert.ok(context.length > 1 && context.length < 8);
    assert.ok(countTokens(JSON.stringify(context)) <= 3000);
    return { outcome: 'answered', answer: 'Unsupported answer', chunk_ids: ['invented-id'] };
  } } }));
  const response = await query(url, kb.kbId);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, 'invalid_answer_response');
});

test('one admission limit covers three active questions across different knowledge bases; the fourth is rejected', async () => {
  const bases = await Promise.all([readyKnowledgeBase(), readyKnowledgeBase(), readyKnowledgeBase(), readyKnowledgeBase()]);
  let entered = 0;
  let resume;
  const gate = new Promise(resolve => { resume = resolve; });
  const url = await startApp(service({ embedder: () => ({ embed: async () => { entered++; await gate; return [[1, 0, 0]]; } }) }));
  const requests = bases.slice(0, 3).map(kb => query(url, kb.kbId));
  try {
    await waitUntil(() => entered === 3);
    const response = await query(url, bases[3].kbId);
    assert.equal(response.status, 429);
    assert.equal((await response.json()).error.code, 'query_concurrency_exceeded');
  } finally {
    resume();
    for (const response of await Promise.all(requests)) assert.equal(response.status, 200);
  }
  assert.equal((await query(url, bases[0].kbId)).status, 200);
});

test('one deadline spans embedding and generation, aborts downstream calls, and releases the slot', async () => {
  const kb = await readyKnowledgeBase();
  let slow = true;
  let generationAborted = false;
  const url = await startApp(service({ deadlineMs: 100,
    embedder: () => ({ embed: async () => { if (slow) await setTimeout(60); return [[1, 0, 0]]; } }),
    answerer: { answer: async (question, context, signal) => {
      if (slow) {
        try { await setTimeout(60, undefined, { signal }); }
        catch (error) { generationAborted = signal.aborted; throw error; }
      }
      return groundedAnswer.answer(question, context);
    } },
  }));
  const response = await query(url, kb.kbId);
  assert.equal(response.status, 504);
  assert.equal((await response.json()).error.code, 'query_timeout');
  await waitUntil(() => generationAborted);
  slow = false;
  assert.equal((await query(url, kb.kbId)).status, 200);
});

test('abandoned operations remain bounded after logical query slots have been released', async () => {
  const kb = await readyKnowledgeBase();
  const pending = [];
  let hang = true;
  const url = await startApp(service({ deadlineMs: 60, limits: new QueryLimits(3, 6),
    embedder: () => ({ embed: async () => hang ? new Promise(resolve => pending.push(resolve)) : [[1, 0, 0]] }),
  }));
  try {
    for (let i = 0; i < 6; i++) assert.equal((await query(url, kb.kbId)).status, 504);
    assert.equal(pending.length, 6);
    assert.equal((await query(url, kb.kbId)).status, 429);
  } finally {
    hang = false;
    pending.forEach(resolve => resolve([[1, 0, 0]]));
  }
  await setTimeout(10);
  assert.equal((await query(url, kb.kbId)).status, 200);
});

test('client disconnect cancels downstream work and frees admission capacity', async () => {
  const kb = await readyKnowledgeBase();
  let entered = false;
  let cancelled = false;
  let slow = true;
  const url = await startApp(service({ embedder: () => ({ embed: async (_texts, signal) => {
    entered = true;
    if (slow) {
      try { await setTimeout(1000, undefined, { signal }); }
      catch (error) { cancelled = signal.aborted; throw error; }
    }
    return [[1, 0, 0]];
  } }) }));
  const controller = new AbortController();
  const pending = query(url, kb.kbId, undefined, { signal: controller.signal }).catch(error => error);
  await waitUntil(() => entered);
  controller.abort();
  await pending;
  await waitUntil(() => cancelled);
  slow = false;
  assert.equal((await query(url, kb.kbId)).status, 200);
});

test('provider failures do not expose details or retry, and disabled querying returns 503', async () => {
  const kb = await readyKnowledgeBase();
  let calls = 0;
  const url = await startApp(service({ embedder: () => ({ embed: async () => { calls++; throw new Error('private-secret'); } }) }));
  const response = await query(url, kb.kbId);
  assert.equal(response.status, 502);
  assert.ok(!JSON.stringify(await response.json()).includes('private-secret'));
  assert.equal(calls, 1);
  const server = createApp({ pool, apiKey, ownerId }).listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  const disabled = await query(`http://127.0.0.1:${server.address().port}`, kb.kbId);
  assert.equal(disabled.status, 503);
});

test('Responses adapter requests GPT-6 Luna structured output without reasoning, retention, or retries', async () => {
  const answer = { outcome: 'answered', answer: '37 days.', chunk_ids: ['chunk-1'] };
  const adapter = new OpenAIAnswerer('test-key', async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'gpt-6-luna');
    assert.deepEqual(body.reasoning, { effort: 'none' });
    assert.equal(body.store, false);
    assert.equal(body.max_output_tokens, 768);
    assert.equal(body.text.format.strict, true);
    assert.ok(body.instructions.includes('untrusted'));
    assert.deepEqual(JSON.parse(body.input[0].content), { question: 'How long?', context: [{ id: 'chunk-1', text: '37 days.' }] });
    return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(answer) }] }] });
  });
  assert.deepEqual(await adapter.answer('How long?', [{ id: 'chunk-1', text: '37 days.' }], new AbortController().signal), answer);
  for (const body of [
    { status: 'incomplete', output: [] },
    { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal' }] }] },
    { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{invalid' }] }] },
  ]) {
    let calls = 0;
    const invalid = new OpenAIAnswerer('test', async () => { calls++; return Response.json(body); });
    await assert.rejects(invalid.answer('Question', [], new AbortController().signal), { status: 502 });
    assert.equal(calls, 1);
  }
});

test('live GPT-6 Luna answers a supported question and refuses an unsupported one', {
  skip: process.env.RUN_LIVE_QUERY_TEST !== 'true',
}, async () => {
  const key = process.env.OPENAI_API_KEY;
  assert.ok(key);
  const source = 'Velora is a fictional service. Velora retains audit logs for exactly 37 days. Its support email is help@velora.example.';
  const embedder = new OpenAIEmbedder(key, 'text-embedding-3-small', 1536);
  const [vector] = await embedder.embed([source], new AbortController().signal);
  const kb = await readyKnowledgeBase({ text: source, vector });
  const url = await startApp(service({
    embedder: (model, dimensions) => new OpenAIEmbedder(key, model, dimensions), answerer: new OpenAIAnswerer(key),
  }));
  for (const [question, outcome] of [
    ['How long does Velora retain audit logs?', 'answered'],
    ["What is Velora's monthly subscription price?", 'insufficient_context'],
  ]) {
    const started = performance.now();
    const response = await query(url, kb.kbId, { question });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.outcome, outcome);
    if (outcome === 'answered') { assert.match(body.answer, /37/); assert.equal(body.sources[0].chunk_id, kb.chunkId); }
    else assert.equal(body.answer, null);
    console.log(`Live query ${outcome}: ${Math.round(performance.now() - started)} ms`);
  }
});
