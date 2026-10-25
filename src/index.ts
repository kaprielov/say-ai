import { OpenAIImageRecognizer } from './ingestion/image-recognition.js';
import { startUploadWorker } from './telegram/upload-worker.js';
import { createApp } from './app.js';
import { config, readAuthConfig, readIngestionConfig, readQueryConfig, readTelegramConfig } from './config.js';
import { pool } from './db.js';
import { OwnerOpenAI } from './providers/owner-openai.js';
import { OpenAIEmbedder } from './ingestion/embeddings.js';
import { startIngestionWorker } from './ingestion/worker.js';
import { QuestionAnswering } from './queries/service.js';
import { TelegramService } from './telegram/service.js';
import { TelegramClient } from './telegram/client.js';
import { startTelegramWorker } from './telegram/worker.js';
import { OpenAIAnswerer } from './queries/answerer.js';

const queryConfig = readQueryConfig();
const telegramConfig = readTelegramConfig();
const ingestion = readIngestionConfig();
const ownerOpenAI = telegramConfig ? new OwnerOpenAI(pool, telegramConfig.encryptionKey, queryConfig?.apiKey,
  ingestion?.model, ingestion?.dimensions) : undefined;
const questions = queryConfig || ownerOpenAI ? new QuestionAnswering({
  pool,
  embedder: (model, dimensions) => new OpenAIEmbedder(queryConfig?.apiKey ?? '', model, dimensions),
  answerer: new OpenAIAnswerer(queryConfig?.apiKey ?? ''),
  providers: ownerOpenAI ? (owner, model, dimensions, context) => ownerOpenAI.providers(owner, model, dimensions, context) : undefined,
}) : undefined;
const telegram = telegramConfig ? new TelegramService(pool, telegramConfig, new TelegramClient(), questions, ownerOpenAI, ownerOpenAI ? (owner, base) => ownerOpenAI.imageRecognizer(owner, base) : undefined) : undefined;
const app = createApp({ pool, ...readAuthConfig(), questions, telegram, imageAvailable: async () => Boolean(ingestion?.apiKey) });
let worker: Awaited<ReturnType<typeof startIngestionWorker>> | undefined;
let uploadWorker: Awaited<ReturnType<typeof startUploadWorker>> | undefined;
let telegramWorker: Awaited<ReturnType<typeof startTelegramWorker>> | undefined;
let server: ReturnType<typeof app.listen> | undefined;
let shuttingDown = false;

async function shutdown(failed = false) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (failed) process.exitCode = 1;
  const closed = server ? new Promise<void>((resolve, reject) => {
    server!.close(error => error ? reject(error) : resolve());
  }) : Promise.resolve();
  await uploadWorker?.stop();
  await telegramWorker?.stop();
  await worker?.stop();
  await closed;
  await pool.end();
}

if (ingestion) {
  try {
    worker = await startIngestionWorker(pool, new OpenAIEmbedder(ingestion.apiKey ?? '', ingestion.model, ingestion.dimensions), () => {
      console.error('Ingestion worker stopped unexpectedly. Restart the application to recover unfinished work.');
      void shutdown(true);
    }, ownerOpenAI ? (owner, knowledgeBaseId) => ownerOpenAI.ingestionEmbedder(owner, ingestion.model, ingestion.dimensions, knowledgeBaseId) : undefined,
      ownerOpenAI ? (owner, base) => ownerOpenAI.imageRecognizer(owner, base) : async () => new OpenAIImageRecognizer(ingestion.apiKey ?? ''));
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
  server.maxConnections = 200;
  server.maxRequestsPerSocket = 1000;
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
}

if (telegram && !shuttingDown) {
  try {
    uploadWorker = await startUploadWorker(telegram, () => {
      console.error('Upload preparation worker stopped unexpectedly. Restart to recover unfinished uploads.');
      void shutdown(true);
    });
    telegramWorker = await startTelegramWorker(telegram, () => {
      console.error('Telegram worker stopped unexpectedly. Restart the application to recover queued work.');
      void shutdown(true);
    });
  } catch {
    console.error('Unable to start Telegram. Check configuration, migrations, and Telegram connectivity.');
    await shutdown(true);
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown();
  });
}
