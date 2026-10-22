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
