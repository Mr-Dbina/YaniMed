import type { PrismaService } from '../../../prisma/prisma.service.js';
import { getGenerationPrisma } from '../persist/question-writer.js';
import type { WrittenQuestion, WrittenStore } from '../runner/ports.js';

export interface WrittenQuestionRow {
  id: string;
  status: string;
  stem: string;
  leadIn: string | null;
  educationalObjective: string;
  topic: { key: string };
  choices: { text: string; isCorrect: boolean }[];
  citations: { documentId: string | null; pageNumber: number; quote: string }[];
}

export function toWrittenQuestion(row: WrittenQuestionRow): WrittenQuestion {
  const key = row.choices.find((choice) => choice.isCorrect);
  return {
    questionId: row.id,
    status: row.status,
    topicKey: row.topic.key,
    stem: row.stem,
    leadIn: row.leadIn,
    objective: row.educationalObjective,
    keyChoiceText: key?.text ?? '',
    citations: row.citations.map((citation) => ({
      documentId: citation.documentId,
      page: citation.pageNumber,
      quote: citation.quote,
    })),
  };
}

/**
 * Every non-retired question of the job, oldest first, in one query with the
 * topic, key choice and citations. Retired questions are never re-checked.
 */
export function createWrittenStore(
  prisma: PrismaService = getGenerationPrisma(),
): WrittenStore {
  return {
    async listWritten(jobId: string): Promise<WrittenQuestion[]> {
      const rows = await prisma.mockQuestion.findMany({
        where: { jobId, status: { not: 'RETIRED' } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          status: true,
          stem: true,
          leadIn: true,
          educationalObjective: true,
          topic: { select: { key: true } },
          choices: { select: { text: true, isCorrect: true } },
          citations: {
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: { documentId: true, pageNumber: true, quote: true },
          },
        },
      });
      return rows.map(toWrittenQuestion);
    },
  };
}
