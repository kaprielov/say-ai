# Say AI testing strategy and local skill plan

Status: milestone 1 approved and implemented; milestones 2 and 3 remain proposed.
Date: 2026-10-24.

## Goal and assessment limits

Increase confidence per test and reduce unnecessary authoring and execution work.
Do not target a lower test count, a prescribed unit/integration ratio, or a coverage percentage.
This audit inspected all test inventories, representative implementations, local TDD references,
project instructions, and local evaluation reports. It is not a complete assertion-by-assertion audit.
Test-first development history, defect detection rate, full-suite runtime, and flakiness are unmeasured.

## Findings

- There are 122 top-level tests across 10 files: ingestion 18, queries 19, replacement 11,
  API 14, Telegram 36, owner keys 11, database 6, documents 1, server limits 3, launcher 3.
  Two are opt-in live-provider tests. Test helpers included, tests occupy 2,718 lines;
  application TypeScript occupies 2,998 lines. These counts do not establish waste or quality.
- The strongest coverage protects ownership, transaction rollback, version isolation,
  durable queues, retries, cancellation, capacity, and credential handling. Preserve these risks.
- Pure chunking/provider tests in `tests/ingestion.test.mjs`, context tests in
  `tests/queries.test.mjs`, and typing/encryption tests in `tests/telegram.test.mjs`
  execute under file-level database setup. Focused selection still incurs the hooks.
- `tests/telegram.test.mjs:402` reads bases and bots created by earlier tests;
  the navigation test at line 654 uses user 40 created at line 624, and later
  restriction tests use bot 400 from that setup. Static evidence shows order coupling;
  isolated failures have not been reproduced in this planning session.
- Some assertions pin presentation choices: exact welcome text, five/four keyboard rows,
  and relative help-text lengths. These are review candidates, not automatic deletions.
  Keep assertions for language routing, actionable controls, return routes, and protocol limits.
- Database assertions are often appropriate: persisted state, no unauthorized writes,
  uniqueness constraints, and transactional activation are actual application contracts.
  Do not replace real PostgreSQL/pgvector with in-memory SQL or mock query strings.
- Existing local `scripts/evaluate-store.mjs` and its source fixture are ignored by Git.
  It has ten realistic cases and saved manually reviewed reports. Historical runs report
  9/10, 7/10, and 10/10; these are tuning observations, not current generalization estimates.
  The final report explicitly identifies the need for held-out questions.
  The script still expects `insufficient_context` for its missing-information case;
  current application behavior can instead redirect when supported topics are available.
  Existing evaluation work should be preserved and reconciled, not recreated blindly.
- No `.github` workflow or aggregate `npm test` script exists in this checkout.
  This establishes a repository gap, not the absence of every possible external CI system.

## Skills assessed

- `/Users/antonkaprielov/.claude/skills/tdd/SKILL.md` and its five reference files:
  useful behavioral tests, vertical red/green increments, and boundary doubles.
  Overbroad rules: rejecting direct database observations; treating integration style
  as universally preferable; requiring user confirmation of routine test choices.
  Missing: project risk priorities, test selection, independence, stopping rules, and RAG evals.
  This skill exists in Claude's directory and is not listed as active in this Codex session;
  its causal influence on the current suite cannot be established.
- `.agents/skills/say-ai-manager-ux/SKILL.md:33`: already appropriately distinguishes
  navigation/session changes from copy-only changes. Preserve this guidance and reference
  one project test-selection policy rather than duplicating it.
- `.agents/skills/plan/SKILL.md`: planning and approval workflow, not a test-quality policy.
- Upstream Superpowers TDD and verification skills were read as comparisons only.
  Do not import blanket test-first/deletion rules or interpret verification as a reason
  to rerun every suite after every small change. Fresh evidence should match the claim.

## Recommended local policy

Create `.agents/skills/say-ai-testing/SKILL.md`, with a compact
`references/test-map.md` if the command matrix would obscure the core rules.
Use original project-specific instructions, borrowing approaches rather than adding dependencies.
Add a brief routing instruction to `AGENTS.md`; avoid two competing local TDD policies.
Leave the global Claude skill unchanged.

### Explicit project routing

Do not rely on local skills shadowing global skills with the same name. Official
Codex documentation states that same-name skills are not merged and both can
appear in selectors. Use the unique name `say-ai-testing` and add this explicit
instruction to repository `AGENTS.md` during milestone 1:

```text
For implementation, bug fixes, refactoring, and test reviews in this repository,
read and follow .agents/skills/say-ai-testing/SKILL.md before choosing or adding
tests. Use this project policy instead of generic TDD/testing skill guidance.
```

Keep AGENTS.md limited to a short routing link and the preference for project
guidance; detailed testing rules belong in the skill. Verify discovery and the actual file
read when trying representative prompts in a new chat; a uniquely named skill
and routing instruction improve reliability but are not a mechanical execution
guarantee. Explicitly mentioning the local skill provides an additional option.
Source: [Codex skill discovery and invocation](https://developers.openai.com/codex/skills).

1. Before adding a test, identify the observable regression and whether an existing test
   can cover it. Prefer extending a suitable case over adding a duplicate.
2. Use red/green for new executable behavior and bug fixes. A failure must be caused by
   the missing behavior, not broken setup. For existing behavior-preserving refactors,
   run existing meaningful tests; add coverage only for an identified gap.
3. Do not require new automated tests for documentation, wording, formatting, or trivial
   wiring already exercised by an existing test. Review both supported translations.
   Wording that changes behavior or critical instructions is not automatically exempt.
4. Use the cheapest credible boundary: pure functions without a database; real PostgreSQL
   for SQL/transactions/locks; service/API flows for wiring; controlled Telegram/OpenAI
   transports for deterministic contracts. Call counts are appropriate when they prove
   paid-call suppression, deduplication, retry budgets, or cancellation behavior.
5. Keep one coherent behavior per case, allowing multiple assertions and boundary tables.
   Each test owns its fixtures and must pass alone. Restore mutated transports and clocks.
6. Pin wording/layout only where it is an explicit product contract. Prefer actions,
   state transitions, locale selection, and Telegram byte limits to arbitrary row counts.
7. Select affected suites during iteration; run the deterministic full suite once before
   integration or after changes spanning shared boundaries. Repeat only after relevant
   edits, failures, or unresolved concerns. Report exactly what ran and what remains unverified.
8. Keep semantic RAG quality separate from schema/citation validation. Prompt, retrieval,
   chunking, model, and moderation changes require relevant quality evaluation evidence.
   Paid/live checks stay explicit and outside default deterministic runs.
9. No mandatory test count, exhaustive Cartesian products, universal coverage gate,
   snapshot proliferation, or mutation-testing dependency in the initial rollout.

## Implementation milestones

### 1. Local policy only — completed

- Create the skill and test map, add the routing line, and link the manager UX validation
  paragraph to the shared policy without changing its product guidance.
- Document current commands and cross-module impact: credentials affect owner-key and
  Telegram flows; retrieval affects queries and replacement; ingestion affects ingestion,
  replacement, and relevant upload flows; shared HTTP/schema changes need broader checks.
- Review the instructions against copy-only edits, a pure chunking fix, owner isolation,
  queue recovery, and prompt changes. This is a manual policy review, not application tests.
- Acceptance: each scenario selects credible checks, avoids redundant tests, and gives
  accurate verification claims. No application or test behavior changes in this milestone.

Implemented the uniquely named `say-ai-testing` skill, its current test map,
concise AGENTS.md routing, and the manager UX policy link.
Application code, tests, dependencies, and the global Claude TDD skill are unchanged.
Automatic discovery in a new chat remains a manual follow-up; file validation
cannot prove skill selection by the host or future model behavior.

### 2. Measured test organization improvement

- First capture full deterministic results and per-file duration on the existing local
  PostgreSQL. Confirm target isolation before any database writes; `database.test.mjs`
  currently uses DATABASE_URL directly with rolled-back fixtures.
- Separate existing pure tests from DB-backed files, sharing only useful setup helpers.
  Retain domain-focused files; avoid one file per function or a wholesale test rewrite.
- Make the identified Telegram cases self-contained, then examine owner-key scenarios
  for similar shared-state dependencies. Remove presentation assertions only where
  their protected contract is absent or already checked more meaningfully.
- Add documented aggregate fast/integration/default commands. Keep live opt-ins separate
  and ensure default execution cannot make paid requests through inherited live flags.
- Acceptance: fast checks work without DATABASE_URL or PostgreSQL; migrated DB tests
  pass together and selected Telegram tests pass alone. Record before/after runtime
  with concurrency held constant; do not promise a speedup before measurement.

### 3. Reproducible RAG evaluation

- Reuse the ignored ten-case evaluator, reconcile outcomes with current behavior, and
  prepare English repository artifacts consistent with AGENTS.md. Preserve Russian
  language evaluation inputs only through an agreed localization/fixture convention.
- Keep tuning cases and a separate held-out set. Start with the existing implementation
  plan's 20-question goal and add greeting, missing evidence, conflicting evidence,
  prompt injection, and false off-topic cases where they expose distinct risks.
- Score evidence retrieval, factual support, unsupported-claim handling, and moderation
  separately. Record code/source/model/prompt identity and timing limitations.
- Preserve manual semantic review; use deterministic assertions for objective properties.
  Do not add an LLM judge or new framework until a measured need justifies it.
- Acceptance: another checkout can run the documented evaluation with explicit credentials,
  output evidence, and review rubric. Agree numerical targets after a baseline; one
  ten-question run is not a reliability or load estimate. Add a small real Telegram
  smoke checklist for onboarding, binding, answering, and panel recovery.

## Validation

Completed during planning:

- `node_modules/.bin/tsc --noEmit`: exit 0.
- `node --import tsx --test tests/documents.test.mjs tests/server-limits.test.mjs tests/dev-public.test.mjs`:
  seven passed, zero failed, approximately 1.18 seconds on Node 22.13.0.
- No DB-writing or paid/live evaluation commands were run in this planning session.

Milestone 1 validation:

- `uv run --with pyyaml python /Users/antonkaprielov/.codex/skills/.system/skill-creator/scripts/quick_validate.py .agents/skills/say-ai-testing`:
  passed. The validator's YAML dependency ran in an isolated uv environment;
  no project dependency was added.
- Local Markdown targets and explicit npm command references were checked against
  the filesystem and `package.json`; all resolved. `git diff --check` passed.
- Manual policy walkthrough (not an independent agent or live activation test):

  | Scenario | Decision produced by the policy |
  | --- | --- |
  | Change manager wording only | Review meaning and both translations; no new wording test or application suite |
  | Fix Unicode chunk boundaries | Relevant failing chunking case, then ingestion checks; current file still requires DB hooks; semantic evaluation if quality changes |
  | Fix owner isolation | Real DB-backed unauthorized/authorized flow and relevant API/Telegram suites; verify no forbidden state changes |
  | Fix queue recovery | Real persisted queue, failure/restart behavior, cleanup, and relevant worker suite; full deterministic validation before integration |
  | Change answering prompt | Controlled adapter contracts plus relevant semantic cases; report a quality gap if live evaluation is outside authorization |

- New-chat discovery and actual activation have not been exercised. The unique
  skill name, explicit repository routing, and direct file access are in place;
  host discovery and future adherence are not guaranteed by static validation.
- No application tests were rerun for this policy-only milestone.

After milestone 2, proposed aggregate commands should execute all existing deterministic
tests with the two live cases disabled, and isolated selections should work, for example:

```sh
node --env-file-if-exists=.env --import tsx --test --test-name-pattern='knowledge base and bot cards' tests/telegram.test.mjs
node --env-file-if-exists=.env --import tsx --test --test-name-pattern='callback navigation edits' tests/telegram.test.mjs
```

Expected: each selected case passes with its own fixtures and cleanup. Commands and paths
must be updated if the relevant cases move. Do not infer full-suite success from these checks.

## Alternatives, risks, and recovery

- Global generic TDD unchanged: lowest setup cost, but misses repository-specific risks
  and retains inappropriate blanket rules. Recommended only as background guidance.
- Local skill alone: small and reversible; improves future decisions but cannot repair
  existing order coupling or make ignored evaluations reproducible. Recommended first step.
- Full framework/coverage/mutation rollout now: higher migration cost without a measured
  bottleneck. Consider targeted mutation experiments later if assertion sensitivity is uncertain.
- Keep the existing regression suite while reorganizing. Split policy, test organization,
  and evaluator changes into reviewable commits so each can be reverted independently.
- Milestone 1 was approved and implemented; milestones 2 and 3 remain proposed follow-up
  scopes until explicitly included in implementation authorization.

## Research sources

- [Google: Change-detector tests considered harmful](https://testing.googleblog.com/2015/01/testing-on-toilet-change-detector-tests.html):
  implementation mirroring can create maintenance work without useful behavioral checks.
- [Ham Vocke: Practical Test Pyramid](https://martinfowler.com/articles/practical-test-pyramid.html):
  choose granularity pragmatically, test real integration boundaries, avoid duplicate high-level checks.
- [Node 22.13 test runner](https://nodejs.org/download/release/v22.13.0/docs/api/test.html):
  use the actual supported runtime's filtering, hooks, reporters, and coverage capabilities.
- [OpenAI evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices):
  representative datasets, separate criteria, and repeatable comparisons for nondeterministic behavior.
- [Superpowers TDD](https://github.com/obra/superpowers/blob/main/skills/test-driven-development/SKILL.md)
  and [verification](https://github.com/obra/superpowers/blob/main/skills/verification-before-completion/SKILL.md):
  alternative agent workflow, not installed or activated for this audit.
