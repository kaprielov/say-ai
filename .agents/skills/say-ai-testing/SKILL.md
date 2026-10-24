---
name: say-ai-testing
description: Choose, write, and review tests for Say AI implementation, bug fixes, and refactoring, including PostgreSQL, Telegram, and RAG behavior. Use for test strategy and validation decisions in this repository; not for unrelated projects.
---

# Say AI testing

Protect meaningful behavior with the smallest credible checks. This is the
project's testing policy; prefer it over generic TDD guidance. Follow the user's
explicit scope and authorization. Routine test selection does not need approval.

## Decide what needs evidence

- Identify the observable regression or invariant before adding a test. Reuse or
  extend existing coverage when it protects the same risk; add a separate case
  when the behavior or setup is meaningfully different.
- Prioritize owner isolation, credential handling, atomic activation, active-version
  availability, durable processing, paid-call suppression, and capacity recovery.
  Preserve these checks when reorganizing tests.
- For new executable behavior and bug fixes, write a focused failing test, confirm
  that it fails for the intended behavior, implement the change, and verify it.
  A missing database, broken import, or invalid fixture is not evidence of a regression.
- For behavior-preserving refactors, run meaningful existing tests; add a test only
  for an identified gap. Do not manufacture a failing test for unchanged behavior.
- Documentation, formatting, copy-only edits, and trivial wiring already exercised
  by existing tests do not need new automated tests. Review localization and all
  supported translations. Changes to actions, critical instructions, validation,
  prompts, or moderation semantics need the corresponding behavioral evidence.

## Choose the boundary

- Test chunking, context selection, and other pure logic directly without database
  setup when possible. Do not introduce abstractions solely to mock internal calls.
- Use real PostgreSQL/pgvector for constraints, transactions, locks, ownership-scoped
  retrieval, and persisted queues. Direct SQL setup and assertions are appropriate
  for persistence contracts; avoid asserting incidental schema or SQL spelling.
- Exercise service/API flows for routing, authentication, durable state transitions,
  and integration between modules. Do not repeat every low-level boundary case there.
- Control Telegram and OpenAI transports at their external boundaries. Keep relevant
  application logic real. Call counts/order are useful when proving no paid call,
  no duplicate delivery, bounded retries, or correct cancellation; avoid internal
  orchestration assertions that merely mirror the implementation.

## Keep cases useful and independent

- Cover one coherent behavior per case. Multiple assertions and small boundary
  tables are appropriate; avoid exhaustive combinations without a distinct risk.
- Each new or edited test must own its prerequisites rather than depend on another
  test's execution. Restore changed transports/clocks and clean up resources.
  Existing order coupling is documented in the test map; do not assume it is fixed.
- Assert outcomes, state transitions, owner boundaries, actionable controls, locale
  selection, and protocol limits. Pin exact wording or layout only for an explicit
  product contract. Do not delete a check solely because it uses SQL or several assertions.
- Do not set a mandatory test count, unit/integration ratio, or coverage gate.
  Add frameworks, snapshots, or mutation tooling only for a demonstrated need.

## Select checks and stop

Read [the test map](references/test-map.md) when selecting commands and affected
suites. It describes current commands and their limitations, not a future layout.

During iteration, run the relevant case or suite. Before integrating executable
changes, run the deterministic full suite once; shared HTTP/schema/runtime changes
also need broad checks. Repeat passing checks only after relevant edits, failures,
or unresolved concerns. Policy/documentation-only changes need content/link review
and skill validation, not an application suite. Run `npm run build` for application
TypeScript changes; compilation does not prove runtime behavior.

Report commands, outcomes, skips, and material gaps. A selected suite proves only
its scope. Do not claim a test-first cycle, full-suite pass, or quality improvement
without corresponding evidence.

## Treat RAG quality separately

Schema-valid output and valid citation IDs do not prove factual support. For changes
to prompts, models, chunking, retrieval, or topic classification, use relevant
semantic evaluation cases as well as deterministic contract tests. Inspect the
existing evaluator and its expectations before running it. Preserve tuning cases
and use held-out questions to assess generalization; record evidence and limitations.

Live checks require explicit authorization for the paid/external effects and stay
outside default deterministic runs. If they cannot run within the authorized scope,
report the quality gap; do not substitute canned provider answers as semantic proof.
