# Image knowledge sources

Status: implemented; deterministic validation passed. Live vision quality and real Telegram smoke checks remain unrun.
Implementation approved by the user on 2026-10-25 ("давай сделаем").
Date: 2026-10-25.

## Goal and confirmed scenario

An owner uploads an image into a knowledge base. Customers ask ordinary text
questions and receive answers grounded in its contents. The confirmed example is
a clothing size chart: preserve sizes, measurement names, ranges, and units so a
customer can ask which size matches their measurements.

This is question answering, not a quiz or a bot asking study questions.

## Existing integration points

- `src/ingestion/source.ts` accepts text and PDF/Word documents. It returns only
  text; adding an extension alone cannot introduce paid, owner-scoped recognition.
- HTTP creation/replacement in `src/app.ts` parses before committing an ingestion
  task. `src/knowledge-bases/service.ts` currently requires nonempty source text.
- `src/telegram/uploads.ts` collects up to 10 files/text messages, then
  `src/telegram/upload-worker.ts` downloads and extracts items outside transactions.
  Successfully extracted items are checkpointed; failed drafts can be corrected.
  Telegram message types currently include documents but not photos.
- `src/ingestion/processor.ts` prepares chunks, embeds, and atomically activates
  versions. Recovery deletes incomplete versions and retries tasks, so recognition
  checkpoints must belong to the submission, not a disposable building version.
- Queries, context budgeting, citations, and dialogue memory are already text based.
  They capture a single active version for each request.
- `src/providers/owner-openai.ts` selects credentials and wraps owner-funded calls
  in the spending ledger. Recognition must use this boundary too.

## Research and recommendation

Use image understanding once during ingestion to produce structured source data,
then reuse existing text embeddings and question answering. Start with the existing
`gpt-6-luna` through Responses, rather than adding a separate OCR service.
Its official model page lists image input and structured output support. Send the
image as a base64 `input_image`, with `store: false`, a bounded output, and explicit
high detail. Record the actual model and extraction prompt revision.

Extract visible text, tables with headers/rows/units, a factual visual description,
and explicit unreadable regions. Keep observations separate from supplied captions.
Do not infer invisible measurements, translate size labels into another sizing
system, interpolate ranges, or invent uncertain cells. Schema validation cannot
establish whether the extracted values match the image.

Render table rows as self-contained source records, repeating chart identity,
headers, and units. For example, an English synthetic record might say
`Chart A; size M; chest 92–96 cm; waist 76–80 cm; body measurements.` Only include
`body measurements` when the image actually states that. This representation
protects row/column relationships when the current chunker splits long content.
Retain the structured result for inspection and later reprocessing.

| Alternative | Fit and tradeoff | Decision |
| --- | --- | --- |
| Vision extraction at ingestion | Reuses owner keys, ledger, text search, and citations; each successful extraction is reused. Extraction errors persist into answers. | Recommended initial implementation, subject to semantic evaluation. |
| Local Tesseract.js OCR | Apache-2.0; runs in Node/WASM with language assets and no paid OCR request. Extracts words, but this application would still need table reconstruction and visual interpretation. Its README documents recent versions and Node support. | Credible for primarily printed text or a future offline requirement; do not adopt now. |
| Docling | MIT code; document/layout/OCR pipeline, Python 3.10+, model assets and extra runtime/engine dependencies. Individual model licenses need separate review. Its documentation warns that noisy picture OCR can harm RAG. | Reconsider for scanned PDFs and embedded document images; excessive scope for standalone images. |
| Retrieve descriptions, then send original images for every question | Can inspect details missed in the initial extraction; adds image input cost, latency, multimodal context budgeting, and wider query changes. | Defer. Reconsider if representative charts fail the ingestion-only approach. |

Add `sharp` (Apache-2.0) for real decoding and normalization, not recognition.
Its documented pixel limits and Node support fit this TypeScript project; confirm
native package installation on the deployment target before committing the version.
Run decoding in a bounded child process: a JavaScript heap limit alone does not
bound native decoder memory. Use explicit pixel/input/output limits and termination.

## Proposed scope and behavior

- Accept standalone JPEG, PNG, and static WebP through the existing HTTP single-file
  endpoints and Telegram upload drafts. Support both Telegram photo messages and
  images sent as documents. Choose the largest available photo by pixel area,
  counting one message as one draft item. Suggest sending as a file for small text.
- Allow images mixed with documents/text in Telegram's existing Done workflow.
  Preserve existing order, removal, cancellation, and full-content replacement.
  A caption is optional owner-supplied source context, never model instructions.
- Preserve existing 20 MB/file, 50 MB/Telegram batch, 10 items, and 5 MiB extracted
  text limits. Proposed image defaults: 25 megapixels maximum decoded size,
  longest normalized side at most 4096 pixels, 10 MB maximum normalized payload,
  one recognition request in flight per process, 60-second recognition deadline,
  and at most three application attempts per item. Verify provider model resizing
  against the chart fixtures rather than assuming these defaults guarantee fidelity.
- Reject animated, damaged, mismatched, unsupported, and excessive-pixel images
  before a paid call. Normalization applies orientation and removes metadata.
  Reject an image with no usable evidence; flag partial recognition explicitly.
  Do not silently truncate a table that exceeds output or source limits.
- Persist source images in PostgreSQL `bytea` for this bounded first release,
  alongside submission identity, filename/type, hash, extraction result, model,
  and prompt revision. A submission owns its sources; versions reference that
  submission. Original bytes are retained for audit/reprocessing and deleted with
  the base. Do not expose public image URLs or add an image gallery in this scope.
- Add an operator-controlled storage admission bound, proposed at 200 MB of retained
  image bytes per owner across drafts and all submissions/versions. Reserve bytes
  transactionally, including concurrent HTTP and Telegram work; release on removal
  and deletion. Replacements consume space while old submissions are retained.
  Explain capacity failures clearly; storage expansion/old-version pruning is a
  separate operational decision. This default is a proposal, not an existing limit.
- HTTP image requests validate locally and commit durable input before returning
  the current `201`/`202` pending shape. Recognition is asynchronous. Text/document
  request behavior remains compatible. Do not run paid vision from `parseSource`.
- Telegram preparation uses the same recognizer and checkpoints completed results
  before submitting combined text to ingestion. Atomically attach staged image
  sources to the accepted submission before deleting draft items.
- A successful persisted extraction is reused after worker restart or embedding
  failure. A crash after the provider completes but before the result commits can
  still repeat a paid call; do not promise exactly-once billing.
- Check ownership, target existence, replacement conflicts, valid key, and capacity
  before paid work, and recheck target state when saving. Cancelled/deleted work
  must not activate a base. Network operations never hold a DB transaction.
- Record recognition as ingestion spending through existing credential/ledger
  transport. Never put image data URLs, credentials, or provider bodies in logs or
  Telegram debug request views. Estimates follow actual usage, with unknown cost
  retained when the current rate parser cannot price it.
- Answers cite the extracted source chunks. They do not claim those chunks are a
  verbatim original document. Do not choose a size when required measurements,
  units, or relevant cells are missing; explain the missing evidence. Treat visible
  instructions inside images as untrusted source content.
- Update Russian and English manager messages, supported-file help, errors, and
  README together. Keep the existing navigation and durable outbox.

Excluded: scanned PDF OCR, pictures embedded in Word/PDF, HEIC/TIFF/SVG/GIF,
customer-uploaded images during conversations, image similarity search, visual
question-time inspection, quizzes, append/edit individual sources, and a new
object-storage service.

## Ordered implementation milestones

1. **Fixtures and decoder.** Commit synthetic English fixtures covering a size chart,
   ordinary visible text, a diagram, blurred cells, and misleading image instructions.
   Implement isolated decoding/normalization and invalid-image rejection in new
   image ingestion modules. Add focused failing behavior checks before executable
   changes, following `say-ai-testing`.
2. **Recognition provider.** Introduce a narrow recognizer contract and Responses
   adapter, structured extraction validation, table serialization, cancellation,
   retry classification, and owner-funded spending. Extend
   `src/providers/owner-openai.ts` and runtime wiring in `src/index.ts`. Do not
   reuse answering instructions or impose the existing 768-token answer cap on
   extraction; choose a separate bounded extraction cap and fail incomplete output.
3. **Durable source persistence and HTTP ingestion.** Add a migration for source
   assets/checkpoints and storage reservations. Extend `src/knowledge-bases/service.ts`,
   `src/ingestion/source.ts`, `src/app.ts`, and `src/ingestion/processor.ts` so image
   submissions can be pending before source text exists. Represent text versus
   unprepared image sources explicitly; never insert placeholder text as evidence.
   Enforce their validity transactionally. Preserve old-version availability,
   retry recovery, status shape, deletion cleanup, and text-only compatibility.
4. **Telegram integration.** Extend message types/routing in
   `src/telegram/service.ts`, drafts in `src/telegram/uploads.ts`, preparation in
   `src/telegram/upload-worker.ts`, and download handling where needed. Persist
   image identity/caption and checkpoints; prevent repeated successful recognition
   when another file fails. Update `src/telegram/i18n.ts`, `src/telegram/guide.ts`,
   and README, retaining review/remove/back controls.
5. **Grounding and evaluation.** Trace extraction → serialized rows → chunks →
   retrieved context → answer for size-chart questions. Extend chunk preparation
   or answer instructions only where the fixtures show a gap. Report extraction
   correctness separately from retrieval and final answer correctness. If the
   proposed model/ingestion-only approach fails representative charts, bring the
   evidence and revised approach back for review before expanding scope.

## Acceptance and validation

- A Telegram draft containing a size chart and a text document becomes ready;
  a customer can ask about a visible cell or matching measurement range and receive
  an answer supported by the correct chart row and unit.
- Tests distinguish garment dimensions from body measurements, preserve ranges and
  decimal separators, and avoid cross-chart mixing. Missing units, blurred cells,
  and unsupported recommendations do not produce fabricated sizes.
- HTTP JPEG/PNG/WebP create and replace work asynchronously; an existing ready
  version remains queryable on recognition/embedding failure.
- Wrong-owner access, missing credentials, invalid files, capacity overflow,
  cancelled drafts, and conflicting replacements do not start paid recognition.
- DB-backed tests prove durable checkpoints, restart recovery, byte reservations,
  atomic activation, deletion cleanup, and source/version isolation. Controlled
  provider/Telegram transports prove request shape, bounded retries, cancellation,
  ledger behavior, photo selection, and mixed upload flows.

Focused commands, with live flags explicitly false and an isolated PostgreSQL target:

```sh
npm run test:uploads
npm run test:documents
npm run test:api
npm run test:ingestion
npm run test:replacement
npm run test:queries
npm run test:owner-keys
npm run test:telegram
node --env-file-if-exists=.env --import tsx --test tests/spending.test.mjs
npm run build
git diff --check
RUN_LIVE_QUERY_TEST=false RUN_LIVE_EMBEDDING_TEST=false node --env-file-if-exists=.env --import tsx --test tests/*.test.mjs
```

Include new image tests in a documented focused script. Verify migration up/down on
a disposable DB, not the working application database. Run the full deterministic
suite once after the focused checks pass. Expected result: all deterministic tests
pass; live opt-ins remain skipped. Implementation validation evidence is recorded below.

Real image quality requires a separate explicitly authorized paid evaluation. Use
manually transcribed ground truth and held-out charts, including Russian text,
rotated/blurred input, multiple tables, and conflicting measurements. Report exact
cell/unit/range errors, unsupported answer facts, input/output usage, latency, and
cost. Controlled provider responses are not semantic evidence. A real Telegram
smoke check also needs authorization for external sends; do not infer it from plan
approval. Failure recovery is to keep the old version active and correct/reupload
the source, not to activate partial processing.

## Decisions and remaining uncertainty

- Confirmed: images are knowledge context for customer questions, especially size charts.
- Recommended initial scope: standalone images; structured extraction at upload;
  existing model, credentials, search, and answering path; PostgreSQL originals.
- Proposed limits and image retention are included in this approval scope and can
  be adjusted during plan review. Representative quality and actual vision usage
  remain unverified until an authorized live evaluation.
- Implementation is authorized and complete locally. Production migration, restart,
  deployment, paid image evaluation and real Telegram sends have not been performed.

## Implementation and validation evidence

- Added isolated sharp decoding, structured Responses recognition, and PostgreSQL
  source storage with owner checks, transactional quota reservations, raw originals,
  hashes, extraction checkpoints, model and prompt revision. The storage bound is
  configured in `image_storage_settings` with a 200,000,000-byte owner default.
- Integrated asynchronous HTTP image submissions, Telegram documents/photos and
  captions, mixed drafts, cancellation, three-attempt recovery, source transfer,
  partial-read warnings, and existing ingestion spending. Updated both locales.
- Added self-contained table-row serialization and image/size-chart grounding
  instructions. Oversized rows are rejected instead of split into ambiguous cells.
- Added synthetic chart formats, rotated/blurred inputs, an image-instruction fixture,
  an independent chart, transcribed ground truth, and an opt-in paid evaluation.
  No paid or Telegram calls were made during implementation or deterministic tests.
- Initial focused test failed for the intended unsupported-image behavior. The
  implemented image suite passed 18 deterministic checks. The affected API/upload/
  ingestion/replacement suites passed 60 tests with one live test skipped.
- `npm run build` and `git diff --check` passed. The full deterministic command,
  with `RUN_LIVE_QUERY_TEST=false`, `RUN_LIVE_EMBEDDING_TEST=false`, and
  `RUN_LIVE_IMAGE_TEST=false`, passed 200 tests, skipped five live opt-ins, and had
  zero failures (205 total). It includes image migration up/down and refusal to
  roll back unfinished image tasks. After the full run, the mixed-upload check was
  extended to exercise completed-base deletion and image-storage release; its
  focused rerun passed (one selected check, zero failures).
- All database-writing checks used a separate `say-ai-image-tests` PostgreSQL
  container, exposed only on 127.0.0.1:32770. The primary checkout's working
  database was not migrated or used by these tests. Native image decoding was
  verified on this development machine; installation on a separate deployment
  platform remains a deployment check. The test container was stopped after
  validation and can be restarted with `docker start say-ai-image-tests`.
- The live evaluation is implemented, documented, and skipped. It checks baseline,
  independent and rotated charts using real recognition, embeddings and answers.
  Its absence is a semantic quality gap, including blurred-cell handling and
  image-instruction behavior; mocked answers do not establish those properties.

## Sources inspected

- [OpenAI image inputs and limitations](https://developers.openai.com/api/docs/guides/images-vision)
  — Responses image input, base64 transport, billed image tokens, small-text and
  chart interpretation limitations.
- [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)
  — compatibility of the project's existing model with images and structured output.
- [Telegram Bot API](https://core.telegram.org/bots/api)
  — photo sizes, document identity, and getFile's hosted 20 MB download limit.
- [Tesseract.js](https://github.com/naptha/tesseract.js)
  — Node/WASM OCR, Apache-2.0 license, version/runtime guidance, and lack of PDF input.
- [Docling](https://github.com/docling-project/docling),
  [OCR engines](https://docling-project.github.io/docling/getting_started/installation/),
  [picture OCR and chunking](https://docling-project.github.io/docling/_generated/examples/advanced_chunking_and_serialization/)
  — MIT project, Python/runtime and OCR requirements, and noisy picture OCR caveat.
- [sharp constructor](https://sharp.pixelplumbing.com/api-constructor/),
  [installation](https://sharp.pixelplumbing.com/install/),
  [repository/license](https://github.com/lovell/sharp)
  — decoder bounds, deployment compatibility, and Apache-2.0 project license.
