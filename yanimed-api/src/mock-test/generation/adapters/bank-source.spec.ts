import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../../prisma/prisma.service.js';
import { GenerationError } from '../generation.errors.js';
import { EMBEDDING_MODEL } from '../../../embeddings/embedding.service.js';
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
    topicKey: 'zz-m5-topic',
    correctChoiceText: `ZZ-m5 key ${id}`,
    documentId: 'doc-1',
    pageNumber: 4,
    quote: `ZZ-m5 quote ${id}`,
    embeddingText: null,
    embeddingModel: null,
    ...overrides,
  };
}

function makePrisma(rows: BankQuestionRow[]) {
  return {
    $queryRaw: vi.fn().mockResolvedValue(rows),
    $executeRaw: vi.fn().mockResolvedValue(1),
  };
}

const VECTOR = Array.from({ length: 768 }, (_, index) => (index === 3 ? 1 : 0));
const VECTOR_TEXT = '[' + VECTOR.join(',') + ']';

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
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it('reuses stored valid embeddings and embeds only missing ones', async () => {
    const prisma = makePrisma([
      questionRow('q1', { embeddingText: VECTOR_TEXT, embeddingModel: EMBEDDING_MODEL }),
      questionRow('q2', { embeddingText: null, embeddingModel: null }),
    ]);
    const embed = countingEmbed();

    const refs = await createBankSource(sourceFor(prisma, embed)).loadRefs();

    expect(refs).toHaveLength(2);
    expect(refs[0].embedding).toEqual(VECTOR);
    expect(refs[1].embedding).toEqual(VECTOR);
    expect(embed).toHaveBeenCalledTimes(1);
    expect(embed).toHaveBeenCalledWith({
      jobId: 'job-1',
      text: 'ZZ-m5 stem q2\n',
    });
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('memoizes the whole load so two calls embed once', async () => {
    const prisma = makePrisma([questionRow('q1'), questionRow('q2')]);
    const embed = countingEmbed();
    const bank = createBankSource(sourceFor(prisma, embed));

    const first = await bank.loadRefs();
    const second = await bank.loadRefs();

    expect(second).toBe(first);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(embed).toHaveBeenCalledTimes(2);
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
