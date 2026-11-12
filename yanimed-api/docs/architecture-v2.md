# YaniMed System Design & Architecture — Revision 2



---

## Page 1

YANIMED / SYSTEM ARCHITECTURE
Revision 2 • Mock Test module
Proposed design blueprint; verify against the repository before coding.
Page 1
YaniMed
System Design & Architecture –
Revision 2
AI-powered PDF-grounded medical reviewer with integrated Mock Test module
DOCUMENT STATUS
SCOPE
Revision 2 of the proposed blueprint. Supersedes v1. Still a
design: implementation requires repository verification (milestone
M1).
Shared Subjects and PDFs, ingestion and retrieval, question
generation and validation, Mock Test exam flow, security,
database constraints, operations, testing and delivery phases.
Deployment assumption
YaniMed is treated as single-user and localhost-run. v2 sizes controls for that (one in-process worker, no per-user quotas)
but keeps userId on every owned row so going multi-user needs no schema change. Items that change if you host it
publicly are tagged [PUBLIC]. Confirm this in M0.
Design principles
• One shared Subject entity across Subjects and Mock Test; no duplicate subject table, no duplicate PDF objects.
• Only uploaded and successfully processed PDFs ground medical answers and exam questions. No web fallback.
• Exactly 50 validated questions per playable attempt. Partial sets are never published.
• Constraints before code paths. Every rule that can be a database constraint is one. Application logic is the second
line of defense, not the first.
• No model output is trusted. It is checked structurally, against the source text, and by an independent verifier pass.
• Durable jobs: state lives in Postgres, never only in a request, a tab, or process memory.
• Smallest safe v1. Offline sync and explicit session takeover are deferred; everything else ships tested.
• Preserve existing features: additive migrations, feature flag, per-milestone regression.
What changed from v1
#
Gap in v1
Fix in v2
Section
1
Validation was named but not defined
Layered validation: deterministic rules, independent verifier, citation
quote match, embedding duplicate check, full-set check
6
2
No coverage strategy
Per-subject topic list, slot planning, per-topic cap, balanced answer
positions
6
3
Undefined numbers ("sufficient",
"bounded")
Concrete defaults for every limit, kept in config
App. A
4
Queue technology undecided
Postgres job table with row-lock claim; in-process worker; boot
recovery
1, 6, 10
5
Content changing mid-flight
Document snapshot per job, versioned chunks, embedding model tags
4, 6
6
Stuck states
ABANDONED + Discard, watchdog, partial unique indexes
5, 7
7
Retry semantics ambiguous
Per-subject question bank; Retry samples unseen questions first
2, 8
8
Reports went nowhere
Report lifecycle with automatic quarantine
8
9
No cost or abuse controls
Job caps, daily AI budget, circuit breaker, call log
10
10
Upload and lifecycle hygiene
Limits, magic-byte checks, OCR cap, reconciliation, backups,
disclaimer
4, 10
11
No traceability or AI testing
Provenance on every question, golden set, structured output only
5, 11


---

## Page 2

YANIMED / SYSTEM ARCHITECTURE
Revision 2 • Mock Test module
Proposed design blueprint; verify against the repository before coding.
Page 2
#
Gap in v1
Fix in v2
Section
12
Offline sync and takeover risk
Deferred to v1.1; online-only autosave, latest session wins
7, 13
13
Plan front-loaded the safe work
M0 decisions, M2 generation spike, tests per milestone, feature flag
12
1. Executive architecture
YaniMed is a PDF-grounded study application. Users organize reviewer PDFs by subject, ask citation-backed questions,
and take subject-specific mock tests. The web client talks to a NestJS backend that owns authorization, persistence,
retrieval, generation, validation and grading. Long-running generation runs in a worker module that is driven by a job table
in Postgres, so no HTTP request or browser tab is ever the execution context.
Next.js Web App
Subjects | Mock Test | Chat
TanStack Query
NestJS REST API
Auth | rules | job control
exam-safe DTOs
Supabase Postgres
Prisma + pgvector
subjects, documents
chunks (versioned)
question bank
attempts, answers, results
generation_jobs (queue)
ai_call_log
Generation Worker
in-process Nest module
claims jobs (SKIP LOCKED)
Cloudflare R2
PDF originals (immutable)
signed URLs only
AI via OmniRoute
drafter | verifier | embeddings
enqueue
read
signed URL
Proposed logical architecture – exact integrations require repository verification
Core technology decisions
Layer
Planned technology / responsibility
Client
Next.js, TypeScript, Tailwind CSS, shadcn/ui; TanStack Query and Zustand as appropriate.
API
NestJS, whitelisted and validated DTOs, REST, stable machine-readable error codes (section 9).
Job runner
Worker module inside the NestJS process. Claims rows from generation_jobs with SELECT ... FOR
UPDATE SKIP LOCKED. No Redis, no new infrastructure. [PUBLIC] run the same module as a separate
process or service.
Database
Supabase PostgreSQL, Prisma, pgvector. Partial unique indexes, CHECK constraints and triggers are added
as reviewed raw SQL inside Prisma migrations, because the Prisma schema cannot express them.
File storage
Cloudflare R2 for original PDFs. Objects are immutable once written. Access only through short-lived signed
URLs issued after an ownership check.
PDF ingestion
Text extraction by physical page; OCR for pages with inadequate text; per-document timeout and OCR cap;
versioned index swap.
AI
Gemini embeddings (model id and dimension stored on every chunk). OmniRoute for drafting and verification,
with the verifier on a different model or combo when the gateway offers one.
Observability
Structured logs carrying jobId and attemptId, an ai_call_log table, and a health endpoint for the Mock Test
subsystem.
2. Phase 0 decision log
These were open in v1 and every later phase depends on them. Each row is a proposed default; confirm or change it in
milestone M0, before schema work starts.


---

## Page 3

YANIMED / SYSTEM ARCHITECTURE
Revision 2 • Mock Test module
Proposed design blueprint; verify against the repository before coding.
Page 3
ID
Decision
Default
Why
D1
Retry semantics
Per-subject question bank. Retry builds a new attempt
from 50 bank questions, unseen first, then least recently
seen. Generation runs only when too few eligible
questions exist, or when the user asks for new ones.
Cuts AI cost, keeps questions immutable,
and makes report quarantine possible.
D2
Queue
Postgres table with row-lock claim.
No new infrastructure; state survives restarts.
D3
Worker hosting
In-process with the API. Stops when the API stops; jobs
resume on boot.
Fits localhost. A sleeping host would
otherwise break recovery. [PUBLIC]
separate process.
D4
Offline
v1 online-only. Banner and disabled controls when
offline. Offline sync is v1.1.
Largest source of subtle bugs, smallest
launch value.
D5
Session ownership
Latest session wins via sessionVersion. Older tabs
get 409 and read-only mode.
No lease, heartbeat or TTL needed in v1.
D6
Minimum content
At least 60 eligible chunks and 40 distinct pages (App.
A).
Below this, 50 varied questions are not
possible.
D7
Verifier
Independent pass; must agree with the key. Different
model if available.
A model grading its own work approves its
own mistakes.
D8
Topics
Controlled per-subject topic list, not free text from the
model.
Free text fragments topic analytics
("Cardiology" vs "Cardiovascular").
D9
Unfinished
attempts
Discard allowed any time; no auto-expiry; dashboard
shows age.
Prevents permanent lock-out by an old
attempt.
D10
Scores vs retired
questions
Scores never change automatically. History shows a
notice.
Matches the immutable-result rule.
D11
Spend control
One active job; per-job call caps; configurable daily
AI-call budget.
Single-user needs a budget, not per-user
quotas.
3. Shared Subjects architecture
Subjects and Mock Test are two views of the same domain data. Creating Pediatrics in Mock Test creates one subject
record that also appears in Subjects. Attaching two PDFs shows "2 PDFs" on the Subjects page, never "50 items".
Display and synchronization rules
• Subjects page: every owned subject, including those with zero PDFs; name and PDF count only.
• Mock Test dashboard: subjects with at least one attached PDF. Generation additionally requires the content threshold
(D6) and says exactly what is missing when it is not met.
• Create, rename, attach, delete and count changes use the same subject ID and attachment records. Relevant client
queries are invalidated and refetched after every mutation.
• No PDF object is ever duplicated for Mock Test.
Deletion is a state, not an instant
• Subject delete (with confirmation): mark the subject DELETING (hidden everywhere) → cancel its active job → delete
R2 objects → hard-delete rows in one transaction. If any step fails the row stays DELETING and the reconciler retries.
Nothing is half-deleted and visible.
• Single PDF delete: mark the document DELETING and remove it from retrieval immediately; delete the R2 object; keep
citation metadata, which then displays "Source Unavailable".
• A bank question whose citations are all unavailable becomes SOURCE_UNAVAILABLE: excluded from new attempts,
kept in history. A question that still has at least one available citation stays ACTIVE.
4. PDF ingestion and retrieval
PDFs are uploaded once and processed into page-aware searchable content. Chat and Mock Test share the index but use
different output policies.


---

## Page 4

YANIMED / SYSTEM ARCHITECTURE
Revision 2 • Mock Test module
Proposed design blueprint; verify against the repository before coding.
Page 4
Stage
Expected behavior
On failure
Upload
Authorize ownership; check magic bytes (%PDF-), MIME, size and page
limits; reject encrypted PDFs with a clear message; store original in R2;
create document record; flag exact content-hash duplicates within the
subject.
Reject with a reason code. No orphan
R2 object.
Extract
Text by actual physical page. OCR pages with inadequate text, up to the
OCR cap. Run inside a per-document timeout.
FAILED with OCR_QUALITY if over
30% of pages are unreadable.
Chunk
Store document ID, physical page range, optional verified printed page and
chapter. Mark eligibleForQuestions=false for front matter, contents,
index, references, repeated headers and very short chunks (still searchable
by chat).
Zero eligible chunks marks the
document READY with a warning, not
usable for Mock Test.
Embed /
index
Embed with retry and rate-limit handling. Write chunks under a new
indexVersion.
Resumable per chunk batch; FAILED
after bounded retries.
Ready
In one transaction after integrity checks (chunks exist, every chunk has an
embedding of the current dimension, page numbers within range), switch
activeIndexVersion.
Old index stays active.
Retrieve
Scope strictly to the current user, selected subject, READY documents and
their active index version. Never use web fallback.
Empty retrieval means "insufficient",
never a guess.
Document status model
UPLOADED → EXTRACTING → (OCR) → EMBEDDING → READY. Side states: FAILED (with reason code),
STALE_INDEX (embedding model changed), DELETING. Every status is visible to the user with a plain-language
message.
Content that changes over time
• Reprocessing builds a new index version beside the old one and swaps atomically, so retrieval never sees a half-built
document. Old versions are garbage-collected only when no running job is pinned to them.
• Embedding model change: chunks store embeddingModel. Retrieval queries only chunks matching the configured
model; a change marks documents STALE_INDEX and queues re-embedding.
• Immutable originals: "replacing" a PDF means uploading a new document and deleting the old one. Citations therefore
never point at a file that changed under them.
Citation invariant
Every cited question references a real source document and an actual physical PDF page, and the quoted supporting text is
found on that page by a normalized match. Printed book pages and chapters are optional unless reliably verified. Deleted
individual PDFs retain historical citation metadata and display "Source Unavailable".
Hygiene and reconciliation
• Reconciler (on demand and weekly): R2 keys with no database row older than 24 hours are removed after a dry-run
report; database documents whose object is missing become FAILED(MISSING_OBJECT).
• Same-hash duplicate uploads warn instead of silently doubling OCR and embedding cost.
5. Mock Test domain model
Conceptual schema, not a mandate to duplicate models already in Prisma. The key change from v1: generated questions
live in a per-subject bank and attempts reference them through an ordered join table.
Entity
Purpose / key fields
Subject, Document, Chunk
(existing, extended)
Subject status (ACTIVE/DELETING). Document status, failure reason, content hash, page count,
activeIndexVersion. Chunk indexVersion, embeddingModel, physical page range,
eligibleForQuestions.
SubjectTopic
Controlled topic list per subject; stable keys; new topics are appended, never renamed under
existing questions.
GenerationJob
Subject, requested count, state, accepted count (0-50), plan JSON (slots), heartbeatAt, recovery
count, AI-call counters, failure reason. GenerationJobDocument snapshots the document IDs and
index versions used.


---

## Page 5

YANIMED / SYSTEM ARCHITECTURE
Revision 2 • Mock Test module
Proposed design blueprint; verify against the repository before coding.
Page 5
Entity
Purpose / key fields
MockQuestion (bank)
Subject, topic, vignette, lead-in, educational objective, status (ACTIVE / QUARANTINED /
RETIRED / SOURCE_UNAVAILABLE). Provenance: job, draft model, verifier model, prompt
version, validator version, verifier result. Content columns immutable.
MockChoice
Question, opaque ID, position 1-4, text, isCorrect, explanation (correct and each distractor).
QuestionCitation
Question, document ID (kept as snapshot title if the document is deleted), physical PDF page,
optional verified printed page/chapter, supporting quote.
MockAttempt
User, subject, status, sessionVersion, cursorPosition, lastActivityAt, optional job link.
AttemptQuestion
Attempt, question, position 1-50, persisted choice order, status UNSEEN/SKIPPED/ANSWERED.
Order is generated once and never reshuffled.
AttemptAnswer
One per attempt question: choice, server-assigned revision, idempotency key.
AttemptResult
Immutable score snapshot: per-question selected, correct and topic; per-topic performance.
QuestionReport
Reporter, attempt, question, reason, details, status OPEN/ACCEPTED/DISMISSED, resolution
note.
AiCallLog
Job, purpose (plan/draft/verify/embed), model, tokens, latency, outcome, error code.
Rules enforced by the database
#
Rule
Enforcement
1
One unfinished attempt per user
and subject
Partial unique index on (user_id, subject_id) WHERE status IN (GENERATING, READY,
IN_PROGRESS, AWAITING_SUBMISSION). Conflict returns 409 ATTEMPT_EXISTS
with the existing attempt ID.
2
One active generation job per
subject
Partial unique index on subject_id WHERE state IN (QUEUED, RUNNING, STALLED,
CANCELLING).
3
Four choices, exactly one correct
Unique (question_id, position) with CHECK position BETWEEN 1 AND 4; partial unique
index on question_id WHERE is_correct. A question is inserted only in a transaction that
writes all four choices and verifies the count.
4
Exactly 50 questions before
READY
Unique (attempt_id, position) with CHECK position BETWEEN 1 AND 50. READY is a
single conditional UPDATE that succeeds only when 50 rows exist and all questions are
ACTIVE.
5
One answer per attempt question
Unique (attempt_question_id).
6
Idempotent, atomic submit
Unique (attempt_id) on attempt_result; status change via UPDATE ... WHERE status =
'AWAITING_SUBMISSION' and a row-count check.
7
Immutable questions and results
BEFORE UPDATE triggers reject changes to question and choice content and to any
attempt_result row. Deletion happens only through subject-deletion cascades.
8
Monotonic revisions
Writes use UPDATE ... WHERE revision = :expected; the server increments. Client clocks
are never used.
9
Stale session rejected
Every mutating call carries sessionVersion; UPDATE ... WHERE session_version = :v.
10
Valid citations
FK to document; CHECK page > 0; page validated against document page count at insert.
11
Report ownership; one report per
question per attempt
FKs plus unique (reporter, attempt, question); ownership check in the service.
12
Keys never leave in exam
responses
Exam DTO classes contain no key, explanation or citation fields; a contract test fails if any
serialized exam response contains them.


---

## Page 6

YANIMED / SYSTEM ARCHITECTURE
Revision 2 • Mock Test module
Proposed design blueprint; verify against the repository before coding.
Page 6
6. Question generation and validation
1  Plan slots
topics + doc snapshot
2  Draft
strict JSON output
3  Check A
deterministic rules
4  Check B
independent verifier
5  Check C
duplicate detection
6  Persist
checkpoint in 1 txn
7  Check D
full 50-set validation
8  READY
attach 50 to attempt
Any reject: redraft the slot (max 3 drafts), then reassign the slot. Repeat until accepted = target.
Generation pipeline – every accepted question is checkpointed before the next is drafted
6.1 Readiness gate
A job starts only when the subject has at least one READY document and meets the content threshold (App. A). Otherwise
the API returns INSUFFICIENT_CONTENT with the actual counts (eligible chunks, pages), so the UI can say what is
missing instead of failing later.
6.2 Planning and coverage
• Snapshot the document IDs and index versions into GenerationJobDocument. Documents added later are ignored by
this job.
• Topics: cluster eligible chunks by chapter/section and embedding similarity, name the clusters, and store them as
SubjectTopic. Topics are stable afterwards; new ones are appended.
• Slots: allocate the target count across topics in proportion to eligible content, capped at 3 per topic (raised only as far as
needed when a subject has fewer than 17 topics). Each slot gets 1-3 adjacent seed chunks.
• Answer-position balance is done by code, not by the model: when an attempt is created, the correct choice is
assigned a balanced position (each of A-D appears 10-15 times in 50) and the distractors are shuffled around it. The
order is persisted once.
6.3 Drafting
One slot at a time. Input: seed chunks, topic, and the objectives already accepted. Output: strict JSON against a schema
(five-sentence vignette, lead-in, four choices, one key, objective, explanations for the key and every distractor, topic,
citation with quote). Free-text fallback is not allowed; a parse failure counts as a rejected draft. Source text is passed as
delimited data, never as instructions.
6.4 Validation layers
Layer
What it checks
A. Deterministic (no AI)
Schema valid. Vignette is exactly five sentences. Lead-in present. Exactly four distinct choices, one key, no
"all/none of the above", choice lengths not wildly uneven. All four explanations present. Topic is in
SubjectTopic. Citation document is in the job snapshot, page is within the page count, and the quote is
found on that page by normalized fuzzy match.
B. Independent verifier
(AI)
A separate call, preferably a different model, receives only the cited text, vignette, lead-in and choices. It
never sees the key or the explanations. For each choice it returns SUPPORTED, CONTRADICTED or
NOT_ADDRESSED plus the supporting quote, and flags NEEDS_OUTSIDE_KNOWLEDGE or
AMBIGUOUS. Accept only if exactly the keyed choice is SUPPORTED and no flag is raised. Any
disagreement rejects the draft. The explanations are checked against the source in the same call.
C. Duplicate check
Cosine similarity of the vignette-plus-lead-in embedding against accepted questions in this job and in the
active bank. Reject at or above the threshold; also reject the same topic with the same normalized
educational objective.
D. Full-set validation
After the target is reached: count is 50, IDs unique, every citation still valid and its document still existing
and in the snapshot, topic cap respected, minimum distinct topics met, no pair above the similarity
threshold, all questions ACTIVE. Failures replace only the offending slots, within a bounded budget.


---

## Page 7

YANIMED / SYSTEM ARCHITECTURE
Revision 2 • Mock Test module
Proposed design blueprint; verify against the repository before coding.
Page 7
Honest limit
Validation reduces medical errors; it cannot eliminate them. The verifier only proves that the answer is supported by the
uploaded text, not that the text is clinically right. That is why the report path (section 8), the study-aid disclaimer (section 10)
and the M2 manual-review gate exist.
6.5 Limits
Every limit has a default in Appendix A and lives in configuration: attempts per slot, total AI calls per job, per-call timeout
and retries with exponential backoff and jitter (honoring Retry-After), job wall-clock timeout, and the replacement budget.
Exceeding any limit ends the job with an explicit reason, never a silent loop.
6.6 Job state machine, recovery and cancellation
• States: QUEUED → RUNNING → COMPLETED. RUNNING → STALLED (watchdog) → RUNNING (auto-recovery,
limited) or FAILED. Any active state → CANCELLING → CANCELLED.
• Failure reasons (shown in the UI): INSUFFICIENT_CONTENT, PROVIDER_UNAVAILABLE, BUDGET_EXHAUSTED,
VALIDATION_EXHAUSTED, SOURCE_CHANGED, TIMEOUT, INTERNAL.
• Checkpoint: each accepted question is inserted with its choices and citations and the job counter is incremented in one
transaction. Recovery replans only the remaining slots. Progress counts accepted, validated questions, never attempted
AI calls.
• Heartbeat and watchdog: the worker writes heartbeatAt; a job with no heartbeat for the stall window is marked
STALLED and resumed. On boot the worker scans for RUNNING jobs left by a previous process. On graceful shutdown
it finishes the current call and returns the job to QUEUED.
• Cancel requires confirmation and sets CANCELLING in a transaction. The worker checks the flag before every AI call
and every persist, and persists with a guard (job state must be RUNNING), so a late result cannot be published. Content
from the cancelled job is discarded.
• Content changes mid-job: new PDFs are ignored (snapshot). A deleted PDF causes questions citing it to be rejected
and replaced; losing too many slots fails the job with SOURCE_CHANGED. A deleted subject cancels the job.
Reprocessing does not disturb the job because the old index version stays pinned.
6.7 Building an attempt from the bank
Eligible = ACTIVE questions whose citations are not all unavailable. Selection prefers questions the user has not seen (a
question counts as seen once it appeared in an attempt that reached IN_PROGRESS), then least recently seen, while
respecting the topic cap. If fewer than 50 eligible questions exist, a job generates the shortfall. If enough eligible questions
exist but fewer than 50 are unseen, the user chooses explicitly: include repeats, or generate new ones (uses AI budget).
Selection and attempt creation run in one transaction.
7. Exam state machine
GENERATING
READY
IN_PROGRESS
AWAITING
SUBMISSION
COMPLETED
FAILED /
CANCELLED
ABANDONED
user Discard, from any unfinished state
COMPLETED is terminal and immutable.
Attempt lifecycle – only COMPLETED is immutable; every unfinished state can be discarded
State
Transitions and UI behavior
GENERATING
Background progress (0-50) that survives navigation. Cancel with confirmation, or recover a failed job.
READY
Show Start Test; no automatic navigation. Discard available.
IN_PROGRESS
Forward-only Answer & Continue or Skip. Back exits to the dashboard; progress persists.
AWAITING_SUBMISSION
All 50 answered; editable neutral navigator; explicit Submit.


---

## Page 8

YANIMED / SYSTEM ARCHITECTURE
Revision 2 • Mock Test module
Proposed design blueprint; verify against the repository before coding.
Page 8
State
Transitions and UI behavior
COMPLETED
Immutable grade, Results, View Answers, Retry, Done.
FAILED / CANCELLED
Meaningful status and reason; safe retry or new generation.
ABANDONED
Result of Discard from any unfinished state. Frees the one-unfinished-attempt slot.
Forward-only navigation (server-computed)
First pass traverses positions 1-50 in the persisted order. Skip marks a question SKIPPED. The server computes the next
question with one deterministic rule: the smallest position greater than the current one whose status is UNSEEN or
SKIPPED; if none, the smallest position with that status; if all are answered the attempt moves to
AWAITING_SUBMISSION. The client never decides, so refresh, resume and revisit all behave identically. No Previous
button and no number navigator during the active exam.
• Answer immutability during IN_PROGRESS: an answered question cannot change. An identical replay returns 200
with no change; a different value returns 409 REVISION_CONFLICT. Editing is allowed only in
AWAITING_SUBMISSION.
• Pre-submission review: all 50 numbers neutral, only the selected one highlighted. Jump, Previous/Next, edit with
autosave. No keys, explanations, citations or correctness indicators before submission.
v1 connectivity and session ownership
• Online-only autosave. Each Answer or Skip is saved to the server with an idempotency key. When offline, controls are
disabled and a banner reads "Offline – answers not saved". Failed saves retry with backoff; a refresh restores state
from the server. Submission is blocked while any save is in flight.
• Latest session wins. Opening the exam increments sessionVersion. A mutating call from an older tab returns 409
SESSION_SUPERSEDED; that tab becomes read-only with a "Use this window" action. Nothing is silently merged.
Submission
One endpoint with an idempotency key. In a single transaction: lock the attempt row; if already COMPLETED return the
existing result; require status AWAITING_SUBMISSION and all 50 answers; grade on the server from the stored keys;
insert the result snapshot; set COMPLETED. Twenty concurrent submits produce exactly one result.
Stuck-state handling
• Discard (any unfinished state, including FAILED) moves the attempt to ABANDONED after confirmation.
• The dashboard shows attempt age and highlights unfinished attempts older than 14 days; there is no silent auto-expiry.
• Watchdog and boot recovery (section 6.6) cover stuck GENERATING attempts; the partial unique index guarantees the
dashboard can never show two unfinished attempts for one subject.
8. Results, review and reports
Each question grades 1 or 0; the score is /50 with percentage and correct/incorrect counts. No pass/fail label and no exam
timer. Results include topic breakdowns (using the controlled topic list) and Retry, View Answers, Done. Post-exam review
shows the original shuffled choices, selected and correct answers, explanations, citations, and All/Correct/Incorrect filters
combinable with a topic filter.
Report lifecycle
Event
Effect
User reports a question (answer key, ambiguity,
citation, explanation, other)
Report is OPEN. The score is never changed automatically.
Reason is ANSWER_KEY or CITATION
Question is QUARANTINED immediately: excluded from new attempts. Past
attempts keep it, marked "Under review".
Owner reviews the Reports screen
ACCEPTED → question RETIRED permanently. DISMISSED → question
returns to ACTIVE if this report was the only reason it was quarantined.
Question later retired
History shows a notice on that question; the stored grade stays as recorded
(D10).


---

## Page 9

YANIMED / SYSTEM ARCHITECTURE
Revision 2 • Mock Test module
Proposed design blueprint; verify against the repository before coding.
Page 9
9. API and trust boundaries
API capability
Security / consistency rule
Subject and PDF operations
Authenticated ownership; reuse existing routes and storage workflow; upload limits and
magic-byte checks.
Generation start / status / cancel
Idempotency key; one active job; readiness gate; budget check; job ownership; race-safe
transitions; status polling with backoff.
Attempt create / discard
Single transaction; partial unique index backs the rule; Discard only on the owner's
unfinished attempts.
Exam retrieval
Exam-safe DTO: no keys, correctness, explanations or citations; opaque choice IDs.
Answer / skip
sessionVersion check, revision check, status rule (immutable during IN_PROGRESS),
server-computed next question.
Submit
Idempotent; server-only grading; complete-answer check; atomic transaction.
Results / history / review
Only COMPLETED attempts; immutable answer mapping and citation metadata.
Question reports
Authenticated reporter; attempt and question ownership; one report per question per
attempt.
Stable error codes the client can rely on: ATTEMPT_EXISTS, JOB_ACTIVE, INSUFFICIENT_CONTENT,
BUDGET_EXHAUSTED, SESSION_SUPERSEDED, REVISION_CONFLICT, NOT_ALL_ANSWERED,
SOURCE_UNAVAILABLE.
Security requirements
• Uploaded PDF text and model outputs are untrusted. Source text goes to the model as delimited data; the model has no
tools; output must match the schema or it is discarded; secrets never appear in prompts.
• Model text is never rendered as raw HTML. Render as escaped text or sanitized markdown (stored XSS via generated
questions is a real bug class).
• PDFs are served through signed URLs with a short TTL, issued per request after the ownership check. No public R2
links.
• API keys and provider routing stay on the server. DTO whitelisting and validation everywhere; audit-friendly logging of
destructive actions.
• [PUBLIC] per-user and per-IP throttles on upload, generation start and report endpoints.
• Additive, reviewed migrations with a rollback note each. Never reset the database; never alter unrelated behavior.
10. Operations, cost and rollout
Deployment and reliability
Use the existing topology. The worker runs in the API process and recovers on boot. Closing the machine or stopping the
API pauses generation; the UI then shows "Paused – server not running" when the heartbeat is stale, and the job resumes
from its checkpoint when the API returns.
Cost and abuse controls
• One active job at a time; per-job caps on drafts, verifications and total AI calls.
• Configurable daily AI-call budget; exhausting it fails new jobs with BUDGET_EXHAUSTED and leaves running jobs to
finish their current slot.
• Circuit breaker around OmniRoute: opens after consecutive failures, waits through a cooldown, then probes. While
open, jobs wait inside their timeout rather than burning calls.
• Every AI call is recorded in ai_call_log, so cost per accepted question is measurable.
Observability
Structured logs with jobId and attemptId. Track: job success and failure by reason, rejection rate per validation layer, AI
calls per accepted question, stalled jobs, provider 429 and error rates, and processing lag. A health endpoint reports these;
investigate any stalled job older than 10 minutes or a rejection rate that jumps after a prompt or model change.
Backup, restore and data hygiene


---

## Page 10

YANIMED / SYSTEM ARCHITECTURE
Revision 2 • Mock Test module
Proposed design blueprint; verify against the repository before coding.
Page 10
• Scheduled database dump (daily or weekly) stored off the machine; restore drill run once before release. Embeddings
are re-derivable from R2 but costly, so chunks are included in the dump. Do not assume the hosting plan provides
backups.
• Reconciler for orphaned R2 objects and missing objects (section 4).
Rollout and compatibility
• Feature flag on server and client (MOCK_TEST_ENABLED). Off hides navigation and returns 404 on Mock Test routes.
Migrations are additive, so the off state is harmless to chat and Subjects.
• Migration check on real data: backfill document status, page counts and index version for existing PDFs; compare row
counts before and after; verify existing chat still retrieves the same chunks.
• Mobile and accessibility: usable at 360 px width, full keyboard operation, visible focus, screen-reader labels on choices.
Product and legal
Show a study-aid notice on generation and results screens: questions are AI-generated from your own PDFs, are not
medical advice, and may contain errors; use Report. State that the user is responsible for the right to use the uploaded
material and that it is for personal study.
11. Testing strategy
Layer
What is tested
Unit
Traversal rule, grading, balanced answer-position assignment, sentence counter, quote fuzzy match,
bank selection.
Database constraints
Each rule in section 5 has a test that tries to violate it, including concurrency: 20 parallel attempt
creations, 20 parallel submits, racing answer writes, stale-session writes.
API contract
Exam-safe responses never contain isCorrect, explanations or citations (snapshot test). Error codes
match section 9.
Job chaos
Kill the process mid-job: resumes with no duplicate or partial questions and ends at exactly 50. Cancel
during an AI call: nothing is published. Provider 429 storm: breaker opens and the job ends cleanly. PDF
deleted mid-job.
Golden set
3-5 PDFs (text, scanned, mixed) with fixed expectations: citation validity 100%, no near-duplicate pairs,
topic cap respected, acceptance rate within a band. Run on every prompt, model or validator change.
Manual quality review
Read a 50-question sample before release (M2, M8) and 20 after any significant prompt or model
change.
Injection and XSS
PDF containing "ignore previous instructions" and markup: schema unchanged, nothing leaked, nothing
rendered as HTML.
End-to-end
Full exam flow on desktop and a 360 px viewport, keyboard-only, refresh at every state.
Regression
The existing backend suite stays green at every milestone; existing chat, upload and auth flows
re-verified at M8.
Exit rule: a milestone closes only when its own tests pass and the existing baseline is green.
12. Phased delivery and acceptance
Milestones are numbered M0-M9 so they do not collide with the existing backend phase tags.
Milestone
Focus
Exit criterion
M0
Decisions
D1-D11 and Appendix A confirmed or changed in writing; this document frozen as v2.1.
M1
Repository audit
Existing services, schema, tests and risks documented; deployment assumption
confirmed; baseline verified green.
M2
Generation spike (script
only)
3-5 real PDFs through plan, draft, layers A-D; manual review of at least 50 questions. Go
if citation validity is 100% and at most 2 of 50 have a wrong or unsupported key. Measure
acceptance rate and AI calls per accepted question; calibrate the similarity threshold and
retry limits. No schema, no UI.
M3
Data and API foundation
Additive migrations with raw-SQL constraints, feature flag, bank model; every section 5
rule has a violating test; concurrency tests pass.


---

## Page 11

YANIMED / SYSTEM ARCHITECTURE
Revision 2 • Mock Test module
Proposed design blueprint; verify against the repository before coding.
Page 11
Milestone
Focus
Exit criterion
M4
Exam flow on fixed
questions
A seeded 50-question fixture runs the whole flow (create attempt, traversal, skip and
revisit, autosave, latest-session-wins, submit, grade, results) with no AI involved.
M5
Real generation
Worker, queue, state machine, readiness gate, bank selection, cancel and recovery,
budget and breaker; job chaos tests pass.
M6
Citations, review and
reports
Authenticated viewer, Source Unavailable, report lifecycle, filters, topic analytics verified.
M7
Hardening
Upload hygiene, reconciler, backup and restore drill, observability and health endpoint,
mobile and accessibility, injection and XSS tests.
M8
Regression and rollout
Frontend and backend builds, integration, existing flows pass; migration check on real
data; flag enabled for personal use; a week of real use with a fix list closed.
M9 (optional)
v1.1
Offline sync and explicit takeover (section 13).
If M2 fails (cut line)
Do not build further. Options, in order: tighten source windows (one chunk per question), add a "preview and approve" step
before a set is published, restrict generation to documents with clean text, or revise the 50-question rule. Decide before M3,
not after the exam UI exists.
13. Deferred to v1.1
Offline sync
• Local queue in IndexedDB keyed by user, attempt and sessionVersion. Operations carry an idempotency key and the
base revision.
• Progress allowed only through already-loaded questions. Sync on reconnect, in order. Submission blocked until the
queue is empty.
• If the session was superseded, local operations are discarded with a message stating how many answers were lost.
Logout clears the store. If storage quota fails, stop progression and say so.
Explicit takeover
Replace latest-wins with a lease: server-timestamped heartbeat (about 30 s) and TTL (about 90 s), a takeover prompt
when another session is live, and revocation of the old session's authority.
14. Final acceptance checklist
• Pediatrics created in Mock Test appears in Subjects; two attached PDFs show "2 PDFs", never "50 items".
• Only processed, PDF-grounded material is used; every question passes validation layers A to D; every citation resolves
to a real page.
• A set covers the subject: topic cap respected, minimum distinct topics met, answer positions balanced.
• Question and choice order are stable across refresh and resume.
• Skip, revisit and pre-submission editing follow the rules; answered questions cannot change during IN_PROGRESS.
• Concurrent attempt creation, answers and submits cannot create duplicate or inconsistent state.
• Stale tabs cannot overwrite progress; offline shows a clear non-saving state.
• A stuck attempt or job can always be discarded, cancelled or recovered; nothing blocks a subject permanently.
• Killing the worker mid-generation never produces partial or duplicate questions.
• Results, citations, reports and history remain consistent when PDFs are deleted; reported questions leave new
attempts.
• Spend is bounded: job caps, daily budget and breaker verified.
• Backup restore drill completed; reconciler dry-run clean.
• Existing Subjects, chat, authentication and upload workflows pass regression with the flag on and off.


---

## Page 12

YANIMED / SYSTEM ARCHITECTURE
Revision 2 • Mock Test module
Proposed design blueprint; verify against the repository before coding.
Page 12
Implementation note
Before coding, reconcile this blueprint with the real repository. Where the current implementation differs, propose the
smallest safe migration path and verify each milestone before proceeding.
Appendix A. Parameter defaults
Starting values. Calibrate in M2 and keep them in configuration, not code.
Parameter
Default
Notes
Minimum eligible chunks to generate
60
Readiness gate (D6).
Minimum distinct pages with eligible text
40
Readiness gate (D6).
Max questions per topic in one set
3
Raised only to ceil(50 / topic count) for small
subjects.
Minimum distinct topics per set
17
Follows from the cap of 3.
Correct-answer position balance
10-15 per letter in 50
Assigned by code at attempt creation.
Draft attempts per slot
3
Then the slot is reassigned.
Total AI calls per job (hard cap)
400
Counts drafts, verifications and embeddings.
Replacement budget at full-set validation
5 slots
Beyond this the job fails
VALIDATION_EXHAUSTED.
Duplicate similarity threshold
0.90 cosine
Calibrate in M2.
Citation quote fuzzy-match threshold
0.90
On normalized text of the cited page.
Job wall-clock timeout
45 min
Failure reason TIMEOUT.
Heartbeat / stalled window
30 s / 120 s
Watchdog marks STALLED.
Auto-recoveries per job
3
Then FAILED.
AI call timeout / retries
60 s / 3
Backoff 2 s, 4 s, 8 s plus jitter; honor
Retry-After.
Circuit breaker
Open after 5 consecutive failures;
60 s cooldown
Then a single probe call.
Daily AI-call budget
1,500
Roughly five full jobs; configurable.
Max PDF size / pages
50 MB / 800 pages
Magic bytes %PDF- and MIME checked.
OCR cap per document
200 pages
Over 30% unreadable pages fails with
OCR_QUALITY.
Per-document processing timeout
15 min
Failure reason TIMEOUT.
Minimum chunk length for questions
200 characters
Shorter chunks are chat-only.
Signed URL TTL
5 min
Issued per request after ownership check.
Stale-attempt highlight
14 days
Display only; no auto-expiry.
Orphan R2 object grace period
24 h
Dry-run report before deletion.
Status polling interval
3 s with backoff
Generation progress.
