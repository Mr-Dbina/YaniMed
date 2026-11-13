import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ensureSubjectTopics,
  publishJobQuestions,
  quarantineJobQuestions,
  writeQuestion,
} from '../../src/mock-test/generation/persist/index.js';
import type { DraftQuestion } from '../../src/mock-test/generation/validate/types.js';
import { createReadySubject, prisma, repository } from './helpers.js';

const TOPIC_KEY = 'zz-m5-topic';

function makeDraft(
  documentId: string,
  overrides: Partial<DraftQuestion> = {},
): DraftQuestion {
  return {
    stem: `ZZ-m5 stem ${randomUUID()}`,
    leadIn: null,
    choices: [
      { text: 'ZZ-m5 choice 1', explanation: 'ZZ-m5 explanation 1' },
      { text: 'ZZ-m5 choice 2', explanation: 'ZZ-m5 explanation 2' },
      { text: 'ZZ-m5 choice 3', explanation: 'ZZ-m5 explanation 3' },
      { text: 'ZZ-m5 choice 4', explanation: 'ZZ-m5 explanation 4' },
    ],
    keyIndex: 1,
    objective: 'ZZ-m5 objective',
    keyExplanation: 'ZZ-m5 key explanation',
    topicKey: TOPIC_KEY,
    citation: {
      documentId,
      page: 5,
      printedPage: 12,
      quote: 'ZZ-m5 citation quote',
    },
    ...overrides,
  };
}

async function claimedJob(requestedCount = 5) {
  const { subject, documents } = await createReadySubject(1);
  const created = await repository.createJob({
    subjectId: subject.id,
    documentIds: [documents[0].id],
    requestedCount,
  });
  const claimed = await repository.claimNext();
  if (!claimed || claimed.jobId !== created.job.id) {
    throw new Error('ZZ-m5 fixture did not claim its own job.');
  }
  const topics = await ensureSubjectTopics(
    subject.id,
    [{ topicKey: TOPIC_KEY, name: 'ZZ M5 Topic' }],
    prisma,
  );
  const topicId = topics.get(TOPIC_KEY);
  if (!topicId) throw new Error('ZZ-m5 fixture did not create its topic.');

  return {
    subject,
    document: documents[0],
    job: created.job,
    claimed,
    topicId,
  };
}

type Fixture = Awaited<ReturnType<typeof claimedJob>>;

function write(
  fixture: Fixture,
  draft: DraftQuestion,
  recoveryCount = fixture.claimed.recoveryCount,
) {
  return writeQuestion(
    {
      fence: { jobId: fixture.job.id, recoveryCount },
      subjectId: fixture.subject.id,
      draft,
      topicId: fixture.topicId,
    },
    prisma,
  );
}

describe('question writer (test DB)', () => {
  it('writes the question, 4 choices and citation as held in one transaction', async () => {
    const fixture = await claimedJob();
    const draft = makeDraft(fixture.document.id, {
      leadIn: 'ZZ-m5 lead-in.',
    });

    const result = await write(fixture, draft);
    expect(result.acceptedCount).toBe(1);

    const job = await prisma.generationJob.findUniqueOrThrow({
      where: { id: fixture.job.id },
    });
    expect(job.acceptedCount).toBe(1);

    const question = await prisma.mockQuestion.findUniqueOrThrow({
      where: { id: result.questionId },
      include: {
        choices: { orderBy: { position: 'asc' } },
        citations: true,
      },
    });
    expect(question.status).toBe('QUARANTINED');
    expect(question.jobId).toBe(fixture.job.id);
    expect(question.subjectId).toBe(fixture.subject.id);
    expect(question.topicId).toBe(fixture.topicId);
    expect(question.stem).toBe(draft.stem);
    expect(question.leadIn).toBe(draft.leadIn);
    expect(question.educationalObjective).toBe(draft.objective);

    expect(question.choices).toHaveLength(4);
    expect(question.choices.map((choice) => choice.position)).toEqual([
      1, 2, 3, 4,
    ]);
    expect(
      question.choices.filter((choice) => choice.isCorrect).map((choice) => choice.position),
    ).toEqual([draft.keyIndex + 1]);
    const keyChoice = question.choices[draft.keyIndex];
    expect(keyChoice.explanation).toContain(draft.choices[draft.keyIndex].explanation);
    expect(keyChoice.explanation).toContain(draft.keyExplanation);

    expect(question.citations).toHaveLength(1);
    expect(question.citations[0]).toMatchObject({
      documentId: fixture.document.id,
      documentTitleSnapshot: fixture.document.title,
      pageNumber: draft.citation.page,
      printedPage: '12',
      quote: draft.citation.quote,
    });
  });

  it('reaches acceptedCount 25 then rejects the 26th write with nothing extra', async () => {
    const fixture = await claimedJob(25);

    for (let index = 1; index <= 25; index += 1) {
      const result = await write(
        fixture,
        makeDraft(fixture.document.id, { stem: `ZZ-m5 stem ${index}` }),
      );
      expect(result.acceptedCount).toBe(index);
    }

    await expect(
      write(fixture, makeDraft(fixture.document.id, { stem: 'ZZ-m5 stem 26' })),
    ).rejects.toMatchObject({ code: 'GENERATION_ACCEPTED_CAP' });

    const job = await prisma.generationJob.findUniqueOrThrow({
      where: { id: fixture.job.id },
    });
    expect(job.acceptedCount).toBe(25);
    await expect(
      prisma.mockQuestion.count({ where: { jobId: fixture.job.id } }),
    ).resolves.toBe(25);
  });

  it('does not write from a stale recovery epoch', async () => {
    const fixture = await claimedJob();
    await prisma.generationJob.update({
      where: { id: fixture.job.id },
      data: { recoveryCount: fixture.claimed.recoveryCount + 1 },
    });

    await expect(write(fixture, makeDraft(fixture.document.id))).rejects.toMatchObject(
      { code: 'GENERATION_STALE_WORKER' },
    );

    const job = await prisma.generationJob.findUniqueOrThrow({
      where: { id: fixture.job.id },
    });
    expect(job.acceptedCount).toBe(0);
    await expect(
      prisma.mockQuestion.count({ where: { jobId: fixture.job.id } }),
    ).resolves.toBe(0);
  });

  it('does not write when the job is CANCELLING, FAILED or COMPLETED', async () => {
    for (const state of ['CANCELLING', 'FAILED', 'COMPLETED'] as const) {
      const fixture = await claimedJob();
      await prisma.generationJob.update({
        where: { id: fixture.job.id },
        data: {
          state,
          ...(state === 'FAILED' ? { failureReason: 'INTERNAL' } : {}),
          ...(state === 'COMPLETED' ? { finishedAt: new Date() } : {}),
        },
      });

      await expect(
        write(fixture, makeDraft(fixture.document.id)),
      ).rejects.toMatchObject({ code: 'GENERATION_STALE_WORKER' });

      const job = await prisma.generationJob.findUniqueOrThrow({
        where: { id: fixture.job.id },
      });
      expect(job.acceptedCount).toBe(0);
      await expect(
        prisma.mockQuestion.count({ where: { jobId: fixture.job.id } }),
      ).resolves.toBe(0);
    }
  });

  it('rejects citation page 0 before writing anything', async () => {
    const fixture = await claimedJob();
    const draft = makeDraft(fixture.document.id, {
      citation: {
        documentId: fixture.document.id,
        page: 0,
        printedPage: null,
        quote: 'ZZ-m5 citation quote',
      },
    });

    await expect(write(fixture, draft)).rejects.toBeInstanceOf(RangeError);

    const job = await prisma.generationJob.findUniqueOrThrow({
      where: { id: fixture.job.id },
    });
    expect(job.acceptedCount).toBe(0);
    await expect(
      prisma.mockQuestion.count({ where: { jobId: fixture.job.id } }),
    ).resolves.toBe(0);
  });

  it('keeps an existing topic name and id on a duplicate upsert', async () => {
    const { subject } = await createReadySubject();

    const first = await ensureSubjectTopics(
      subject.id,
      [{ topicKey: 'zz-m5-stable', name: 'Original name' }],
      prisma,
    );
    const second = await ensureSubjectTopics(
      subject.id,
      [{ topicKey: 'zz-m5-stable', name: 'Renamed name' }],
      prisma,
    );

    expect(second.get('zz-m5-stable')).toBe(first.get('zz-m5-stable'));
    const stored = await prisma.subjectTopic.findUniqueOrThrow({
      where: {
        subjectId_key: { subjectId: subject.id, key: 'zz-m5-stable' },
      },
    });
    expect(stored.name).toBe('Original name');
  });

  it('publishes only the completed job held questions', async () => {
    const first = await claimedJob();
    const firstWrite = await write(first, makeDraft(first.document.id));
    await prisma.generationJob.update({
      where: { id: first.job.id },
      data: { state: 'COMPLETED', finishedAt: new Date() },
    });

    const second = await claimedJob();
    const secondWrite = await write(second, makeDraft(second.document.id));

    await expect(publishJobQuestions(first.job.id, prisma)).resolves.toBe(1);

    const published = await prisma.mockQuestion.findUniqueOrThrow({
      where: { id: firstWrite.questionId },
    });
    const stillHeld = await prisma.mockQuestion.findUniqueOrThrow({
      where: { id: secondWrite.questionId },
    });
    expect(published.status).toBe('ACTIVE');
    expect(stillHeld.status).toBe('QUARANTINED');
  });

  it('refuses to publish a RUNNING or FAILED job and changes nothing', async () => {
    const fixture = await claimedJob();
    const written = await write(fixture, makeDraft(fixture.document.id));

    await expect(
      publishJobQuestions(fixture.job.id, prisma),
    ).rejects.toMatchObject({ code: 'GENERATION_INVALID_TRANSITION' });

    await prisma.generationJob.update({
      where: { id: fixture.job.id },
      data: { state: 'FAILED', failureReason: 'INTERNAL' },
    });
    await expect(
      publishJobQuestions(fixture.job.id, prisma),
    ).rejects.toMatchObject({ code: 'GENERATION_INVALID_TRANSITION' });

    const question = await prisma.mockQuestion.findUniqueOrThrow({
      where: { id: written.questionId },
    });
    expect(question.status).toBe('QUARANTINED');
  });

  it('quarantines idempotently and leaves RETIRED questions alone', async () => {
    const fixture = await claimedJob();
    const written = await write(fixture, makeDraft(fixture.document.id));
    await prisma.generationJob.update({
      where: { id: fixture.job.id },
      data: { state: 'COMPLETED', finishedAt: new Date() },
    });
    await publishJobQuestions(fixture.job.id, prisma);

    const first = await quarantineJobQuestions(fixture.job.id, prisma);
    const second = await quarantineJobQuestions(fixture.job.id, prisma);
    expect(first).toBe(1);
    expect(second).toBe(1);

    const held = await prisma.mockQuestion.findUniqueOrThrow({
      where: { id: written.questionId },
    });
    expect(held.status).toBe('QUARANTINED');

    await prisma.mockQuestion.update({
      where: { id: written.questionId },
      data: { status: 'RETIRED' },
    });
    await expect(
      quarantineJobQuestions(fixture.job.id, prisma),
    ).resolves.toBe(0);
    const retired = await prisma.mockQuestion.findUniqueOrThrow({
      where: { id: written.questionId },
    });
    expect(retired.status).toBe('RETIRED');
  });

  it('lets exactly one of two writers take the last slot', async () => {
    const fixture = await claimedJob(25);
    await prisma.generationJob.update({
      where: { id: fixture.job.id },
      data: { acceptedCount: 24 },
    });

    const results = await Promise.allSettled([
      write(fixture, makeDraft(fixture.document.id, { stem: 'ZZ-m5 race A' })),
      write(fixture, makeDraft(fixture.document.id, { stem: 'ZZ-m5 race B' })),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    if (rejected[0].status === 'rejected') {
      expect(rejected[0].reason).toMatchObject({
        code: 'GENERATION_ACCEPTED_CAP',
      });
    }

    const job = await prisma.generationJob.findUniqueOrThrow({
      where: { id: fixture.job.id },
    });
    expect(job.acceptedCount).toBe(25);
    await expect(
      prisma.mockQuestion.count({ where: { jobId: fixture.job.id } }),
    ).resolves.toBe(1);
  });

  it('rejects a topic that belongs to another subject', async () => {
    const fixture = await claimedJob();
    const other = await createReadySubject();
    const otherTopics = await ensureSubjectTopics(
      other.subject.id,
      [{ topicKey: 'zz-m5-other', name: 'ZZ M5 Other' }],
      prisma,
    );
    const otherTopicId = otherTopics.get('zz-m5-other');
    if (!otherTopicId) throw new Error('ZZ-m5 fixture did not create its topic.');

    await expect(
      writeQuestion(
        {
          fence: {
            jobId: fixture.job.id,
            recoveryCount: fixture.claimed.recoveryCount,
          },
          subjectId: fixture.subject.id,
          draft: makeDraft(fixture.document.id),
          topicId: otherTopicId,
        },
        prisma,
      ),
    ).rejects.toMatchObject({ code: 'GENERATION_NOT_FOUND' });

    const job = await prisma.generationJob.findUniqueOrThrow({
      where: { id: fixture.job.id },
    });
    expect(job.acceptedCount).toBe(0);
    await expect(
      prisma.mockQuestion.count({ where: { jobId: fixture.job.id } }),
    ).resolves.toBe(0);
  });

  it('rejects a citation document outside the job snapshot', async () => {
    const { subject, documents } = await createReadySubject(2);
    const created = await repository.createJob({
      subjectId: subject.id,
      documentIds: [documents[0].id],
      requestedCount: 5,
    });
    const claimed = await repository.claimNext();
    if (!claimed || claimed.jobId !== created.job.id) {
      throw new Error('ZZ-m5 fixture did not claim its own job.');
    }
    const topics = await ensureSubjectTopics(
      subject.id,
      [{ topicKey: TOPIC_KEY, name: 'ZZ M5 Topic' }],
      prisma,
    );
    const topicId = topics.get(TOPIC_KEY);
    if (!topicId) throw new Error('ZZ-m5 fixture did not create its topic.');

    await expect(
      writeQuestion(
        {
          fence: { jobId: created.job.id, recoveryCount: claimed.recoveryCount },
          subjectId: subject.id,
          draft: makeDraft(documents[1].id),
          topicId,
        },
        prisma,
      ),
    ).rejects.toMatchObject({ code: 'GENERATION_NOT_FOUND' });

    const job = await prisma.generationJob.findUniqueOrThrow({
      where: { id: created.job.id },
    });
    expect(job.acceptedCount).toBe(0);
    await expect(
      prisma.mockQuestion.count({ where: { jobId: created.job.id } }),
    ).resolves.toBe(0);
  });

  it('stores very long text unchanged', async () => {
    const fixture = await claimedJob();
    const longStem = 'Z'.repeat(10_000);
    const longExplanation = 'Y'.repeat(8_000);
    const draft = makeDraft(fixture.document.id, {
      stem: longStem,
      choices: makeDraft(fixture.document.id).choices.map((choice, index) => ({
        ...choice,
        explanation: index === 0 ? longExplanation : choice.explanation,
      })),
      keyIndex: 0,
    });

    const result = await write(fixture, draft);
    const question = await prisma.mockQuestion.findUniqueOrThrow({
      where: { id: result.questionId },
      include: { choices: { orderBy: { position: 'asc' } } },
    });
    expect(question.stem).toBe(longStem);
    expect(question.choices[0].explanation).toContain(longExplanation);
    expect(question.choices[0].explanation).toContain(draft.keyExplanation);
  });
});
