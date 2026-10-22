# RAG API: system design notes

Status: MVP requirements, API draft, data flows, recovery policy, query limits, proposed architecture, and initial evaluation approach recorded. Technology choices and some implementation details remain open.

Updated: 22 October 2026.

### Current implementation

The API now uses Node.js, TypeScript, Express, and PostgreSQL with pgvector. It supports API-key authentication, owner-scoped knowledge-base creation/status, and background ingestion within one application instance. The remaining sections preserve the design discussion; suggestions below are not all implemented.

Ingestion uses OpenAI `text-embedding-3-small` with 1536 dimensions by default, configurable for future versions. It chunks with `cl100k_base` into up to 512 tokens with up to 64 tokens of overlap, embeds sequential batches of 16, and stores model/dimensions/configuration with each attempt version. Activation and task completion commit atomically. An exclusive database advisory lock protects startup recovery and enforces a single ingestion worker. Partial failed versions are deleted; successful versions are retained.

Transient ingestion failures allow three persisted attempts total, separated by 10 seconds and 60 seconds. Interrupted attempts count toward that total; permanent provider errors fail immediately. Each provider request is bounded by 30 seconds and each attempt by ten minutes. These are implementation defaults, not evidence that the one-hour freshness target has been met. Real workload quality, freshness, and query latency remain to be evaluated. The query and content-replacement endpoints are not implemented yet.

## 1. Context and scope

Build a RAG service with an API that developers can use to create chatbots without implementing the retrieval and generation infrastructure themselves. Use this project to practise system design while building the service.

The MVP serves one developer. Every knowledge base still has an owner, and API access is checked against that owner.

Developers operate their own bots and call this API. Telegram is the initial integration use case; operating Telegram bots is outside the service's responsibilities. Non-technical chatbot users interact with the developer's bot rather than directly with this API.

## 2. Functional requirements

### Confirmed behavior

1. The developer can create a knowledge base and submit plain-text content.
2. The developer can submit a question against a selected knowledge base and receive an answer based on its content.
3. Answers are returned as complete responses, without streaming.
4. If the knowledge base contains insufficient information to answer a question, the service declines to answer.
5. Access to a knowledge base is checked against its owner.
6. Submitting updated content replaces the complete content of that knowledge base rather than appending to it.
7. While replacement content is processing, questions use the previous ready version if one exists. If no ready version exists, querying returns an error.
8. Reject another content replacement for the same knowledge base while an ingestion task is pending or processing.

### Processing status

- The API draft includes checking processing status. The exact status fields and whether they use a separate endpoint remain under review.

### Feature still under consideration

- The original draft requested a choice of LLM models. Whether the MVP supports multiple models, and how the developer selects one, remains undecided.

## 3. Scale and non-functional requirements

| Area | Agreed target or assumption |
| --- | --- |
| Knowledge bases | 20 |
| Content volume | 100 pages per knowledge base |
| Query concurrency | Up to 3 questions being processed at once globally, across all knowledge bases; reject additional requests immediately with `429 Too Many Requests` |
| Answer latency | Maximum 10 seconds; no streaming |
| Ingestion freshness | Submitted text becomes available for questions within a maximum of 1 hour |

Plain text has no fixed page size. The page estimate must be translated into bytes or tokens if a later capacity decision requires it.

The agreed 10-second deadline covers the full query, including embedding, retrieval, and generation. On timeout, return an explicit error, attempt to cancel the model call, and do not automatically retry within that request. The exact timeout HTTP code and response body remain open. Cancellation may not stop provider-side execution or charges.

Declining unsupported questions is required behavior. Start with manual answer-quality evaluation using a repeatable question set (section 12). Numerical quality and latency success-rate targets remain open.

## 4. Additional goals and implementation preferences

These came from the initial requirements draft and remain relevant, but they are not yet fully specified:

- **Context efficiency:** construct a prompt containing general rules, relevant knowledge-base context, and the user's question while avoiding unnecessary context. Context budgets and quality criteria remain undefined.
- **Advance ingestion:** prepare the knowledge base before question requests. Generating embeddings in advance was the original implementation idea; the user-facing target is the ingestion freshness requirement above.
- **Observability:** provide analytics comparable to Langfuse. Required traces, metrics, retention, and tooling have not been selected.
- **Reuse:** evaluate existing solutions such as LlamaIndex. This is an implementation preference, not a committed framework choice.

## 5. Out of scope

- User interface.
- Billing.
- Hosting or operating messenger bots.
- Queues and external queue infrastructure. The chosen MVP approach uses database task records and background processing within the same application.

## 6. Core entities: provisional discussion

This step identifies the main concepts needed by the system. It does not finalize database tables, storage technology, or every field.

| Concept | Current position |
| --- | --- |
| `KnowledgeBase` | Clearly a core entity: an owned collection of content used to answer questions. Vector storage is an implementation detail, rather than its complete definition. |
| `KnowledgeBaseStatus` | Proposed as state on the knowledge base rather than an independent entity. Status values and transitions have not been finalized. |
| `AugmentedPrompt` | The combination of rules, retrieved context, and a user question. Proposed as data assembled during a request; independent persistence is not required by current requirements. |
| Owner identity | Ownership and access checks are required. The identity may be represented by a developer or account; a separate `Owner` entity has not been agreed. |
| `Document` | An optional suggestion for giving each plain-text submission its own identity. It has not been adopted as a core entity. Its usefulness depends on how submissions are managed. |
| `IngestionTask` | Follows from the developer's chosen processing approach: a persistent record of ingestion work and its status, used for background execution and startup recovery. Exact fields remain to be designed. |

`Owner` and `Document` were suggestions derived during this project's discussion. They are not a prescribed Hello Interview pattern.

The provisional entity list now includes `KnowledgeBase` and `IngestionTask`. Refine it as API design and data flow reveal additional needs.

## 7. Open decisions

These can be resolved as the design develops; they do not all need to block the first API draft.

- What delay or backoff should separate ingestion attempts? The three-attempt limit is agreed.
- How are retries made safe after partially stored results or interrupted version activation? Restarting ingestion from the beginning is agreed; cleanup and atomic activation mechanisms still need implementation design.
- Which backend framework, database deployment, embedding model, and answering model should be selected? Section 11 records recommendations, not confirmed choices.
- Does the MVP need knowledge-base deletion?
- Does the MVP support multiple LLM models?
- What exact response bodies represent insufficient evidence, an unready knowledge base, a timeout, or excess concurrent requests? Timeout HTTP status remains open; concurrent-query rejection uses `429` and overlapping replacement rejection uses `409`.
- Are questions and answers persisted, or retained only through observability traces?
- What answer-quality, latency reliability, and availability targets are appropriate?

## 8. API draft

### Agreed behavior

- Developers create knowledge bases with plain-text content, inspect their status, and submit questions.
- Content replacement replaces all content under the existing knowledge-base identity.
- Queries use the previous ready version while replacement content is being processed. Queries fail if no ready version exists.
- Access is authenticated and checked against ownership.
- Developers poll knowledge-base metadata for readiness. Replacement requests are rejected while ingestion is pending or processing for that knowledge base.

### Proposed endpoint contract

The names, HTTP codes, and response fields below are review suggestions, not a fully agreed contract. They revise the developer's original `/knowledge-base` and `/query` draft.

| Method and path | Purpose | Proposed success response |
| --- | --- | --- |
| `POST /knowledge-bases` | Create a knowledge base from `{ "text": "..." }` | `201 Created` with its ID and initial processing status |
| `GET /knowledge-bases/{id}` | Read metadata and processing status | `200 OK` with its ID, processing status, and query availability |
| `PUT /knowledge-bases/{id}/content` | Submit `{ "text": "..." }` to replace all content asynchronously | `202 Accepted` with processing status |
| `POST /knowledge-bases/{id}/queries` | Submit `{ "question": "..." }` | `200 OK` with an answer or an explicit insufficient-context outcome |

The developer originally proposed a separate `GET /knowledge-base/{id}/status` endpoint. Including status in the knowledge-base metadata response was suggested as a simpler alternative; either shape remains possible.

The server assembles the augmented prompt from rules, retrieved context, and the question. Accepting a question instead of a fully assembled prompt is a proposed revision to the original API draft.

### Processing status and query availability

These need to be represented separately: replacement content can be processing while a previous version remains queryable. A proposed metadata response is:

```json
{
  "id": "kb_123",
  "status": "processing",
  "queryable": true
}
```

Here, `status` describes the latest content submission; `queryable` indicates whether a ready version exists. Proposed states are `pending`, `processing`, `ready`, and `failed`. These names are not finalized.

If no ready version exists, a proposed query response is `409 Conflict`:

```json
{
  "error": {
    "code": "knowledge_base_not_ready",
    "message": "No ready version is available for queries."
  }
}
```

Insufficient evidence is different from an unready knowledge base. The former is an expected refusal outcome after querying usable content; the latter prevents the query from being processed.

Keeping the previous ready version available implies building replacement content separately and switching the active version only after successful processing. The mechanism, failure handling, version cleanup, and treatment of in-flight queries belong to the later design.

### Replacement already in progress

Reject a replacement with `409 Conflict` when the same knowledge base already has pending or processing ingestion work. The behavior and HTTP status are agreed; the proposed error code `ingestion_in_progress` and response body remain suggestions.

The check and creation of the new task must prevent two simultaneous requests from both being accepted. The database mechanism remains to be designed.

### Query concurrency and timeout behavior

- Enforce a global limit of three concurrent questions across all knowledge bases, not three per knowledge base.
- Reject an additional question immediately with `429 Too Many Requests`; do not place it in a waiting queue. The developer's bot handles rejection and may retry later.
- Enforce a 10-second deadline over the query work, including embedding, retrieval, and generation.
- On timeout, return an explicit timeout error and attempt cancellation. Do not automatically retry within the request.
- Release the request's concurrency slot on completion, failure, or timeout. Track any provider calls still running after cancellation separately so abandoned work does not silently accumulate.
- For one application instance, a shared in-memory counter was proposed. Multiple instances would need coordinated enforcement; the mechanism is not yet selected.

## 9. Ingestion data flow

### Chosen execution approach

The developer selected the following approach:

1. Save the task and its status in the database before returning `202 Accepted` for a replacement submission.
2. Process the task in the background within the same application.
3. On application startup, find unfinished tasks and retry them.
4. Reject additional replacements for the same knowledge base while work is pending or processing.

### Working sequence

1. Authenticate the caller, check knowledge-base ownership, and validate the submitted plain text.
2. Reject the request if this knowledge base already has pending or processing ingestion work.
3. Durably save the replacement text and a pending ingestion task before acknowledging acceptance. Exact persistence details remain to be designed.
4. Return `202 Accepted`; the developer can poll `GET /knowledge-bases/{id}` for progress.
5. Background processing claims the task and splits the text into chunks.
6. Generate an embedding for each chunk, retaining the association between each vector and the exact chunk text that produced it.
7. Store the chunks and vectors for the new version without exposing partially processed content to queries.
8. After successful processing, activate the new version and mark the task complete. Queries use the previous ready version until activation; if none exists, queries return an error.
9. On startup, recover unfinished tasks from the database.

Version identifiers and a switch of the active version are proposed mechanisms for preserving the previous ready content during replacement; their concrete implementation is not yet selected.

### Agreed recovery policy

- Restart interrupted or failed ingestion from the beginning rather than resuming at a particular chunk.
- Allow three attempts total: one initial attempt and up to two retries. Startup recovery must respect this persisted total rather than resetting it.
- After the third failed attempt, mark ingestion as `failed`, expose the failure through status, and stop automatic retries for that submission.
- Keep the previous ready version available throughout processing and after terminal failure. If no ready version exists, queries remain unavailable.

The trade-off is simpler recovery at the cost of repeated chunking and potentially repeated embedding charges.

### Proposed recovery sequence

1. Find unfinished ingestion after startup, or retry after a processing failure while the application remains running.
2. Check the persisted attempt count before starting another attempt.
3. Discard or isolate incomplete results from the failed attempt without removing the active ready version.
4. Reprocess the saved replacement text from the beginning.
5. Activate the replacement only after all required chunks and vectors are successfully stored.

### Recovery mechanisms still to design

- Retrying after partial progress must not create duplicate or mixed-version results.
- Recovery must account for a crash between activating a version and recording task completion.
- Choose retry delays, task-claiming rules, and the exact persistence of attempt counts.
- Interrupted attempts must count toward the total. A crash during activation must not cause a completed active version to be deleted as though it were an incomplete attempt.

## 10. Query data flow

### Developer's draft

1. Validate the question.
2. Convert the question into a vector.
3. Find the top matches.
4. Send the complete prompt, containing general rules, retrieved chunks, and the question, to the LLM.
5. Receive the answer and return it to the caller.

### Review refinements

These apply existing requirements to the draft; the concrete mechanisms remain to be selected.

- Authenticate the caller and verify ownership before accessing knowledge-base content.
- Resolve a ready version for the request; return an error if none exists. Use one version throughout retrieval so replacement does not mix old and new content. Retention of versions used by in-flight queries remains to be designed.
- Embed the question using a model compatible with the embeddings stored for that version.
- Scope retrieval to the selected knowledge base and ready version. Top matches must return their associated chunk text for prompt construction.
- Select context within a token budget rather than blindly including every retrieved chunk. Retrieval count, selection strategy, and budget are not yet specified.
- Similarity search returns the nearest available matches even when they cannot answer the question. The system must still support declining for insufficient evidence. The evidence assessment and refusal mechanism are open design decisions.
- The developer proposed cosine similarity with a refusal threshold of `0.6`. A working interpretation is to filter retrieved chunks below the threshold and decline if none remain. This aggregation rule is a review suggestion; the numerical threshold is provisional and must be evaluated with the selected embedding model and representative questions. A high similarity score alone does not establish that a chunk contains the answer.
- Bound the full request, including embedding, retrieval, and generation, by the agreed 10-second deadline. Apply the global concurrency limit and timeout behavior in section 8; exact timeout error details remain open.

## 11. Proposed architecture and technology options

This is the starting architecture suggested in discussion. It is not a finalized technology selection.

```mermaid
flowchart LR
    Bot[Developer's bot] --> API[API application]
    API --> DB[(PostgreSQL + pgvector)]
    Processor[Background ingestion processor] --> DB
    Processor --> Embedding[Embedding API]
    API --> Embedding
    API --> LLM[LLM API]
    subgraph Application
        API
        Processor
    end
```

- **API application:** authenticates callers, validates inputs, checks ownership, accepts content, exposes status, and handles questions.
- **Background ingestion processor:** finds saved work, chunks text, generates embeddings, stores results, and activates completed versions. It initially runs within the same application.
- **Database:** stores knowledge-base metadata, ownership, source text, ingestion state, chunks, and vectors if pgvector is selected.
- **Embedding API:** converts chunks during ingestion and questions during retrieval into compatible vectors.
- **LLM API:** receives rules, retrieved text, and the question; produces an answer or an insufficient-context outcome.

### Recommendations discussed, not yet selected

| Area | Options and recommendation | Trade-off |
| --- | --- | --- |
| Backend | Express with TypeScript is sufficient for the MVP; NestJS offers established application conventions. FastAPI with Python was also compared. | Express requires choosing application structure; NestJS introduces additional framework concepts. Python may fit preferred RAG libraries, while TypeScript may fit developer familiarity. |
| Storage | PostgreSQL with pgvector is the proposed starting point. | One database simplifies operation and version switching, but ingestion, vector search, and metadata operations share resources. |
| Embeddings | `text-embedding-3-small` was recommended as an initial baseline. `text-embedding-3-large` and Voyage `voyage-4` were alternatives to evaluate. | Retrieval quality must be measured on representative content; changing to an incompatible embedding model requires re-embedding stored content. |
| Answering | `gpt-6-luna` was recommended as a hosted baseline, initially with reasoning disabled. `gpt-4.1-mini` and `gemini-3.5-flash-lite` were comparison candidates. | Provider documentation does not prove grounded-answer quality or compliance with this system's 10-second deadline. |

Model research was performed on 21 October 2026. Availability and pricing should be checked when implementing. No model calls or workload benchmarks were performed during that research. Store embedding model and dimensions with a knowledge-base version; keep answering-model selection independent of embedding selection.

References used for technology comparisons and model research:

- [Express](https://expressjs.com/) and [NestJS](https://docs.nestjs.com/).
- [FastAPI features](https://fastapi.tiangolo.com/features/) and [background tasks](https://fastapi.tiangolo.com/tutorial/background-tasks/).
- [pgvector](https://github.com/pgvector/pgvector) and [PostgreSQL transactions](https://www.postgresql.org/docs/current/tutorial-transactions.html).
- [OpenAI embeddings](https://developers.openai.com/api/docs/guides/embeddings), [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna), and [GPT-4.1 Mini](https://developers.openai.com/api/docs/models/gpt-4.1-mini).
- [Voyage embeddings](https://docs.voyageai.com/docs/embeddings) and [Gemini pricing and model options](https://ai.google.dev/gemini-api/docs/pricing).

## 12. Initial evaluation and implementation approach

### Answer-quality evaluation

Begin with manual review of a small, repeatable set of questions and expected results from a representative knowledge base. A script may submit questions and record outputs; manual evaluation does not require manually making every API call.

A proposed initial set contains 20 questions:

- Eight questions clearly answered in the source text.
- Six answerable questions phrased differently from the source.
- Six questions whose answers are absent and should produce a refusal.

For each question, record the expected answer or refusal and supporting passages when present. Review retrieval and generation separately: did retrieved chunks contain the evidence, and did the answer use it correctly without adding unsupported claims? Record complete response time and evaluate with three concurrent requests. Repeat the set after changes to chunking, embeddings, prompts, or answering models. The exact sample counts are suggestions; measurable acceptance thresholds remain open.

Ownership, state transitions, retries, response formats, concurrency limits, and timeouts can be checked with automated tests independently of manual answer-quality evaluation.

### Implementation readiness

The current design is sufficient to begin an MVP once technology choices are settled. The suggested first implementation path is submitting text, processing it, checking readiness, and querying it for an answer or refusal. Then add and verify replacement versions, recovery, and concurrency/deadline enforcement before considering the agreed MVP behavior complete.

## 13. Learning framework and references

The project follows Hello Interview's broad progression:

1. Requirements — initial baseline recorded above.
2. Core entities — provisional discussion recorded above.
3. API or system interface — draft recorded above; under review.
4. Data flow — ingestion and query drafts recorded above.
5. High-level design — proposed components and connections recorded above; technology selection remains open.
6. Deep dives — ingestion recovery, overlapping replacements, query deadlines, concurrency, and initial quality evaluation discussed above.

References inspected during the discussion:

- [System Design Delivery Framework](https://www.hellointerview.com/learn/system-design/in-a-hurry/delivery): recommends a focused requirements list, provisional core entities, API design, and then architecture. Its core-entity example is `User`, `Tweet`, and `Follow`; it does not prescribe RAG entities.
- [System Design Requirements Gathering](https://www.hellointerview.com/blog/system-design-requirements): recommends clarifying scope, prioritizing requirements, considering scale, and making system qualities specific enough to guide design.

Project requirements come from the conversation. Proposed interpretations and unresolved decisions are labeled separately above.
