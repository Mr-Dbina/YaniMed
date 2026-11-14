import type { PrismaService } from '../../../prisma/prisma.service.js';
import { BANK_EMBED_CAP } from '../generation.constants.js';
import { getGenerationPrisma } from '../persist/question-writer.js';
import type { EmbedPort } from '../runner/ports.js';
import type { AcceptedQuestionRef, BankSource } from '../validate/check-c.js';

export interface BankSourceOptions {
  prisma?: PrismaService;
  subjectId: string;
  jobId: string;
  embed: EmbedPort;
  cap?: number;
}

export interface BankQuestionRow {
  id: string;
  stem: string;
  leadIn: string | null;
  educationalObjective: string;
  topic: { key: string };
  choices: { text: string }[];
  citations: { documentId: string | null; pageNumber: number; quote: string }[];
}

/**
 * Check C treats a null bank embedding as "skipped", so the cap leaves refs
 * unembedded rather than dropping them. The type still says number[].
 */
type BankRef = Omit<AcceptedQuestionRef, 'embedding'> & {
  embedding: number[] | null;
};

export function bankQuestionText(row: BankQuestionRow): string {
  return `${row.stem}\n${row.leadIn ?? ''}`;
}

export function toBankRef(row: BankQuestionRow): BankRef {
  const citation = row.citations[0];
  return {
    key: row.id,
    embedding: null,
    topicKey: row.topic.key,
    objective: row.educationalObjective,
    documentId: citation?.documentId ?? '',
    page: citation?.pageNumber ?? 0,
    quote: citation?.quote ?? '',
    keyChoiceText: row.choices[0]?.text ?? '',
  };
}

/**
 * The subject's ACTIVE questions that are not part of this job. The bank has
 * no stored embeddings, so the first `cap` refs are embedded on demand and the
 * rest stay null. One memoized promise per source: repeated calls embed once.
 */
export function createBankSource(options: BankSourceOptions): BankSource {
  const {
    subjectId,
    jobId,
    embed,
    cap = BANK_EMBED_CAP,
    prisma = getGenerationPrisma(),
  } = options;

  let cached: Promise<AcceptedQuestionRef[]> | null = null;

  const build = async (): Promise<AcceptedQuestionRef[]> => {
    const rows = await prisma.mockQuestion.findMany({
      where: {
        subjectId,
        status: 'ACTIVE',
        OR: [{ jobId: null }, { jobId: { not: jobId } }],
        citations: { some: {} },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        stem: true,
        leadIn: true,
        educationalObjective: true,
        topic: { select: { key: true } },
        choices: {
          where: { isCorrect: true },
          orderBy: { position: 'asc' },
          take: 1,
          select: { text: true },
        },
        citations: {
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: 1,
          select: { documentId: true, pageNumber: true, quote: true },
        },
      },
    });

    const refs = rows.map(toBankRef);
    const embedCount = Math.max(0, Math.min(cap, refs.length));
    for (let index = 0; index < embedCount; index += 1) {
      refs[index].embedding = await embed({
        jobId,
        text: bankQuestionText(rows[index]),
      });
    }
    return refs as AcceptedQuestionRef[];
  };

  return {
    loadRefs(): Promise<AcceptedQuestionRef[]> {
      cached ??= build();
      return cached;
    },
  };
}
