# Prompt-injection defenses

Status update (2026-10-24): additional model classification and evidence review are
**disabled in normal application/provider wiring** at the user's request. Runtime
uses one generation call plus the existing query embedding. Fixed platform rules,
lower-trust owner preferences, citation validation, and deterministic link checks
remain active. Topic classification is again part of the generation response; only
validated off-topic redirections can drive moderation. Independent semantic checking
is deferred in [the specialized verification plan](../plans/specialized-answer-verification.md).

The sections describing separate classifier/reviewer requests below document the
retained experimental implementation, not the active production configuration.
It can be exercised through explicit dependency injection in tests; it is not
automatically enabled by account keys, bot settings, or an environment flag.

## Scope and trust boundaries

The answering pipeline treats visitor questions, retrieved documents, generated
answers, and free-form owner preferences as lower-trust content. Bot ownership,
knowledge-base/version scoping, quotas, and delivery permissions remain server-side.
The model has no tools, SQL access, or credential-bearing prompt fields. These
capability limits reduce impact; they do not establish answer correctness.

The generator's platform `instructions` are fixed. Owner preferences are serialized
under `bot_preferences` in the user-data envelope beside the question and context.
Only validated language/detail/retrieval profile values are accepted from settings.
Free-form instructions remain limited to presentation and audience. They cannot
change the server's output schema or select the security checker's instructions.
Separating roles and data reduces exposure; it is not an absolute model-level boundary.

## Experimental query sequence (disabled by default)

1. Capture the owned active knowledge-base version and effective bot revision.
2. Embed the question, retrieve/select bounded context, and decline empty retrieval.
3. Classify the question using a dedicated request containing only the question and
   selected evidence. It receives neither owner preferences nor the generator's reply.
4. Generate a candidate answer. Ignore its proposed topic when an independent checker is explicitly enabled.
5. Validate outcome, answer shape, and exact membership of cited chunk IDs. Withhold
   a factual answer to a question independently classified as off-topic.
6. Check recognized URLs, bare domain links, and email addresses against the cited
   evidence. Host, path, query, and fragment changes are not approved merely because
   the domain matches. Unexpected schemes and embedded credentials are blocked.
7. Review nonempty candidate answers against the cited evidence in an independent,
   fixed-prompt request. It receives no owner preferences or generator-proposed topic.
   Review redirections against their suggested subjects, not as factual answers to
   an unsupported original question.
8. Deliver only a candidate that passes these gates. A link-policy failure or negative
   review returns `insufficient_context` with no answer or sources. Checker/provider
   failure returns a sanitized error rather than silently bypassing validation.

A valid citation ID remains a format check, not proof of factual support. The
separate evidence reviewer adds a probabilistic check; it is not a proof system.

## Experimental independent moderation (deferred)

Only the independent classifier's `off_topic` label is exposed to the Telegram
moderation path. It applies even when a candidate factual answer was withheld.
The generator's topic field is ignored in this experimental mode. Greetings,
related complaints, missing information, and ambiguous follow-ups should not count
as off-topic; the fixed classifier instructions explicitly describe those cases.
Provider errors and aborted queries do not issue a moderation decision. Existing
visitor quotas, warning thresholds, and pause rules remain unchanged. Owner tests
never apply visitor penalties.

## Operational costs and diagnostics

When explicitly configured for an experiment, a successful question makes three model requests: classification,
generation, and evidence review, plus the existing query embedding. The two safety
requests have 64-output-token limits; generation retains its 768-token limit. Early
exits can omit later stages. All stages share the existing 30-second deadline,
cancellation signal, query admission, and outstanding-operation accounting. They
run sequentially to preserve the downstream capacity bound. There are no automatic
provider retries. Every request uses the same resolved owner key and `store: false`.

Owner-initiated test summaries show the classifier label and evidence-review state,
including link-policy blocks. The existing full-request view shows the generator's
request; it is not a transcript of all three model calls. Session retention and
owner access checks are unchanged. No production content history or external
observability integration was added.

## Evidence and limitations

Deterministic checks use controlled provider transports. They cover instruction/data
separation, strict verdict parsing, citation laundering when the reviewer rejects,
independent moderation labels, unapproved links, fail-closed errors, owner-key
routing, cancellation, and retained capacity. They do not measure actual resistance
to adversarial model inputs or establish lower false-positive rates.

`tests/fixtures/query-safety-cases.json` adds an opt-in synthetic semantic smoke set:
benign factual answers, greetings, missing information, legitimate contact details,
direct citation laundering, document injection, owner-preference injection, and
moderation evasion. Benign cases require useful answers so universal refusal cannot
pass the set. The set is English-only and small; Russian, repeated/adaptive attacks,
conflicting evidence, prompt extraction, and real business cases need broader review.
Preserve the existing local store evaluator and its historical results separately.

Run the paid smoke set only with explicit authorization and a confirmed local test
database role that can create disposable databases:

```sh
RUN_LIVE_QUERY_TEST=true node --env-file=.env --import tsx --test --test-name-pattern='live prompt-injection defenses' tests/queries.test.mjs
```

This creates temporary test data and performs multiple billable model/embedding
calls. It does not send Telegram messages. The implementation session did not run it.

Residual risks include correlated failure of the generator and reviewer (currently
the same model family), injection into the classifier's untrusted evidence, reviewer
false approvals/refusals, source poisoning, and unrecognized or socially described
link formats. A URL found in cited evidence is not necessarily a safe destination;
this policy checks provenance, not reputation. Information placed in retrievable
bot documents should not be considered secret from that bot's visitors. No universal
prompt-injection prevention or measured success rate is claimed.

## Historical validation before runtime disabling (2026-10-24)

- `npm run build` passed.
- The full deterministic suite with `RUN_LIVE_QUERY_TEST=false` and
  `RUN_LIVE_EMBEDDING_TEST=false` passed: 135 cases passed, 3 paid opt-in cases skipped.
- Focused checks exercised both classifier/reviewer timeouts, fail-closed missing
  configuration, owner-key routing, and withheld-answer moderation without penalizing
  manager tests.
- `git diff --check` passed; the development health endpoint returned HTTP 200.
- No paid semantic or real Telegram-message checks were performed. Controlled
  transports verify application behavior, not the robustness of the actual model.
