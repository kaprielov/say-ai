# First-user pilot readiness plan

Status: preparation checklist; pilot launch is pending the checks below.
Created: 2026-10-24.

## Decision and scope

Prepare a small, assisted pilot with 2–3 bot owners before considering a broader
self-service launch. The technical foundation supports this next step, but current
answer quality, real Telegram behavior, availability, and concurrent use still need
evidence. This document records planned work, not approval to perform paid calls,
send external messages, or deploy changes.

The pilot should establish whether owners can turn their actual documents into a
useful bot, where they need help, and which answers fail. Record assistance as well
as defects so successful onboarding does not hide usability problems.

## Evidence available on 2026-10-24

- `npm run build` passed.
- `npm run db:check` passed against the local database; pgvector and the application
  schema were available. This does not establish readiness of a remote deployment.
- The full deterministic suite passed: 125 passed, 0 failed, 2 live cases skipped
  out of 127 cases. Both live opt-ins were explicitly disabled.
- Existing tests cover owner isolation, encrypted credentials, durable processing,
  recovery, atomic content activation, old-version availability, admission limits,
  and controlled Telegram flows.
- A saved store evaluation reported 10/10 manually reviewed results, with a median
  HTTP latency of about 3 seconds and a maximum of about 9 seconds. Those ten
  questions were used during tuning, ran sequentially, and predate some current
  behavior. They do not establish current quality, moderation accuracy, or capacity.
  Local artifacts are under `logs/store-eval-2026-10-23T20-08-15.404Z/` and are
  ignored by Git; they may be unavailable in another checkout.
- No new paid provider calls, real Telegram smoke checks, or remote deployment
  checks were performed during the readiness analysis.

## Before inviting owners

### 1. Verify current answer quality and moderation

- [ ] Prepare 20–30 new questions using representative documents from prospective
  pilot owners. Keep these separate from the existing tuning questions.
- [ ] Write expected facts and supporting passages before running the questions.
  For unsupported questions, specify acceptable refusal or redirection behavior.
- [ ] Include direct facts, paraphrases, exceptions, calculations, missing facts,
  conflicting evidence, greetings, related complaints, and ambiguous follow-ups.
- [ ] Include prompt injection in questions and source text, plus bot instructions
  that conflict with source-evidence or moderation rules.
- [ ] Check Russian and English behavior, including configured response language.
- [ ] Evaluate off-topic labels separately from factual correctness. Related
  complaints, missing information, and ambiguous follow-ups must not trigger abuse
  penalties. Check escalation through the customer flow as well as owner tests;
  owner tests intentionally do not apply visitor penalties.
- [ ] Record settings revision, content version, selected evidence, outcome, factual
  support, latency, and defects. Avoid committing private documents or credentials.
- [ ] Resolve material unsupported claims and incorrect visitor restrictions, then
  rerun affected cases. Preserve any remaining limitations in the pilot notes.

Completion evidence: a dated review of the current implementation on new questions,
with unresolved issues explicitly accepted or fixed before invitation. Valid JSON
and valid citation IDs alone are not evidence of factual support.

### 2. Verify the full path in real Telegram

- [ ] Use a fresh owner account: start, select a language, open the secure key form,
  connect a key, upload a document, and receive the ready notification.
- [ ] Test the base, create a managed bot, and ask it a question from another account.
- [ ] Check the Mini App and bot-creation controls on the clients pilot owners use.
- [ ] Publish answer settings, test the resulting behavior, and restore a previous
  settings version.
- [ ] Replace content and verify old answers during processing, followed by answers
  from the new version once activation completes.
- [ ] Verify pause/resume, missing or invalid credentials, quota messages, and
  recovery from stale or deleted navigation panels.
- [ ] Confirm owners understand who pays for indexing, validation, and answers.

Completion evidence: the actual owner-to-visitor flow succeeds; client-specific
failures and assistance needed are recorded. Controlled transports do not replace
this check.

### 3. Establish availability and recovery

- [ ] Choose a continuously available host and a stable public HTTPS address for
  unattended pilot use. A temporary local tunnel is suitable only for a supervised
  session with clearly agreed availability.
- [ ] Configure automatic process restart and verify migrations on the target.
  Keep the current single-instance worker constraint.
- [ ] Back up PostgreSQL and preserve the encryption master key separately and
  securely. A database backup alone cannot recover encrypted credentials.
- [ ] Verify restoration in an isolated environment and verify graceful/forced
  restart recovery without changing live webhook destinations accidentally.
- [ ] Verify target webhook reachability and recovery after an application restart.
- [ ] Name the person responsible for availability and provide a support contact
  and a way to pause the pilot.

Completion evidence: a documented deployment, backup location without secrets,
successful restore/restart checks, and an identified operator.

### 4. Measure simultaneous Telegram use

The Telegram worker currently awaits each update before processing the next update
and draining outgoing messages. A slow model request can delay other bots, manager
menus, and delivery. The query deadline does not bound time already spent queued.
See [the worker loop](../../src/telegram/worker.ts).

- [ ] Agree on acceptable end-to-end reply and menu response times for the pilot.
- [ ] Measure several simultaneous visitors across multiple bots, including a
  deliberately slow provider request and a run during document ingestion.
- [ ] Measure from message arrival to delivery, including queue wait; do not report
  model processing time alone as user-visible latency.
- [ ] Confirm queues drain after the burst and no accepted work remains stuck.
- [ ] If delays prevent useful testing, separate AI execution from manager handling
  and delivery with bounded concurrency while preserving ordering, owner isolation,
  quotas, and durable recovery. Reuse existing contract tests for these invariants.

Completion evidence: recorded timings and a supported pilot traffic envelope, or
the necessary queue-processing fix before invitations.

### 5. Make pilot failures diagnosable

The current `/health` endpoint checks database connectivity only. It does not prove
that workers are progressing, webhooks work, or answers are being delivered.

- [x] Provide an initial read-only aggregate snapshot with `npm run pilot:status`:
  worker-lock presence, pending/due/deferred updates and deliveries, retries,
  current due age, and ingestion failures. Implemented on 2026-10-25.
- [ ] Add or establish an operator check for worker progress, pending update/outbox
  counts, oldest queued work, and failed ingestion.
- [ ] Capture sanitized error codes and processing timings with correlation IDs
  sufficient to investigate a reported failure.
- [ ] Distinguish provider errors, timeouts, capacity rejection, and delivery errors
  without recording credentials, source documents, or ordinary message contents.
- [ ] Verify that an operator can detect stopped processing even when `/health`
  continues to return a successful response.

Completion evidence: a deliberate failure is visible and can be investigated.
A full analytics platform or external tracing integration is unnecessary here.

The initial snapshot does not complete this section. Worker locks do not establish
progress, and Telegram tables currently have no separate arrival timestamp:
`oldest_due_seconds` is based on the current retry eligibility timestamp, not
original queue age. Heartbeats/progress detection, correlation IDs, phase timings,
sanitized runtime error reporting, and a deliberate stalled-worker check remain
open. See [operator command details](../../README.md#pilot-operator-check).

## Pilot setup and expectations

- [ ] Select 2–3 owners and agree on their use cases, clients, documents, and testing
  window. Assist with API billing and key setup where needed.
- [ ] Set explicit customer and test quotas for each owner. Both default to no daily
  quota; request limits are not exact spending caps.
- [ ] Explain that conversation history is not supplied to the model. Questions
  should be self-contained; short follow-ups may lack enough context.
- [ ] Explain the single-file upload limit of 1 MiB, lack of OCR, and full-content
  replacement rather than append behavior.
- [ ] Explain that new bots created with a selected ready base currently start
  answering immediately. Decide whether an explicit first-publication step is
  needed; otherwise have owners verify the bot before sharing its link.
- [ ] Explain how documents, model requests, and Telegram messages are handled,
  including that owner-test details explicitly opened in Telegram remain messages
  there. Agree on suitable pilot materials and a deletion/support procedure.
- [ ] Provide a feedback route. Ask for the failed action or question, expected
  result, approximate time, and bot identity; collect content only with permission.

## During the pilot

- [ ] Track completed onboarding, time to first useful answer, and assistance needed.
- [ ] Review incorrect answers, unexpected refusals, false abuse restrictions,
  delays, delivery failures, and owner confusion.
- [ ] Prioritize issues that block the main flow or undermine trust before adding
  features. Record fixes and verify affected behavior.
- [ ] Pause affected bots or invitations for cross-owner disclosure, credential
  exposure, repeated material unsupported claims, or unrecoverable processing.
- [ ] Review results after the agreed testing window and decide whether to expand,
  repeat the pilot, or resolve specific blockers first.

## Deferred unless pilot evidence changes the priority

- Full analytics dashboards, Langfuse, and large-scale batch evaluation tooling.
- OCR, multi-document management, and conversation memory.
- Multiple application replicas and general high-throughput scaling.
- A provider-funded demo mode. Revisit this if requiring an owner API key prevents
  the intended audience from reaching the first useful answer.

## Verification and progress log

Follow [the project testing policy](../../.agents/skills/say-ai-testing/SKILL.md)
when implementing changes. Run focused checks during iteration; executable changes
need the required build and deterministic full-suite validation before integration.
Live checks require authorization for their paid/external effects.

Recorded deterministic command:

```sh
RUN_LIVE_QUERY_TEST=false RUN_LIVE_EMBEDDING_TEST=false node --env-file-if-exists=.env --import tsx --test tests/*.test.mjs
```

For each completed checklist section, add the date, implementation revision,
environment, evidence location, result, and unresolved limitations below. Do not
mark planned or historical checks as newly completed.

| Date | Check | Result and evidence | Remaining limitations |
| --- | --- | --- | --- |
| 2026-10-24 | Local build, DB check, deterministic suite | Build and DB check passed; 125 passed, 0 failed, 2 skipped | Real Telegram, current semantic quality, concurrency, and remote deployment remain unverified |
| 2026-10-25 | Initial operator snapshot, `scripts/pilot-status.mjs` | Three focused checks passed in a disposable DB; local `npm run pilot:status` succeeded; build passed; final full suite: 139 passed, 0 failed, 3 live cases skipped (142 total) | Lock presence is not progress; due age is not arrival age; runtime error/timing diagnostics and live checks remain open |

The 2026-10-25 full-suite runs initially exposed a pre-existing clock-dependent
Telegram assertion: the database clock was about 48 ms ahead of Node, making a
strict six-hour upper bound fail. Commit `319a6c4` compares the remaining interval
using the database clock. All 38 Telegram cases passed after that test-only fix,
followed by the successful full run above. No application moderation behavior was
changed. The operator snapshot made no external calls or database writes.
