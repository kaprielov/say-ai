# Larger knowledge-base uploads and multiple Telegram files

Status: implemented and locally validated in the isolated worktree; not merged or deployed.
Approved by the user on 2026-10-25. Branch: `codex/knowledge-base-batch-upload`.
Date: 2026-10-25.
Baseline: `fe6dee6` in the dedicated `knowledge-base-batch-upload` worktree.

## Goal and isolation

Allow a manager to create or fully replace one knowledge base using several
documents, sent together or separately, with higher upload limits. Keep the
current checkout, running application, and its database unchanged. This worktree
starts at committed HEAD; uncommitted pilot/spending changes in the primary
checkout are deliberately absent. Reconcile those changes before any later merge.
Implementation is confined to this worktree. No production/current-build migration, deployment, app restart, or merge has been performed.

## Current behavior

- `src/telegram/service.ts` accepts one document or text in `upload`/`replace`,
  creates an ingestion task immediately, and changes the session to `selected`.
  Subsequent documents therefore do not join that task.
- The 1 MiB limit is repeated in the manager, Telegram download metadata/stream
  checks, `src/ingestion/source.ts`, document extraction, and user guidance.
- `src/telegram/worker.ts` handles updates in bot order within a transaction.
  Downloading/parsing a larger batch there would delay all manager interactions.
- Ingestion already persists source text, retries interrupted work, and activates
  complete versions atomically. Replacement keeps the previous active version.
- HTTP multipart currently uses Multer memory storage and accepts exactly one
  `file`. Parsing happens before the creation transaction.

## Proposed limits and user flow

These are product defaults to approve, not limits inferred from the request:

| Bound | Proposed default |
| --- | --- |
| Individual raw file | 20,000,000 bytes (20 MB) |
| Files in one draft | 10 |
| Total downloaded file bytes per draft | 50,000,000 bytes (50 MB) |
| Combined extracted UTF-8 text, including separators | 5,242,880 bytes (5 MiB) |
| Open drafts per owner | 1 |
| Inactive draft retention | 24 hours |
| Concurrent batch preparation jobs | 1 per application |

Use exact byte checks and explicit units in both languages. Telegram's published
20 MB download limit is the reason to keep raw files within that bound. A large
PDF may contain relatively little text; file size and extracted text need separate
limits. Retain parser memory/time limits initially and report actionable errors.

After naming a base or selecting Replace content, collect document references in
a durable draft. Show filenames/count and a **Done** action. Accept grouped files
and separate messages identically. Do not finish on the first file or on a timer.
Done freezes the draft and queues preparation; repeated clicks are idempotent.
Support removing an item, canceling the draft, and resuming after Help/restart.
Pasted text is a single-item draft using the same completion action; document
captions are not implicitly treated as source text.

One completed draft produces one knowledge base/version and one ingestion task.
Replacement replaces the complete content; incremental append is excluded.
Validate all items before embeddings. An invalid file prevents partial activation
and identifies the file to remove or resend; other draft items remain available.
Late files after Done receive an explicit closed-draft response and are never
silently attached to a new draft. Telegram provides no album-complete event, so
the visible list is the user's review boundary; no claim of perfect late-arrival
detection is made.

## Research and alternatives

1. [Telegram Bot API: getFile and Message](https://core.telegram.org/bots/api#getfile)
   documents the 20 MB cloud download bound and `media_group_id`. A group arrives
   as individual messages, rather than one upload payload.
2. [python-telegram-bot media-group patterns](https://github.com/python-telegram-bot/python-telegram-bot/wiki/Frequently-requested-design-patterns#how-do-i-deal-with-a-media-group)
   compares timer collection with explicit user completion. Timer completion is
   smoother but can miss delayed updates; explicit Done also handles files sent
   separately. Borrow the interaction pattern only; add no Python dependency.
3. [Multer documentation](https://github.com/expressjs/multer#memorystorage)
   warns that memory storage can exhaust RAM with large or numerous uploads.
   Preserve bounded admission before parsing; do not multiply a new file limit
   by the existing 64 concurrent HTTP slots without a separate upload bound.
4. [Telegram local Bot API server](https://core.telegram.org/bots/api#using-a-local-bot-api-server)
   removes the cloud download-size restriction, but adds a service to operate.
   Exclude it unless files above 20 MB become a confirmed requirement.

Prefer the existing PostgreSQL queue/outbox and existing document parsers. No new
runtime dependency, parser, external storage service, OCR, or framework is needed.
Alternative: parse every file during update handling. It needs less queue wiring
but prolongs manager transactions and blocks unrelated updates; reject for larger
batches. Alternative: separate bases per file conflicts with the single-base goal.

## Implementation milestones

1. **Limits and bounded transport.** Centralize raw-file, batch, and extracted-text
   limits under ingestion. Apply raw limits to Telegram metadata and streaming
   byte counts, and text limits after decoding/extraction. Reject before fetching
   when metadata already exceeds a limit; still check actual bytes when metadata
   is missing or wrong. Update shared HTTP single-file limits consistently, add
   upload admission before memory buffering, and retain the single-file multipart
   contract and existing JSON contract in this iteration. Document these HTTP
   differences. Reject unsupported types before download where possible.
2. **Durable drafts.** Add a reversible migration for owner-scoped drafts/items,
   target base, generation ID, ordered message IDs, file references, actual sizes,
   preparation state, retry times, and expiry. Bind callbacks to draft identity;
   enforce ownership, base ownership, item count, and one open draft under locks.
   Deduplicate update/message identity; allow two intentionally submitted files
   with the same filename. Preserve deterministic item ordering.
3. **Manager flow.** Change `upload`/`replace` and their Help/Continue/Back routes
   in `src/telegram/service.ts`. Reuse durable outbox panels and edit recovery.
   Done creates a durable preparation job in a short transaction; no file parsing
   runs inside the Telegram update transaction. Recheck pending earlier admitted
   messages for the draft before freezing. Prevent stale callbacks from mutating
   a newer draft. Update `i18n.ts`, `guide.ts`, and README in Russian and English.
4. **Preparation and activation.** Add a bounded preparation worker using existing
   PostgreSQL claim/retry conventions, wired through `src/index.ts`. Download and
   extract one item at a time outside long database transactions. Persist bounded
   extracted text and per-item progress; discard raw buffers after each item.
   Recover in-progress jobs on restart and bound transient retries (three attempts,
   existing 10/60-second retry convention). Invalid content returns the draft to
   an editable error state; temporary transport errors retry without embeddings.
   Before persistence, enforce actual batch bytes and combined text bytes.
   Join validated sources with deterministic paragraph separators, retaining the
   item manifest for errors. Keep existing chunk/citation representation in this
   iteration; file-aware citations and chunking changes are excluded.
   Atomically call existing create/replace, attach the completion notification,
   and record task ID/closed draft so crash recovery cannot create duplicate tasks.
   Recheck base ownership/existence, base count, credentials, and replacement busy
   state at submission. Never switch active content during preparation.
5. **Capacity, cleanup, and verification.** Expire abandoned drafts and remove
   staged text/references in bounded cleanup batches. Cap total queued preparation
   jobs (proposed 100 globally, one submitted job per owner) and release capacity
   on failure/cancel/delete/expiry. Ensure cleanup cannot delete claimed work.
   Check larger-source chunking CPU, peak memory, and the current ten-minute
   ingestion deadline locally with controlled embeddings. Do not raise processing
   concurrency or deadlines speculatively; report measurements and adjust the
   proposed text ceiling if the existing algorithm cannot support it credibly.

Likely affected components: `src/ingestion/{source,documents}.ts`, a shared limits
module, `src/telegram/{client,service,worker,i18n,guide}.ts`, preparation worker,
`src/index.ts`, upload admission wiring, new migration, README, and affected tests.
Keep the existing HTTP API one-file protocol; HTTP multi-file support is a later
scope decision. No production migration, deployment, merge, or app restart here.

## Acceptance criteria and validation

- A group of three files and three separate messages both produce one base
  containing all accepted text after Done; a single file/text also works.
- Boundaries accept the exact byte/file limit and reject limit + 1. Count actual
  stream bytes, extracted UTF-8 bytes, separators, missing metadata, and totals.
- Duplicate deliveries/Done clicks, restart during extraction or submission,
  ownership violations, stale callbacks, outbox failure, and cancellation do not
  duplicate tasks, lose accepted draft items, or leak capacity.
- Invalid/oversized/unsupported files cause no embedding requests. Preparation
  remains editable after a content error; activation occurs only for a complete
  successful ingestion. A failed replacement leaves the previous version usable.
- Manager messages remain responsive while another owner's files are prepared.
  Expiry, deletion, retry exhaustion, and queue-full behavior are actionable.
- Validate shared HTTP behavior, extraction cancellation/time/memory limits,
  language coverage, and the unchanged retrieval/citation representation.

Follow `say-ai-testing`. Add focused failing behavioral cases before executable
changes; use real disposable PostgreSQL for queue/locking/activation contracts and
controlled Telegram/embedding transports. Run affected suites (`test:telegram`,
`test:documents`, `test:api`, `test:replacement`, `test:ingestion`,
`test:server-limits`, and `test:db` for the migration), plus `npm run build`.
Before integration run the deterministic full suite once:

```sh
RUN_LIVE_QUERY_TEST=false RUN_LIVE_EMBEDDING_TEST=false node --env-file-if-exists=.env --import tsx --test tests/*.test.mjs
```

Use a separate disposable database and application ports/tokens; do not copy the
current `.env` and accidentally run workers against the current build's database.
Test migration up/down on that disposable database. Validation evidence is recorded below. Real Telegram smoke checks and paid semantic evaluations require
separate authorization and are not implied by plan approval. Controlled tests do
not establish real client rendering or large-corpus semantic quality.

## Risks, recovery, and approval

The new defaults increase memory, tokenization time, storage, and embedding cost;
the byte ceiling alone is not a performance guarantee. Per-item sequential
preparation and bounded admission limit amplification. The text ceiling remains
provisional pending local measurements. Parser guards can still reject a valid
but complex document; increasing raw size does not promise arbitrary PDF support.
Joined sources can mix at file boundaries under existing chunking, an explicit
quality limitation to assess before considering file-aware chunking separately.

Rollback: stop the isolated instance, preserve task/base data needed for diagnosis,
and revert application changes. Remove only draft/preparation schema after workers
are stopped and no staged work is needed; do not roll back existing content data.
The primary checkout/build requires no recovery because it is not changed.

Approved scope: proposed limits, explicit Done for files/text, and Telegram
batch scope with consistent shared single-file limits. Approval covers
implementation and local deterministic validation in this worktree only.


## Implementation record

- Implemented the proposed byte/count limits, persistent drafts, removal/cancel/
  resume controls, explicit completion, owner checks, atomic submission, bounded
  sequential background preparation, restart recovery, expiry, and English/Russian
  copy. Raw bytes remain transient; validated text is staged until submission.
- Increased manager-user webhook backlog admission to 20 updates so an entire
  ten-file group can be admitted. Child-bot visitor admission remains five.
  A focused failing webhook test reproduced rejection of the sixth file first.
- Larger text exposed a CPU bottleneck in existing tokenization. Moved it into a
  cancellable child process (768 MiB V8 heap; 64 MiB result bound), preserving the
  ten-minute attempt deadline. Reduced offset-map memory with a typed array,
  segmented at mandatory LF boundaries, and added a byte-proven fast path for
  short paragraphs. Chunk strategy, token limits, text and citation semantics
  remain unchanged. Compared with the original implementation on 300 deterministic
  Unicode/line-break cases across three token budgets: exact chunks and token
  counts matched. These are deterministic equivalence checks, not RAG-quality
  evaluations.
- Existing test cleanup explicitly includes the new referenced tables. The dialogue
  migration test now rolls back the newer draft migration before its own migration;
  the draft migration has its own up/down verification in a disposable database.

### Local evidence

- Initial focused tests reproduced the 1 MiB rejection and premature first-file
  submission before implementation. API, documents, Telegram, ingestion,
  replacement, worker, queue, ownership, cancellation, outbox-full recovery, and
  migration checks were subsequently exercised with controlled transports.
- `npm run build` and `git diff --check` passed. The final deterministic full
  suite (`RUN_LIVE_QUERY_TEST=false RUN_LIVE_EMBEDDING_TEST=false node
  --env-file-if-exists=.env --import tsx --test tests/*.test.mjs`) passed 174 tests
  with four opt-in live tests skipped and zero failures (178 total). The final
  focused `npm run test:uploads` also passed all 18 checks, including the last
  error-message localization adjustment. No paid or real Telegram calls occurred.
- A 5,242,880-byte synthetic corpus of short English paragraphs generated exactly
  41,283 chunks both before and after optimization. Original direct chunking took
  370,504 ms with 640 MiB peak process RSS. Final compiled isolated chunking took
  3,337 ms; the parent event loop ticked 312 times and parent peak RSS was 79 MiB.
  The latter excludes child-process RSS and is not a total memory measurement.
  An intermediate superseded benchmark was deliberately stopped; its signal exit
  is not evidence of a resource-limit failure.
- Full ingestion of that corpus into the isolated PostgreSQL database completed
  ready in 43,587 ms, with 41,283 persisted chunks and 2,581 controlled embedding
  batches. The adapter returned three-dimensional deterministic vectors; no paid
  calls occurred. This proves local processing and activation under the deadline,
  not real-provider throughput, production memory sizing, or semantic answer quality.
- Tests used a separate `say-ai-batch-upload-tests` PostgreSQL container, never the
  primary checkout's database. Its connection is in this worktree's ignored `.env`.
  The test container was stopped after validation and can be restarted with `docker start say-ai-batch-upload-tests` for
  later local checks. No server or real Telegram worker was launched.

### Remaining integration checks

Real Telegram client rendering/download acceptance and real-provider throughput
were not checked. The current checkout has uncommitted pilot/spending work absent
from this HEAD-based worktree; reconcile that separately before merging. No merge
or deployment is authorized by this implementation step.
