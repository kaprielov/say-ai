# Bot-owner answer settings and single-question testing

Status: first slice approved on 2026-10-24; implemented and validated.
Branch: `codex/bot-owner-settings` in an isolated worktree.

## Approved scope

The user explicitly narrowed this work to the Say AI interface for bot owners and
approved implementation. Provide bot-specific answer settings, a separate draft,
publication and rollback, and single-question testing with context and request
inspection. Use existing Telegram panels; a Mini App is not needed for this slice.

Langfuse, platform-engineering observability, production history, analytics dashboards,
saved question sets, batch comparisons, automated judges, model selection, and full
replacement of the platform prompt are deferred. There is no new external integration.

## Implemented behavior

- Bot-local instructions (4000 characters), answer-detail and language presets, and
  balanced/focused/expanded context profiles. Defaults preserve the existing pipeline.
- Bot-row JSON stores a separate draft, published revision, and the last 20 published
  revisions. Every mutation uses an optimistic version token. Publication is atomic
  and leaves the bot's enabled state intact. Rollback preserves unfinished drafts.
- Production uses the bot's captured published configuration. Default HTTP and
  knowledge-base tests keep their existing behavior. Knowledge-base selection changes
  invalidate stale edit/test controls. Owner transfer resets all answer settings.
- The bot card exposes Answer settings and Test bot. Test either a draft or published
  version through the production query service, charged to the separate test quota,
  without visitor penalties or customer delivery.
- Successful tests expose selected chunk IDs/text, captured content version, settings
  revision, elapsed time, and the exact assembled generation request without headers.
  Details are paginated and scoped to the owner's current bot-testing session.
- Only the latest test details are retained, cleared on leaving testing, expired after
  24 hours, and removed by bounded background cleanup. Opened details are also ordinary
  private Telegram messages; local cleanup does not delete those messages.
- Failed tests clear the old snapshot and show a sanitized error code with navigation.
  Full failed-query context and provider token/cost breakdowns are deferred.
- Russian and English panels, input guidance, validation, and help are updated together.

## Components

- `src/bots/settings.ts`: validation, owner isolation, compare-and-swap writes,
  publication, history retention, and rollback.
- `migrations/1793059200000_bot_answer_settings.mjs`: bot state and manager-session
  fields; migration down removes the newly stored settings/details.
- `src/queries/{answerer,context,service}.ts`: request construction, profile selection,
  captured configuration, and opt-in owner-test diagnostics.
- `src/telegram/{service,worker,i18n,manager-ui,guide}.ts`: navigation, draft editing,
  tests, cleanup, localization, and help.
- `tests/bot-settings.test.mjs`, `tests/queries.test.mjs`, and
  `tests/telegram.test.mjs`: new behavioral evidence and preserved existing coverage.

## Validation and acceptance

Use the project testing policy and real disposable PostgreSQL databases for ownership,
publication, race handling, and migration behavior. Control provider and Telegram
transports for deterministic tests. Preserve existing moderation, cancellation,
capacity, and owner-key checks.

Focused checks passed after implementation:

```sh
npm run build
RUN_LIVE_QUERY_TEST=false RUN_LIVE_EMBEDDING_TEST=false node --env-file-if-exists=.env --import tsx --test tests/bot-settings.test.mjs tests/telegram.test.mjs tests/queries.test.mjs
```

Final validation passed:

- `npm run build`.
- Full deterministic suite with both live flags false: 125 passed, 2 opt-in live cases
  skipped, no failures (127 cases). It used the original checkout's local `.env` via
  an explicit `--env-file` path because worktrees do not copy ignored credentials.
- The focused bot-owner scenario also passed after adding explicit discard confirmation.
- Migration up on an existing bot, down, and re-up passed in a disposable database.
- `git diff --check` passed. Both language variants and callback byte limits were checked.

These checks establish their specific contracts, not model quality or real Telegram
rendering. The running application's schema and process were not changed.

## Quality and manual-check limits

No paid model calls or real Telegram sends have been authorized or performed for
this implementation. Existing local store-evaluation cases remain untouched. Defaults
are preserved, but custom instructions and retrieval profiles require paid semantic
review before claiming answer-quality improvements. Relevant review cases: supported
facts, missing information, greetings, contradictory evidence, abusive related
complaints, context injection, instructions that conflict with evidence rules, and
language/detail preferences. Review factual support separately from schema/citations.

Controlled tests establish contracts and routing, not semantic grounding or actual
Telegram rendering. The first release has no automatic quality gate on publication.
The diagnostics display similarity-selected evidence, not calibrated confidence.

## Rollout and recovery

Apply the new migration before starting the branch. Existing bots start with defaults.
Test an owner's draft before publishing. Roll back a bot with Restore previous version;
this does not revert knowledge-base content. Keep the additive schema when reverting
application code during initial rollout. Only use migration down when intentional
loss of newly stored settings and test details is acceptable.

## Research retained for future work

The original research found Langfuse suitable for internal engineering tracing and
experiments, with hosting and data-policy decisions still required. That work is
explicitly outside this implementation. Primary references:

- https://langfuse.com/docs/observability/overview
- https://langfuse.com/docs/observability/sdk/overview
- https://langfuse.com/docs/evaluation/experiments/datasets
- https://langfuse.com/self-hosting
