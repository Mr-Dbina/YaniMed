import { describe, expect, it } from 'vitest';
import type { ResultDto } from '../../src/mock-test/exam.dto.js';
import {
  assertTestDb,
  correctChoiceId,
  createReadyAttempt,
  createSubjectWithQuestions,
  examKey,
  getAttemptQuestions,
  prisma,
  seedAttemptAtAwaitingSubmission,
  seededRng,
  service,
} from './helpers.js';

async function createAwaitingAttempt() {
  const { subject } = await createSubjectWithQuestions();
  return seedAttemptAtAwaitingSubmission(subject.id);
}

/** Stable reason codes or class names with counts, never row data. */
function rejectionCounts(
  results: PromiseSettledResult<unknown>[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const result of results) {
    if (result.status !== 'rejected') continue;
    const reason = result.reason as
      | { code?: unknown; name?: unknown }
      | undefined;
    const key =
      reason && typeof reason.code === 'string'
        ? reason.code
        : reason && typeof reason.name === 'string'
          ? reason.name
          : 'unknown';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

describe('M4 exam concurrency', () => {
  it('runs only against the throwaway test DB', () => {
    assertTestDb();
    expect(process.env.YANIMED_TEST_DB).toBe('1');
  });

  it('20 parallel submits create exactly one AttemptResult and return one score', async () => {
    const { attemptId, sessionVersion } = await createAwaitingAttempt();

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        service.submitAttempt(attemptId, sessionVersion, examKey()),
      ),
    );

    const rejected = rejectionCounts(results);
    expect(
      Object.keys(rejected),
      `rejection reasons: ${JSON.stringify(rejected)}`,
    ).toEqual([]);

    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<ResultDto> =>
        result.status === 'fulfilled',
    );
    expect(fulfilled).toHaveLength(20);
    expect(new Set(fulfilled.map((result) => result.value.score))).toEqual(
      new Set([25]),
    );
    expect(
      await prisma.attemptResult.count({ where: { attemptId } }),
    ).toBe(1);
  });

  it('20 parallel identical answers create exactly one AttemptAnswer', async () => {
    const { attemptId } = await createReadyAttempt();
    const started = await service.startAttempt(attemptId);
    const rows = await getAttemptQuestions(attemptId);
    const choiceId = correctChoiceId(rows[0]);

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        service.answerQuestion(attemptId, {
          sessionVersion: started.sessionVersion,
          position: rows[0].position,
          choiceId,
          idempotencyKey: examKey(),
        }),
      ),
    );

    const rejected = rejectionCounts(results);
    expect(
      Object.keys(rejected),
      `rejection reasons: ${JSON.stringify(rejected)}`,
    ).toEqual([]);
    expect(
      await prisma.attemptAnswer.count({
        where: { attemptQuestion: { attemptId } },
      }),
    ).toBe(1);

    const stored = await prisma.attemptAnswer.findUniqueOrThrow({
      where: { attemptQuestionId: rows[0].id },
    });
    expect(stored.choiceId).toBe(choiceId);
    expect(stored.revision).toBe(1);
  });

  it('20 parallel createAttempt calls yield one attempt and 19 ATTEMPT_EXISTS', async () => {
    const { subject } = await createSubjectWithQuestions();

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, index) =>
        service.createAttempt(subject.id, seededRng(1000 + index)),
      ),
    );

    const fulfilled = results.filter(
      (
        result,
      ): result is PromiseFulfilledResult<{ attemptId: string; status: 'READY' }> =>
        result.status === 'fulfilled',
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult =>
        result.status === 'rejected',
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(19);

    const winner = fulfilled[0].value.attemptId;
    for (const rejection of rejected) {
      expect(rejection.reason).toMatchObject({
        code: 'ATTEMPT_EXISTS',
        attemptId: winner,
      });
    }

    expect(
      await prisma.mockAttempt.count({
        where: {
          subjectId: subject.id,
          status: {
            in: ['GENERATING', 'READY', 'IN_PROGRESS', 'AWAITING_SUBMISSION'],
          },
        },
      }),
    ).toBe(1);
    expect(
      await prisma.attemptQuestion.count({
        where: { attempt: { subjectId: subject.id } },
      }),
    ).toBe(25);
  });

  it('two sessions racing answers accept only the latest sessionVersion', async () => {
    const { attemptId } = await createReadyAttempt();
    const first = await service.startAttempt(attemptId);
    const second = await service.startAttempt(attemptId);
    const rows = await getAttemptQuestions(attemptId);
    const choiceId = correctChoiceId(rows[0]);

    const [older, newer] = await Promise.allSettled([
      service.answerQuestion(attemptId, {
        sessionVersion: first.sessionVersion,
        position: 1,
        choiceId,
        idempotencyKey: examKey(),
      }),
      service.answerQuestion(attemptId, {
        sessionVersion: second.sessionVersion,
        position: 1,
        choiceId,
        idempotencyKey: examKey(),
      }),
    ]);

    expect(older.status).toBe('rejected');
    if (older.status === 'rejected') {
      expect(older.reason).toMatchObject({ code: 'SESSION_SUPERSEDED' });
    }
    expect(newer.status).toBe('fulfilled');
    expect(
      await prisma.attemptAnswer.count({
        where: { attemptQuestion: { attemptId } },
      }),
    ).toBe(1);
  });
});
