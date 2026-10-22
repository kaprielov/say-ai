# Say AI

RAG API in development, using Node.js, TypeScript, Express, and PostgreSQL with pgvector.

## Local setup

Requires Node.js 22.13 or newer and OrbStack running with its Docker engine enabled.

```sh
npm ci
cp .env.example .env
npm run db:up
npm run db:migrate
npm run db:check
```

Set `DEVELOPER_API_KEY` in `.env` to a generated secret and `DEVELOPER_OWNER_ID` to your stable owner identifier, such as `anton`. Generate a key with:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Paste the result into `.env`, then run `npm run dev`. The server fails at startup if the key or owner is missing. Keys must contain at least 32 letters, numbers, underscores, or hyphens. Keep the owner ID stable: changing it changes which knowledge bases the configured developer can access. The key can be rotated independently.

The API listens at `http://localhost:3000`. `GET /health` checks the database connection and returns `200` when available or `503` otherwise.

The database is exposed only on `127.0.0.1:5433`. Local credentials are in `.env`; the committed example contains development-only values. If you change the database credentials or port, update both the `POSTGRES_*` settings and `DATABASE_URL`. Environment variables supplied by the shell take precedence over `.env` for Node.js and Compose.

PostgreSQL initializes credentials only when the data volume is first created. Editing `.env` does not change credentials in an existing database.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the API with automatic restart on source changes. |
| `npm run build` | Compile application TypeScript into `dist/`. |
| `npm start` | Run the compiled API. |
| `npm run db:up` | Start PostgreSQL and wait for its health check. |
| `npm run db:stop` | Stop PostgreSQL while preserving its data. |
| `npm run db:migrate` | Apply pending migrations. |
| `npm run db:rollback` | Undo the latest migration; the initial rollback deletes application tables and their data. |
| `npm run db:check` | Check connection, pgvector, and application tables. |
| `npm run test:db` | Verify schema constraints and vector retrieval against the migrated database. Fixtures are rolled back. |
| `npm run test:api` | Test authentication, validation, persistence, owner isolation, and atomic creation in a temporary database. Requires database creation permission, available with the local Compose user. |
| `npm run test:ingestion` | Test chunking, the provider adapter, ingestion, activation, retries, and restart recovery in a temporary database. No paid provider calls by default. |

Compose stores database files in a named volume. Normal stops and restarts preserve it. Run migrations explicitly; application startup does not modify the schema.

## Knowledge-base API

Send `Authorization: Bearer <DEVELOPER_API_KEY>` to all knowledge-base endpoints. The server maps this key to `DEVELOPER_OWNER_ID`; request body fields cannot override ownership. Missing or invalid keys return `401`. `/health` remains public.

### Create

```http
POST /knowledge-bases
Authorization: Bearer <your-key>
Content-Type: application/json

{"text":"Your knowledge-base content."}
```

The JSON body may be up to 1 MiB. `text` must be a non-empty string without null characters. Original whitespace is preserved. Invalid text or JSON returns `400`, oversized bodies return `413`, and unsupported content types return `415`.

The server commits the knowledge base and pending ingestion task together before returning `201 Created`, with a `Location` header and:

```json
{"id":"<uuid>","status":"pending","queryable":false}
```

### Read status

```http
GET /knowledge-bases/<uuid>
Authorization: Bearer <your-key>
```

Returns `200` with `id`, latest submission `status`, and `queryable`. Status can be `pending`, `processing`, `ready`, or `failed`. Query availability is determined separately by the presence of an active version. No source text, credentials, or database errors are returned. A malformed ID returns `400` with `invalid_id`. A missing or inaccessible knowledge base returns the same `404` response.

Errors use a common shape:

```json
{"error":{"code":"unauthorized","message":"A valid bearer API key is required."}}
```

## Background ingestion

Set `OPENAI_API_KEY` in `.env` or the shell to enable the worker, then start the application with `npm run dev` or `npm start`. This is the provider credential; it is separate from `DEVELOPER_API_KEY`, which authenticates callers of this API. Leave `OPENAI_API_KEY` empty to run the API without ingestion. `INGESTION_ENABLED=false` explicitly pauses the worker; `INGESTION_ENABLED=true` requires a provider key.

The worker polls once per second while idle and processes one task at a time inside the application. An exclusive PostgreSQL advisory lock prevents two application instances from running ingestion and startup recovery against the same database. A worker database failure shuts down the application with a nonzero exit code; restart it to recover durable work.

1. Claim a pending task and persist the incremented attempt count with an isolated content version.
2. Split source text into chunks of at most 512 `cl100k_base` tokens with an overlap of up to 64 tokens. Chunks remain exact source substrings, including Unicode characters and whitespace within usable chunks. Whitespace-only chunks are omitted.
3. Embed batches of at most 16 chunks, sequentially, and save their text, token counts, positions, and vectors under the isolated version.
4. After every batch succeeds, mark the version ready, switch the active version, and complete the task in one transaction.

Defaults are `EMBEDDING_MODEL=text-embedding-3-small` and `EMBEDDING_DIMENSIONS=1536`. The adapter also supports `text-embedding-3-large`, with up to 3072 dimensions; the small model supports up to 1536. See the [official OpenAI embeddings guide](https://developers.openai.com/api/docs/guides/embeddings). The configured model, dimensions, and chunking settings are stored per version. Changing configuration affects future ingestions; existing embeddings are retained.

Each provider request has a 30-second timeout, and each ingestion attempt has a ten-minute deadline. Transient failures retry from the beginning after 10 seconds, then 60 seconds, with a maximum of three persisted attempts total. Permanent provider errors such as invalid credentials or invalid requests fail immediately. No additional retries happen inside the provider adapter. Stored errors use sanitized codes and messages, without provider response bodies or source text.

Partial failed versions are removed. Shutdown attempts to cancel the current provider call; its unfinished task remains durable. On restart, interrupted attempts count toward the limit, incomplete versions are removed, and eligible work restarts from the beginning. A third interrupted attempt becomes failed. Previous successful versions remain available and are never removed by this cleanup. Cancellation may not stop provider-side execution or charges.

With ingestion enabled, poll `GET /knowledge-bases/<uuid>` until `status` becomes `ready` or `failed`. A ready knowledge base reports `queryable: true`; question answering will be implemented in the next step. Query availability here means prepared content exists, rather than that a query endpoint has already been implemented.

To run the optional live test, which makes a paid OpenAI embeddings request using a short synthetic source in a temporary database:

```sh
RUN_LIVE_EMBEDDING_TEST=true node --env-file=.env --import tsx --test --test-name-pattern='real OpenAI' tests/ingestion.test.mjs
```

The one-hour ingestion target still needs representative volume and provider-rate-limit measurements.

## Database model

- `knowledge_bases`: owner and active content version.
- `ingestion_tasks`: source text, processing state, attempts started, next retry time, and sanitized failure details. A partial unique index permits only one pending or processing task per knowledge base.
- `content_versions`: one version per ingestion attempt, recording embedding model, dimensions, chunking configuration, and readiness.
- `chunks`: exact text, position, token count, and vector, with dimensions constrained to match its version.

Vectors use the dimension-independent `vector` type so model selection remains open. Each version specifies its dimensions; foreign keys and checks prevent mismatched chunks. Retrieval will use exact cosine search, scoped to a version, without an approximate vector index initially. See the [pgvector documentation](https://github.com/pgvector/pgvector) for variable-dimension storage and search.

Foreign keys also prevent attaching another knowledge base's task or active version. The ingestion processor activates ready versions and updates task completion atomically. It increments attempts before work, schedules retries, and maintains `updated_at` for task and activation changes; these transitions are application logic rather than database triggers.

Migrations use [node-pg-migrate](https://salsita.github.io/node-pg-migrate/) and run transactionally. The initial rollback retains the `vector` extension but removes the four application tables.

The current application provides the health endpoint, database foundation, single-developer authentication, knowledge-base creation/status, and background ingestion. Querying and the content-replacement endpoint are the next implementation steps. See [the implementation plan](implementation-plan.md) and [system design](system-design.md).
