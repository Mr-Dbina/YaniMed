import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../../prisma/prisma.service.js';
import type { DraftQuestion } from '../validate/types.js';
import {
  publishJobQuestions,
  quarantineJobQuestions,
  writeQuestion,
  type WriteQuestionArgs,
} from './question-writer.js';
import { ensureSubjectTopics } from './topics.js';

function makeDraft(overrides: Partial<DraftQuestion> = {}): DraftQuestion {
  return {
    stem: 'Which drug is first-line for type 2 diabetes?',
    leadIn: null,
    choices: [
      { text: 'Metformin 500 mg', explanation: 'Metformin is first-line.' },
      { text: 'Insulin glargine', explanation: 'Insulin is added later.' },
      { text: 'Glipizide', explanation: 'Sulfonylureas are not first choice.' },
      { text: 'Diet alone', explanation: 'Lifestyle alone is not enough.' },
    ],
    keyIndex: 0,
    objective: 'Choose first-line drug therapy.',
    keyExplanation: 'Metformin is first-line per the cited page.',
    topicKey: 'diabetes',
    citation: {
      documentId: 'doc-1',
      page: 5,
      printedPage: 12,
      quote: 'Metformin is first-line therapy for type 2 diabetes.',
    },
    ...overrides,
  };
}

function makeArgs(overrides: Partial<WriteQuestionArgs> = {}): WriteQuestionArgs {
  return {
    fence: { jobId: 'job-1', recoveryCount: 1 },
    subjectId: 'subject-1',
    draft: makeDraft(),
    topicId: 'topic-1',
    ...overrides,
  };
}

function fakeClient(): { client: PrismaService; transaction: ReturnType<typeof vi.fn> } {
  const transaction = vi.fn();
  return {
    client: { $transaction: transaction } as unknown as PrismaService,
    transaction,
  };
}

describe('writeQuestion argument validation', () => {
  it('rejects a draft without exactly 4 choices before any DB call', async () => {
    for (const count of [3, 5]) {
      const { client, transaction } = fakeClient();
      const choices = Array.from({ length: count }, (_, index) => ({
        text: `Choice ${index + 1}`,
        explanation: `Explanation ${index + 1}`,
      }));

      await expect(
        writeQuestion(
          makeArgs({ draft: makeDraft({ choices, keyIndex: 0 }) }),
          client,
        ),
      ).rejects.toBeInstanceOf(RangeError);
      expect(transaction).not.toHaveBeenCalled();
    }
  });

  it('rejects an out-of-range keyIndex before any DB call', async () => {
    for (const keyIndex of [4, -1, 1.5]) {
      const { client, transaction } = fakeClient();

      await expect(
        writeQuestion(makeArgs({ draft: makeDraft({ keyIndex }) }), client),
      ).rejects.toBeInstanceOf(RangeError);
      expect(transaction).not.toHaveBeenCalled();
    }
  });

  it('rejects a citation page below 1 before any DB call', async () => {
    for (const page of [0, -1]) {
      const { client, transaction } = fakeClient();
      const draft = makeDraft({
        citation: { ...makeDraft().citation, page },
      });

      await expect(
        writeQuestion(makeArgs({ draft }), client),
      ).rejects.toBeInstanceOf(RangeError);
      expect(transaction).not.toHaveBeenCalled();
    }
  });

  it('rejects empty subject and topic ids before any DB call', async () => {
    const { client, transaction } = fakeClient();

    await expect(
      writeQuestion(makeArgs({ subjectId: '  ' }), client),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      writeQuestion(makeArgs({ topicId: '' }), client),
    ).rejects.toBeInstanceOf(RangeError);
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe('ensureSubjectTopics', () => {
  it('deduplicates plan keys and returns key -> id without renaming', async () => {
    const createMany = vi.fn().mockResolvedValue({ count: 2 });
    const findMany = vi.fn().mockResolvedValue([
      { key: 'diabetes', id: 'topic-a' },
      { key: 'asthma', id: 'topic-b' },
    ]);
    const client = {
      subjectTopic: { createMany, findMany },
    } as unknown as PrismaService;

    const result = await ensureSubjectTopics(
      'subject-1',
      [
        { topicKey: 'diabetes', name: 'Diabetes' },
        { topicKey: 'diabetes', name: 'Renamed diabetes' },
        { topicKey: ' asthma ', name: 'Asthma' },
      ],
      client,
    );

    expect(createMany).toHaveBeenCalledWith({
      data: [
        { subjectId: 'subject-1', key: 'diabetes', name: 'Diabetes' },
        { subjectId: 'subject-1', key: 'asthma', name: 'Asthma' },
      ],
      skipDuplicates: true,
    });
    expect(result.get('diabetes')).toBe('topic-a');
    expect(result.get('asthma')).toBe('topic-b');
  });

  it('returns an empty map without a DB call for an empty plan', async () => {
    const { client, transaction } = fakeClient();

    const result = await ensureSubjectTopics('subject-1', [], client);

    expect(result.size).toBe(0);
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe('publishJobQuestions', () => {
  it('refuses a job that is not COMPLETED and changes nothing', async () => {
    const updateMany = vi.fn();
    const tx = {
      generationJob: {
        findUnique: vi.fn().mockResolvedValue({ state: 'RUNNING' }),
      },
      mockQuestion: { updateMany },
    };
    const client = {
      $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) =>
        callback(tx),
      ),
    } as unknown as PrismaService;

    await expect(
      publishJobQuestions('job-1', client),
    ).rejects.toMatchObject({ code: 'GENERATION_INVALID_TRANSITION' });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('flips only held questions of a COMPLETED job', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 3 });
    const tx = {
      generationJob: {
        findUnique: vi.fn().mockResolvedValue({ state: 'COMPLETED' }),
      },
      mockQuestion: { updateMany },
    };
    const client = {
      $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) =>
        callback(tx),
      ),
    } as unknown as PrismaService;

    await expect(publishJobQuestions('job-1', client)).resolves.toBe(3);
    expect(updateMany).toHaveBeenCalledWith({
      where: { jobId: 'job-1', status: 'QUARANTINED' },
      data: { status: 'ACTIVE' },
    });
  });
});

describe('quarantineJobQuestions', () => {
  it('sets every non-RETIRED question to held and is repeatable', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 2 });
    const tx = { mockQuestion: { updateMany } };
    const client = {
      $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) =>
        callback(tx),
      ),
    } as unknown as PrismaService;

    await expect(quarantineJobQuestions('job-1', client)).resolves.toBe(2);
    await expect(quarantineJobQuestions('job-1', client)).resolves.toBe(2);
    expect(updateMany).toHaveBeenNthCalledWith(1, {
      where: { jobId: 'job-1', status: { not: 'RETIRED' } },
      data: { status: 'QUARANTINED' },
    });
    expect(updateMany).toHaveBeenCalledTimes(2);
  });
});
