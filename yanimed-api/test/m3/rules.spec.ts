import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  addAttemptQuestions,
  assertTestDb,
  assertDbError,
  choiceData,
  createAnswerableAttempt,
  createAttempt,
  createCitation,
  createDocument,
  createFullAttempt,
  createGenerationJob,
  createPlayableAttempt,
  createQuestion,
  createQuestions,
  createSubject,
  createTopic,
  expectDbError,
  prisma,
  questionData,
} from './helpers.js';

describe('M3 test environment guard', () => {
  it('runs only after the test env loader set YANIMED_TEST_DB=1', () => {
    expect(process.env.YANIMED_TEST_DB).toBe('1');
    expect(() => assertTestDb()).not.toThrow();
  });
});

describe('R1 one unfinished attempt per subject', () => {
  it('R1 rejects a second unfinished attempt for the same subject', async () => {
    const subject = await createSubject();
    await createAttempt(subject.id);

    await expectDbError(
      prisma.mockAttempt.create({
        data: { subjectId: subject.id, status: 'GENERATING' },
      }),
      /MockAttempt_subjectId_active_key|23505|P2002/,
    );
  });

  it('R1 allows a new attempt after the previous one is ABANDONED', async () => {
    const subject = await createSubject();
    const first = await createAttempt(subject.id);
    await prisma.mockAttempt.update({
      where: { id: first.id },
      data: { status: 'ABANDONED' },
    });

    const second = await createAttempt(subject.id);
    expect(second.status).toBe('GENERATING');
  });
});

describe('R2 one active generation job per subject', () => {
  it('R2 rejects a second active generation job for the same subject', async () => {
    const subject = await createSubject();
    await createGenerationJob(subject.id, 'QUEUED');

    await expectDbError(
      createGenerationJob(subject.id, 'QUEUED'),
      /GenerationJob_subjectId_active_key|23505|P2002/,
    );
  });

  it('R2 allows a new job after the previous job COMPLETED', async () => {
    const subject = await createSubject();
    await createGenerationJob(subject.id, 'COMPLETED');

    const next = await createGenerationJob(subject.id, 'QUEUED');
    expect(next.state).toBe('QUEUED');
  });
});

describe('R3 four choices, one correct, set checked at commit', () => {
  it('R3 accepts exactly four choices with exactly one correct', async () => {
    const subject = await createSubject();
    const question = await createQuestion({ subjectId: subject.id });

    expect(question.choices).toHaveLength(4);
    expect(question.choices.filter(choice => choice.isCorrect)).toHaveLength(1);
  });

  it('R3 rejects a choice position outside 1..4', async () => {
    const subject = await createSubject();
    const question = await createQuestion({ subjectId: subject.id });

    await expectDbError(
      prisma.mockChoice.create({ data: choiceData(question.id, 5) }),
      /MockChoice_position_check/,
    );
  });

  it('R3 rejects a duplicate choice position', async () => {
    const subject = await createSubject();
    const question = await createQuestion({ subjectId: subject.id });

    await expectDbError(
      prisma.mockChoice.create({ data: choiceData(question.id, 1) }),
      /MockChoice_questionId_position_key|23505|P2002/,
    );
  });

  it('R3 rejects a question that commits with only three choices', async () => {
    const subject = await createSubject();
    const topic = await createTopic(subject.id);

    await expectDbError(
      prisma.$transaction(
        async tx => {
          const question = await tx.mockQuestion.create({
            data: questionData(subject.id, topic.id),
          });
          await tx.mockChoice.createMany({
            data: [1, 2, 3].map(position => choiceData(question.id, position)),
          });
        },
        { timeout: 20000 },
      ),
      /R3/,
    );
  });

  it('R3 rejects a question whose choices arrive in separate transactions', async () => {
    const subject = await createSubject();
    const topic = await createTopic(subject.id);

    // The first commit sees one choice and fails; the next transaction cannot help.
    await expectDbError(
      prisma.$transaction(
        async tx => {
          const question = await tx.mockQuestion.create({
            data: questionData(subject.id, topic.id),
          });
          await tx.mockChoice.create({ data: choiceData(question.id, 1) });
        },
        { timeout: 20000 },
      ),
      /R3/,
    );
  });

  it('R3 rejects two correct choices for one question', async () => {
    const subject = await createSubject();
    const topic = await createTopic(subject.id);

    await expectDbError(
      prisma.$transaction(
        async tx => {
          const question = await tx.mockQuestion.create({
            data: questionData(subject.id, topic.id),
          });
          await tx.mockChoice.createMany({
            data: [
              choiceData(question.id, 1, true),
              choiceData(question.id, 2, true),
            ],
          });
        },
        { timeout: 20000 },
      ),
      /MockChoice_questionId_correct_key|23505|P2002/,
    );
  });
});

describe('R4 25 questions and playable-state transitions', () => {
  it('R4 rejects a MockAttempt inserted directly as READY', async () => {
    const subject = await createSubject();

    await expectDbError(
      prisma.mockAttempt.create({
        data: { subjectId: subject.id, status: 'READY' },
      }),
      /R4: a MockAttempt must be inserted with status GENERATING/,
    );
  });

  it('R4 rejects an attempt question position outside 1..25', async () => {
    const subject = await createSubject();
    const attempt = await createAttempt(subject.id);
    const question = await createQuestion({ subjectId: subject.id });

    await expectDbError(
      prisma.attemptQuestion.create({
        data: {
          attemptId: attempt.id,
          questionId: question.id,
          position: 26,
          choiceOrder: [1, 2, 3, 4],
        },
      }),
      /AttemptQuestion_position_check/,
    );
  });

  it('R4 rejects duplicate attempt question positions', async () => {
    const subject = await createSubject();
    const attempt = await createAttempt(subject.id);
    const questions = await createQuestions(subject.id, 2);

    await prisma.attemptQuestion.create({
      data: {
        attemptId: attempt.id,
        questionId: questions[0].id,
        position: 1,
        choiceOrder: [1, 2, 3, 4],
      },
    });

    await expectDbError(
      prisma.attemptQuestion.create({
        data: {
          attemptId: attempt.id,
          questionId: questions[1].id,
          position: 1,
          choiceOrder: [1, 2, 3, 4],
        },
      }),
      /AttemptQuestion_attemptId_position_key|23505|P2002/,
    );
  });

  it('R4 rejects the same question twice in one attempt', async () => {
    const subject = await createSubject();
    const attempt = await createAttempt(subject.id);
    const question = await createQuestion({ subjectId: subject.id });

    await prisma.attemptQuestion.create({
      data: {
        attemptId: attempt.id,
        questionId: question.id,
        position: 1,
        choiceOrder: [1, 2, 3, 4],
      },
    });

    await expectDbError(
      prisma.attemptQuestion.create({
        data: {
          attemptId: attempt.id,
          questionId: question.id,
          position: 2,
          choiceOrder: [1, 2, 3, 4],
        },
      }),
      /AttemptQuestion_attemptId_questionId_key|23505|P2002/,
    );
  });

  it('R4 rejects leaving GENERATING with fewer than 25 questions', async () => {
    const subject = await createSubject();
    const attempt = await createAttempt(subject.id);
    const question = await createQuestion({ subjectId: subject.id });
    await addAttemptQuestions(attempt.id, [question.id]);

    await expectDbError(
      prisma.mockAttempt.update({
        where: { id: attempt.id },
        data: { status: 'READY' },
      }),
      /R4/,
    );
  });

  it('R4 rejects leaving GENERATING when a question is not ACTIVE', async () => {
    const subject = await createSubject();
    const { attempt, questions } = await createFullAttempt(subject.id);

    await prisma.mockQuestion.update({
      where: { id: questions[0].id },
      data: { status: 'QUARANTINED' },
    });

    await expectDbError(
      prisma.mockAttempt.update({
        where: { id: attempt.id },
        data: { status: 'READY' },
      }),
      /R4/,
    );
  });

  it('R4 allows READY once 25 ACTIVE questions exist', async () => {
    const subject = await createSubject();
    const { attempt } = await createPlayableAttempt(subject.id);

    expect(attempt.status).toBe('READY');
    expect(
      await prisma.attemptQuestion.count({ where: { attemptId: attempt.id } }),
    ).toBe(25);
  });
});

describe('R5 one answer per attempt question', () => {
  it('R5 rejects a second answer for the same attempt question', async () => {
    const subject = await createSubject();
    const { attemptQuestion, choice } = await createAnswerableAttempt(subject.id);

    await prisma.attemptAnswer.create({
      data: {
        attemptQuestionId: attemptQuestion.id,
        choiceId: choice.id,
        revision: 1,
        idempotencyKey: `ZZ-m3-answer-${randomUUID()}`,
      },
    });

    await expectDbError(
      prisma.attemptAnswer.create({
        data: {
          attemptQuestionId: attemptQuestion.id,
          choiceId: choice.id,
          revision: 1,
          idempotencyKey: `ZZ-m3-answer-${randomUUID()}`,
        },
      }),
      /AttemptAnswer_attemptQuestionId_key|attemptQuestionId|23505|P2002/,
    );
  });
});

describe('R6 one result per attempt', () => {
  it('R6 rejects a second result for the same attempt', async () => {
    const subject = await createSubject();
    const attempt = await createAttempt(subject.id);

    await prisma.attemptResult.create({
      data: { attemptId: attempt.id, score: 20, total: 25, snapshot: { run: 1 } },
    });

    await expectDbError(
      prisma.attemptResult.create({
        data: { attemptId: attempt.id, score: 21, total: 25, snapshot: { run: 2 } },
      }),
      /AttemptResult_attemptId_key|attemptId|23505|P2002/,
    );
  });
});

describe('R7 immutable question content and snapshots', () => {
  it('R7 rejects MockQuestion stem changes', async () => {
    const subject = await createSubject();
    const question = await createQuestion({ subjectId: subject.id });

    await expectDbError(
      prisma.mockQuestion.update({
        where: { id: question.id },
        data: { stem: 'changed after generation' },
      }),
      /R7: MockQuestion content and provenance are immutable/,
    );
  });

  it('R7 rejects MockQuestion leadIn changes, including NULL to text', async () => {
    const subject = await createSubject();
    const question = await createQuestion({ subjectId: subject.id });

    await expectDbError(
      prisma.mockQuestion.update({
        where: { id: question.id },
        data: { leadIn: 'late lead-in' },
      }),
      /R7: MockQuestion content and provenance are immutable/,
    );
  });

  it('R7 allows MockQuestion status changes', async () => {
    const subject = await createSubject();
    const question = await createQuestion({ subjectId: subject.id });

    const updated = await prisma.mockQuestion.update({
      where: { id: question.id },
      data: { status: 'RETIRED' },
    });
    expect(updated.status).toBe('RETIRED');
  });

  it('R7 allows GenerationJob deletion to clear MockQuestion.jobId to NULL', async () => {
    const subject = await createSubject();
    const job = await createGenerationJob(subject.id, 'COMPLETED');
    const question = await createQuestion({ subjectId: subject.id, jobId: job.id });

    await prisma.generationJob.delete({ where: { id: job.id } });

    const after = await prisma.mockQuestion.findUniqueOrThrow({
      where: { id: question.id },
    });
    expect(after.jobId).toBeNull();
  });

  it('R7 rejects MockChoice updates', async () => {
    const subject = await createSubject();
    const question = await createQuestion({ subjectId: subject.id });

    await expectDbError(
      prisma.mockChoice.update({
        where: { id: question.choices[0].id },
        data: { text: 'changed choice text' },
      }),
      /R7: MockChoice rows are immutable/,
    );
  });

  it('R7 rejects AttemptResult updates', async () => {
    const subject = await createSubject();
    const attempt = await createAttempt(subject.id);
    const result = await prisma.attemptResult.create({
      data: { attemptId: attempt.id, score: 20, total: 25, snapshot: { run: 1 } },
    });

    await expectDbError(
      prisma.attemptResult.update({
        where: { id: result.id },
        data: { score: 24 },
      }),
      /R7: AttemptResult is immutable/,
    );
  });

  it('R7 rejects QuestionCitation content updates', async () => {
    const subject = await createSubject();
    const question = await createQuestion({ subjectId: subject.id });
    const document = await createDocument(subject.id);
    const citation = await createCitation(question.id, document.id);

    await expectDbError(
      prisma.questionCitation.update({
        where: { id: citation.id },
        data: { quote: 'changed quote' },
      }),
      /R7: QuestionCitation content is immutable/,
    );
  });

  it('R7 allows QuestionCitation.documentId to clear to NULL', async () => {
    const subject = await createSubject();
    const question = await createQuestion({ subjectId: subject.id });
    const document = await createDocument(subject.id);
    const citation = await createCitation(question.id, document.id);

    const cleared = await prisma.questionCitation.update({
      where: { id: citation.id },
      data: { documentId: null },
    });
    expect(cleared.documentId).toBeNull();
  });

  it('R7 does not block DELETE', async () => {
    const subject = await createSubject();
    const question = await createQuestion({ subjectId: subject.id });

    await prisma.mockQuestion.delete({ where: { id: question.id } });

    expect(
      await prisma.mockQuestion.findUnique({ where: { id: question.id } }),
    ).toBeNull();
  });
});

describe('R8 answer revision', () => {
  it('R8 rejects revision 0', async () => {
    const subject = await createSubject();
    const { attemptQuestion, choice } = await createAnswerableAttempt(subject.id);

    await expectDbError(
      prisma.attemptAnswer.create({
        data: {
          attemptQuestionId: attemptQuestion.id,
          choiceId: choice.id,
          revision: 0,
          idempotencyKey: `ZZ-m3-answer-${randomUUID()}`,
        },
      }),
      /AttemptAnswer_revision_check|revision/,
    );
  });
});

describe('R9 counter ranges', () => {
  it('R9 rejects sessionVersion 0', async () => {
    const subject = await createSubject();

    await expectDbError(
      prisma.mockAttempt.create({
        data: { subjectId: subject.id, status: 'GENERATING', sessionVersion: 0 },
      }),
      /MockAttempt_sessionVersion_check|sessionVersion/,
    );
  });

  it('R9 rejects cursorPosition below 1', async () => {
    const subject = await createSubject();

    await expectDbError(
      prisma.mockAttempt.create({
        data: { subjectId: subject.id, status: 'GENERATING', cursorPosition: 0 },
      }),
      /MockAttempt_cursorPosition_check|cursorPosition/,
    );
  });

  it('R9 rejects cursorPosition past 26', async () => {
    const subject = await createSubject();

    await expectDbError(
      prisma.mockAttempt.create({
        data: { subjectId: subject.id, status: 'GENERATING', cursorPosition: 27 },
      }),
      /MockAttempt_cursorPosition_check|cursorPosition/,
    );
  });

  it('R9 rejects requestedCount 0', async () => {
    const subject = await createSubject();

    await expectDbError(
      prisma.generationJob.create({
        data: {
          subjectId: subject.id,
          state: 'QUEUED',
          requestedCount: 0,
          idempotencyKey: `ZZ-m3-job-${randomUUID()}`,
        },
      }),
      /GenerationJob_requestedCount_check|requestedCount/,
    );
  });

  it('R9 rejects requestedCount above 25', async () => {
    const subject = await createSubject();

    await expectDbError(
      prisma.generationJob.create({
        data: {
          subjectId: subject.id,
          state: 'QUEUED',
          requestedCount: 26,
          idempotencyKey: `ZZ-m3-job-${randomUUID()}`,
        },
      }),
      /GenerationJob_requestedCount_check|requestedCount/,
    );
  });

  it('R9 rejects acceptedCount above requestedCount', async () => {
    const subject = await createSubject();

    await expectDbError(
      prisma.generationJob.create({
        data: {
          subjectId: subject.id,
          state: 'QUEUED',
          requestedCount: 5,
          acceptedCount: 6,
          idempotencyKey: `ZZ-m3-job-${randomUUID()}`,
        },
      }),
      /GenerationJob_acceptedCount_check|acceptedCount/,
    );
  });

  it('R9 rejects negative recoveryCount', async () => {
    const subject = await createSubject();

    await expectDbError(
      prisma.generationJob.create({
        data: {
          subjectId: subject.id,
          state: 'QUEUED',
          recoveryCount: -1,
          idempotencyKey: `ZZ-m3-job-${randomUUID()}`,
        },
      }),
      /GenerationJob_recoveryCount_check|recoveryCount/,
    );
  });

  it('R9 rejects negative aiCallCount', async () => {
    const subject = await createSubject();

    await expectDbError(
      prisma.generationJob.create({
        data: {
          subjectId: subject.id,
          state: 'QUEUED',
          aiCallCount: -1,
          idempotencyKey: `ZZ-m3-job-${randomUUID()}`,
        },
      }),
      /GenerationJob_aiCallCount_check|aiCallCount/,
    );
  });

  it('R9 allows acceptedCount equal to requestedCount (25)', async () => {
    const subject = await createSubject();

    const job = await prisma.generationJob.create({
      data: {
        subjectId: subject.id,
        state: 'QUEUED',
        requestedCount: 25,
        acceptedCount: 25,
        idempotencyKey: `ZZ-m3-job-${randomUUID()}`,
      },
    });
    expect(job.requestedCount).toBe(25);
  });
});

describe('R10 citation pages and result score', () => {
  it('R10 rejects QuestionCitation.pageNumber 0', async () => {
    const subject = await createSubject();
    const question = await createQuestion({ subjectId: subject.id });

    await expectDbError(
      prisma.questionCitation.create({
        data: {
          questionId: question.id,
          documentId: null,
          documentTitleSnapshot: 'ZZ-m3 document',
          pageNumber: 0,
          quote: 'ZZ-m3 quote',
        },
      }),
      /QuestionCitation_pageNumber_check|pageNumber/,
    );
  });

  it('R10 rejects a score above total', async () => {
    const subject = await createSubject();
    const attempt = await createAttempt(subject.id);

    await expectDbError(
      prisma.attemptResult.create({
        data: { attemptId: attempt.id, score: 26, total: 25, snapshot: {} },
      }),
      /AttemptResult_score_check|score/,
    );
  });

  it('R10 rejects a negative score', async () => {
    const subject = await createSubject();
    const attempt = await createAttempt(subject.id);

    await expectDbError(
      prisma.attemptResult.create({
        data: { attemptId: attempt.id, score: -1, total: 25, snapshot: {} },
      }),
      /AttemptResult_score_check|score/,
    );
  });

  it('R10 allows score equal to total', async () => {
    const subject = await createSubject();
    const attempt = await createAttempt(subject.id);

    const result = await prisma.attemptResult.create({
      data: { attemptId: attempt.id, score: 25, total: 25, snapshot: {} },
    });
    expect(result.score).toBe(result.total);
  });
});

describe('Subject cascade', () => {
  it('deletes every Mock Test row through the Subject cascade', async () => {
    const subject = await createSubject();
    const { attempt, questions } = await createFullAttempt(subject.id);
    const attemptQuestions = await prisma.attemptQuestion.findMany({
      where: { attemptId: attempt.id },
      orderBy: { position: 'asc' },
    });
    const choice = await prisma.mockChoice.findFirstOrThrow({
      where: { questionId: questions[0].id },
    });
    const answer = await prisma.attemptAnswer.create({
      data: {
        attemptQuestionId: attemptQuestions[0].id,
        choiceId: choice.id,
        revision: 1,
        idempotencyKey: `ZZ-m3-answer-${randomUUID()}`,
      },
    });
    const result = await prisma.attemptResult.create({
      data: { attemptId: attempt.id, score: 20, total: 25, snapshot: {} },
    });
    const report = await prisma.questionReport.create({
      data: {
        attemptId: attempt.id,
        questionId: questions[0].id,
        reason: 'AMBIGUITY',
      },
    });
    const document = await createDocument(subject.id);
    const citation = await createCitation(questions[1].id, document.id);
    // A COMPLETED job is outside the R2 active-job partial unique index.
    const job = await createGenerationJob(subject.id, 'COMPLETED');
    const jobDocument = await prisma.generationJobDocument.create({
      data: { jobId: job.id, documentId: document.id },
    });

    // The three deferred foreign keys (AttemptQuestion_questionId_fkey,
    // AttemptAnswer_choiceId_fkey, GenerationJobDocument_documentId_fkey)
    // are checked at COMMIT, so every cascade can finish first.
    await prisma.subject.delete({ where: { id: subject.id } });

    expect(await prisma.subject.findUnique({ where: { id: subject.id } })).toBeNull();
    expect(await prisma.subjectTopic.count({ where: { subjectId: subject.id } })).toBe(0);
    expect(await prisma.generationJob.count({ where: { subjectId: subject.id } })).toBe(0);
    expect(await prisma.mockQuestion.count({ where: { subjectId: subject.id } })).toBe(0);
    expect(await prisma.mockAttempt.count({ where: { subjectId: subject.id } })).toBe(0);
    expect(
      await prisma.generationJobDocument.findUnique({
        where: {
          jobId_documentId: { jobId: jobDocument.jobId, documentId: jobDocument.documentId },
        },
      }),
    ).toBeNull();
    expect(
      await prisma.mockChoice.count({
        where: { questionId: { in: questions.map(question => question.id) } },
      }),
    ).toBe(0);
    expect(
      await prisma.questionCitation.findUnique({ where: { id: citation.id } }),
    ).toBeNull();
    expect(
      await prisma.questionReport.findUnique({ where: { id: report.id } }),
    ).toBeNull();
    expect(
      await prisma.attemptQuestion.count({ where: { attemptId: attempt.id } }),
    ).toBe(0);
    expect(await prisma.attemptResult.findUnique({ where: { id: result.id } })).toBeNull();
    expect(await prisma.attemptAnswer.findUnique({ where: { id: answer.id } })).toBeNull();
    expect(await prisma.document.findUnique({ where: { id: document.id } })).toBeNull();
  });
});

describe('Deferred foreign keys still reject standalone deletes', () => {
  it('rejects deleting a MockQuestion referenced by AttemptQuestion (AttemptQuestion_questionId_fkey)', async () => {
    const subject = await createSubject();
    const { question, attemptQuestion } = await createAnswerableAttempt(subject.id);

    // The constraint is deferred, so the violation surfaces at COMMIT instead
    // of at the DELETE statement. The row and its children must survive.
    await expectDbError(
      prisma.mockQuestion.delete({ where: { id: question.id } }),
      /AttemptQuestion_questionId_fkey|23503|P2003/,
    );

    expect(
      await prisma.mockQuestion.findUnique({ where: { id: question.id } }),
    ).not.toBeNull();
    expect(
      await prisma.attemptQuestion.findUnique({ where: { id: attemptQuestion.id } }),
    ).not.toBeNull();
    expect(
      await prisma.mockChoice.count({ where: { questionId: question.id } }),
    ).toBe(4);
  });

  it('rejects deleting a MockChoice referenced by AttemptAnswer (AttemptAnswer_choiceId_fkey)', async () => {
    const subject = await createSubject();
    const { attemptQuestion, choice } = await createAnswerableAttempt(subject.id);
    const answer = await prisma.attemptAnswer.create({
      data: {
        attemptQuestionId: attemptQuestion.id,
        choiceId: choice.id,
        revision: 1,
        idempotencyKey: `ZZ-m3-answer-${randomUUID()}`,
      },
    });

    await expectDbError(
      prisma.mockChoice.delete({ where: { id: choice.id } }),
      /AttemptAnswer_choiceId_fkey|23503|P2003/,
    );

    expect(
      await prisma.mockChoice.findUnique({ where: { id: choice.id } }),
    ).not.toBeNull();
    expect(
      await prisma.attemptAnswer.findUnique({ where: { id: answer.id } }),
    ).not.toBeNull();
  });

  it('rejects deleting a Document referenced by GenerationJobDocument (GenerationJobDocument_documentId_fkey)', async () => {
    const subject = await createSubject();
    const job = await createGenerationJob(subject.id, 'COMPLETED');
    const document = await createDocument(subject.id);
    const jobDocument = await prisma.generationJobDocument.create({
      data: { jobId: job.id, documentId: document.id },
    });

    await expectDbError(
      prisma.document.delete({ where: { id: document.id } }),
      /GenerationJobDocument_documentId_fkey|23503|P2003/,
    );

    expect(
      await prisma.document.findUnique({ where: { id: document.id } }),
    ).not.toBeNull();
    expect(
      await prisma.generationJobDocument.findUnique({
        where: {
          jobId_documentId: { jobId: jobDocument.jobId, documentId: jobDocument.documentId },
        },
      }),
    ).not.toBeNull();
  });
});

describe('Error matcher self-check', () => {
  it('assertDbError rejects an unrelated message', () => {
    expect(() =>
      assertDbError(new Error('connection refused'), /R4/),
    ).toThrow(/Expected a database error matching/);
  });
});
