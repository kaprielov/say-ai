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

Submissions currently remain pending: background ingestion and querying have not been implemented yet.

## Database model

- `knowledge_bases`: owner and active content version.
- `ingestion_tasks`: source text, processing state, attempts started, next retry time, and sanitized failure details. A partial unique index permits only one pending or processing task per knowledge base.
- `content_versions`: one version per ingestion attempt, recording embedding model, dimensions, chunking configuration, and readiness.
- `chunks`: exact text, position, token count, and vector, with dimensions constrained to match its version.

Vectors use the dimension-independent `vector` type so model selection remains open. Each version specifies its dimensions; foreign keys and checks prevent mismatched chunks. Retrieval will use exact cosine search, scoped to a version, without an approximate vector index initially. See the [pgvector documentation](https://github.com/pgvector/pgvector) for variable-dimension storage and search.

Foreign keys also prevent attaching another knowledge base's task or active version. The future ingestion service must activate only ready versions and update task completion atomically. It must increment attempts before work, schedule retries, and maintain `updated_at`; the schema does not implement that workflow.

Migrations use [node-pg-migrate](https://salsita.github.io/node-pg-migrate/) and run transactionally. The initial rollback retains the `vector` extension but removes the four application tables.

The current application provides the health endpoint, database foundation, single-developer authentication, and knowledge-base creation/status. Ingestion and answering are the next implementation steps. See [the implementation plan](implementation-plan.md) and [system design](system-design.md).
