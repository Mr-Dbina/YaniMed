import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createBankSource,
  createJobSource,
  createPlanStore,
  createWrittenStore,
  resolveStyleHint,
} from '../../src/mock-test/generation/adapters/index.js';
import { ensureSubjectTopics, writeQuestion } from '../../src/mock-test/generation/persist/index.js';
import type { GenerationPlan } from '../../src/mock-test/generation/plan/planner.js';
import type { DraftQuestion } from '../../src/mock-test/generation/validate/types.js';
import { createReadySubject, prisma, repository } from './helpers.js';

const TOPIC_KEY = 'zz-m5-adapter-topic';

function vector768(seed: number): number[] {
  return Array.from({ length: 768 }, (_, index) => (index === seed ? 1 : 0));
}

async function claimedJob(requestedCount = 25) {
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
  return {
    subject,
    document: documents[0],
    job: created.job,
    claimed,
  };
}

type Fixture = Awaited<ReturnType<typeof claimedJob>>;

async function topicIdFor(fixture: Fixture): Promise<string> {
  const topics = await ensureSubjectTopics(
    fixture.subject.id,
    [{ topicKey: TOPIC_KEY, name: 'ZZ M5 Adapter Topic' }],
    prisma,
  );
  const topicId = topics.get(TOPIC_KEY);
  if (!topicId) throw new Error('ZZ-m5 fixture did not create its topic.');
  return topicId;
}

function makeDraft(
  documentId: string,
  overrides: Partial<DraftQuestion> = {},
): DraftQuestion {
  return {
    stem: `ZZ-m5 adapter stem ${randomUUID()}`,
    leadIn: null,
    choices: [
      { text: 'ZZ-m5 choice 1', explanation: 'ZZ-m5 explanation 1' },
      { text: 'ZZ-m5 choice 2', explanation: 'ZZ-m5 explanation 2' },
      { text: 'ZZ-m5 choice 3', explanation: 'ZZ-m5 explanation 3' },
      { text: 'ZZ-m5 choice 4', explanation: 'ZZ-m5 explanation 4' },
    ],
    keyIndex: 1,
    objective: 'ZZ-m5 adapter objective',
    keyExplanation: 'ZZ-m5 adapter key explanation',
    topicKey: TOPIC_KEY,
    citation: {
      documentId,
      page: 5,
      printedPage: 12,
      quote: 'ZZ-m5 adapter quote',
    },
    ...overrides,
  };
}

async function write(
  fixture: Fixture,
  topicId: string,
  draft: DraftQuestion,
) {
  return writeQuestion(
    {
      fence: {
        jobId: fixture.job.id,
        recoveryCount: fixture.claimed.recoveryCount,
      },
      subjectId: fixture.subject.id,
      draft,
      topicId,
    },
    prisma,
  );
}

async function addChunk(
  documentId: string,
  input: {
    page: number;
    chunkIndex: number;
    content: string;
    embedding?: number[];
  },
) {
  const chunk = await prisma.chunk.create({
    data: {
      documentId,
      content: input.content,
      page: input.page,
      chunkIndex: input.chunkIndex,
    },
  });
  if (input.embedding) {
    const literal = `[${input.embedding.join(',')}]`;
    await prisma.$executeRaw`
      UPDATE "Chunk" SET "embedding" = ${literal}::vector WHERE "id" = ${chunk.id}
    `;
  }
  return chunk;
}

function validPlan(): GenerationPlan {
  return {
    topics: [{ topicKey: TOPIC_KEY, name: 'ZZ M5 Adapter Topic', clusterId: 0, slotCount: 1 }],
    slots: [{ index: 0, topicKey: TOPIC_KEY, seedChunkIds: ['chunk-1', 'chunk-2'] }],
    candidates: { [TOPIC_KEY]: ['chunk-1', 'chunk-2'] },
    stats: {
      eligibleChunks: 2,
      distinctPages: 1,
      clusters: 1,
      attempt: 1,
      excludedEmbeddings: 0,
    },
  };
}

describe('job source adapter (test DB)', () => {
  it('loads the snapshot, pages and parsed chunk embeddings', async () => {
    const fixture = await claimedJob(5);
    const documentId = fixture.document.id;

    await prisma.documentPage.create({
      data: { documentId, pageNumber: 1, text: 'ZZ-m5 page one' },
    });
    await prisma.documentPage.create({
      data: {
        documentId,
        pageNumber: 2,
        text: 'ZZ-m5 page two',
        needsOcr: false,
        ocrUsed: true,
      },
    });
    const embedded = await addChunk(documentId, {
      page: 1,
      chunkIndex: 0,
      content: 'ZZ-m5 embedded chunk',
      embedding: vector768(7),
    });
    const plain = await addChunk(documentId, {
      page: 2,
      chunkIndex: 1,
      content: 'ZZ-m5 plain chunk',
    });

    const inputs = await createJobSource(prisma).load(fixture.job.id);

    expect(inputs.subjectId).toBe(fixture.subject.id);
    expect(inputs.subjectName).toBe(fixture.subject.name);
    expect(inputs.styleHint).toBe(resolveStyleHint(fixture.subject.name));
    expect(inputs.styleHint).toBe('CLINICAL_STEM');
    expect(inputs.requestedCount).toBe(5);
    expect(inputs.snapshotDocumentIds).toEqual(new Set([documentId]));
    expect(inputs.documents.get(documentId)).toEqual({
      title: fixture.document.title,
      pageCount: 60,
    });
    expect(inputs.pages.get(`${documentId}:1`)).toEqual({
      text: 'ZZ-m5 page one',
      needsOcr: false,
    });
    expect(inputs.pages.get(`${documentId}:2`)).toEqual({
      text: 'ZZ-m5 page two',
      needsOcr: true,
    });

    expect(inputs.chunks).toHaveLength(2);
    const parsed = inputs.chunks.find((chunk) => chunk.id === embedded.id);
    expect(parsed?.embedding).toEqual(vector768(7));
    expect(parsed).toMatchObject({
      documentId,
      content: 'ZZ-m5 embedded chunk',
      page: 1,
      chunkIndex: 0,
      needsReview: false,
    });
    expect(inputs.chunks.find((chunk) => chunk.id === plain.id)?.embedding).toBeNull();
  });

  it('accepts a snapshot document with zero chunks', async () => {
    const fixture = await claimedJob(5);

    const inputs = await createJobSource(prisma).load(fixture.job.id);

    expect(inputs.chunks).toEqual([]);
    expect(inputs.documents.size).toBe(1);
  });

  it('throws GENERATION_NOT_FOUND when a snapshot document is not READY', async () => {
    const fixture = await claimedJob(5);
    await prisma.document.update({
      where: { id: fixture.document.id },
      data: { status: 'PROCESSING' },
    });

    await expect(
      createJobSource(prisma).load(fixture.job.id),
    ).rejects.toMatchObject({
      code: 'GENERATION_NOT_FOUND',
      details: {
        snapshotDocuments: 1,
        missingDocuments: 0,
        notReadyDocuments: 1,
      },
    });
  });

  it('throws GENERATION_NOT_FOUND for a missing job', async () => {
    await expect(
      createJobSource(prisma).load(randomUUID()),
    ).rejects.toMatchObject({ code: 'GENERATION_NOT_FOUND' });
  });
});

describe('plan store adapter (test DB)', () => {
  it('round trips the plan and starts with null', async () => {
    const fixture = await claimedJob(5);
    const store = createPlanStore(prisma);

    await expect(store.load(fixture.job.id)).resolves.toBeNull();

    const plan = validPlan();
    await store.save(
      { jobId: fixture.job.id, recoveryCount: fixture.claimed.recoveryCount },
      plan,
    );

    await expect(store.load(fixture.job.id)).resolves.toEqual(plan);
  });

  it('drops unknown fields instead of storing text', async () => {
    const fixture = await claimedJob(5);
    const store = createPlanStore(prisma);
    const plan = {
      ...validPlan(),
      sourceText: 'ZZ-m5 never stored',
    } as unknown as GenerationPlan;

    await store.save(
      { jobId: fixture.job.id, recoveryCount: fixture.claimed.recoveryCount },
      plan,
    );

    const job = await prisma.generationJob.findUniqueOrThrow({
      where: { id: fixture.job.id },
      select: { planJson: true },
    });
    expect(job.planJson).toEqual(validPlan());
    expect(job.planJson).not.toHaveProperty('sourceText');
  });

  it('rejects a stale recovery epoch and writes nothing', async () => {
    const fixture = await claimedJob(5);
    await prisma.generationJob.update({
      where: { id: fixture.job.id },
      data: { recoveryCount: fixture.claimed.recoveryCount + 1 },
    });

    await expect(
      createPlanStore(prisma).save(
        { jobId: fixture.job.id, recoveryCount: fixture.claimed.recoveryCount },
        validPlan(),
      ),
    ).rejects.toMatchObject({ code: 'GENERATION_STALE_WORKER' });

    const job = await prisma.generationJob.findUniqueOrThrow({
      where: { id: fixture.job.id },
      select: { planJson: true },
    });
    expect(job.planJson).toBeNull();
  });

  it('rejects a save when the job is not RUNNING', async () => {
    const fixture = await claimedJob(5);
    await prisma.generationJob.update({
      where: { id: fixture.job.id },
      data: { state: 'COMPLETED', finishedAt: new Date() },
    });

    await expect(
      createPlanStore(prisma).save(
        { jobId: fixture.job.id, recoveryCount: fixture.claimed.recoveryCount },
        validPlan(),
      ),
    ).rejects.toMatchObject({ code: 'GENERATION_STALE_WORKER' });

    const job = await prisma.generationJob.findUniqueOrThrow({
      where: { id: fixture.job.id },
      select: { planJson: true },
    });
    expect(job.planJson).toBeNull();
  });

  it('rejects a malformed stored plan', async () => {
    const fixture = await claimedJob(5);
    await prisma.generationJob.update({
      where: { id: fixture.job.id },
      data: { planJson: { topics: [], slots: 'not-an-array' } },
    });

    await expect(
      createPlanStore(prisma).load(fixture.job.id),
    ).rejects.toMatchObject({ code: 'GENERATION_INVALID_PLAN' });
  });
});

describe('written store adapter (test DB)', () => {
  it('lists held questions with key choice text, topic key and citations', async () => {
    const fixture = await claimedJob(5);
    const topicId = await topicIdFor(fixture);

    const firstDraft = makeDraft(fixture.document.id, {
      leadIn: 'ZZ-m5 adapter lead-in.',
    });
    const secondDraft = makeDraft(fixture.document.id);
    const first = await write(fixture, topicId, firstDraft);
    const second = await write(fixture, topicId, secondDraft);

    await prisma.questionCitation.create({
      data: {
        questionId: first.questionId,
        documentId: fixture.document.id,
        documentTitleSnapshot: fixture.document.title,
        pageNumber: 6,
        quote: 'ZZ-m5 second quote',
        createdAt: new Date(Date.now() + 60_000),
      },
    });
    await prisma.mockQuestion.update({
      where: { id: second.questionId },
      data: { status: 'RETIRED' },
    });

    const written = await createWrittenStore(prisma).listWritten(fixture.job.id);

    expect(written).toHaveLength(1);
    expect(written[0]).toEqual({
      questionId: first.questionId,
      status: 'QUARANTINED',
      topicKey: TOPIC_KEY,
      stem: firstDraft.stem,
      leadIn: firstDraft.leadIn,
      objective: firstDraft.objective,
      keyChoiceText: firstDraft.choices[firstDraft.keyIndex].text,
      citations: [
        {
          documentId: fixture.document.id,
          page: firstDraft.citation.page,
          quote: firstDraft.citation.quote,
        },
        {
          documentId: fixture.document.id,
          page: 6,
          quote: 'ZZ-m5 second quote',
        },
      ],
    });
  });

  it('returns an empty list for a job without questions', async () => {
    const fixture = await claimedJob(5);

    await expect(
      createWrittenStore(prisma).listWritten(fixture.job.id),
    ).resolves.toEqual([]);
  });
});

describe('bank source adapter (test DB)', () => {
  it('returns only same-subject ACTIVE questions from other jobs, newest first, capped', async () => {
    const fixture = await claimedJob(25);
    const topicId = await topicIdFor(fixture);
    const createdAt = (offsetMs: number) => new Date(Date.now() - offsetMs);

    const older = await write(
      fixture,
      topicId,
      makeDraft(fixture.document.id, { stem: 'ZZ-m5 bank older' }),
    );
    const middle = await write(
      fixture,
      topicId,
      makeDraft(fixture.document.id, { stem: 'ZZ-m5 bank middle' }),
    );
    const newest = await write(
      fixture,
      topicId,
      makeDraft(fixture.document.id, {
        stem: 'ZZ-m5 bank newest',
        leadIn: 'ZZ-m5 bank lead-in',
      }),
    );
    await prisma.mockQuestion.update({
      where: { id: older.questionId },
      data: { status: 'ACTIVE', jobId: null, createdAt: createdAt(3_000) },
    });
    await prisma.mockQuestion.update({
      where: { id: middle.questionId },
      data: { status: 'ACTIVE', jobId: null, createdAt: createdAt(2_000) },
    });
    await prisma.mockQuestion.update({
      where: { id: newest.questionId },
      data: { status: 'ACTIVE', jobId: null, createdAt: createdAt(1_000) },
    });

    const currentJob = await write(fixture, topicId, makeDraft(fixture.document.id));
    await prisma.mockQuestion.update({
      where: { id: currentJob.questionId },
      data: { status: 'ACTIVE' },
    });
    const held = await write(fixture, topicId, makeDraft(fixture.document.id));
    await prisma.mockQuestion.update({
      where: { id: held.questionId },
      data: { jobId: null },
    });
    const uncited = await prisma.mockQuestion.create({
      data: {
        subjectId: fixture.subject.id,
        topicId,
        jobId: null,
        status: 'ACTIVE',
        stem: 'ZZ-m5 uncited stem',
        educationalObjective: 'ZZ-m5 uncited objective',
        draftModel: 'zz-m5',
        promptVersion: 'm5',
        validatorVersion: 'm5',
      },
      select: { id: true },
    });

    const other = await claimedJob(25);
    const otherTopicId = await topicIdFor(other);
    const otherSubject = await write(
      other,
      otherTopicId,
      makeDraft(other.document.id, { stem: 'ZZ-m5 other subject' }),
    );
    await prisma.mockQuestion.update({
      where: { id: otherSubject.questionId },
      data: { status: 'ACTIVE' },
    });

    const embed = vi.fn(async () => vector768(7));
    const refs = await createBankSource({
      prisma,
      subjectId: fixture.subject.id,
      jobId: fixture.job.id,
      embed,
      cap: 2,
    }).loadRefs();

    expect(refs.map((ref) => ref.key)).toEqual([
      newest.questionId,
      middle.questionId,
      older.questionId,
    ]);
    expect(refs.map((ref) => ref.embedding)).toEqual([
      vector768(7),
      vector768(7),
      null,
    ]);
    expect(embed).toHaveBeenCalledTimes(2);
    expect(embed).toHaveBeenNthCalledWith(1, {
      jobId: fixture.job.id,
      text: 'ZZ-m5 bank newest\nZZ-m5 bank lead-in',
    });

    const newestRef = refs[0];
    expect(newestRef).toMatchObject({
      key: newest.questionId,
      topicKey: TOPIC_KEY,
      objective: 'ZZ-m5 adapter objective',
      documentId: fixture.document.id,
      page: 5,
      quote: 'ZZ-m5 adapter quote',
      keyChoiceText: 'ZZ-m5 choice 2',
    });

    const returned = new Set(refs.map((ref) => ref.key));
    expect(returned.has(currentJob.questionId)).toBe(false);
    expect(returned.has(held.questionId)).toBe(false);
    expect(returned.has(uncited.id)).toBe(false);
    expect(returned.has(otherSubject.questionId)).toBe(false);
  });

  it('returns nothing when the subject has no other questions', async () => {
    const fixture = await claimedJob(5);
    const embed = vi.fn(async () => vector768(7));

    const refs = await createBankSource({
      prisma,
      subjectId: fixture.subject.id,
      jobId: fixture.job.id,
      embed,
    }).loadRefs();

    expect(refs).toEqual([]);
    expect(embed).not.toHaveBeenCalled();
  });
});
