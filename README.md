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
| `npm run test:queries` | Test question answering, ownership, retrieval, grounding contracts, concurrency, deadlines, and cancellation in a temporary database. No paid provider calls by default. |
| `npm run test:replacement` | Test content replacement through the API, concurrent submissions, version switching, failure recovery, and old-version availability. Uses a temporary database and controlled providers. |

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

### Replace content

```http
PUT /knowledge-bases/<uuid>/content
Authorization: Bearer <your-key>
Content-Type: application/json

{"text":"Our shop now closes at 9 PM."}
```

Replaces the complete content under the existing knowledge-base ID. The same ownership checks and text validation apply as on creation: a non-empty string without null characters, in a JSON body up to 1 MiB. Invalid IDs return `400`; missing or inaccessible knowledge bases return `404`.

The server commits the new source text and pending ingestion task before returning `202 Accepted`, with a `Location` header pointing to the status endpoint:

```json
{"id":"<uuid>","status":"pending","queryable":true}
```

`queryable` is false when no ready version exists yet. If any ingestion task for this knowledge base is pending or processing, the request returns `409` with `ingestion_in_progress`. This includes initial ingestion and retries scheduled for later. A database constraint and a transaction with an owner-scoped knowledge-base row lock prevent simultaneous replacements from both being accepted.

Poll the metadata endpoint to observe progress. Questions continue to use the previous ready version during processing and after terminal failure. Once ingestion succeeds, subsequent questions use only the new version. Questions already in flight retain their captured version; successful old versions are retained. When no ready version exists, questions continue to return `409` until ingestion succeeds.

After terminal ingestion failure, a new replacement can be submitted with a fresh three-attempt budget. Retrying the same PUT while its previous submission is pending or processing returns `409`; this endpoint does not implement an idempotency key. With ingestion paused, accepted submissions remain pending until the worker is enabled.

### Ask a question

```http
POST /knowledge-bases/<uuid>/queries
Authorization: Bearer <your-key>
Content-Type: application/json

{"question":"How long are audit logs retained?"}
```

With `OPENAI_API_KEY` configured and a ready content version, the API embeds the question using that version's stored model and dimensions, retrieves its closest chunks, and asks **GPT-6 Luna** for a grounded answer. It uses the [Responses API with structured output](https://developers.openai.com/api/docs/guides/structured-outputs), `reasoning.effort: "none"`, `store: false`, and at most 768 output tokens. The [GPT-6 Luna model documentation](https://developers.openai.com/api/docs/models/gpt-6-luna) describes the selected model's supported settings.

Successful answer, with exact supporting source chunks:

```json
{
  "outcome": "answered",
  "answer": "Audit logs are retained for 37 days.",
  "sources": [{"chunk_id":"<uuid>","text":"Velora retains audit logs for 37 days."}]
}
```

When the available context cannot support an answer, the API returns `200` with:

```json
{"outcome":"insufficient_context","answer":null,"sources":[]}
```

The question must be non-empty, contain no null characters, and fit within 4096 JavaScript string characters and 1024 `cl100k_base` tokens. The JSON body limit is 1 MiB. The server captures one ready version for each request; later activation of another version does not change that request's retrieval. Searches are scoped to both the selected version and its knowledge base.

Retrieval ranks the closest eight chunks by cosine similarity without a similarity cutoff. It selects context within a 3000-token budget measured over the serialized chunks with `cl100k_base`. This is a budgeting convention, not the answering model's exact token count. If no context is available, the API declines without a generation call. Otherwise, the model assesses whether the passages support an answer and can decline. Similarity determines ranking, not whether a chunk is allowed into the prompt. `RETRIEVAL_MIN_SIMILARITY` is no longer used.

Prompts instruct the model to use only supplied evidence and treat questions and source text as untrusted data. Answered responses must cite supplied chunk IDs; missing or invented citations are rejected. Semantic grounding still requires manual quality evaluation; structured output and valid citations alone do not prove every claim is supported.

At most three queries run concurrently across all knowledge bases in one application process. Additional queries receive `429` immediately, without waiting. A single ten-second deadline covers admitted query processing, including token validation, ownership lookup, embedding, retrieval, and generation. Timeout returns `504`, attempts cancellation, and releases the query slot. Client disconnection also attempts cancellation. No provider requests are automatically retried.

Operations still running after cancellation remain counted until they settle. A separate cap of six outstanding downstream operations prevents repeated timed-out requests from accumulating unlimited work; it can also cause `429` while fewer than three queries are active. Native provider transports have finite timeouts, and the configured production database pool bounds connection waits and SQL execution. Cancellation cannot guarantee that provider-side execution or charges stop.

| HTTP status | Meaning |
| --- | --- |
| `400` | Invalid ID, question, or JSON. |
| `401` | Missing or invalid developer API key. |
| `404` | Knowledge base is missing or belongs to another owner. |
| `409` | Knowledge base has no ready version. |
| `413` / `415` | Oversized body or unsupported content type/encoding. |
| `429` | Query capacity is full. |
| `502` | Downstream processing failed or the answering model returned an incomplete, refused, or invalid response. Provider details are not exposed. |
| `503` | OpenAI credentials are absent or the stored embedding configuration is unsupported. Ingestion can be paused independently of querying. |
| `504` | The query exceeded its ten-second deadline. |

An insufficient-evidence outcome is a successful `200` refusal, separate from a provider-level safety refusal or processing failure. The application does not persist questions or answers. Request prompts are sent to OpenAI, with response storage disabled in the Responses request.

To run the optional paid live check using a synthetic knowledge base in a temporary database:

```sh
RUN_LIVE_QUERY_TEST=true node --env-file=.env --import tsx --test --test-name-pattern='live GPT-6 Luna' tests/queries.test.mjs
```

This smoke test exercises one supported answer and one insufficient-context outcome using the normal retrieval behavior. It is not the full representative quality or concurrent-load evaluation from the implementation plan.

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

With ingestion enabled, poll `GET /knowledge-bases/<uuid>` until `status` becomes `ready` or `failed`. A ready knowledge base reports `queryable: true` and can be queried when the OpenAI credential is configured.

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

The current application provides the health endpoint, database foundation, single-developer authentication, knowledge-base creation/status/replacement, background ingestion, and question answering. Full representative quality, latency, and freshness evaluation remains to be completed. See [the implementation plan](implementation-plan.md) and [system design](system-design.md).
