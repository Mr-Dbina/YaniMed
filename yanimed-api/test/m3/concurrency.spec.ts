import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  assertDbError,
  createAnswerableAttempt,
  createAttempt,
  createFullAttempt,
  createGenerationJob,
  createSubject,
  prisma,
} from './helpers.js';

// Vitest's fileParallelism is off, so these tests never race each other for the
// same fixture. Each test uses its own Subject.
describe('M3 concurrency', () => {
  it('R1: 20 parallel attempt inserts yield exactly one unfinished attempt', async () => {
    const subject = await createSubject();

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        createAttempt(subject.id),
      ),
    );

    const fulfilled = results.filter(result => result.status === 'fulfilled');
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(19);
    for (const rejection of rejected) {
      assertDbError(
        rejection.reason,
        /MockAttempt_subjectId_active_key|23505|P2002|subjectId/,
      );
    }
  });

  it('R2: 20 parallel generation-job inserts yield exactly one active job', async () => {
    const subject = await createSubject();

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => createGenerationJob(subject.id, 'QUEUED')),
    );

    const fulfilled = results.filter(result => result.status === 'fulfilled');
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(19);
    for (const rejection of rejected) {
      assertDbError(
        rejection.reason,
        /GenerationJob_subjectId_active_key|23505|P2002|subjectId/,
      );
    }
  });

  it('R6: 20 parallel result inserts yield exactly one result', async () => {
    const subject = await createSubject();
    const { attempt } = await createFullAttempt(subject.id);
    await prisma.mockAttempt.update({
      where: { id: attempt.id },
      data: { status: 'COMPLETED' },
    });

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, index) =>
        prisma.attemptResult.create({
          data: {
            attemptId: attempt.id,
            score: 25 - index,
            total: 25,
            snapshot: { parallel: true },
          },
        }),
      ),
    );

    const fulfilled = results.filter(result => result.status === 'fulfilled');
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(19);
    for (const rejection of rejected) {
      assertDbError(
        rejection.reason,
        /AttemptResult_attemptId_key|attemptId|23505|P2002/,
      );
    }
  });

  it('R5: 20 parallel answer inserts yield exactly one answer', async () => {
    const subject = await createSubject();
    const { attemptQuestion, choice } = await createAnswerableAttempt(subject.id);

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        prisma.attemptAnswer.create({
          data: {
            attemptQuestionId: attemptQuestion.id,
            choiceId: choice.id,
            revision: 1,
            idempotencyKey: `ZZ-m3-answer-${randomUUID()}`,
          },
        }),
      ),
    );

    const fulfilled = results.filter(result => result.status === 'fulfilled');
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(19);
    for (const rejection of rejected) {
      assertDbError(
        rejection.reason,
        /AttemptAnswer_attemptQuestionId_key|attemptQuestionId|23505|P2002/,
      );
    }
  });

  it('R4: two parallel GENERATING -> READY transitions both settle and leave one READY attempt', async () => {
    const subject = await createSubject();
    const { attempt } = await createFullAttempt(subject.id);

    // Observed on Postgres row locking: the second UPDATE waits, then re-reads
    // the committed row. OLD.status is READY, so the R4 check is skipped and
    // both transactions succeed. The final state stays READY with 25 rows.
    const results = await Promise.allSettled([
      prisma.$transaction(tx =>
        tx.mockAttempt.update({
          where: { id: attempt.id },
          data: { status: 'READY' },
        }),
      ),
      prisma.$transaction(tx =>
        tx.mockAttempt.update({
          where: { id: attempt.id },
          data: { status: 'READY' },
        }),
      ),
    ]);

    expect(results.every(result => result.status === 'fulfilled')).toBe(true);
    const final = await prisma.mockAttempt.findUniqueOrThrow({
      where: { id: attempt.id },
    });
    expect(final.status).toBe('READY');
    expect(
      await prisma.attemptQuestion.count({ where: { attemptId: attempt.id } }),
    ).toBe(25);
  });

  it('R9: 20 parallel stale-session updates produce exactly one winning row count', async () => {
    const subject = await createSubject();
    const attempt = await createAttempt(subject.id);
    const expectedVersion = attempt.sessionVersion;

    const counts = await Promise.all(
      Array.from({ length: 20 }, () =>
        prisma.$executeRaw`
          UPDATE "MockAttempt"
             SET "sessionVersion" = "sessionVersion" + 1
           WHERE "id" = ${attempt.id}
             AND "sessionVersion" = ${expectedVersion}
        `,
      ),
    );

    expect(counts.filter(count => count === 1)).toHaveLength(1);
    expect(counts.filter(count => count === 0)).toHaveLength(19);

    const final = await prisma.mockAttempt.findUniqueOrThrow({
      where: { id: attempt.id },
    });
    expect(final.sessionVersion).toBe(expectedVersion + 1);
  });
});
