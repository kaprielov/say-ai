# Say AI

RAG API and Telegram bot manager in development, using Node.js, TypeScript, Express, and PostgreSQL with pgvector.

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
| `npm run dev:public` | Start Cloudflare Tunnel and the backend, automatically supplying the public URL and refreshing Telegram webhooks. |
| `npm run build` | Compile application TypeScript into `dist/`. |
| `npm start` | Run the compiled API. |
| `npm run db:up` | Start PostgreSQL and wait for its health check. |
| `npm run db:stop` | Stop PostgreSQL while preserving its data. |
| `npm run db:migrate` | Apply pending migrations. |
| `npm run db:rollback` | Undo the latest migration; the initial rollback deletes application tables and their data. |
| `npm run db:check` | Check connection, pgvector, and application tables. |
| `npm run pilot:status` | Read aggregate worker-lock, Telegram backlog, delivery retry, and ingestion status without provider or Telegram calls. |
| `npm run test:db` | Verify schema constraints and vector retrieval against the migrated database. Fixtures are rolled back. |
| `npm run test:api` | Test authentication, validation, persistence, owner isolation, and atomic creation in a temporary database. Requires database creation permission, available with the local Compose user. |
| `npm run test:images` | Verify image decoding, table serialization, durable recognition, storage bounds, and Telegram/API image flows with controlled providers. |
| `npm run test:documents` | Test document extraction capacity, cancellation, and cleanup without database or provider calls. |
| `npm run test:ingestion` | Test chunking, the provider adapter, ingestion, activation, retries, and restart recovery in a temporary database. No paid provider calls by default. |
| `npm run test:queries` | Test question answering, ownership, retrieval, grounding contracts, concurrency, deadlines, and cancellation in a temporary database. No paid provider calls by default. |
| `npm run test:owner-keys` | Verify encrypted owner credentials, Mini App authentication, onboarding, validation, and provider routing with controlled transports. |
| `npm run test:telegram` | Verify Telegram ownership, bot lifecycle, durable processing, quotas, and topic redirections with controlled transports. |
| `npm run test:server-limits` | Verify HTTP concurrency admission and request burst rejection without external calls. |
| `npm run test:dev-public` | Verify tunnel startup, public URL injection, and child-process cleanup without real public access. |
| `npm run test:replacement` | Test content replacement through the API, concurrent submissions, version switching, failure recovery, and old-version availability. Uses a temporary database and controlled providers. |

Compose stores database files in a named volume. Normal stops and restarts preserve it. Run migrations explicitly; application startup does not modify the schema.

## Pilot operator check

Run `npm run pilot:status` against the intended `DATABASE_URL` for a read-only JSON
snapshot. It reports worker advisory-lock presence in that database, pending/due/
deferred Telegram updates and outgoing messages, retry counts, and ingestion task
counts including recent failures. The command requires the migrated schema and
selects no message payloads, source text, owner identifiers, or credentials.
Connection/schema failures produce a sanitized diagnostic and exit code 1.
Exit code 0 means the snapshot was collected, not that the pilot is healthy.

Apply the worker-progress migration with `npm run db:migrate` before starting the
updated application. Workers record startup and actual loop progress in the DB,
at most once per ten seconds. Ingestion also records progress after committed
embedding batches, so a long document does not look stalled while batches advance.
There is no independent heartbeat timer that can hide a frozen processing loop.
Progress is matched to the current lock holder's database PID and session start;
an old process's record is not accepted as the new worker's progress.

Each worker reports `progress_age_seconds` and a status:

| Status | Meaning |
| --- | --- |
| `stopped` | No lock and no currently due/processing work. This can be intentional. |
| `missing` | Work exists, but no worker holds the lock. |
| `unknown` | A lock exists without a matching progress record; check the running version and DB permissions. |
| `idle` | Fresh progress; no currently due/processing work. Future retries are excluded. |
| `working` | Fresh progress with work present. This does not guarantee every queued item advances. |
| `stalled` | Work exists and no progress has been recorded for over five minutes. Investigate a suspected stall. |
| `unresponsive` | Progress is over five minutes old even though no due work is visible. |

`attention_required` is true for `missing`, `unknown`, `stalled`, or `unresponsive`.
The fixed conservative threshold is reported as `stale_after_seconds: 300`; a
fresh worker may still be slow or fail to answer. No restart or external notification
is triggered, and CLI exit code 0 still means the report was collected successfully.
The read-only command itself never refreshes progress. Workers need write access
to `worker_progress`; diagnostic queries should run under the same DB role as the
application (or a role with access to its session metadata).

Compare successive snapshots to investigate accumulating work; this is not a
throughput measurement. `oldest_due_seconds` measures time since the
earliest current `available_at` among due rows. Retries reset that timestamp, so it
does not measure the original Telegram arrival/delivery age. `due` also does not
guarantee eligibility: per-bot/chat ordering can hold work behind a deferred retry.
An empty due queue has a null age. Ingestion's `oldest_unfinished_seconds` measures
time since submission, including scheduled retry waits. Failed ingestion counts
include historical failed submissions even if a later replacement succeeded.

See [the first-user pilot plan](docs/plans/first-user-pilot.md) for launch checks
and remaining diagnostic gaps. The focused check runs with:

```sh
node --env-file-if-exists=.env --test tests/pilot-status.test.mjs
```

## Knowledge-base API

### Pilot listing catalog storage

`npm run db:migrate` creates `listings`, `listing_variants`, and
`telegram_listing_selections`. If the optional manual `test_catalog` snapshot
exists, migration `1793577600000_listing_catalog` copies its records into the
public tables, preserving stock and measurements. The original schema remains a
backup; edit current stock in `public.listing_variants`. The manual SQL fixture
in `scripts/fixtures/avito-test-catalog.sql` only populates that backup schema and
must not be used to update the public catalog after migration.

Listings belong to a bot and its owner. Bot transfer deletes its previous catalog
and selections. Synthetic stock and test listings have explicit flags. Measurement
values are centimeters; `half_waist` and `half_hips` are flat half measurements,
not circumferences. Reference charts do not imply that a color is available.

Enabled customer bots with a catalog show product buttons after `/start`. Choosing
a product binds it to that bot and visitor. `/start`, `/reset`, and **Choose another
product** clear the selection and visitor history; selecting a product starts a
fresh product dialogue. Bots without a catalog keep the knowledge-base flow.
Child webhooks must include `callback_query`; application startup refreshes them.

Before each product answer, the query pipeline checks the current bot, owner,
knowledge-base binding, and visitor selection, then reads price, variants, stock,
and measurements from the public catalog. It uses only that selected listing as
evidence, avoiding unrelated knowledge-base products and embedding retrieval.
Existing dialogue limits, answer settings, provider accounting, quotas, and safety
validation still apply. Catalog evidence is capped at 50 variants and 3000 tokens;
oversized records fail without a provider request. The bot labels test stock as
fictional. Product photos are not yet displayed in Telegram cards.

Rolling this migration back drops the public catalog and selections, including
edits made after import; the manual snapshot remains.

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

Supported extensions (case-insensitive): `.txt`, `.md`, `.markdown`, `.csv`, `.tsv`, `.json`, `.jsonl`, `.ndjson`, `.yaml`, `.yml`, `.pdf`, `.docx`, `.doc`, `.jpg`, `.jpeg`, `.png`, and `.webp`. Files may be up to 20 MB (20,000,000 bytes) of file bytes, excluding multipart framing. Plain text formats must contain valid UTF-8 text, optionally with a UTF-8 BOM. Empty or whitespace-only text files, invalid UTF-8, and binary control characters return `400`; oversized files return `413`; unsupported extensions return `415`. Send exactly one file with no additional form fields. HTTP multipart buffering is limited to two simultaneous uploads per process; excess uploads return `429` with `upload_capacity_full`, and disconnects release admission capacity. JSON request bodies retain their 1 MiB limit. Malformed multipart requests, missing files, extra fields, and multiple files return `400` with `invalid_upload`.

Plain text formats are ingested as source text: formatting, table headers, and structured keys remain in the source. The API does not parse or validate CSV, JSON, or YAML syntax or import their records into database tables. Original text and line endings are preserved, with only an optional leading UTF-8 BOM removed.

PDF and Word documents are parsed locally before the ingestion task is created. PDF extraction uses the document's embedded text layer; Word extraction supports modern `.docx` and legacy binary `.doc` files. Paragraph text and table cell values are extracted, but document styling, images, and exact table or multi-column layout are not preserved. The resulting text is indexed and quoted as source chunks. Scans and image-only documents require OCR, which is not included. Files with no readable text return `400` with `empty_document`; damaged, encrypted, or mismatched files return `400` with `invalid_document`. The API does not accept document passwords or macro-enabled `.docm` files.

Document extraction runs in separate child processes with a 15-second deadline and a 256 MiB JavaScript heap limit per process. At most two extractions run concurrently per application process; further document requests return `429` with `document_capacity_full`. Timed-out extraction returns `422` with `document_timeout`. Client disconnection cancels extraction. Extracted text must also fit within 5 MiB (5,242,880 UTF-8 bytes); larger results return `413` with `extracted_text_too_large`, including compressed Word files whose upload size is small. Failed extraction does not create a knowledge base or replacement task.

For text and PDF/Word uploads, the filename and MIME type are not stored; MIME guesses do not determine acceptance. Document signatures and parsers validate the selected document format. Uploads are processed without writing temporary files and use the same durable ingestion pipeline as JSON submissions.

```sh
curl http://localhost:3000/knowledge-bases \
  -H "Authorization: Bearer $DEVELOPER_API_KEY" \
  -F "file=@knowledge.pdf"
```

The server commits the knowledge base and pending ingestion task together before returning `201 Created`, with a `Location` header and:

```json
{"id":"<uuid>","status":"pending","queryable":false}
```

### Image sources

Upload a static JPEG, PNG, or WebP through the same single-file create/replace
endpoints. In Telegram, add photos or image files to the existing upload draft,
optionally mix them with documents/text, and tap **Done**. For small text, send the
image as a file to preserve more detail. Images serve as knowledge sources for
customer text questions; customers do not upload pictures during conversations.

The server checks actual image contents in an isolated decoder before recognition.
Images are limited to 20 MB and 25 megapixels; orientation is applied, metadata is
removed from the provider input, and the longest side is bounded to 4096 pixels.
Normalized PNG input must fit within 10 MB. Animated, mismatched, damaged and
unsupported formats are rejected. Decoding has a 15-second deadline and two slots
per process, with a 256 MiB JavaScript heap ceiling plus native decoder memory
bounded by pixel/input limits. The heap ceiling is not a total RSS limit.

HTTP uploads commit durable sources and return the usual pending `201`/`202`
response; recognition happens in the ingestion worker. Telegram recognizes images
in the durable upload-preparation worker. Both use GPT-6 Luna through Responses
with high-detail image input, structured output, `store: false`, an 8192-token
output cap, one recognition call at a time per process, a 60-second call deadline,
and at most three attempts per item per submission. An explicit Telegram retry
starts a new attempt budget for unfinished items. Telegram owners use their own
key; recognition appears under document processing in Spending. Developer HTTP
images require `OPENAI_API_KEY` and enabled ingestion. Image input adds provider
usage; estimates use returned usage, and unsupported usage remains unknown.

Recognition extracts visible text, table headers/rows/notes, observed content and
unreadable regions. Table records repeat the chart identity, headers and units so
size-to-measurement relationships survive chunking. A row that exceeds the chunk
budget is rejected with a request to split the image while preserving row labels.
The recognized text enters existing retrieval and answering; subsequent questions
do not re-send the image. Original images, hashes and successful recognition
checkpoints are retained in PostgreSQL with their submission, including older
versions, until the base is deleted. Filenames are sanitized and bounded. Captions
are owner-supplied source context. No public image links or image browser are added.

An operator-controlled owner storage bound defaults to 200,000,000 bytes across
retained image sources and draft reservations. Unknown-size Telegram images reserve
20 MB until their real size is known. Reservations and actual byte changes are
transactional, and removal/deletion releases capacity. Operators can update
`image_storage_settings.owner_bytes` (minimum 20 MB); do not reduce it below current
reserved usage. A replacement needs capacity alongside retained old sources.
Normal application migrations must be applied before starting this version.
Rolling back the image migration requires every image submission to have extracted
text or to be removed; rollback discards original image storage and keeps extracted
text. Back up originals before an intentional rollback if they are needed.

A saved recognition result is reused after a restart or embedding failure. A crash
between provider completion and saving the result can still repeat a paid call.
Failed replacement keeps the prior ready version available. Partial recognition
is marked in source evidence and Telegram upload feedback. Missing units, unclear
cells, or conflicting measurements must not be filled in with guessed sizes.
Recognition can still misread a plausible number; test representative customer
questions before relying on a chart. Scanned PDF OCR and embedded Word/PDF images
remain outside this release.

`npm run test:images` uses a disposable PostgreSQL database and controlled providers.
An explicitly authorized paid quality check is available separately:

```sh
RUN_LIVE_IMAGE_TEST=true node --env-file-if-exists=.env --import tsx --test --test-name-pattern='live image extraction' tests/image-sources.test.mjs
```

It checks real extraction cells, indexed retrieval and answers on baseline,
held-out and rotated size charts. Review unsupported claims, blurred regions and
image instructions manually as described in `tests/fixtures/README.md`. No semantic
quality result should be inferred from the deterministic checks.

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

For greetings, capability questions, and questions the evidence cannot answer, the model can return `200` with `outcome: "redirected"`, a friendly reply of up to 280 characters, and source chunks supporting the suggested topics. The reply acknowledges the message or missing information and steers the conversation toward one or two topics covered by the knowledge base. Its sources support those topic suggestions, not an answer to the original unsupported question. The reply uses the user's language.

If no safe topic can be suggested or retrieval is empty, the API returns `200` with:

```json
{"outcome":"insufficient_context","answer":null,"sources":[]}
```

The question must be non-empty, contain no null characters, and fit within 4096 JavaScript string characters and 1024 `cl100k_base` tokens. The JSON body limit is 1 MiB. The server captures one ready version for each request; later activation of another version does not change that request's retrieval. Searches are scoped to both the selected version and its knowledge base.

Retrieval ranks the closest eight chunks by cosine similarity without a similarity cutoff. It first budgets the strongest three matches, then tries to add their immediate next and previous chunks using at most 1000 additional tokens, and finally fills remaining space with the other ranked matches. Neighbors are fetched only from the captured version of the same knowledge base, even when they did not rank in the top eight. Repeated chunk IDs from overlapping windows are included once; original chunk text and IDs remain unchanged for citations. Neighbor expansion also works for previously ingested versions.

The complete serialized context fits within a 3000-token budget measured with `cl100k_base`. This is a budgeting convention, not the answering model's exact token count. Expansion can displace lower-ranked matches, so its quality must be evaluated on representative questions. If no context is available, the API declines without a generation call. Otherwise, the model assesses whether the passages support an answer and can redirect or decline. Similarity determines ranking, not whether a chunk is allowed into the prompt. `RETRIEVAL_MIN_SIMILARITY` is no longer used.

Platform instructions are fixed; free-form bot preferences, questions, and source text are serialized as lower-trust input data. The server checks citation IDs and recognized links against the cited evidence. Unknown links are withheld with `insufficient_context`. These deterministic checks do not prove factual support or eliminate prompt injection. See [the defense boundaries](docs/security/prompt-injection.md).

A normal successful question makes **one generation call**, plus its existing query embedding. The generator also returns the topic label in this call; only validated off-topic redirections can drive moderation. Additional model-based classification and evidence review are disabled in normal application/provider wiring to avoid their latency and cost. Their experimental adapter is retained for future evaluation; see [the specialized verification plan](docs/plans/specialized-answer-verification.md). Model response storage remains disabled.

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

A redirection or insufficient-evidence outcome is a successful `200` response, separate from a provider-level safety refusal or processing failure. HTTP queries are stateless; managed Telegram bots can use bounded dialogue memory described below. Owner-initiated bot tests can retain the latest diagnostic snapshot as described under Per-bot answer settings and testing. Request prompts are sent to OpenAI, with response storage disabled in the Responses request.

To run the optional paid live check using a synthetic knowledge base in a temporary database:

```sh
RUN_LIVE_QUERY_TEST=true node --env-file=.env --import tsx --test --test-name-pattern='live GPT-6 Luna' tests/queries.test.mjs
```

This smoke test exercises a supported answer, a missing-information redirection, and a greeting using the normal retrieval behavior. It is not the full representative quality or concurrent-load evaluation from the implementation plan.

## Background ingestion

For developer-owned HTTP bases, set `OPENAI_API_KEY` in `.env` or the shell to enable the worker, then start the application with `npm run dev` or `npm start`. This is the provider credential; it is separate from `DEVELOPER_API_KEY`, which authenticates callers of this API. Without Telegram configured, leaving `OPENAI_API_KEY` empty runs the API without ingestion. With Telegram configured, the worker starts by default and resolves each Telegram owner's saved key; no shared OpenAI key is required. The developer HTTP owner still needs the server key. `INGESTION_ENABLED=false` explicitly pauses the worker; `INGESTION_ENABLED=true` requires either a server key or configured Telegram owner-key support.

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

The optional Telegram integration provides management through a manager bot and native Telegram buttons. A small server-rendered Mini App form handles OpenAI keys, without a separate frontend project. Each private-chat user owns knowledge bases under the stable `telegram:<numeric-user-id>` owner ID. The developer HTTP key retains its configured owner and does not grant Telegram users HTTP access.

### Setup

1. Create a manager bot in [BotFather](https://t.me/BotFather). In BotFather's Mini App, enable **Bot Management Mode** for that bot.
2. Set `TELEGRAM_MANAGER_TOKEN` in `.env`. Do not send the token through a chat or commit it.
3. For local public access, install `cloudflared` and run `npm run dev:public` after configuring the credentials below. This starts a Cloudflare Quick Tunnel and the backend together, injecting `TELEGRAM_PUBLIC_URL` automatically without editing `.env`. Stop any existing backend on the same port first. For a separately managed tunnel or deployment, set `TELEGRAM_PUBLIC_URL` to its public HTTPS base URL. Telegram must be able to reach `/telegram/webhook/<bot-id>`.
4. Set `TELEGRAM_WEBHOOK_SECRET` to a random secret containing at least 32 URL-safe characters. Set `TELEGRAM_TOKEN_ENCRYPTION_KEY` to a random 32-byte key encoded as 64 hexadecimal characters. Generate them separately:

   ```sh
   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

5. Optionally configure `OPENAI_API_KEY` for developer-owned HTTP bases. Telegram owners supply their own keys during onboarding. Run `npm run db:migrate`, then start the application. Startup verifies the manager token and registers its commands and the webhooks of the manager and all stored child bots. Leaving the manager token empty disables Telegram integration.
6. Open the manager bot in a current Telegram client, send `/start`, and choose **English** or **Русский**. The preference is stored per Telegram user. Existing users without a preference are also prompted on their next interaction. Then choose **Connect OpenAI key** and complete the form before accessing the main menu.

Preserve the encryption key across restarts and deployments. Existing managed bot tokens cannot be decrypted with another key. Webhook secrets and encrypted bot credentials are server-side only. A change to the manager webhook secret is applied on startup; existing child bots keep their own stored secrets. When the public URL changes, restarting the backend updates every stored bot webhook, including paused bots. Invalid child credentials pause that bot without blocking the others; other registration failures stop startup so it can be retried. The public development command stops both processes with Ctrl+C or when either process exits. Its temporary URL changes on each launch; a named Cloudflare Tunnel with a domain is an option for a stable hostname. Quick Tunnels are intended for development.

### Owner OpenAI keys

Onboarding is **language → OpenAI key → main menu**. The manager requires a saved, valid owner key before accepting knowledge-base or bot management actions. Existing users must also connect a key. **OpenAI key** in the menu or `/openai` opens settings for replacement or removal. Removal requires confirmation and blocks future provider calls until another key is connected; requests already in flight can finish with their captured key.

The button opens `/telegram/openai-key` as a Telegram Mini App. The password field posts the key directly to the backend, never through `Telegram.WebApp.sendData` or the bot chat. The form does not persist it in browser storage or a URL. The server validates Telegram's signed `initData`, rejects duplicate fields, and accepts sessions up to ten minutes old with a 30-second future-clock allowance. The signed user determines ownership; client-supplied owner IDs are ignored. Same-origin checks, CSP, bounded JSON, and `no-store` responses protect the credential endpoint. Open the form again if its session expires. Temporary tunnel URLs in old messages expire; request a fresh settings message after a tunnel restart.

Validation performs one short embeddings request with the configured ingestion model and one minimal GPT-6 Luna Responses request. These two calls are billable against the submitted key. The form explains this before submission. A key needs API billing and access to both endpoints/models. Checks are limited to three attempts per owner per minute. Invalid, restricted, quota-limited, and temporarily unavailable checks receive distinct messages; a failed replacement leaves the old key intact.

`owner_openai_keys` stores only AES-256-GCM ciphertext, a revision, validity, and update time. Its encryption key is derived from `TELEGRAM_TOKEN_ENCRYPTION_KEY` with a separate domain from Telegram bot credentials. Preserve that master key. Plaintext keys are not returned, logged, or placed in the Telegram queue. Key-like strings accidentally sent in Telegram updates are redacted before persistence, and a pasted manager message is scheduled for deletion where possible; this cannot undo its initial transmission through Telegram.

Every Telegram query resolves credentials from the registered base owner and captures one key for both question embeddings and generation. Ingestion resolves the owner key once per attempt for all embedding batches. The server's `OPENAI_API_KEY` is never a fallback for a Telegram owner. A `401` or `403` provider response invalidates the captured revision; an older in-flight request cannot invalidate a newer replacement. Missing credentials fail ingestion without a provider request. After reconnecting a key, resubmit failed content from **Replace content**. Changing only the key does not require re-embedding ready content when the embedding configuration remains compatible.

### User flow

- **Language / Язык** in the main menu or `/language` opens the language selector again. Switching language returns to the main menu. Manager messages, buttons, status cards, validation errors, ingestion notifications, and chat command descriptions use the stored preference. User-supplied names and source content are preserved; model answers continue to follow the question's language.
- **Create knowledge base** asks for a name, then collects up to ten supported files or text messages in a draft. Send files together or separately and tap **Done**. Each file may be up to 20 MB (20,000,000 bytes), all files together up to 50 MB, and the combined extracted UTF-8 text up to 5 MiB, including paragraph separators. Native Telegram messages have their own text length limit. The shared upload decoder also supports PDF, DOCX, and DOC; scanned documents require OCR and are not supported.
- **My knowledge bases** lists the owner's bases. Each base provides status, renaming, complete content replacement, test questions, bot creation, and deletion with confirmation. Replacement uses the same draft flow and replaces the complete content; the previous version stays available until successful activation. File errors preserve the draft for removal or retry. Ingestion completion or failure is reported through a persistent notification. Deletion requires ingestion to have finished and pauses and disconnects associated bots.
- **Create Telegram bot** opens Telegram's native managed-bot creation dialog. The owner confirms its name and username. Telegram's `managed_bot` update provides the owner and bot identity; the manager retrieves the token and sets the child webhook automatically. The user does not copy a child token.
- New bots created with a selected ready knowledge base start answering immediately and are accessible to other users. Bots without a selected ready base remain paused and restricted to their owner; select a ready base in **My bots** and choose **Publish / enable answers** to activate them. Switching the selected base pauses answers until the owner publishes again. **Pause answers** stops answering in this backend; it does not delete the Telegram account or change its username.
- Child bots answer text questions in private chats using their registered owner's selected base. A customer cannot choose a different base or invoke management actions. `/start` introduces the bot. Testing in the manager uses the same answering service.
- `/cancel`, `/help`, and `/start` return to the manager's main menu. Base and bot lists are paginated. Creating multiple bots from one owner uses that owner's shared allowance. If a creation completes after its setup was canceled, the bot remains unbound; select a base through **My bots**.

Drafts survive restart and Help, and **Review upload** in the main menu resumes them. Inactive editable drafts expire after 24 hours. Each owner has one active upload; the preparation queue holds at most 100 jobs globally. The manager webhook allows 20 queued updates per user so a ten-file selection fits before processing starts; child-bot visitors retain their five-update bound. **Cancel upload** discards a draft or stops preparation before submission. `/cancel` discards an editable draft; already submitted work continues. Files arriving after **Done** receive an explicit closed-upload response. Telegram sends album items individually, so review the collected list before finishing.

A separate preparation worker downloads and parses one file at a time outside Telegram update transactions. It persists validated text between transient retries, checks actual download bytes even when metadata is absent, and creates exactly one ingestion task only after every source validates. Preparation uses the existing durable outbox. Raw files are not persisted. Staged text is removed on submission, cancellation, deletion, or draft expiry. HTTP multipart remains a single-file API.

Tokenization runs in a cancellable child process using the unchanged chunking algorithm, with a 768 MiB JavaScript heap ceiling and a 64 MiB output ceiling. The existing ten-minute ingestion deadline also covers tokenization. A valid byte size does not guarantee that a complex document fits parser limits or that a large corpus can finish within the processing deadline. Run `npm run test:uploads` for the draft/worker and tokenization contracts.

The implementation follows Telegram's [Managed Bots flow](https://core.telegram.org/bots/features#managed-bots), [`request_managed_bot` button](https://core.telegram.org/bots/api#keyboardbutton), and [managed-bot token methods](https://core.telegram.org/bots/api#getmanagedbottoken). Live bot creation still needs verification with a real manager token and supported Telegram clients.

### Manager navigation

The home menu emphasizes bots, knowledge bases, and creation. Account settings group the API key, language, and owner quotas; `/settings` opens them directly. Knowledge-base cards put testing and updates first, keep rename/delete under **More actions**, and show a refresh action during processing. Back buttons return to the parent screen. Direct list-item cards retain the originating page in their return link.

Spam protection is split into **Message limits**, **Off-topic questions**, and **Notifications**. Each parameter starts with a short hint and preset buttons; custom numeric input remains available. **Details** reveals the full explanation, including edge cases and the meaning of zero. The default help screen and introduction are brief, with the full guide available on request. Help preserves the current input step and can return to it.

Lists of knowledge bases, bots, and restricted visitors show up to five items per page. Base-picker callbacks carry both the target bot and base, with independent ownership checks; ordinary base lists cannot accidentally inherit a pending binding action.

Inline navigation updates the message that was clicked through durable `editMessageText` outbox jobs. User input, announcements, and native reply-keyboard actions can still produce new messages. Unchanged edits are treated as complete; an uneditable or deleted panel falls back to a normal message. This reduces chat clutter while preserving existing delivery retries and chat ordering. Legacy callbacks remain supported.

The interaction model follows [progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/), [optional detail](https://design-system.service.gov.uk/components/details/), and Telegram's [inline keyboard and message APIs](https://core.telegram.org/bots/api#editmessagetext). These are design choices, not measured usability results; real user feedback is still needed.

### Processing and limits

Authenticated webhooks persist updates before acknowledging them. `(bot_id, update_id)` deduplication prevents a delivered update from being processed twice after a successful commit. Source changes, session state, update completion, and outgoing messages commit together. A single Telegram worker processes updates in per-bot arrival order, with up to three attempts for transient failures; a delayed retry holds later updates for that bot; other bots continue. Bots take turns between completed updates. It holds a PostgreSQL advisory lock, separate from the ingestion worker's lock. Use one application instance with workers enabled.

The persistent outbox retries message delivery up to five times and honors Telegram `retry_after`. A blocked customer does not disable the whole bot. Revoked child tokens pause answering when delivery reports unauthorized; managed-bot updates refresh tokens, and owner changes detach the previous base and pause the bot. Terminal delivery failures are logged without tokens, source text, or provider details. Raw update payloads are cleared after completion; deduplication identifiers remain.

External API calls and PostgreSQL cannot commit atomically. An interruption after Telegram accepts an outgoing message but before its deletion from the outbox can duplicate that message. A crash after an AI request but before the update transaction commits can repeat the provider request and its charges. The current worker is intentionally sequential, so a slow question delays other Telegram requests; scale this before serving sustained traffic. Telegram's update retention also limits recovery from prolonged downtime.

Owner daily customer and test quotas are independent and default to zero (no daily quota). The manager's **Settings → Owner limits** menu configures them. `TELEGRAM_DAILY_QUERY_LIMIT` optionally supplies the initial customer quota; explicit owner settings take precedence. Admitted provider failures consume the appropriate quota. Database calendar days determine resets. Quotas count requests, not exact currency. Telegram users can hold at most 20 knowledge bases. Managed bots use the configurable dialogue memory described below.

**Spending** in the home menu or **Settings → Spending** shows estimated USD usage through Say AI for today (UTC), the trailing seven days, or the current calendar month (UTC). Customer answers include query embeddings and dialogue-resolution calls and are broken down by bot in five-item pages. Tests, document indexing/reindexing, and key checks have separate subtotals. The screen remains accessible without a connected key. It does not read an OpenAI balance, include other applications, or reconstruct spending before tracking was enabled; final charges must be checked in OpenAI billing. This release provides reporting, without currency budgets or automatic spending notifications.

`provider_spending` records each owner-key HTTP attempt independently of the Telegram/ingestion transaction, without credentials, prompts, answers, or document content. An unknown-cost row is committed before the paid request; if this insert fails, the paid call is suppressed. Retries are separate attempts. Returned usage is recorded before application answer/vector validation, including incomplete responses; transport failures, missing/invalid usage, unknown models, and unsupported rates remain visibly unknown and excluded from known subtotals. Final ledger-write failures leave the initial unknown row and produce a sanitized operator log. Rows are retained after key removal, bot transfer/deletion, and knowledge-base deletion.

Prices are immutable snapshots of [OpenAI's published standard global API rates](https://developers.openai.com/api/docs/pricing), verified on 2026-10-25, in `src/providers/spending.ts`. Supported estimates cover `text-embedding-3-small`, `text-embedding-3-large`, and short-context standard `gpt-6-luna` (including dated snapshots). Generation requests explicitly select the default service tier. Cache reads and 30-minute/12-hour writes use distinct rates; reasoning tokens are already included in output tokens. Missing cache-write data and non-default returned tiers are unknown. Historical estimates are not recalculated when rates change; update the rate version for future calls. Apply database migrations before starting the updated workers.

Each bot's **Spam protection** menu configures visitor quotas (5/minute, 30/day by default), duplicate suppression (60 seconds), an off-topic window (10 minutes), warning threshold (3 requests), initial pause (15 minutes), repeated-abuse pause (6 hours), repeat window after a pause (24 hours), and notifications (enabled, coalesced over 15 minutes). Zero disables the corresponding soft rule; disabling visitor frequency limits still leaves the operator's 30/minute ceiling. Notification coalescing has a one-minute operator minimum. On the threshold request the bot warns; a further clearly off-topic request in the window pauses answers. Greetings, complaints, missing knowledge, and uncertain classifications do not count as violations. Only validated redirections classified as clearly off-topic count. Blocked messages do not call the model or extend the block. Exact normalized duplicates do not call the model or resend replies. The repeat window starts at the end of a pause. An owner can page through active restrictions and remove individual restrictions from the manager. Repeated-abuse notices include a count and links to restrictions/settings; they use the owner's selected language and the durable outbox. Full message text is not retained for moderation. Restriction timestamps are explicitly displayed in UTC. Owner transfer clears the previous visitor state, settings, and pending security notices.

### Mandatory server capacity controls

Operator-owned limits in `src/server-limits.ts` cannot be disabled by bot owners. HTTP admission allows a burst of 100 requests and replenishes at 100/second, with at most 64 active handlers per process. Production HTTP connections are capped at 200, with 10-second header, 15-second request-body, and 5-second keep-alive timeouts. Existing query limits remain three concurrent queries, six outstanding downstream operations, a 30-second query deadline, and bounded input/context/output tokens. Telegram's single worker additionally ensures one question runs at a time.

Telegram webhook delivery is capped at two connections per bot. Temporary Cloudflare tunnel hosts are resolved locally during registration and supplied through the Bot API IP override, avoiding negative DNS caches for newly created names. Authenticated webhook bodies are limited to 64 KiB. Admission uses a database transaction and a nonblocking advisory lock to bound pending updates to 1000 globally (plus 100 reserved manager slots), 200 per customer-bot owner, 100 per customer bot, and 5 per visitor/bot. Duplicate deliveries remain acknowledged even when the queue is full. Saturation returns `503` with `Retry-After`, allowing Telegram to retry. Bot scheduling preserves per-bot order and alternates eligible bots; a slow in-flight query can still delay everyone until its deadline. A mandatory 120 admitted questions/minute/owner limit includes tests. The outbox is capped at 5000 entries; saturation pauses new webhook admission and defers asynchronous notifications while existing delivery drains. Some updates already admitted during saturation may be discarded without a response to preserve capacity. These are conservative single-instance limits, not a measured throughput guarantee or network-level DDoS protection.

The Telegram worker removes completed update identifiers after seven days in bounded batches, inactive visitor state after 30 days (preserving active restrictions/repeat windows), daily usage after 90 days, and expired owner-rate rows after one day. Source questions and generated answers are not stored by the query API. Queue payloads are cleared on completion. Telegram queued payloads and outgoing messages still exist until processed/delivered. Sustained-load and representative multilingual topic-classification evaluation remain required before production rollout.

Run `npm run test:telegram` for isolated-database integration tests with controlled Telegram and answer transports. No real Telegram or paid OpenAI requests are made by these tests.

### Dialogue memory

Open **My bots → a bot → Dialogue memory**. Defaults apply to existing and new bots:
5 question/answer pairs, reset after 60 minutes of inactivity. Choose 0–20 pairs
(0 disables memory) and an inactivity timeout of 5–10080 minutes (up to 7 days),
using presets or custom values. These settings apply immediately, independently of
answer-setting drafts, and clear existing visitor and test dialogues. **Clear all
dialogues** requires confirmation. A visitor can send `/reset` (also while the bot
is paused) to clear only their own history without a model request or query quota.
In the manager, `/reset` clears the owner's test dialogues.

History is isolated by bot and visitor. Manager tests use separate published/draft
histories. Changing the knowledge base, its active content version, or the selected
answer-settings revision makes prior history inapplicable. Reconnecting a bot also
clears its history. A dialogue stores complete pairs, with a second limit of 6000
history tokens; expired history is ignored immediately and deleted in bounded
background batches. Rejected, duplicate, rate-limited and failed requests, and
confirmed off-topic exchanges, do not extend history. Delivered fallback replies
for insufficient evidence can be retained for conversational continuity.

For a follow-up with history, one additional owner-funded model request resolves
references into a standalone search question. Retrieval and optional safety checks
use that question. Generation receives the original question and history as
untrusted data, separately from current source evidence. Previous answers are not
sources of facts. More history increases input cost; disabling memory avoids the
additional resolution call. HTTP queries and direct knowledge-base tests remain
stateless. This is short-term context, not a long-term user profile or archive.

`npm run test:queries` includes the isolated dialogue request and budget checks.
The opt-in live conversation evaluation in `tests/queries.test.mjs` uses
`tests/fixtures/conversation-cases.json` for follow-ups, topic changes, and
unverified prior claims. It requires `RUN_LIVE_QUERY_TEST=true` and makes paid
provider calls; it is skipped in deterministic runs.

### Per-bot answer settings and testing

Open **My bots → a bot → Answer settings** to edit instructions, answer detail,
response language, and context selection. Changes stay in a draft. **Publish draft**
activates them for subsequent requests without enabling a paused bot. **Restore
previous version** switches to the previous published settings while preserving any
draft. The last 20 published versions are retained. Changing a bot's owner clears
its settings and history. Knowledge-base tests and HTTP queries keep the default
answering profile.

Instructions can contain up to 4000 characters. They guide presentation and audience;
source-evidence requirements, structured output, and moderation rules remain platform
controlled. Model behavior still needs semantic evaluation. Context presets are:

| Profile | Candidates | Seed chunks | Context budget | Neighbor budget |
| --- | --- | --- | --- | --- |
| Balanced (default) | 8 | 3 | 3000 tokens | 1000 tokens |
| Focused | 4 | 2 | 1500 tokens | 0 tokens |
| Expanded | 12 | 4 | 4500 tokens | 1500 tokens |

These budgets use the existing `cl100k_base` convention. Changing a profile does not
reindex the knowledge base. Expanded context can increase provider cost and is not
an assurance of better answers. Answer detail remains subject to the existing
768-output-token cap.

**Test bot** runs a question through the normal answering pipeline using either the
published settings or the draft. It uses the owner's OpenAI key and test quota,
without customer delivery or visitor penalties. Results show the outcome, settings
revision, elapsed processing time, topic and optional evidence-review status, selected source
context, and the assembled generation request without transport headers. The request
view shows the generation payload, including dialogue history when enabled; it does not show the separate follow-up resolution request. Extra model review is marked disabled. Changing settings requires reselecting a test
version. Every question captures the ready knowledge-base version at execution time;
this is not a fixed-version comparison experiment.

Only the latest test's details are kept in the owner's manager session. Leaving
testing clears them; details expire after 24 hours and background cleanup removes
expired content in bounded batches. Details explicitly opened in Telegram remain
in that private conversation under Telegram's normal message retention. Long-term conversation archives, analytics dashboards, Langfuse, and batch evaluation are outside this release. Failed test calls show a sanitized error code rather than provider
response bodies; full context inspection currently requires a completed query. Additional model-based
checks are currently disabled; factual support still requires semantic evaluation.

Apply the new database migration before running this version. The additional focused
settings checks run with:

```sh
node --env-file-if-exists=.env --import tsx --test tests/bot-settings.test.mjs
```
