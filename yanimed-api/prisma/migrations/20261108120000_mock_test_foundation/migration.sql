-- Mock Test v2.1 foundation (additive only).
-- Creates the generation, question-bank, attempt and reporting tables.
-- No existing table, column, index, enum or migration is touched.

BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

-- CreateEnum
CREATE TYPE "public"."GenerationJobState" AS ENUM (
    'QUEUED', 'RUNNING', 'STALLED', 'CANCELLING', 'CANCELLED', 'COMPLETED', 'FAILED'
);

-- CreateEnum
CREATE TYPE "public"."MockQuestionStatus" AS ENUM (
    'ACTIVE', 'QUARANTINED', 'RETIRED', 'SOURCE_UNAVAILABLE'
);

-- CreateEnum
CREATE TYPE "public"."MockAttemptStatus" AS ENUM (
    'GENERATING', 'READY', 'IN_PROGRESS', 'AWAITING_SUBMISSION', 'COMPLETED', 'FAILED', 'CANCELLED', 'ABANDONED'
);

-- CreateEnum
CREATE TYPE "public"."AttemptQuestionStatus" AS ENUM (
    'UNSEEN', 'SKIPPED', 'ANSWERED'
);

-- CreateEnum
CREATE TYPE "public"."QuestionReportReason" AS ENUM (
    'ANSWER_KEY', 'AMBIGUITY', 'CITATION', 'EXPLANATION', 'OTHER'
);

-- CreateEnum
CREATE TYPE "public"."QuestionReportStatus" AS ENUM (
    'OPEN', 'ACCEPTED', 'DISMISSED'
);

-- CreateEnum
CREATE TYPE "public"."AiCallPurpose" AS ENUM (
    'PLAN', 'DRAFT', 'VERIFY', 'EMBED'
);

-- CreateTable
CREATE TABLE "public"."SubjectTopic" (
    "id" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubjectTopic_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SubjectTopic_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "public"."Subject"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "public"."GenerationJob" (
    "id" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "state" "public"."GenerationJobState" NOT NULL,
    "requestedCount" INTEGER NOT NULL DEFAULT 25,
    "acceptedCount" INTEGER NOT NULL DEFAULT 0,
    "planJson" JSONB,
    "heartbeatAt" TIMESTAMP(3),
    "recoveryCount" INTEGER NOT NULL DEFAULT 0,
    "aiCallCount" INTEGER NOT NULL DEFAULT 0,
    "failureReason" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GenerationJob_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "GenerationJob_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "public"."Subject"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
-- GenerationJobDocument.documentId uses ON DELETE NO ACTION (not RESTRICT):
-- NO ACTION is checked at statement end, so a whole-Subject cascade can remove
-- the dependent job rows first and still finish.
CREATE TABLE "public"."GenerationJobDocument" (
    "jobId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GenerationJobDocument_pkey" PRIMARY KEY ("jobId", "documentId"),
    CONSTRAINT "GenerationJobDocument_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "public"."GenerationJob"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "GenerationJobDocument_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "public"."Document"("id") ON DELETE NO ACTION ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "public"."MockQuestion" (
    "id" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "jobId" TEXT,
    "status" "public"."MockQuestionStatus" NOT NULL DEFAULT 'ACTIVE',
    "stem" TEXT NOT NULL,
    "leadIn" TEXT,
    "educationalObjective" TEXT NOT NULL,
    "draftModel" TEXT NOT NULL,
    "verifierModel" TEXT,
    "promptVersion" TEXT NOT NULL,
    "validatorVersion" TEXT NOT NULL,
    "verifierResult" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MockQuestion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MockQuestion_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "public"."Subject"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MockQuestion_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "public"."SubjectTopic"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MockQuestion_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "public"."GenerationJob"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "public"."MockChoice" (
    "id" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "isCorrect" BOOLEAN NOT NULL,
    "explanation" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MockChoice_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MockChoice_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "public"."MockQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "public"."QuestionCitation" (
    "id" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "documentId" TEXT,
    "documentTitleSnapshot" TEXT NOT NULL,
    "pageNumber" INTEGER NOT NULL,
    "printedPage" TEXT,
    "quote" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuestionCitation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "QuestionCitation_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "public"."MockQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "QuestionCitation_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "public"."Document"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "public"."MockAttempt" (
    "id" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "status" "public"."MockAttemptStatus" NOT NULL,
    "sessionVersion" INTEGER NOT NULL DEFAULT 1,
    "cursorPosition" INTEGER NOT NULL DEFAULT 1,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "jobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MockAttempt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MockAttempt_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "public"."Subject"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MockAttempt_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "public"."GenerationJob"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "public"."AttemptQuestion" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "choiceOrder" INTEGER[],
    "status" "public"."AttemptQuestionStatus" NOT NULL DEFAULT 'UNSEEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttemptQuestion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AttemptQuestion_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "public"."MockAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AttemptQuestion_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "public"."MockQuestion"("id") ON DELETE NO ACTION ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "public"."AttemptAnswer" (
    "id" TEXT NOT NULL,
    "attemptQuestionId" TEXT NOT NULL,
    "choiceId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttemptAnswer_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AttemptAnswer_attemptQuestionId_fkey" FOREIGN KEY ("attemptQuestionId") REFERENCES "public"."AttemptQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AttemptAnswer_choiceId_fkey" FOREIGN KEY ("choiceId") REFERENCES "public"."MockChoice"("id") ON DELETE NO ACTION ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "public"."AttemptResult" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttemptResult_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AttemptResult_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "public"."MockAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "public"."QuestionReport" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "reason" "public"."QuestionReportReason" NOT NULL,
    "details" TEXT,
    "status" "public"."QuestionReportStatus" NOT NULL DEFAULT 'OPEN',
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuestionReport_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "QuestionReport_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "public"."MockAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "QuestionReport_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "public"."MockQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "public"."AiCallLog" (
    "id" TEXT NOT NULL,
    "jobId" TEXT,
    "purpose" "public"."AiCallPurpose" NOT NULL,
    "model" TEXT NOT NULL,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "latencyMs" INTEGER,
    "outcome" TEXT NOT NULL,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiCallLog_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AiCallLog_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "public"."GenerationJob"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "SubjectTopic_subjectId_key_key" ON "public"."SubjectTopic"("subjectId", "key");

-- CreateIndex
CREATE INDEX "SubjectTopic_subjectId_idx" ON "public"."SubjectTopic"("subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "GenerationJob_idempotencyKey_key" ON "public"."GenerationJob"("idempotencyKey");

-- CreateIndex
CREATE INDEX "GenerationJob_subjectId_idx" ON "public"."GenerationJob"("subjectId");

-- CreateIndex
CREATE INDEX "GenerationJobDocument_documentId_idx" ON "public"."GenerationJobDocument"("documentId");

-- CreateIndex
CREATE INDEX "MockQuestion_subjectId_idx" ON "public"."MockQuestion"("subjectId");

-- CreateIndex
CREATE INDEX "MockQuestion_topicId_idx" ON "public"."MockQuestion"("topicId");

-- CreateIndex
CREATE INDEX "MockQuestion_jobId_idx" ON "public"."MockQuestion"("jobId");

-- CreateIndex
CREATE INDEX "MockQuestion_status_idx" ON "public"."MockQuestion"("status");

-- CreateIndex
CREATE UNIQUE INDEX "MockChoice_questionId_position_key" ON "public"."MockChoice"("questionId", "position");

-- CreateIndex
CREATE INDEX "QuestionCitation_questionId_idx" ON "public"."QuestionCitation"("questionId");

-- CreateIndex
CREATE INDEX "QuestionCitation_documentId_idx" ON "public"."QuestionCitation"("documentId");

-- CreateIndex
CREATE INDEX "MockAttempt_subjectId_idx" ON "public"."MockAttempt"("subjectId");

-- CreateIndex
CREATE INDEX "MockAttempt_status_idx" ON "public"."MockAttempt"("status");

-- CreateIndex
CREATE INDEX "MockAttempt_jobId_idx" ON "public"."MockAttempt"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "AttemptQuestion_attemptId_position_key" ON "public"."AttemptQuestion"("attemptId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "AttemptQuestion_attemptId_questionId_key" ON "public"."AttemptQuestion"("attemptId", "questionId");

-- CreateIndex
CREATE INDEX "AttemptQuestion_questionId_idx" ON "public"."AttemptQuestion"("questionId");

-- CreateIndex
CREATE UNIQUE INDEX "AttemptAnswer_attemptQuestionId_key" ON "public"."AttemptAnswer"("attemptQuestionId");

-- CreateIndex
CREATE INDEX "AttemptAnswer_choiceId_idx" ON "public"."AttemptAnswer"("choiceId");

-- CreateIndex
CREATE UNIQUE INDEX "AttemptResult_attemptId_key" ON "public"."AttemptResult"("attemptId");

-- CreateIndex
CREATE UNIQUE INDEX "QuestionReport_attemptId_questionId_key" ON "public"."QuestionReport"("attemptId", "questionId");

-- CreateIndex
CREATE INDEX "QuestionReport_questionId_idx" ON "public"."QuestionReport"("questionId");

-- CreateIndex
CREATE INDEX "AiCallLog_jobId_idx" ON "public"."AiCallLog"("jobId");

-- ===========================================================================
-- Raw SQL rules (section 5 of the v2.1 spec).
--
-- WARNING: Prisma cannot model partial indexes or triggers. `prisma migrate
-- dev` would see these as unknown objects and may try to drop or regenerate
-- them, so do not use `prisma migrate dev` on this schema.
-- Safe apply commands (both run `prisma migrate deploy`):
--   test DB: npm run db:test:run -- prisma migrate deploy
--   main DB: npm run db:migrate
--
-- The checks below are regular CHECK constraints; the partial unique indexes
-- enforce "at most one active row" rules that Prisma cannot express.
-- All identifiers are double-quoted because PostgreSQL folds unquoted names
-- to lower case, while the Prisma models use PascalCase names.
-- ===========================================================================

-- R1: at most one unfinished (playable) attempt per subject.
CREATE UNIQUE INDEX "MockAttempt_subjectId_active_key"
    ON "public"."MockAttempt"("subjectId")
    WHERE "status" IN ('GENERATING', 'READY', 'IN_PROGRESS', 'AWAITING_SUBMISSION');

-- R2: at most one unfinished generation job per subject.
CREATE UNIQUE INDEX "GenerationJob_subjectId_active_key"
    ON "public"."GenerationJob"("subjectId")
    WHERE "state" IN ('QUEUED', 'RUNNING', 'STALLED', 'CANCELLING');

-- R3: a question has four choices (1..4), exactly one of them correct.
ALTER TABLE "public"."MockChoice"
    ADD CONSTRAINT "MockChoice_position_check" CHECK ("position" BETWEEN 1 AND 4);

-- R3: at most one correct choice per question.
CREATE UNIQUE INDEX "MockChoice_questionId_correct_key"
    ON "public"."MockChoice"("questionId")
    WHERE "isCorrect";

-- R3: enforce exactly four choices and exactly one correct choice at commit
-- time, so all four rows can be inserted in one transaction. A deferred
-- constraint trigger checks the final state rather than each row.
CREATE OR REPLACE FUNCTION "public"."mock_choice_exactly_four_one_correct"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    total_choices INTEGER;
    correct_choices INTEGER;
BEGIN
    SELECT COUNT(*), COUNT(*) FILTER (WHERE "isCorrect")
      INTO total_choices, correct_choices
      FROM "public"."MockChoice"
     WHERE "questionId" = NEW."questionId";

    IF total_choices <> 4 THEN
        RAISE EXCEPTION 'R3: question % must have exactly 4 choices (found %)',
            NEW."questionId", total_choices;
    END IF;

    IF correct_choices <> 1 THEN
        RAISE EXCEPTION 'R3: question % must have exactly 1 correct choice (found %)',
            NEW."questionId", correct_choices;
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "MockChoice_exactly_four_one_correct"
    AFTER INSERT ON "public"."MockChoice"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION "public"."mock_choice_exactly_four_one_correct"();

-- R4: attempt questions are numbered 1..25 (the two uniqueness rules are
-- already declared above as AttemptQuestion_attemptId_position_key and
-- AttemptQuestion_attemptId_questionId_key).
ALTER TABLE "public"."AttemptQuestion"
    ADD CONSTRAINT "AttemptQuestion_position_check" CHECK ("position" BETWEEN 1 AND 25);

-- R4: an attempt may only leave GENERATING for a playable state when it has
-- exactly 25 questions and every one of those questions is still ACTIVE.
CREATE OR REPLACE FUNCTION "public"."mock_attempt_requires_full_set_active"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    total_questions INTEGER;
    active_questions INTEGER;
BEGIN
    IF OLD."status" = 'GENERATING'
       AND NEW."status" IN ('READY', 'IN_PROGRESS', 'AWAITING_SUBMISSION', 'COMPLETED') THEN
        SELECT COUNT(*)
          INTO total_questions
          FROM "public"."AttemptQuestion"
         WHERE "attemptId" = NEW."id";

        SELECT COUNT(*)
          INTO active_questions
          FROM "public"."AttemptQuestion" aq
          JOIN "public"."MockQuestion" q ON q."id" = aq."questionId"
         WHERE aq."attemptId" = NEW."id"
           AND q."status" = 'ACTIVE';

        IF total_questions <> 25 OR active_questions <> 25 THEN
            RAISE EXCEPTION
                'R4: attempt % can only become playable with exactly 25 questions whose status is ACTIVE (found % rows, % ACTIVE)',
                NEW."id", total_questions, active_questions;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "MockAttempt_requires_full_set_active"
    BEFORE UPDATE OF "status" ON "public"."MockAttempt"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."mock_attempt_requires_full_set_active"();

-- R4: an attempt must start in GENERATING. Playable states are reached only by
-- the UPDATE guarded by mock_attempt_requires_full_set_active above.
CREATE OR REPLACE FUNCTION "public"."mock_attempt_insert_must_generate"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW."status" <> 'GENERATING' THEN
        RAISE EXCEPTION 'R4: a MockAttempt must be inserted with status GENERATING';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "MockAttempt_insert_generating"
    BEFORE INSERT ON "public"."MockAttempt"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."mock_attempt_insert_must_generate"();

-- R7: question content and provenance are immutable. Only "status" may change
-- after insert (quarantine, retire, mark source unavailable). "jobId" may only
-- be cleared to NULL, because ON DELETE SET NULL on GenerationJob needs that.
CREATE OR REPLACE FUNCTION "public"."mock_question_content_immutable"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW."subjectId" IS DISTINCT FROM OLD."subjectId"
       OR NEW."topicId" IS DISTINCT FROM OLD."topicId"
       OR NEW."stem" IS DISTINCT FROM OLD."stem"
       OR NEW."leadIn" IS DISTINCT FROM OLD."leadIn"
       OR NEW."educationalObjective" IS DISTINCT FROM OLD."educationalObjective"
       OR NEW."draftModel" IS DISTINCT FROM OLD."draftModel"
       OR NEW."verifierModel" IS DISTINCT FROM OLD."verifierModel"
       OR NEW."promptVersion" IS DISTINCT FROM OLD."promptVersion"
       OR NEW."validatorVersion" IS DISTINCT FROM OLD."validatorVersion"
       OR NEW."verifierResult" IS DISTINCT FROM OLD."verifierResult" THEN
        RAISE EXCEPTION 'R7: MockQuestion content and provenance are immutable';
    END IF;

    IF NEW."jobId" IS DISTINCT FROM OLD."jobId"
       AND NEW."jobId" IS NOT NULL THEN
        RAISE EXCEPTION 'R7: MockQuestion.jobId may only be cleared to NULL';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "MockQuestion_content_immutable"
    BEFORE UPDATE ON "public"."MockQuestion"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."mock_question_content_immutable"();

-- R7: MockChoice rows are fully immutable after insert.
CREATE OR REPLACE FUNCTION "public"."mock_choice_immutable"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW."questionId" IS DISTINCT FROM OLD."questionId"
       OR NEW."position" IS DISTINCT FROM OLD."position"
       OR NEW."text" IS DISTINCT FROM OLD."text"
       OR NEW."isCorrect" IS DISTINCT FROM OLD."isCorrect"
       OR NEW."explanation" IS DISTINCT FROM OLD."explanation"
       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
        RAISE EXCEPTION 'R7: MockChoice rows are immutable';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "MockChoice_immutable"
    BEFORE UPDATE ON "public"."MockChoice"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."mock_choice_immutable"();

-- R7: a submitted AttemptResult is fully immutable after insert.
CREATE OR REPLACE FUNCTION "public"."attempt_result_immutable"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW."attemptId" IS DISTINCT FROM OLD."attemptId"
       OR NEW."score" IS DISTINCT FROM OLD."score"
       OR NEW."total" IS DISTINCT FROM OLD."total"
       OR NEW."snapshot" IS DISTINCT FROM OLD."snapshot"
       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
        RAISE EXCEPTION 'R7: AttemptResult is immutable';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "AttemptResult_immutable"
    BEFORE UPDATE ON "public"."AttemptResult"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."attempt_result_immutable"();

-- R7: citation content is immutable. "documentId" may only be cleared to NULL
-- (by ON DELETE SET NULL); it may never be reassigned to another document.
CREATE OR REPLACE FUNCTION "public"."question_citation_content_immutable"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW."questionId" IS DISTINCT FROM OLD."questionId"
       OR NEW."documentTitleSnapshot" IS DISTINCT FROM OLD."documentTitleSnapshot"
       OR NEW."pageNumber" IS DISTINCT FROM OLD."pageNumber"
       OR NEW."printedPage" IS DISTINCT FROM OLD."printedPage"
       OR NEW."quote" IS DISTINCT FROM OLD."quote" THEN
        RAISE EXCEPTION 'R7: QuestionCitation content is immutable';
    END IF;

    IF NEW."documentId" IS DISTINCT FROM OLD."documentId"
       AND NEW."documentId" IS NOT NULL THEN
        RAISE EXCEPTION 'R7: QuestionCitation.documentId may only be cleared to NULL';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "QuestionCitation_content_immutable"
    BEFORE UPDATE ON "public"."QuestionCitation"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."question_citation_content_immutable"();

-- No UPDATE-blocking trigger is added for DELETE: subject deletion cascades
-- must be able to remove these rows.

-- R8: an answer revision starts at 1 and only increases.
ALTER TABLE "public"."AttemptAnswer"
    ADD CONSTRAINT "AttemptAnswer_revision_check" CHECK ("revision" >= 1);

-- R9: attempt progress counters stay in their valid range.
-- cursorPosition 26 means "past the end" of the 25 questions.
ALTER TABLE "public"."MockAttempt"
    ADD CONSTRAINT "MockAttempt_sessionVersion_check" CHECK ("sessionVersion" >= 1);

ALTER TABLE "public"."MockAttempt"
    ADD CONSTRAINT "MockAttempt_cursorPosition_check" CHECK ("cursorPosition" BETWEEN 1 AND 26);

ALTER TABLE "public"."GenerationJob"
    ADD CONSTRAINT "GenerationJob_requestedCount_check" CHECK ("requestedCount" BETWEEN 1 AND 25);

ALTER TABLE "public"."GenerationJob"
    ADD CONSTRAINT "GenerationJob_acceptedCount_check" CHECK ("acceptedCount" BETWEEN 0 AND "requestedCount");

ALTER TABLE "public"."GenerationJob"
    ADD CONSTRAINT "GenerationJob_recoveryCount_check" CHECK ("recoveryCount" >= 0);

ALTER TABLE "public"."GenerationJob"
    ADD CONSTRAINT "GenerationJob_aiCallCount_check" CHECK ("aiCallCount" >= 0);

-- R10: citation pages are 1-based and positive.
ALTER TABLE "public"."QuestionCitation"
    ADD CONSTRAINT "QuestionCitation_pageNumber_check" CHECK ("pageNumber" > 0);

-- A result can never score outside its own total.
ALTER TABLE "public"."AttemptResult"
    ADD CONSTRAINT "AttemptResult_score_check" CHECK ("score" BETWEEN 0 AND "total");

COMMIT;
