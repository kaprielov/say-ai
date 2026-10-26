# Current Say AI test map

Run commands from the repository root. Check `package.json` and nearby tests if
the layout has changed. Choose the row matching the changed behavior, then expand
for shared dependencies. This matrix is a starting point, not an instruction to
run every listed suite for every edit in a directory.

| Changed behavior | Relevant commands and evidence |
| --- | --- |
| HTTP auth, request/upload validation, creation/status | `npm run test:api`; add `test:queries` or `test:replacement` for those routes |
| Parsing, document capacity, cancellation | `npm run test:documents`; affected upload cases in `test:api` and `test:replacement` |
| Chunking, embedding adapter, ingestion, restart recovery | `npm run test:ingestion`; add `test:replacement` for activation/old-version availability and relevant upload flows for extraction changes |
| Context, retrieval, answering contracts, query deadlines | `npm run test:queries`; add `test:replacement` for captured-version behavior; semantic eval for quality changes |
| Replacement, version switching, query availability | `npm run test:replacement`; add affected ingestion/query cases |
| Manager navigation, callbacks, sessions, outbox, Telegram quotas | `npm run test:telegram`; review both languages and relevant manager UX behavior |
| Owner credentials, Mini App authentication, provider routing | `npm run test:owner-keys` and relevant `test:telegram` cases; include ingestion/queries when shared provider behavior changes |
| Database constraints or migrations | `npm run test:db` plus affected DB-backed suites; verify migrations on a disposable database |
| HTTP admission or webhook concurrency/address resolution | `npm run test:server-limits`; add Telegram/API cases when their wiring changes |
| Public development launcher | `npm run test:dev-public` |
| Pilot operator snapshot and progress | `node --env-file-if-exists=.env --test tests/pilot-status.test.mjs`; disposable PostgreSQL checks for aggregate backlog, lock/session matching, stale progress, migration rollback, read-only collection, and sanitized CLI failure; worker wiring also needs `test:ingestion` and `test:telegram` |
| Copy, documentation, formatting only | Review meaning, links, localization, and supported translations; no new wording-only tests |

## Current environment limitations

- Documents, server-limits, dev-public, and query-safety test files currently run without a
  database. Ingestion, queries, Telegram, and owner-key files mix pure checks with
  file-level database hooks. Filtering by name does not remove those hooks.
- Most DB-backed suites create and migrate random temporary databases through
  `DATABASE_URL`; the role needs database creation permission. `test:db` instead
  uses the configured database directly and rolls back its fixtures. Confirm the
  target is a local disposable test database before executing database-writing checks.
  Do not expose connection strings in output or migrate an unrelated database.
- Some existing Telegram tests depend on earlier cases: cards/help uses previously
  created owner bases/bots; navigation uses user 40; later restrictions use bot 400.
  Use the whole Telegram file until affected fixtures are made self-contained.
  A filtered setup failure is not a valid TDD red result.
- `npm test` runs every `tests/*.test.mjs` file after database prerequisites are met.
  It forces `RUN_LIVE_QUERY_TEST`, `RUN_LIVE_EMBEDDING_TEST`, and
  `RUN_LIVE_IMAGE_TEST` to `false`, overriding shell and `.env` opt-ins.
  CI runs the same command against a fresh migrated PostgreSQL/pgvector service.
  Expect all opt-in live cases to be skipped. Check the exit status and actual
  summary; the command is guidance, not evidence that the current suite passes.
  For focused runs, explicitly disable the relevant live flags as well. Do not run
  broad checks for copy/policy-only changes.

## RAG and real Telegram evidence

`scripts/evaluate-store.mjs`, its store fixture, and reports in `logs/store-eval-*`
exist locally but are ignored by Git. The script creates a persistent knowledge
base and makes paid calls. It is not a default test command or available in every
checkout. Inspect its source, target, and current outcome expectations before use.

The ten store questions were used during tuning. Saved results include manual
review, but are historical observations, not proof of current quality. The old
missing-information expectation may need reconciliation with supported-topic
redirections. Review factual support separately from retrieval and topic labels.
See `implementation-plan.md` milestone 5 for the broader evaluation goal.

Controlled Telegram transports verify application decisions, not real client
rendering or external API acceptance. For affected flows, include an authorized
manual smoke check of onboarding, binding, answering, or panel recovery as needed;
report when real Telegram behavior was not checked.
