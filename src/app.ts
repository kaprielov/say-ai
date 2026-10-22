import { createHash, timingSafeEqual } from 'node:crypto';
import express, { type ErrorRequestHandler } from 'express';
import type { Pool } from 'pg';

type AppOptions = {
  pool: Pool;
  apiKey: string;
  ownerId: string;
};

function keyDigest(key: string) {
  return createHash('sha256').update(key).digest();
}

export function createApp({ pool, apiKey, ownerId }: AppOptions) {
  const app = express();
  app.disable('x-powered-by');
  const expectedDigest = keyDigest(apiKey);

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

  app.post('/knowledge-bases', express.json({ limit: '1mb' }), async (request, response) => {
    if (!request.is('application/json')) {
      response.status(415).json({ error: { code: 'unsupported_media_type', message: 'Use Content-Type: application/json.' } });
      return;
    }
    const text = request.body?.text;
    if (typeof text !== 'string' || !text.trim() || text.includes('\0')) {
      response.status(400).json({ error: { code: 'invalid_text', message: 'text must be a non-empty string without null characters.' } });
      return;
    }

    const client = await pool.connect();
    let id: string;
    try {
      await client.query('BEGIN');
      const result = await client.query<{ id: string }>(
        'INSERT INTO knowledge_bases (owner_id) VALUES ($1) RETURNING id',
        [response.locals.ownerId],
      );
      id = result.rows[0]!.id;
      await client.query(
        'INSERT INTO ingestion_tasks (knowledge_base_id, source_text) VALUES ($1, $2)',
        [id, text],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    response.location(`/knowledge-bases/${id}`).status(201).json({ id, status: 'pending', queryable: false });
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

  app.use((_request, response) => {
    response.status(404).json({ error: { code: 'not_found', message: 'Route not found.' } });
  });

  const handleError: ErrorRequestHandler = (error, _request, response, _next) => {
    if (error.type === 'entity.too.large') {
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
