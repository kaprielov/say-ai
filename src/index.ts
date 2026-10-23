import { createApp } from './app.js';
import { config, readAuthConfig, readIngestionConfig, readQueryConfig } from './config.js';
import { pool } from './db.js';
import { OpenAIEmbedder } from './ingestion/embeddings.js';
import { startIngestionWorker } from './ingestion/worker.js';
import { QuestionAnswering } from './queries/service.js';
import { OpenAIAnswerer } from './queries/answerer.js';

const queryConfig = readQueryConfig();
const questions = queryConfig ? new QuestionAnswering({
  pool,
  embedder: (model, dimensions) => new OpenAIEmbedder(queryConfig.apiKey, model, dimensions),
  answerer: new OpenAIAnswerer(queryConfig.apiKey),
}) : undefined;
const app = createApp({ pool, ...readAuthConfig(), questions });
const ingestion = readIngestionConfig();
let worker: Awaited<ReturnType<typeof startIngestionWorker>> | undefined;
let server: ReturnType<typeof app.listen> | undefined;
let shuttingDown = false;

async function shutdown(failed = false) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (failed) process.exitCode = 1;
  const closed = server ? new Promise<void>((resolve, reject) => {
    server!.close(error => error ? reject(error) : resolve());
  }) : Promise.resolve();
  await worker?.stop();
  await closed;
  await pool.end();
}

if (ingestion) {
  try {
    worker = await startIngestionWorker(pool, new OpenAIEmbedder(ingestion.apiKey, ingestion.model, ingestion.dimensions), () => {
      console.error('Ingestion worker stopped unexpectedly. Restart the application to recover unfinished work.');
      void shutdown(true);
    });
  } catch {
    console.error('Unable to start ingestion worker. Check database availability and ensure only one application instance is running.');
    await pool.end();
    process.exit(1);
  }
} else {
  console.log('Ingestion disabled. Set OPENAI_API_KEY to enable background processing.');
}

if (!shuttingDown) {
  server = app.listen(config.port, () => {
    console.log(`Server listening on http://localhost:${config.port}`);
  });
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown();
  });
}
