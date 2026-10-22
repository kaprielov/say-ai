const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required. Copy .env.example to .env for local development.');
}

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}

export const config = { databaseUrl, port };

export function readAuthConfig() {
  const apiKey = process.env.DEVELOPER_API_KEY;
  const ownerId = process.env.DEVELOPER_OWNER_ID?.trim();
  if (!apiKey || !/^[A-Za-z0-9_-]{32,}$/.test(apiKey)) {
    throw new Error('DEVELOPER_API_KEY must contain at least 32 letters, numbers, underscores, or hyphens.');
  }
  if (!ownerId) {
    throw new Error('DEVELOPER_OWNER_ID is required.');
  }
  return { apiKey, ownerId };
}

export function readIngestionConfig() {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const setting = process.env.INGESTION_ENABLED;
  if (setting !== undefined && setting !== 'true' && setting !== 'false') {
    throw new Error('INGESTION_ENABLED must be true or false.');
  }
  const enabled = setting === undefined ? Boolean(apiKey) : setting === 'true';
  if (!enabled) return undefined;
  if (!apiKey) throw new Error('OPENAI_API_KEY is required when ingestion is enabled.');
  const model = process.env.EMBEDDING_MODEL ?? 'text-embedding-3-small';
  if (model !== 'text-embedding-3-small' && model !== 'text-embedding-3-large') {
    throw new Error('EMBEDDING_MODEL must be text-embedding-3-small or text-embedding-3-large.');
  }
  const maxDimensions = model === 'text-embedding-3-small' ? 1536 : 3072;
  const dimensions = Number(process.env.EMBEDDING_DIMENSIONS ?? maxDimensions);
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > maxDimensions) {
    throw new Error(`EMBEDDING_DIMENSIONS must be between 1 and ${maxDimensions}.`);
  }
  return { apiKey, model, dimensions };
}
