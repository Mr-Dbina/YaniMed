import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../../prisma/prisma.service.js';
import { GenerationError } from '../generation.errors.js';
import {
  createBankSource,
  type BankQuestionRow,
  type BankSourceOptions,
} from './bank-source.js';

function questionRow(
  id: string,
  overrides: Partial<BankQuestionRow> = {},
): BankQuestionRow {
  return {
    id,
    stem: `ZZ-m5 stem ${id}`,
    leadIn: null,
    educationalObjective: `ZZ-m5 objective ${id}`,
    topic: { key: 'zz-m5-topic' },
    choices: [{ text: `ZZ-m5 key ${id}` }],
    citations: [
      {
        documentId: 'doc-1',
        pageNumber: 4,
        quote: `ZZ-m5 quote ${id}`,
      },
    ],
    ...overrides,
  };
}

function makePrisma(rows: BankQuestionRow[]) {
  return {
    mockQuestion: { findMany: vi.fn().mockResolvedValue(rows) },
  };
}

const VECTOR = Array.from({ length: 768 }, (_, index) => (index === 3 ? 1 : 0));

function countingEmbed() {
  return vi.fn(async () => [...VECTOR]);
}

function sourceFor(
  prisma: ReturnType<typeof makePrisma>,
  embed: BankSourceOptions['embed'],
  cap?: number,
): BankSourceOptions {
  return {
    prisma: prisma as unknown as PrismaService,
    subjectId: 'subject-1',
    jobId: 'job-1',
    embed,
    ...(cap === undefined ? {} : { cap }),
  };
}

describe('bank source', () => {
  it('maps the question fields and embeds only the first cap refs', async () => {
    const prisma = makePrisma([
      questionRow('q1', { leadIn: 'ZZ-m5 lead-in' }),
      questionRow('q2'),
      questionRow('q3'),
    ]);
    const embed = countingEmbed();

    const refs = await createBankSource(sourceFor(prisma, embed, 2)).loadRefs();

    expect(refs).toHaveLength(3);
    expect(refs[0]).toMatchObject({
      key: 'q1',
      topicKey: 'zz-m5-topic',
      objective: 'ZZ-m5 objective q1',
      documentId: 'doc-1',
      page: 4,
      quote: 'ZZ-m5 quote q1',
      keyChoiceText: 'ZZ-m5 key q1',
    });
    expect(refs[0].embedding).toEqual(VECTOR);
    expect(refs[1].embedding).toEqual(VECTOR);
    expect(refs[2]).toMatchObject({ key: 'q3', embedding: null });

    expect(embed).toHaveBeenCalledTimes(2);
    expect(embed).toHaveBeenNthCalledWith(1, {
      jobId: 'job-1',
      text: 'ZZ-m5 stem q1\nZZ-m5 lead-in',
    });
    expect(embed).toHaveBeenNthCalledWith(2, {
      jobId: 'job-1',
      text: 'ZZ-m5 stem q2\n',
    });
  });

  it('memoizes the whole load so two calls embed once', async () => {
    const prisma = makePrisma([questionRow('q1'), questionRow('q2')]);
    const embed = countingEmbed();
    const bank = createBankSource(sourceFor(prisma, embed));

    const first = await bank.loadRefs();
    const second = await bank.loadRefs();

    expect(second).toBe(first);
    expect(prisma.mockQuestion.findMany).toHaveBeenCalledTimes(1);
    expect(embed).toHaveBeenCalledTimes(2);
  });

  it('scopes the query to the subject and every job except this one', async () => {
    const prisma = makePrisma([]);

    await createBankSource(sourceFor(prisma, countingEmbed())).loadRefs();

    expect(prisma.mockQuestion.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          subjectId: 'subject-1',
          status: 'ACTIVE',
          OR: [{ jobId: null }, { jobId: { not: 'job-1' } }],
          citations: { some: {} },
        },
      }),
    );
  });

  it('embeds nothing when the cap is zero', async () => {
    const prisma = makePrisma([questionRow('q1')]);
    const embed = countingEmbed();

    const refs = await createBankSource(sourceFor(prisma, embed, 0)).loadRefs();

    expect(refs).toHaveLength(1);
    expect(refs[0].embedding).toBeNull();
    expect(embed).not.toHaveBeenCalled();
  });

  it('propagates an embed failure', async () => {
    const prisma = makePrisma([questionRow('q1')]);
    const embed = vi.fn(async () => {
      throw new GenerationError('GENERATION_BUDGET_EXHAUSTED', {
        jobId: 'job-1',
      });
    });

    await expect(
      createBankSource(sourceFor(prisma, embed)).loadRefs(),
    ).rejects.toMatchObject({ code: 'GENERATION_BUDGET_EXHAUSTED' });
  });
});
