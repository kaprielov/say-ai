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
| `npm run test:documents` | Test document extraction capacity, cancellation, and cleanup without database or provider calls. |
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

Alternatively, upload one text file or document using `multipart/form-data` with a single `file` field:

```sh
curl http://localhost:3000/knowledge-bases \
  -H "Authorization: Bearer $DEVELOPER_API_KEY" \
  -F "file=@knowledge.md"
```

Supported extensions (case-insensitive): `.txt`, `.md`, `.markdown`, `.csv`, `.tsv`, `.json`, `.jsonl`, `.ndjson`, `.yaml`, `.yml`, `.pdf`, `.docx`, and `.doc`. Files may be up to 1 MiB of file bytes, excluding multipart framing. Plain text formats must contain valid UTF-8 text, optionally with a UTF-8 BOM. Empty or whitespace-only text files, invalid UTF-8, and binary control characters return `400`; oversized files return `413`; unsupported extensions return `415`. Send exactly one file with no additional form fields. Malformed multipart requests, missing files, extra fields, and multiple files return `400` with `invalid_upload`.

Plain text formats are ingested as source text: formatting, table headers, and structured keys remain in the source. The API does not parse or validate CSV, JSON, or YAML syntax or import their records into database tables. Original text and line endings are preserved, with only an optional leading UTF-8 BOM removed.

PDF and Word documents are parsed locally before the ingestion task is created. PDF extraction uses the document's embedded text layer; Word extraction supports modern `.docx` and legacy binary `.doc` files. Paragraph text and table cell values are extracted, but document styling, images, and exact table or multi-column layout are not preserved. The resulting text is indexed and quoted as source chunks. Scans and image-only documents require OCR, which is not included. Files with no readable text return `400` with `empty_document`; damaged, encrypted, or mismatched files return `400` with `invalid_document`. The API does not accept document passwords or macro-enabled `.docm` files.

Document extraction runs in separate child processes with a 15-second deadline and a 256 MiB JavaScript heap limit per process. At most two extractions run concurrently per application process; further document requests return `429` with `document_capacity_full`. Timed-out extraction returns `422` with `document_timeout`. Client disconnection cancels extraction. Extracted text must also fit within 1 MiB; larger results return `413` with `extracted_text_too_large`, including compressed Word files whose upload size is small. Failed extraction does not create a knowledge base or replacement task.

The uploaded filename and MIME type are not stored; MIME guesses do not determine acceptance. Document signatures and parsers validate the selected document format. Uploads are processed without writing temporary files and use the same durable ingestion pipeline as JSON submissions.

```sh
curl http://localhost:3000/knowledge-bases \
  -H "Authorization: Bearer $DEVELOPER_API_KEY" \
  -F "file=@knowledge.pdf"
```

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

This endpoint also accepts a file with the same formats, extraction rules, and limits as creation:

```sh
curl -X PUT http://localhost:3000/knowledge-bases/<uuid>/content \
  -H "Authorization: Bearer $DEVELOPER_API_KEY" \
  -F "file=@updated-knowledge.csv"
```

An uploaded file replaces the complete source content; it is not appended to existing content.

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

Retrieval ranks the closest eight chunks by cosine similarity without a similarity cutoff. It first budgets the strongest three matches, then tries to add their immediate next and previous chunks using at most 1000 additional tokens, and finally fills remaining space with the other ranked matches. Neighbors are fetched only from the captured version of the same knowledge base, even when they did not rank in the top eight. Repeated chunk IDs from overlapping windows are included once; original chunk text and IDs remain unchanged for citations. Neighbor expansion also works for previously ingested versions.

The complete serialized context fits within a 3000-token budget measured with `cl100k_base`. This is a budgeting convention, not the answering model's exact token count. Expansion can displace lower-ranked matches, so its quality must be evaluated on representative questions. If no context is available, the API declines without a generation call. Otherwise, the model assesses whether the passages support an answer and can decline. Similarity determines ranking, not whether a chunk is allowed into the prompt. `RETRIEVAL_MIN_SIMILARITY` is no longer used.

Prompts instruct the model to use only supplied evidence and treat questions and source text as untrusted data. Answered responses must cite supplied chunk IDs; missing or invented citations are rejected. Semantic grounding still requires manual quality evaluation; structured output and valid citations alone do not prove every claim is supported.

At most three queries run concurrently across all knowledge bases in one application process. Additional queries receive `429` immediately, without waiting. A single 30-second deadline covers admitted query processing, including token validation, ownership lookup, embedding, retrieval, and generation. Timeout returns `504`, attempts cancellation, and releases the query slot. Client disconnection also attempts cancellation. No provider requests are automatically retried.

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
| `504` | The query exceeded its 30-second deadline. |

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
2. Keep paragraphs in separate chunks of at most 512 `cl100k_base` tokens to avoid mixing unrelated policies in one embedding. Long paragraphs split at sentence boundaries; oversized sentences fall back to Unicode-safe hard splits. Within long paragraphs, overlap uses complete sentences within 64 tokens where possible; oversized sentences retain bounded overlap at hard splits. Separate paragraphs do not overlap. Chunks remain exact source substrings, including whitespace within usable chunks. Whitespace-only chunks are omitted. The stored strategy is `paragraph-sentence-v1`; this affects new ingestions only. Replace existing content to regenerate its chunks with the new strategy.
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

## Telegram interface

The optional Telegram integration provides the user interface through a manager bot and native Telegram buttons; no frontend or Mini App is required. Each private-chat user owns knowledge bases under the stable `telegram:<numeric-user-id>` owner ID. The developer HTTP key retains its configured owner and does not grant Telegram users HTTP access.

### Setup

1. Create a manager bot in [BotFather](https://t.me/BotFather). In BotFather's Mini App, enable **Bot Management Mode** for that bot.
2. Set `TELEGRAM_MANAGER_TOKEN` in `.env`. Do not send the token through a chat or commit it.
3. For local public access, install `cloudflared` and run `npm run dev:public` after configuring the credentials below. This starts a Cloudflare Quick Tunnel and the backend together, injecting `TELEGRAM_PUBLIC_URL` automatically without editing `.env`. Stop any existing backend on the same port first. For a separately managed tunnel or deployment, set `TELEGRAM_PUBLIC_URL` to its public HTTPS base URL. Telegram must be able to reach `/telegram/webhook/<bot-id>`.
4. Set `TELEGRAM_WEBHOOK_SECRET` to a random secret containing at least 32 URL-safe characters. Set `TELEGRAM_TOKEN_ENCRYPTION_KEY` to a random 32-byte key encoded as 64 hexadecimal characters. Generate them separately:

   ```sh
   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

5. Configure `OPENAI_API_KEY` for ingestion and answering, run `npm run db:migrate`, then start the application. Startup verifies the manager token and registers its commands and the webhooks of the manager and all stored child bots. Leaving the manager token empty disables Telegram integration.
6. Open the manager bot in a current Telegram client and send `/start`.

Preserve the encryption key across restarts and deployments. Existing managed bot tokens cannot be decrypted with another key. Webhook secrets and encrypted bot credentials are server-side only. A change to the manager webhook secret is applied on startup; existing child bots keep their own stored secrets. When the public URL changes, restarting the backend updates every stored bot webhook, including paused bots. Invalid child credentials pause that bot without blocking the others; other registration failures stop startup so it can be retried. The public development command stops both processes with Ctrl+C or when either process exits. Its temporary URL changes on each launch; a named Cloudflare Tunnel with a domain is an option for a stable hostname. Quick Tunnels are intended for development.

### User flow

- **Create knowledge base** asks for a name, then accepts one supported file up to 1 MiB or a text message. Native Telegram messages have their own text length limit. The shared upload decoder also supports PDF, DOCX, and DOC; scanned documents require OCR and are not supported.
- **My knowledge bases** lists the owner's bases. Each base provides status, renaming, complete content replacement, test questions, bot creation, and deletion with confirmation. Ingestion completion or failure is reported through a persistent notification. Deletion requires ingestion to have finished and pauses and disconnects associated bots.
- **Create Telegram bot** opens Telegram's native managed-bot creation dialog. The owner confirms its name and username. Telegram's `managed_bot` update provides the owner and bot identity; the manager retrieves the token and sets the child webhook automatically. The user does not copy a child token.
- New bots created with a selected ready knowledge base start answering immediately and are accessible to other users. Bots without a selected ready base remain paused and restricted to their owner; select a ready base in **My bots** and choose **Publish / enable answers** to activate them. Switching the selected base pauses answers until the owner publishes again. **Pause answers** stops answering in this backend; it does not delete the Telegram account or change its username.
- Child bots answer text questions in private chats using their registered owner's selected base. A customer cannot choose a different base or invoke management actions. `/start` introduces the bot. Testing in the manager uses the same answering service.
- `/cancel`, `/help`, and `/start` return to the manager's main menu. Base and bot lists are paginated. Creating multiple bots from one owner uses that owner's shared allowance. If a creation completes after its setup was canceled, the bot remains unbound; select a base through **My bots**.

The implementation follows Telegram's [Managed Bots flow](https://core.telegram.org/bots/features#managed-bots), [`request_managed_bot` button](https://core.telegram.org/bots/api#keyboardbutton), and [managed-bot token methods](https://core.telegram.org/bots/api#getmanagedbottoken). Live bot creation still needs verification with a real manager token and supported Telegram clients.

### Processing and limits

Authenticated webhooks persist updates before acknowledging them. `(bot_id, update_id)` deduplication prevents a delivered update from being processed twice after a successful commit. Source changes, session state, update completion, and outgoing messages commit together. A single Telegram worker processes updates in arrival order, with up to three attempts for transient failures; a delayed retry holds later updates until it can run. It holds a PostgreSQL advisory lock, separate from the ingestion worker's lock. Use one application instance with workers enabled.

The persistent outbox retries message delivery up to five times and honors Telegram `retry_after`. A blocked customer does not disable the whole bot. Revoked child tokens pause answering when delivery reports unauthorized; managed-bot updates refresh tokens, and owner changes detach the previous base and pause the bot. Terminal delivery failures are logged without tokens, source text, or provider details. Raw update payloads are cleared after completion; deduplication identifiers remain.

External API calls and PostgreSQL cannot commit atomically. An interruption after Telegram accepts an outgoing message but before its deletion from the outbox can duplicate that message. A crash after an AI request but before the update transaction commits can repeat the provider request and its charges. The current worker is intentionally sequential, so a slow question delays other Telegram requests; scale this before serving sustained traffic. Telegram's update retention also limits recovery from prolonged downtime.

`TELEGRAM_DAILY_QUERY_LIMIT` defaults to 100 admitted questions per owner per database calendar day, shared across customer bots and manager tests. Provider failures consume the allowance. This is an application allowance, not an exact currency budget. Telegram users can hold at most 20 knowledge bases. Ingestion uses the existing durable worker and provider limits; updates continue serving the previous ready version. Conversation history is not supplied to the model.

Run `npm run test:telegram` for isolated-database integration tests with controlled Telegram and answer transports. No real Telegram or paid OpenAI requests are made by these tests.
