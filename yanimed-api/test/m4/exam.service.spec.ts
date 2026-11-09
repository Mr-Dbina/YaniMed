import { describe, expect, it } from 'vitest';
import {
  answerAll,
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
  wrongChoiceId,
} from './helpers.js';

// Keys that must never appear in an exam-safe response.
const FORBIDDEN_EXAM_KEYS = [
  'isCorrect',
  'explanation',
  'citation',
  'correctChoiceId',
];

function expectExamSafe(value: unknown): void {
  const json = JSON.stringify(value);
  for (const forbidden of FORBIDDEN_EXAM_KEYS) {
    expect(json).not.toContain(forbidden);
  }
}

function expectChoiceShape(choices: { id: string; letter: string; text: string }[]): void {
  for (const choice of choices) {
    expect(Object.keys(choice).sort()).toEqual(['id', 'letter', 'text']);
  }
}

describe('M4 exam service', () => {
  it('runs only against the throwaway test DB', () => {
    assertTestDb();
    expect(process.env.YANIMED_TEST_DB).toBe('1');
  });

  it('createAttempt: READY attempt with 25 stored rows and 6/6/6/7 answer letters', async () => {
    const { subject } = await createSubjectWithQuestions();
    const created = await service.createAttempt(subject.id, seededRng());

    expect(created.status).toBe('READY');

    const attempt = await prisma.mockAttempt.findUniqueOrThrow({
      where: { id: created.attemptId },
    });
    expect(attempt.status).toBe('READY');
    expect(attempt.sessionVersion).toBe(1);
    expect(attempt.cursorPosition).toBe(1);

    const rows = await getAttemptQuestions(created.attemptId);
    expect(rows).toHaveLength(25);
    expect(rows.map((row) => row.position)).toEqual(
      Array.from({ length: 25 }, (_, index) => index + 1),
    );

    const letterCounts = [0, 0, 0, 0];
    for (const row of rows) {
      expect(row.status).toBe('UNSEEN');
      expect(row.question.status).toBe('ACTIVE');
      expect([...row.choiceOrder].sort()).toEqual([1, 2, 3, 4]);

      const correct = row.question.choices.find((choice) => choice.isCorrect);
      expect(correct).toBeDefined();
      if (!correct) throw new Error('ZZ-m4 fixture has no correct choice.');

      const displayIndex = row.choiceOrder.indexOf(correct.position);
      expect(displayIndex).toBeGreaterThanOrEqual(0);
      expect(displayIndex).toBeLessThanOrEqual(3);
      letterCounts[displayIndex] += 1;
    }

    // 5..8 per letter and exactly one letter carries the extra question.
    expect(letterCounts.reduce((sum, count) => sum + count, 0)).toBe(25);
    for (const count of letterCounts) {
      expect(count).toBeGreaterThanOrEqual(5);
      expect(count).toBeLessThanOrEqual(8);
    }
    expect(letterCounts.filter((count) => count === 6)).toHaveLength(3);
    expect(letterCounts.filter((count) => count === 7)).toHaveLength(1);

    // At most two questions per topic; the fixture spreads 25 over 13 topics.
    const perTopic = new Map<string, number>();
    for (const row of rows) {
      perTopic.set(
        row.question.topicId,
        (perTopic.get(row.question.topicId) ?? 0) + 1,
      );
    }
    expect(perTopic.size).toBe(13);
    for (const count of perTopic.values()) expect(count).toBeLessThanOrEqual(2);

    // The correct stored position is displayed at its assigned letter.
    const started = await service.startAttempt(created.attemptId);
    const first = rows[0];
    const firstCorrect = first.question.choices.find(
      (choice) => choice.isCorrect,
    );
    if (!firstCorrect) throw new Error('ZZ-m4 fixture has no correct choice.');
    const firstIndex = first.choiceOrder.indexOf(firstCorrect.position);
    expect(started.question.position).toBe(1);
    expect(started.question.choices.map((choice) => choice.letter)).toEqual([
      'A',
      'B',
      'C',
      'D',
    ]);
    expect(started.question.choices[firstIndex].id).toBe(firstCorrect.id);
  });

  it('createAttempt: 24 ACTIVE questions -> INSUFFICIENT_CONTENT with counts', async () => {
    const { subject } = await createSubjectWithQuestions(24);

    await expect(
      service.createAttempt(subject.id, seededRng()),
    ).rejects.toMatchObject({
      code: 'INSUFFICIENT_CONTENT',
      details: { available: 24, required: 25 },
    });

    expect(
      await prisma.mockAttempt.count({ where: { subjectId: subject.id } }),
    ).toBe(0);
  });

  it('createAttempt: skips a question whose citations are all unavailable', async () => {
    const { subject } = await createSubjectWithQuestions(26);
    const questions = await prisma.mockQuestion.findMany({
      where: { subjectId: subject.id },
      orderBy: { id: 'asc' },
    });
    const excluded = questions[0];
    if (!excluded) throw new Error('ZZ-m4 fixture has no questions.');

    await prisma.questionCitation.create({
      data: {
        questionId: excluded.id,
        documentId: null,
        documentTitleSnapshot: 'ZZ-m4 unavailable',
        pageNumber: 1,
        quote: 'ZZ-m4 quote',
      },
    });

    const created = await service.createAttempt(subject.id, seededRng());
    const rows = await getAttemptQuestions(created.attemptId);

    expect(rows).toHaveLength(25);
    expect(rows.some((row) => row.questionId === excluded.id)).toBe(false);
  });

  it('createAttempt: second call -> ATTEMPT_EXISTS with the existing id', async () => {
    const { subject } = await createSubjectWithQuestions();
    const first = await service.createAttempt(subject.id, seededRng());

    await expect(
      service.createAttempt(subject.id, seededRng(1)),
    ).rejects.toMatchObject({
      code: 'ATTEMPT_EXISTS',
      attemptId: first.attemptId,
    });
  });

  it('startAttempt: increments sessionVersion; resume invalidates the older session', async () => {
    const { attemptId } = await createReadyAttempt();

    const first = await service.startAttempt(attemptId);
    expect(first.sessionVersion).toBe(2);
    expect(first.question.position).toBe(1);

    const resumed = await service.startAttempt(attemptId);
    expect(resumed.sessionVersion).toBe(3);

    const rows = await getAttemptQuestions(attemptId);
    const choiceId = correctChoiceId(rows[0]);

    await expect(
      service.answerQuestion(attemptId, {
        sessionVersion: first.sessionVersion,
        position: 1,
        choiceId,
        idempotencyKey: examKey(),
      }),
    ).rejects.toMatchObject({ code: 'SESSION_SUPERSEDED' });

    await expect(
      service.getCurrentQuestion(attemptId, first.sessionVersion),
    ).rejects.toMatchObject({ code: 'SESSION_SUPERSEDED' });

    const current = await service.getCurrentQuestion(
      attemptId,
      resumed.sessionVersion,
    );
    expect(current?.position).toBe(1);

    const accepted = await service.answerQuestion(attemptId, {
      sessionVersion: resumed.sessionVersion,
      position: 1,
      choiceId,
      idempotencyKey: examKey(),
    });
    expect(accepted.answeredCount).toBe(1);
  });

  it('answers Q1..Q25 in order and reaches AWAITING_SUBMISSION at cursor 26', async () => {
    const { attemptId } = await createReadyAttempt();
    const started = await service.startAttempt(attemptId);

    const last = await answerAll(
      attemptId,
      started.sessionVersion,
      correctChoiceId,
    );

    expect(last.status).toBe('AWAITING_SUBMISSION');
    expect(last.answeredCount).toBe(25);
    expect(last.nextQuestion).toBeNull();

    const attempt = await prisma.mockAttempt.findUniqueOrThrow({
      where: { id: attemptId },
    });
    expect(attempt.status).toBe('AWAITING_SUBMISSION');
    expect(attempt.cursorPosition).toBe(26);

    expect(
      await service.getCurrentQuestion(attemptId, started.sessionVersion),
    ).toBeNull();

    const navigator = await service.getReviewNavigator(
      attemptId,
      started.sessionVersion,
    );
    expect(navigator.status).toBe('AWAITING_SUBMISSION');
    expect(navigator.items).toHaveLength(25);
    expect(navigator.items.map((item) => item.position)).toEqual(
      Array.from({ length: 25 }, (_, index) => index + 1),
    );
    expect(navigator.items.every((item) => item.answered)).toBe(true);
    expect(
      navigator.items.every((item) => item.selectedChoiceId !== null),
    ).toBe(true);
  }, 120000);

  it('replays the identical answer as a no-op', async () => {
    const { attemptId } = await createReadyAttempt();
    const started = await service.startAttempt(attemptId);
    const rows = await getAttemptQuestions(attemptId);
    const choiceId = correctChoiceId(rows[0]);

    await service.answerQuestion(attemptId, {
      sessionVersion: started.sessionVersion,
      position: 1,
      choiceId,
      idempotencyKey: examKey(),
    });

    const replay = await service.answerQuestion(attemptId, {
      sessionVersion: started.sessionVersion,
      position: 1,
      choiceId,
      idempotencyKey: examKey(),
    });

    expect(replay.answeredCount).toBe(1);
    expect(replay.nextQuestion?.position).toBe(2);

    const stored = await prisma.attemptAnswer.findUniqueOrThrow({
      where: { attemptQuestionId: rows[0].id },
    });
    expect(stored.choiceId).toBe(choiceId);
    expect(stored.revision).toBe(1);
    expect(
      await prisma.attemptAnswer.count({
        where: { attemptQuestion: { attemptId } },
      }),
    ).toBe(1);
  });

  it('rejects a different choice while IN_PROGRESS with REVISION_CONFLICT', async () => {
    const { attemptId } = await createReadyAttempt();
    const started = await service.startAttempt(attemptId);
    const rows = await getAttemptQuestions(attemptId);

    await service.answerQuestion(attemptId, {
      sessionVersion: started.sessionVersion,
      position: 1,
      choiceId: correctChoiceId(rows[0]),
      idempotencyKey: examKey(),
    });

    await expect(
      service.answerQuestion(attemptId, {
        sessionVersion: started.sessionVersion,
        position: 1,
        choiceId: wrongChoiceId(rows[0]),
        idempotencyKey: examKey(),
      }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });

    const stored = await prisma.attemptAnswer.findUniqueOrThrow({
      where: { attemptQuestionId: rows[0].id },
    });
    expect(stored.choiceId).toBe(correctChoiceId(rows[0]));
    expect(stored.revision).toBe(1);
  });

  it('skips a question and revisits it after Q25', async () => {
    const { attemptId } = await createReadyAttempt();
    const started = await service.startAttempt(attemptId);
    const rows = await getAttemptQuestions(attemptId);

    const skipped = await service.skipQuestion(attemptId, {
      sessionVersion: started.sessionVersion,
      position: 1,
    });
    expect(skipped.status).toBe('IN_PROGRESS');
    expect(skipped.nextQuestion?.position).toBe(2);

    for (const row of rows.filter((candidate) => candidate.position >= 2)) {
      await service.answerQuestion(attemptId, {
        sessionVersion: started.sessionVersion,
        position: row.position,
        choiceId: correctChoiceId(row),
        idempotencyKey: examKey(),
      });
    }

    const afterLast = await prisma.mockAttempt.findUniqueOrThrow({
      where: { id: attemptId },
    });
    expect(afterLast.status).toBe('IN_PROGRESS');
    expect(afterLast.cursorPosition).toBe(1);

    const revisit = await service.answerQuestion(attemptId, {
      sessionVersion: started.sessionVersion,
      position: 1,
      choiceId: correctChoiceId(rows[0]),
      idempotencyKey: examKey(),
    });
    expect(revisit.status).toBe('AWAITING_SUBMISSION');
    expect(revisit.nextQuestion).toBeNull();
    expect(revisit.answeredCount).toBe(25);

    const stored = await prisma.attemptQuestion.findUniqueOrThrow({
      where: { id: rows[0].id },
    });
    expect(stored.status).toBe('ANSWERED');
  }, 120000);

  it('refuses a skip when no other UNSEEN question remains', async () => {
    const { attemptId } = await createReadyAttempt();
    const started = await service.startAttempt(attemptId);
    const rows = await getAttemptQuestions(attemptId);

    for (const row of rows.filter((candidate) => candidate.position <= 24)) {
      await service.answerQuestion(attemptId, {
        sessionVersion: started.sessionVersion,
        position: row.position,
        choiceId: correctChoiceId(row),
        idempotencyKey: examKey(),
      });
    }

    await expect(
      service.skipQuestion(attemptId, {
        sessionVersion: started.sessionVersion,
        position: 25,
      }),
    ).rejects.toMatchObject({ code: 'SKIP_NOT_ALLOWED' });

    // An answered question can never be skipped either.
    await expect(
      service.skipQuestion(attemptId, {
        sessionVersion: started.sessionVersion,
        position: 1,
      }),
    ).rejects.toMatchObject({ code: 'SKIP_NOT_ALLOWED' });
  });

  it('edits an answer in AWAITING_SUBMISSION and increments revision', async () => {
    const { subject } = await createSubjectWithQuestions();
    const seeded = await seedAttemptAtAwaitingSubmission(subject.id);
    const first = seeded.questions[0];

    const response = await service.answerQuestion(seeded.attemptId, {
      sessionVersion: seeded.sessionVersion,
      position: first.position,
      choiceId: first.wrongChoiceId,
      idempotencyKey: examKey(),
    });
    expect(response.status).toBe('AWAITING_SUBMISSION');
    expect(response.answeredCount).toBe(25);

    const stored = await prisma.attemptAnswer.findUniqueOrThrow({
      where: { attemptQuestionId: first.attemptQuestionId },
    });
    expect(stored.choiceId).toBe(first.wrongChoiceId);
    expect(stored.revision).toBe(2);

    const attempt = await prisma.mockAttempt.findUniqueOrThrow({
      where: { id: seeded.attemptId },
    });
    expect(attempt.status).toBe('AWAITING_SUBMISSION');

    const result = await service.submitAttempt(
      seeded.attemptId,
      seeded.sessionVersion,
      examKey(),
    );
    expect(result.score).toBe(24);
  });

  it('refuses submit before AWAITING_SUBMISSION and never auto-submits', async () => {
    const { attemptId } = await createReadyAttempt();
    const started = await service.startAttempt(attemptId);

    await expect(
      service.submitAttempt(attemptId, started.sessionVersion, examKey()),
    ).rejects.toMatchObject({ code: 'NOT_IN_PROGRESS' });

    // Seeded edit window with one unanswered question: submit must refuse and
    // write no result. A real attempt cannot reach AWAITING_SUBMISSION with an
    // unanswered question because the engine only does it when none remain.
    const { subject } = await createSubjectWithQuestions();
    const seeded = await seedAttemptAtAwaitingSubmission(
      subject.id,
      (question) =>
        question.position <= 24 ? question.correctChoiceId : null,
    );

    await expect(
      service.submitAttempt(seeded.attemptId, seeded.sessionVersion, examKey()),
    ).rejects.toMatchObject({ code: 'NOT_ALL_ANSWERED' });
    expect(
      await prisma.attemptResult.count({
        where: { attemptId: seeded.attemptId },
      }),
    ).toBe(0);
  });

  it('grades all-correct and mixed attempts and keeps the first result', async () => {
    const allCorrect = await createSubjectWithQuestions();
    const allSeed = await seedAttemptAtAwaitingSubmission(
      allCorrect.subject.id,
    );

    const first = await service.submitAttempt(
      allSeed.attemptId,
      allSeed.sessionVersion,
      examKey(),
    );
    expect(first).toMatchObject({
      attemptId: allSeed.attemptId,
      score: 25,
      total: 25,
      percentage: 100,
      correctCount: 25,
      incorrectCount: 0,
      unansweredCount: 0,
    });

    const replay = await service.submitAttempt(
      allSeed.attemptId,
      allSeed.sessionVersion,
      examKey(),
    );
    expect(replay.score).toBe(25);
    expect(
      await prisma.attemptResult.count({
        where: { attemptId: allSeed.attemptId },
      }),
    ).toBe(1);

    const mixed = await createSubjectWithQuestions();
    const mixedSeed = await seedAttemptAtAwaitingSubmission(
      mixed.subject.id,
      (question) =>
        question.position <= 5
          ? question.wrongChoiceId
          : question.correctChoiceId,
    );

    const graded = await service.submitAttempt(
      mixedSeed.attemptId,
      mixedSeed.sessionVersion,
      examKey(),
    );
    expect(graded).toMatchObject({
      score: 20,
      total: 25,
      percentage: 80,
      correctCount: 20,
      incorrectCount: 5,
      unansweredCount: 0,
    });
  });

  it('discardAttempt frees the subject slot', async () => {
    const { subject, attemptId } = await createReadyAttempt();

    const discarded = await service.discardAttempt(attemptId);
    expect(discarded).toEqual({ attemptId, status: 'ABANDONED' });

    const again = await service.createAttempt(subject.id, seededRng(7));
    expect(again.status).toBe('READY');
    expect(again.attemptId).not.toBe(attemptId);
  });

  it('getResult and getReview require COMPLETED', async () => {
    const { attemptId } = await createReadyAttempt();
    await service.startAttempt(attemptId);

    await expect(service.getResult(attemptId)).rejects.toMatchObject({
      code: 'NOT_IN_PROGRESS',
    });
    await expect(service.getReview(attemptId)).rejects.toMatchObject({
      code: 'NOT_IN_PROGRESS',
    });
    await expect(
      service.getResult('00000000-0000-0000-0000-000000000000'),
    ).rejects.toMatchObject({ code: 'ATTEMPT_NOT_FOUND' });
    await expect(
      service.getReview('00000000-0000-0000-0000-000000000000'),
    ).rejects.toMatchObject({ code: 'ATTEMPT_NOT_FOUND' });

    const { subject } = await createSubjectWithQuestions();
    const seeded = await seedAttemptAtAwaitingSubmission(subject.id);
    await service.submitAttempt(
      seeded.attemptId,
      seeded.sessionVersion,
      examKey(),
    );

    const result = await service.getResult(seeded.attemptId);
    expect(result.score).toBe(25);

    const review = await service.getReview(seeded.attemptId);
    expect(review.questions).toHaveLength(25);
    expect(review.score).toBe(25);

    // A completed attempt cannot be discarded.
    await expect(service.discardAttempt(seeded.attemptId)).rejects.toMatchObject({
      code: 'NOT_IN_PROGRESS',
    });
  });

  it('marks a QUARANTINED question under review without changing the score', async () => {
    const { subject } = await createSubjectWithQuestions();
    const seeded = await seedAttemptAtAwaitingSubmission(subject.id);
    await service.submitAttempt(
      seeded.attemptId,
      seeded.sessionVersion,
      examKey(),
    );

    const quarantinedQuestion = seeded.questions[0];
    await prisma.mockQuestion.update({
      where: { id: quarantinedQuestion.questionId },
      data: { status: 'QUARANTINED' },
    });

    const review = await service.getReview(seeded.attemptId);
    const quarantined = review.questions.find(
      (item) => item.position === quarantinedQuestion.position,
    );
    expect(quarantined?.underReview).toBe(true);
    expect(quarantined?.isCorrect).toBe(true);

    const others = review.questions.filter(
      (item) => item.position !== quarantinedQuestion.position,
    );
    expect(others.every((item) => item.underReview === false)).toBe(true);
    expect(review.score).toBe(25);
    expect(review.perTopic.length).toBeGreaterThan(0);
    expect((await service.getResult(seeded.attemptId)).score).toBe(25);
  });

  it('rejects unknown attempts, unknown positions, and foreign choices', async () => {
    const { attemptId } = await createReadyAttempt();
    const started = await service.startAttempt(attemptId);
    const rows = await getAttemptQuestions(attemptId);
    const stranger = '00000000-0000-0000-0000-000000000000';

    await expect(
      service.answerQuestion(attemptId, {
        sessionVersion: started.sessionVersion,
        position: 1,
        choiceId: correctChoiceId(rows[1]),
        idempotencyKey: examKey(),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CHOICE' });

    await expect(
      service.answerQuestion(attemptId, {
        sessionVersion: started.sessionVersion,
        position: 26,
        choiceId: correctChoiceId(rows[0]),
        idempotencyKey: examKey(),
      }),
    ).rejects.toMatchObject({ code: 'QUESTION_NOT_FOUND' });

    await expect(
      service.answerQuestion(stranger, {
        sessionVersion: started.sessionVersion,
        position: 1,
        choiceId: correctChoiceId(rows[0]),
        idempotencyKey: examKey(),
      }),
    ).rejects.toMatchObject({ code: 'ATTEMPT_NOT_FOUND' });

    await expect(
      service.skipQuestion(stranger, {
        sessionVersion: started.sessionVersion,
        position: 1,
      }),
    ).rejects.toMatchObject({ code: 'ATTEMPT_NOT_FOUND' });
  });

  it('refuses submit with an unanswered question and refuses to edit it in', async () => {
    const { subject } = await createSubjectWithQuestions();
    const seeded = await seedAttemptAtAwaitingSubmission(
      subject.id,
      (question) =>
        question.position <= 24 ? question.correctChoiceId : null,
    );
    const missing = seeded.questions[24];

    await expect(
      service.answerQuestion(seeded.attemptId, {
        sessionVersion: seeded.sessionVersion,
        position: missing.position,
        choiceId: missing.correctChoiceId,
        idempotencyKey: examKey(),
      }),
    ).rejects.toMatchObject({ code: 'NOT_EDITABLE' });

    await expect(
      service.submitAttempt(seeded.attemptId, seeded.sessionVersion, examKey()),
    ).rejects.toMatchObject({ code: 'NOT_ALL_ANSWERED' });
    expect(
      await prisma.attemptResult.count({
        where: { attemptId: seeded.attemptId },
      }),
    ).toBe(0);
  });

  it('contract: exam-safe responses never leak keys inside the choice shape', async () => {
    const { attemptId } = await createReadyAttempt();
    const started = await service.startAttempt(attemptId);

    expectExamSafe(started.question);
    expectChoiceShape(started.question.choices);

    const rows = await getAttemptQuestions(attemptId);
    const answered = await service.answerQuestion(attemptId, {
      sessionVersion: started.sessionVersion,
      position: 1,
      choiceId: correctChoiceId(rows[0]),
      idempotencyKey: examKey(),
    });
    expectExamSafe(answered);
    expect(answered.nextQuestion).not.toBeNull();
    if (answered.nextQuestion) {
      expectChoiceShape(answered.nextQuestion.choices);
    }

    for (const row of rows.filter((candidate) => candidate.position >= 2)) {
      await service.answerQuestion(attemptId, {
        sessionVersion: started.sessionVersion,
        position: row.position,
        choiceId: correctChoiceId(row),
        idempotencyKey: examKey(),
      });
    }

    const navigator = await service.getReviewNavigator(
      attemptId,
      started.sessionVersion,
    );
    expectExamSafe(navigator);
    for (const item of navigator.items) {
      expect(Object.keys(item).sort()).toEqual([
        'answered',
        'position',
        'selectedChoiceId',
      ]);
    }
  }, 120000);
});
