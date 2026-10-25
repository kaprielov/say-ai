# Per-bot tuning, testing, debugging, and analytics

Status: proposed; awaiting user review and explicit implementation approval.
Date: 2026-10-24.

## Goal

Give a bot owner an understandable iteration loop: edit a draft, test representative
questions, inspect evidence and failures, compare against the published configuration,
publish, and roll back. Make production failures diagnosable by bot and revision.

Planning only: application code, configuration, dependencies, and external systems
have not been changed. Existing unrelated working-tree edits are preserved.

## Repository findings

- `src/queries/answerer.ts` has a single hardcoded instruction block, model,
  reasoning setting, and output-token limit. The input is JSON containing question
  and context, with a strict structured-output schema.
- That instruction block combines evidence rules, tone, redirection, and topic
  classification. Off-topic classifications affect visitor enforcement in
  `src/telegram/service.ts`; prompt edits can therefore change moderation behavior.
- `src/queries/context.ts` fixes eight candidates, three seeds, a 3000-token context
  budget, and a 1000-token neighbor budget. `src/queries/service.ts` uses exact
  cosine ranking, does not select similarity scores, and has no similarity cutoff.
- `QuestionAnswering.ask` receives a knowledge-base ID and owner, without a bot
  configuration. It captures a ready content version for each request.
- The bot card offers knowledge-base selection, pause/publish, and spam protection.
  The existing answer test belongs to a knowledge base and does not simulate a
  particular bot's configuration.
- `telegram_usage` records owner-level daily quota reservations, including failures
  after reservation. It is not a per-bot quality, successful-answer, or cost ledger.
- There is no dedicated persisted query history. Telegram update/outbox payloads
  are transport state, not a stable diagnostic history.
- Provider response usage and model response metadata are currently discarded.
  Topic information except enforced off-topic is discarded after validation.
- `src/providers/owner-openai.ts` resolves encrypted owner credentials and checks
  access to the fixed answering model. Model selection would also require changing
  this validation/routing contract.
- `scripts/evaluate-store.mjs` exists locally but is ignored by Git. It makes paid
  calls and creates a persistent knowledge base. Preserve its useful cases, translate
  repository fixtures to English, and reconcile its old unsupported-question
  expectation with current redirection behavior. Do not execute it implicitly.
- `implementation-plan.md` milestone 5 already identifies evaluation and phase
  timings. This proposal extends those goals to the current Telegram product.

## Recommended product scope

### Configuration belonging to a bot

Keep knowledge ingestion/versioning on the knowledge base. Store answering behavior
and retrieval selection on the bot so two bots sharing a base can behave differently.
Keep account credentials and account quotas at owner scope and spam protection in
its current group. Knowledge-base tests continue to use an explicit default profile.

First release controls:

1. Bot role, audience, subject scope, and additional answering instructions.
2. Tone, preferred answer detail, and response-language policy, with useful presets.
3. Missing-information behavior: ask a clarification, suggest supported topics, or
   offer a configured contact route. Contact details must be explicitly configured;
   their provenance is distinct from retrieved knowledge-base evidence.
4. Examples of desired answers, bounded by prompt/token limits. Examples guide style
   and behavior; they are not an alternative source of business facts.
5. Advanced retrieval controls: candidate count, seed count, context-token budget,
   and neighbor expansion. Show current defaults, units, bounds, and reset.

Do not expose every provider parameter initially. Add model profiles after measuring
cost/quality and verifying provider capabilities and owner access. Do not offer a
generic temperature slider without confirming the selected model supports it.
Do not add a similarity cutoff until evaluation demonstrates a useful operating point.
Chunking and embedding changes require a new content version and reindexing; they
belong to a later knowledge-base workflow, not an immediate bot setting.

### Prompt editing contract

Provide editable bot instructions and an exact preview of the assembled request:
platform rules + bot instructions/presets + examples + question and selected context.
Keep question/context as structured data and preserve original citation IDs.
Avoid introducing an arbitrary executable template language.

Platform-controlled evidence rules, output schema, untrusted-data handling, citation
validation, and moderation invariants remain outside the editable section. Prompt
priority alone cannot guarantee model compliance; preserve runtime checks and run
semantic/adversarial evaluations. Prompt-only topic classification remains a risk.
Changes to scope or instructions must be checked against off-topic enforcement;
only confirmed off-topic outcomes should trigger the existing enforcement path.

Full replacement of the platform prompt is a separate expert-mode decision. It is
not included in the proposed first release. Fixed-context generation replay is
useful for isolating prompt effects but must be labeled separately from a full RAG test.

### Drafts, publication, and rollback

Use immutable published revisions and a separately editable draft. Capture the
effective revision and knowledge-base version once per run. Publishing changes an
active revision pointer atomically; it does not implicitly enable a paused bot.
Requests already running retain their captured configuration. Reject stale draft
writes/publishes using revision checks. Rollback selects a previous immutable revision.
Changing the bound knowledge base invalidates comparisons against the previous base.
Deleting/transferring a bot must not expose its former owner's drafts or traces.

### Manager experience

Proposed bot-card actions: Answer settings, Test bot, History and analytics, alongside
the existing base selection and protection controls. Show published/draft status.
Use Telegram panels for navigation, presets, quick tests, and summary statistics.
Recommend a small authenticated Telegram Mini App for long prompt editing, exact
request inspection, and side-by-side comparisons; confirm this interface scope before
implementation. Reuse `webapp-auth.ts` authentication patterns, never trust a bot ID
from the client, and preserve localized Russian and English UI text.

Test results should show answer, outcome, selected evidence, effective revision,
knowledge-base version, timing, usage, and validation failures. Offer a manual rating
and Save as test case. Compare published versus draft using the same questions and
captured content version. Full pipeline tests must use the same query service and
owner providers as production, with separate test quota accounting and no visitor
penalties or customer delivery. Clearly distinguish functional bot testing from a
later dedicated spam-protection simulation.

### Debugging and analytics

Record causal stages: admission, embedding, retrieval, context selection, generation,
answer validation, and delivery. Correlate async outbox delivery using the run ID;
generation success must not be reported as successful Telegram delivery.

Record owner/bot IDs, run/attempt ID, test/production mode, configuration revision,
platform prompt version, content version, selected chunk IDs, ranking scores,
selection reasons, phase timings, outcomes, and sanitized error categories. Similarity
scores indicate ranking, not calibrated answer confidence. Provider usage should
include input/output/cached/reasoning tokens where supplied and the returned model.
Costs are estimates based on a versioned rate source; unknown prices/usage remain
unknown. Include query-embedding cost as well as generation; report ingestion separately.

Preserve enough detail to distinguish missing knowledge, missed retrieval, generation
failure, contract rejection, capacity/quota rejection, and delivery failure. These are
observations or human labels, not infallible automated root-cause determinations.

Manager summaries: request volume, answered/redirected/insufficient outcomes, errors,
latency distribution, estimated spend, manual feedback, and reviewed unanswered topics.
Separate tests from production and show denominators, sample sizes, period/timezone,
and telemetry completeness. Outcomes and ratings do not establish factual correctness
or customer resolution. Topic grouping and judge-model scores are later optional
paid features, not default work on every customer request.

## Observability decision and researched alternatives

Recommend Langfuse as an optional internal engineering backend, with Say AI owning
tenant authorization, bot configuration, publication, and the manager experience.
Use Postgres for bounded manager run summaries, feedback, and configuration revisions;
export richer opted-in traces to Langfuse. Do not build a general trace explorer.
Keep configuration in one authoritative store rather than synchronizing two editable
prompt registries. Initially include local revision IDs in Langfuse trace metadata;
Langfuse prompt management can be reconsidered for shared platform prompts later.

| Option | Fit and tradeoff |
| --- | --- |
| Langfuse | Traces, usage/cost views, datasets, experiments, and prompt tools. Current JS/TS SDK uses OpenTelemetry and supports Node 22. Core is MIT with separately licensed enterprise directories. Good fit without adopting LangChain. |
| Phoenix | Credible OTel/OpenInference tracing and evaluation alternative with TypeScript support. Server currently uses ELv2, including a hosted/managed-service restriction; assess separately before exposing substantial Phoenix functionality to customers. Its internal-use fit remains credible. |
| LangSmith | Credible tracing/evaluation platform; self-hosting is an Enterprise add-on. No existing LangChain dependency or special integration advantage in this repository. |
| Postgres summaries only | Lowest added operational burden and enough for initial manager history. Building trace exploration and experiment tools ourselves would expand scope; retain this as a fallback, not the long-term tracing recommendation. |

Both Langfuse and Phoenix show current project/docs activity; this is not a support
or reliability guarantee. Pin compatible SDK/server versions at implementation time.

For a pilot, prefer Langfuse Cloud EU if the data policy permits it. The pricing page
currently lists Hobby with 50k units/month, 30-day access, and two users; Core starts
at $29/month with 100k units and $8/100k additional units. Units are not equivalent to
customer questions; measure actual trace volume before forecasting costs. Recheck
pricing before adoption. Judge-model and customer provider calls cost extra.

Self-hosting adds web/worker components, Postgres, ClickHouse, Redis/Valkey, and object
storage. Core licensing does not eliminate infrastructure, upgrades, backups, or
operational work. No deployment or new account is authorized by this plan.

Use explicit spans around existing fetch-based provider adapters rather than replacing
them with an SDK solely for auto-instrumentation. Current candidate packages are
`@langfuse/tracing`, `@langfuse/otel`, and `@opentelemetry/sdk-node`; add
`@langfuse/client` only when datasets/scores require it. Initialize tracing before
application imports as required by the chosen integration. Bound buffering/export
timeouts and shutdown work; export failure must not fail or delay customer answers.
Record dropped telemetry; do not imply best-effort traces are a billing ledger.

## Data and access policy

The current product does not maintain query history; content tracing is a deliberate
new storage/external-disclosure behavior. Default to content-free metadata, with
explicitly enabled bounded content capture for debugging and clear retention controls.
Do not promise exact historical prompts when content capture was disabled or expired.
Show the effective settings/version even when historical text is unavailable.

Redact credentials and transport headers before capture/export. Pseudonymize visitor
identifiers; never export webhook payloads wholesale. Masking cannot guarantee removal
of all personal data in free text. Decide access, retention, deletion, and export
policy before production content capture. Suggested initial retention: 30 days for
run summaries and a shorter configurable window for enabled debug content; align
external retention/deletion capabilities with the chosen plan or disable content export.
Do not issue shared Langfuse project credentials or shared-project trace links to bot
owners. Metadata filters are not tenant authorization. Keep Langfuse internal at first.

## Ordered implementation milestones

1. **Versioned per-bot runtime configuration.** Add a migration, owner-scoped config
   service, validated bounds/defaults, immutable revisions, atomic publication and
   rollback. Thread a captured bot configuration through `telegram/service.ts`,
   `queries/service.ts`, `queries/context.ts`, and `queries/answerer.ts`. Preserve
   default HTTP/knowledge-base query behavior and owner credential routing.
2. **Diagnostic foundation and optional Langfuse export.** Add run IDs, summary storage,
   provider usage, stage observations, ranking scores, content policy, and exporter
   initialization/shutdown in `index.ts`. Correlate `telegram/worker.ts` delivery.
   Verify disabled/unavailable telemetry leaves answer behavior intact.
3. **Owner-facing settings and single-question playground.** Extend `telegram/service.ts`,
   `manager-ui.ts`, `i18n.ts`, `guide.ts`, and session persistence. Add authenticated
   editor/detail routes in `app.ts` if the Mini App option is accepted. Implement
   draft/published tests, prompt preview, rating, reset, publish, and rollback.
4. **Saved cases and comparison runs.** Add owner/bot-scoped cases, expected facts and
   evidence, expected outcomes/topics, and a bounded durable batch runner. Snapshot
   both compared revisions and the content version, allow cancellation, reserve test
   quota per execution, and avoid automatic retries of uncertain paid calls. Show
   progress/cost information and per-case comparison. Integrate Langfuse experiments
   through APIs where helpful, preserving Say AI authorization and run ownership.
5. **Manager analytics.** Add period summaries and filters over owned run records,
   feedback and unresolved questions. Distinguish failed, blocked, dropped, and sampled
   records. Add semantic grouping/automatic judges only after a measured need and
   explicit cost controls. Revisit advanced model/retrieval profiles after baseline data.

Each milestone is reviewable independently. A useful first implementation slice is
milestones 1–3; datasets/comparison and analytics follow on the same identifiers.
Likely new components: bot-configuration service, query diagnostics, telemetry setup,
run-summary persistence, and later evaluation runner. Avoid a generic workflow framework.

## Acceptance and validation

- Two bots owned by one manager can use one base with different published instructions;
  another owner cannot inspect or alter either bot's drafts, history, cases, or runs.
- Draft edits have no production effect. Publishing/rollback is atomic, stale edits
  are rejected, and in-flight runs retain their original revision and content version.
- Test bot uses the selected bot revision through the production answering pipeline,
  consumes test quota, and cannot penalize or message a customer.
- Preview matches the actual assembled request. Context/citation IDs and supported
  output contracts remain valid. Unsupported questions are not treated as off-topic
  solely because evidence is absent; scoped instructions do not silently alter penalties.
- Enabled traces expose each stage and actual usage where available. Timeouts,
  provider failures, contract failures, and delivery failures remain distinguishable.
- Disabled/export-failed telemetry preserves deadlines, capacity recovery, and answers.
  No credential appears in saved previews, diagnostic errors, or exported data.
- Comparison runs share a captured content version, record costs and partial results,
  and cannot publish drafts automatically. Reports separate semantic review from schema checks.
- Both English and Russian interfaces provide clear units, defaults, errors, state,
  Back navigation, and target identity. Real Telegram rendering requires a manual check.

Follow `.agents/skills/say-ai-testing/SKILL.md`. Add focused cases for the above
new risks; reuse current coverage for unchanged behavior. Use real PostgreSQL for
ownership, constraints, snapshots, and publication races; controlled external
transports for deterministic tests. Candidate checks by milestone:

```sh
npm run build
npm run test:db
npm run test:queries
npm run test:replacement
npm run test:telegram
npm run test:owner-keys
npm run test:api
RUN_LIVE_QUERY_TEST=false RUN_LIVE_EMBEDDING_TEST=false node --env-file-if-exists=.env --import tsx --test tests/*.test.mjs
```

Choose focused commands during iteration; run the full deterministic suite once before
integration with live flags explicitly false and a confirmed disposable database.
For quality changes, preserve useful store tuning cases and add held-out answerable,
unsupported, conflicting-evidence, greeting, follow-up, and injection cases. Review
retrieval support and factual claims separately from citation/schema validity.
Paid semantic evaluations, experiment calls, and real Telegram checks need explicit
authorization. No application tests or paid checks were run for this planning document.

Rollback disables optional telemetry and selects the prior bot revision; retain
revision tables during initial rollout. Revert schema only after accounting for
new stored data. Start existing bots on a revision equivalent to current defaults.

## Decisions to refine before implementation

- Confirm first slice: versioned settings, diagnostics, and single-question bot testing.
- Confirm Telegram panels plus an authenticated Mini App for long editing/comparison,
  or accept a smaller Telegram-only first release.
- Confirm Langfuse Cloud EU versus self-hosting and allowed diagnostic content/retention.
- Confirm editable instructions with a fixed platform contract versus a broader expert
  prompt mode. The latter requires separate moderation/grounding evaluation and scope.
- Exact model choices, numerical quality gates, and cost limits remain unset until
  representative baseline measurements and provider compatibility checks exist.

## Primary research references

Checked 2026-10-24; product capabilities/prices may change.

- [Langfuse tracing](https://langfuse.com/docs/observability/overview)
- [Langfuse JS/TS SDK and runtime requirements](https://langfuse.com/docs/observability/sdk/overview)
- [Langfuse prompt management](https://langfuse.com/docs/prompt-management/overview)
- [Langfuse datasets](https://langfuse.com/docs/evaluation/experiments/datasets)
- [Langfuse experiments via SDK](https://langfuse.com/docs/evaluation/experiments/experiments-via-sdk)
- [Langfuse usage and cost tracking](https://langfuse.com/docs/observability/features/token-and-cost-tracking)
- [Langfuse masking](https://langfuse.com/docs/observability/features/masking)
- [Langfuse hosting architecture](https://langfuse.com/self-hosting)
- [Langfuse pricing](https://langfuse.com/pricing)
- [Langfuse repository and license boundaries](https://github.com/langfuse/langfuse)
- [Langfuse license](https://raw.githubusercontent.com/langfuse/langfuse/main/LICENSE)
- [Phoenix capabilities and TypeScript/OTel support](https://arize.com/docs/phoenix)
- [Phoenix license](https://raw.githubusercontent.com/Arize-ai/phoenix/main/LICENSE)
- [LangSmith self-hosting](https://docs.langchain.com/langsmith/self-hosted)
