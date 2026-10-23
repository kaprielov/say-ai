import { createHash, timingSafeEqual } from 'node:crypto';
import express, { type ErrorRequestHandler } from 'express';
import type { Pool } from 'pg';
import type { QuestionAnswering } from './queries/service.js';
import { QueryError } from './queries/errors.js';
import { parseSource, sourceText } from './ingestion/source.js';
import { createKnowledgeBase, replaceKnowledgeBase, transaction } from './knowledge-bases/service.js';
import type { TelegramService } from './telegram/service.js';
import { telegramRouter } from './telegram/router.js';

type AppOptions = {
  pool: Pool;
  apiKey: string;
  ownerId: string;
  questions?: QuestionAnswering;
  telegram?: TelegramService;
};

function keyDigest(key: string) {
  return createHash('sha256').update(key).digest();
}

export function createApp({ pool, apiKey, ownerId, questions, telegram }: AppOptions) {
  const app = express();
  app.disable('x-powered-by');
  const expectedDigest = keyDigest(apiKey);
  if (telegram) app.use('/telegram', telegramRouter(telegram));

  app.get('/health', async (_request, response) => {
    try {
      await pool.query('SELECT 1');
      response.json({ status: 'ok', database: 'connected' });
    } catch {
      response.status(503).json({ status: 'error', database: 'unavailable' });
    }
  });

  app.use('/knowledge-bases', (request, response, next) => {
    const match = /^Bearer ([A-Za-z0-9_-]+)$/i.exec(request.get('authorization') ?? '');
    if (!match || !timingSafeEqual(keyDigest(match[1]!), expectedDigest)) {
      response.set('WWW-Authenticate', 'Bearer');
      response.status(401).json({ error: { code: 'unauthorized', message: 'A valid bearer API key is required.' } });
      return;
    }
    response.locals.ownerId = ownerId;
    next();
  });

  app.post('/knowledge-bases', parseSource, async (request, response) => {
    const text = sourceText(request.body);

    const { id } = await transaction(pool, db => createKnowledgeBase(db, response.locals.ownerId, text));
    response.location(`/knowledge-bases/${id}`).status(201).json({ id, status: 'pending', queryable: false });
  });

  app.put<{ id: string }>('/knowledge-bases/:id/content', parseSource, async (request, response) => {
    const id = request.params.id;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw new QueryError(400, 'invalid_id', 'Knowledge base ID must be a valid UUID.');
    }
    const text = sourceText(request.body);

    const { queryable } = await transaction(pool, db => replaceKnowledgeBase(db, response.locals.ownerId, id, text));
    response.location(`/knowledge-bases/${id}`).status(202).json({ id, status: 'pending', queryable });
  });

  app.get('/knowledge-bases/:id', async (request, response) => {
    const id = request.params.id;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      response.status(400).json({ error: { code: 'invalid_id', message: 'Knowledge base ID must be a valid UUID.' } });
      return;
    }
    const result = await pool.query(`
      SELECT kb.id, latest.status, kb.active_version_id IS NOT NULL AS queryable
      FROM knowledge_bases kb
      JOIN LATERAL (
        SELECT status FROM ingestion_tasks WHERE knowledge_base_id = kb.id
        ORDER BY created_at DESC, id DESC LIMIT 1
      ) latest ON true
      WHERE kb.id = $1 AND kb.owner_id = $2
    `, [id, response.locals.ownerId]);
    if (!result.rows[0]) {
      response.status(404).json({ error: { code: 'not_found', message: 'Knowledge base not found.' } });
      return;
    }
    response.json(result.rows[0]);
  });

  app.post('/knowledge-bases/:id/queries', express.json({ limit: '1mb' }), async (request, response) => {
    const id = request.params.id;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw new QueryError(400, 'invalid_id', 'Knowledge base ID must be a valid UUID.');
    }
    if (!request.is('application/json')) throw new QueryError(415, 'unsupported_media_type', 'Use Content-Type: application/json.');
    const question = request.body?.question;
    if (typeof question !== 'string' || !question.trim() || question.includes('\0')) {
      throw new QueryError(400, 'invalid_question', 'question must be a non-empty string without null characters.');
    }
    if (question.length > 4096) {
      throw new QueryError(400, 'question_too_long', 'question must not exceed 4096 characters or 1024 tokens.');
    }
    if (!questions) throw new QueryError(503, 'querying_unavailable', 'Question answering is not configured.');
    const disconnect = new AbortController();
    const onClose = () => {
      if (!response.writableEnded) disconnect.abort(new QueryError(499, 'client_disconnected', 'Client disconnected.'));
    };
    response.once('close', onClose);
    try {
      const result = await questions.ask(id, response.locals.ownerId, question, disconnect.signal);
      if (!response.destroyed) response.json(result);
    } catch (error) {
      if (!response.destroyed) throw error;
    } finally {
      response.removeListener('close', onClose);
    }
  });

  app.use((_request, response) => {
    response.status(404).json({ error: { code: 'not_found', message: 'Route not found.' } });
  });

  const handleError: ErrorRequestHandler = (error, _request, response, _next) => {
    if (error instanceof QueryError) {
      response.status(error.status).json({ error: { code: error.code, message: error.message } });
    } else if (error.type === 'entity.too.large') {
      response.status(413).json({ error: { code: 'payload_too_large', message: 'JSON body must not exceed 1 MiB.' } });
    } else if (error.type === 'entity.parse.failed') {
      response.status(400).json({ error: { code: 'invalid_json', message: 'Request body must be valid JSON.' } });
    } else if (error.status === 415) {
      response.status(415).json({ error: { code: 'unsupported_media_type', message: 'Unsupported request encoding.' } });
    } else {
      console.error('Request failed due to an internal error.');
      response.status(500).json({ error: { code: 'internal_error', message: 'An internal error occurred.' } });
    }
  };
  app.use(handleError);
  return app;
}
