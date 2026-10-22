import { setTimeout } from 'node:timers/promises';
import type { Pool } from 'pg';
import { IngestionProcessor } from './processor.js';
import type { Embedder } from './embeddings.js';

export async function startIngestionWorker(pool: Pool, embedder: Embedder, onFailure: () => void) {
  const client = await pool.connect();
  const controller = new AbortController();
  let failed = false;
  const handleConnectionError = () => {
    failed = true;
    controller.abort();
  };
  client.on('error', handleConnectionError);
  let locked = false;
  try {
    const result = await client.query('SELECT pg_try_advisory_lock(1792627200, 1) AS locked');
    locked = result.rows[0].locked;
    if (!locked) throw new Error('Another ingestion worker is already running. Use one application instance.');
    await new IngestionProcessor(client, embedder).recover();
  } catch (error) {
    client.removeListener('error', handleConnectionError);
    client.release(true);
    throw error;
  }

  const processor = new IngestionProcessor(client, embedder);
  const running = (async () => {
    try {
      while (!controller.signal.aborted) {
        const processed = await processor.processNext(controller.signal);
        if (!processed) await setTimeout(1000, undefined, { signal: controller.signal });
      }
    } catch {
      // A connection loss is fatal even though it also aborts the current attempt.
      if (!controller.signal.aborted) failed = true;
    } finally {
      try {
        if (locked) await client.query('SELECT pg_advisory_unlock(1792627200, 1)');
      } catch {
        failed = true;
      }
      client.removeListener('error', handleConnectionError);
      client.release(failed);
    }
    if (failed) onFailure();
  })();

  return {
    async stop() {
      controller.abort();
      await running;
    },
  };
}
