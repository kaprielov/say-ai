# Specialized answer verification and independent moderation

Status: deferred by user decision on 2026-10-24. Do not enable additional model
calls in ordinary answers at this stage. The initial three-call implementation was
not acceptable for the product's current latency/cost budget.

## Current decision

- Keep one generation request per ordinary question, plus the existing query embedding.
- Keep fixed platform instructions, owner preferences in the lower-trust input
  envelope, citation-ID validation, and deterministic link provenance checks.
- Classify topic in the same generation response and only count validated off-topic
  redirections. This retains the earlier limitation: generation and moderation labels
  are not independently verified.
- Do not label an unchecked answer as having passed semantic review. Owner-test
  diagnostics explicitly show that extra model review is disabled.
- Keep the experimental checker adapter and its focused contracts available for
  future evaluation, without wiring it into default application or owner providers.

## Future candidate

The user suggested a model like **JEV**. This is recorded as a candidate name, not a
verified model recommendation. Confirm the exact project/model/provider before
researching capabilities, licensing, availability, or deployment requirements. No
model has been selected, downloaded, connected, or evaluated.

## Future work

1. Compare specialized grounding/injection checkers and a minimal topic classifier
   with the current single-call baseline. Consider checking only selected risky
   requests or an asynchronous quality sample where appropriate. Asynchronous checks
   can support analytics but cannot block a response already sent.
2. Define acceptable per-question cost, additional latency, and degradation policy.
   Measure them rather than replacing two calls with an unmeasured generic judge.
3. Preserve the separation between question classification and owner-customized
   generation. Do not pass owner instructions or generator-proposed topic labels to
   an independent classifier.
4. Evaluate benign usefulness, false topic penalties, unsupported factual claims,
   malicious links, direct/question injection, document poisoning, owner-preference
   injection, and prompt extraction. Include Russian and English business scenarios.
5. Reuse `tests/fixtures/query-safety-cases.json` as an initial synthetic smoke set,
   together with the existing local store evaluator. Add held-out cases and repeated
   attacks; passing the small smoke set does not establish security or general quality.
6. Only integrate a selected model after an explicit follow-up implementation decision.
   Cover provider isolation, failure behavior, cancellation, capacity, and paid-call
   suppression. If checks are later enabled, do not silently bypass them on failure.

## Notes

The retained `OpenAIAnswerSafety` adapter is an experimental reference, not the
preferred future provider. Its current model requests are intentionally absent from
`src/index.ts` and `OwnerOpenAI.providers`. Explicitly injected checker tests still
exercise the future-enabled path. The normal-mode regression checks assert one
Responses call and no classifier/reviewer request using owner credentials.

This task does not claim semantic grounding guarantees. A genuine citation ID and
an approved evidence link can accompany a false statement; specialized verification
remains a future layer, not a property of the active deterministic checks.

## Validation of the current single-call mode

On 2026-10-24, `npm run build` and the full deterministic suite passed with both
live opt-ins false: 136 passed, 3 paid checks skipped. Owner-provider transport
checks assert exactly one Responses request and no classifier/reviewer request.
Separate checks preserve unknown-link blocking and legacy validated-redirection
moderation. No paid semantic evaluation was run during the disabling change.
