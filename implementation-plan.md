# RAG API implementation plan

Based on [system-design.md](system-design.md). Written on 22 October 2026.

The repository currently contains the system design only. Build a single-instance MVP in small, working increments. The first usable slice accepts text, prepares it, and answers a question; the MVP is complete only after replacement, recovery, ownership, concurrency, and deadline behavior are verified.

## 1. Starting decisions

Use these as proposed implementation defaults. Record final choices in the system design when implementation begins.

| Area | Starting decision |
| --- | --- |
| Runtime and API | Node.js, TypeScript, Express. Use a supported Node.js release and pin dependencies when scaffolding. |
| Storage | PostgreSQL with pgvector; local development through Docker Compose. Use SQL migrations and a PostgreSQL client with explicit transactions. |
| Deployment | One application process running the HTTP API and background ingestion loop. Multiple replicas are outside this MVP. |
| Authentication | One configured developer API key mapped to a stable owner ID. Keep ownership checks in the application so additional owners can be introduced later. |
| Providers | One configurable embedding model and one configurable answering model. Verify API availability, dimensions, cancellation support, and a real request before committing model identifiers. |
| RAG implementation | Start with direct provider calls and small application modules. Evaluate a framework only if a concrete implementation need justifies it. |
| Retrieval | Exact cosine search scoped to one knowledge-base version. Add a vector index only if measured retrieval latency requires it. |
| Version retention | Retain successful old versions for the MVP so activation cannot invalidate an in-flight query. Delete incomplete attempt data safely. Plan successful-version cleanup separately. |
| Features | Use the four endpoints in the design. Defer deletion, model selection per request, streaming, and chat history. |

Choose explicit text, question, chunk, context, and output limits during the first milestone. The “100 pages” estimate needs a representative text sample before it can become a meaningful byte or token limit.

## 2. Milestone 1 — runnable application and durable ingestion records

### Work

- Scaffold the TypeScript application, development scripts, configuration validation, structured logging, and health endpoint.
- Add PostgreSQL with pgvector, migrations, and an example environment file without secrets.
- Separate HTTP handlers, database access, ingestion, retrieval, and provider adapters. Keep the structure small.
- Implement API-key authentication and owner-scoped knowledge-base access. Return `404` for missing or inaccessible knowledge bases.
- Finalize request validation, metadata fields, and a common error format.
- Implement `POST /knowledge-bases` and `GET /knowledge-bases/{id}`. Creation must persist the knowledge base, source text, and pending task in one transaction before returning `201`.
- Document local startup and API examples.

### Initial persistence model

| Record | Required information |
| --- | --- |
| Knowledge base | ID, owner ID, active version ID, timestamps. |
| Ingestion task | Knowledge-base ID, submitted source text, status, attempts started, next attempt time, sanitized failure details, timestamps. |
| Content version | Knowledge-base ID, ingestion task and attempt identity, embedding model and dimensions, chunking configuration, readiness state. |
| Chunk | Version ID, position, exact text, token count, embedding. |

Derive submission status from the latest task and `queryable` from the active version. Avoid independently maintained copies of the same state.

Enforce at most one pending or processing task per knowledge base with a database constraint, such as a partial unique index. Use transactions for task acceptance, claiming, and activation.

### Acceptance

- A developer can create a knowledge base and retrieve its pending status after an application restart.
- Invalid inputs and credentials produce documented errors.
- Owner isolation is tested with two owner identities, even though production initially configures one developer.

## 3. Milestone 2 — first working ingestion and query flow

### Work

- Add a background loop that polls durable tasks and claims work transactionally. Persist the incremented attempt count before calling a provider.
- Split text deterministically with a token-aware chunk size and overlap. Preserve exact chunk text and order.
- Embed chunks in bounded batches and store them under an isolated attempt version.
- Once all chunks are stored, activate the version and mark the task ready in one database transaction.
- Implement `POST /knowledge-bases/{id}/queries`: authenticate, check ownership, capture the active version, embed the question, retrieve matching chunks, assemble a bounded prompt, and generate a complete response.
- Store embedding model and dimensions on each version and use that configuration for query embeddings.
- Define a response outcome of `answered` or `insufficient_context`. Return refusal as a successful query outcome, distinct from an unready knowledge base.
- Include grounding instructions and treat retrieved text as untrusted content. Require refusal when the context cannot support an answer.
- Make retrieval count, similarity filtering, and context budget configurable. Treat the design's `0.6` threshold as an evaluation candidate, not an established quality guarantee.

### Acceptance

- With real provider credentials, submitted text becomes ready and supports a grounded answer through the API.
- An unready knowledge base returns `409` with `knowledge_base_not_ready`.
- An unrelated question produces an explicit refusal in the initial manual check.
- Retrieval cannot include chunks from another knowledge base or version.

This is the first usable development slice. It is not yet the complete MVP.

## 4. Milestone 3 — safe content replacement and recovery

### Work

- Implement `PUT /knowledge-bases/{id}/content`, durably saving the text and pending task before returning `202`.
- Return `409` with `ingestion_in_progress` if another submission is pending or processing. Translate the database constraint violation into this response.
- Keep the active version available while building replacement content. Switch versions only through the activation transaction.
- Implement three attempts total per submission, including interrupted attempts. Use persisted retry scheduling; start with delays of 10 seconds and 60 seconds after the first and second failures.
- Retry transient failures; mark permanent validation or configuration failures terminal with a useful sanitized status message. Three attempts are a maximum, not a reason to repeat a known permanent failure.
- On startup, reconcile tasks left processing. An interrupted third attempt becomes failed; other interrupted attempts restart from the beginning under a new attempt identity.
- Remove incomplete attempt data without touching any active or successfully completed version. Perform cleanup transactionally after verifying the version's state.
- Make shutdown stop new claims and attempt cancellation of ongoing work. Durable state must still support recovery after a forced exit.

### Acceptance

- Two simultaneous replacements result in exactly one accepted task.
- Queries continue to use the previous version during replacement and after terminal ingestion failure.
- An in-flight query uses its captured version even if replacement activates meanwhile.
- A restart after partial chunk storage never exposes mixed or duplicate attempt data.
- A crash before activation commit leaves the old version active; a crash after commit leaves the new version active and its task complete.
- Repeated restarts never reset the three-attempt budget.

## 5. Milestone 4 — bounded query execution

### Work

- Add one application-wide admission gate for three concurrent queries. Acquire a slot without waiting; return `429` with `query_concurrency_exceeded` when full.
- Apply one 10-second deadline from query admission through embedding, retrieval, and generation. Pass remaining time and cancellation signals to downstream operations.
- Use `504` with `query_timeout` as the proposed timeout contract. Disable automatic query retries in provider clients.
- Release the admission slot on success, refusal, error, timeout, or client disconnect.
- Track provider calls that remain unresolved after cancellation separately. Bound provider transport timeouts and add a protective limit so repeated timeouts cannot accumulate unlimited abandoned work.
- Bound database waits and provider output tokens. Keep ingestion batch concurrency low enough to avoid starving query traffic; measure contention with real calls.

### Acceptance

- Three queries can run across different knowledge bases; the fourth is rejected immediately.
- Controlled slow-provider tests verify the full deadline and slot release on every exit path.
- A timed-out query does not trigger an automatic retry.
- Repeated timeouts demonstrate bounded outstanding provider work.

## 6. Milestone 5 — evaluation, observability, and MVP handoff

### Work

- Create a representative plain-text fixture and a repeatable 20-question evaluation set: eight directly answerable, six paraphrased, and six unsupported questions.
- Record expected answers or refusals and supporting passages before tuning retrieval or prompts.
- Add an evaluation script that records retrieved evidence, outcomes, model configuration, and full response latency for manual review.
- Run it with one and three concurrent queries, including a run during ingestion. Report observed behavior against the 10-second query and one-hour ingestion requirements.
- Review retrieval and answer quality separately. Agree on numerical quality and reliability targets after the baseline; do not claim these from a single successful run.
- Add request IDs and timings for embedding, retrieval, generation, and ingestion attempts. Record token usage where supplied, retries, refusals, timeouts, and rejected queries.
- Default logs to metadata without raw source text, questions, answers, or credentials. Decide explicitly whether content traces and an external tool such as Langfuse are needed.
- Document setup, authentication, endpoint contracts, polling, failure recovery, model configuration, evaluation commands, and the single-instance deployment constraint.
- Update the system design to distinguish implemented decisions from remaining suggestions.

### Acceptance

- Automated checks cover ownership, transactional replacement, recovery, version isolation, concurrency, and deadlines using a real PostgreSQL test database and controlled provider adapters.
- Real-provider evaluation results are saved with known limitations and any unmet targets.
- A developer can follow the README to create a knowledge base, poll readiness, obtain an answer or refusal, replace content, and inspect a failed submission.

## 7. Where to start

Implement milestone 1 first. Its reviewable deliverable is a runnable API, a reproducible local database, migrations, and authenticated create/status endpoints with durable pending tasks. Then complete the ingestion-to-answer slice before adding the recovery and load safeguards.

Do not add a bot integration, UI, external queue, multiple application replicas, or additional model choices until the agreed MVP behavior works and has been evaluated.
