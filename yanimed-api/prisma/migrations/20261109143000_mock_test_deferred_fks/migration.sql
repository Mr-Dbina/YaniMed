-- Mock Test deferred foreign keys (additive only).
-- Makes three ON DELETE NO ACTION foreign keys DEFERRABLE INITIALLY DEFERRED.
--
-- Plain NO ACTION is checked at the end of the statement. A whole-Subject
-- delete can therefore hit one of these checks before the cascade from
-- MockAttempt, MockAttempt -> AttemptQuestion, or GenerationJob has removed
-- the dependent rows. Deferring the check to COMMIT lets the cascade remove
-- every dependent row first.
--
-- A standalone delete of a referenced MockQuestion, MockChoice or Document
-- still fails: the check runs at COMMIT and the referenced row is gone.
--
-- Prisma cannot model deferrability, so prisma/schema.prisma stays unchanged.

BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

-- AttemptQuestion.questionId -> MockQuestion: a Subject delete cascades
-- MockQuestion and MockAttempt -> AttemptQuestion; the check must wait for
-- both to finish.
ALTER TABLE "public"."AttemptQuestion"
    ALTER CONSTRAINT "AttemptQuestion_questionId_fkey" DEFERRABLE INITIALLY DEFERRED;

-- AttemptAnswer.choiceId -> MockChoice: a Subject delete cascades MockChoice
-- and MockAttempt -> AttemptQuestion -> AttemptAnswer; the check must wait
-- for both to finish.
ALTER TABLE "public"."AttemptAnswer"
    ALTER CONSTRAINT "AttemptAnswer_choiceId_fkey" DEFERRABLE INITIALLY DEFERRED;

-- GenerationJobDocument.documentId -> Document: a Subject delete cascades
-- Document and GenerationJob -> GenerationJobDocument; the check must wait
-- for both to finish.
ALTER TABLE "public"."GenerationJobDocument"
    ALTER CONSTRAINT "GenerationJobDocument_documentId_fkey" DEFERRABLE INITIALLY DEFERRED;

COMMIT;
