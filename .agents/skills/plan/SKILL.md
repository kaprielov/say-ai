---
name: plan
description: Research existing solutions, open-source projects, and established practices for a complex project task, then develop and refine an implementation plan with the user before coding. Use only when explicitly invoked; not for routine edits or simple questions.
---

# Research and plan

Turn a complex task into a researched, reviewable plan. This skill applies to
the explicitly requested task, not to every subsequent task in the chat.
Match the user's conversation language; write repository artifacts in English.

## Understand the task

Read the relevant repository instructions, code, tests, and documentation.
Establish the desired behavior, constraints, existing capabilities, and likely
integration points. Ask early if missing information would materially change
the research direction; otherwise investigate with stated assumptions.

Stay in planning: read-only inspection and research are allowed, as is writing
or updating the task's plan document. Do not change application code,
configuration, dependencies, or external systems during this workflow.

## Research before proposing a solution

Search the web for existing solutions, relevant open-source projects, and
established practices. Prefer original project repositories, official
documentation, and firsthand developer accounts over summaries and listicles.
Open and inspect the sources that support the recommendation.

Check how candidate solutions fit this repository and its requirements.
Where relevant, assess licensing, maintenance, compatibility, dependencies,
operational cost, and limitations. Distinguish adopting a dependency from
borrowing an approach. Consider reusing the project's existing capabilities.

Compare credible alternatives when there is a meaningful choice, including
evidence against the preferred approach. Explain why the recommendation fits;
do not present popularity or an author's experience as universal proof.
Link supporting sources, distinguish findings from assumptions, and identify
remaining uncertainty. If browsing is unavailable, disclose the research gap
instead of presenting remembered information as verified current guidance.

## Draft a concrete plan

Present a concise research summary and an implementation plan grounded in the
actual codebase. Include the information needed to review the decision:

- Goal and observable acceptance criteria.
- Scope and exclusions, including affected files or components.
- Recommended approach, important tradeoffs, and supporting references.
- Ordered implementation steps or independently verifiable milestones.
- Validation commands or manual checks and the expected results.
- Material risks, assumptions, and unresolved decisions; recovery steps where needed.

Keep detail proportional to complexity. Avoid generic steps and speculative
abstractions. For work spanning multiple milestones or sessions, save an
editable plan in `docs/plans/<descriptive-task-name>.md`, following any existing
repository convention instead when present. Keep sources, decisions, open
questions, and progress together; do not create a separate research report by default.

## Refine with the user

Invite the user to review the plan, clarify decisions, and add requirements.
Make questions specific and explain meaningful alternatives. Recommend a
default when there is enough evidence; do not invent questions just to create
an approval step.

Incorporate feedback into the same plan. Research new requirements when they
change the approach, and make material revisions visible. Corrections, answers
to questions, and additional requirements are not approval to implement.

When the plan is ready, explicitly ask for approval and wait. Do not start
implementation unless the user explicitly approves or instructs you to execute
the presented plan. After approval, follow the agreed scope and validation;
seek approval again only when discoveries materially change scope, approach,
or risk. Update a saved plan as work proceeds.
