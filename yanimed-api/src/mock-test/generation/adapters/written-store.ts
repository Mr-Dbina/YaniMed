import type { PrismaService } from '../../../prisma/prisma.service.js';
import { EMBEDDING_MODEL } from '../../../embeddings/embedding.service.js';
import { DUPLICATE_EMBEDDING_DIMENSIONS } from '../generation.constants.js';
import { getGenerationPrisma } from '../persist/question-writer.js';
import { parseEmbedding } from '../text/embedding.js';
import type { WrittenQuestion, WrittenStore } from '../runner/ports.js';

export function toWrittenQuestion(row: {
  id: string;
  status: string;
  stem: string;
  leadIn: string | null;
  educationalObjective: string;
  topicKey: string;
  choices: { text: string; isCorrect: boolean }[];
  citations: { documentId: string | null; pageNumber: number; quote: string }[];
  embeddingText: string | null;
  embeddingModel: string | null;
}): WrittenQuestion {
  const parsed = parseEmbedding(row.embeddingText);
  const valid =
    parsed.length === DUPLICATE_EMBEDDING_DIMENSIONS &&
    row.embeddingModel === EMBEDDING_MODEL;

  const key = row.choices.find((choice) => choice.isCorrect);
  return {
    questionId: row.id,
    status: row.status,
    topicKey: row.topicKey,
    stem: row.stem,
    leadIn: row.leadIn,
    objective: row.educationalObjective,
    keyChoiceText: key?.text ?? '',
    citations: row.citations.map((citation) => ({
      documentId: citation.documentId,
      page: citation.pageNumber,
      quote: citation.quote,
    })),
    embedding: valid ? parsed : null,
  };
}

export function createWrittenStore(
  prisma: PrismaService = getGenerationPrisma(),
): WrittenStore {
  return {
    async listWritten(jobId: string): Promise<WrittenQuestion[]> {
      const rows = await prisma.$queryRaw<Array<{
        id: string;
        status: string;
        stem: string;
        leadIn: string | null;
        educationalObjective: string;
        topicKey: string;
        choices: { text: string; isCorrect: boolean }[];
        citations: { documentId: string | null; pageNumber: number; quote: string }[];
        embeddingText: string | null;
        embeddingModel: string | null;
      }>>`
        SELECT
          q."id",
          q."status",
          q."stem",
          q."leadIn",
          q."educationalObjective",
          t."key" AS "topicKey",
          COALESCE(
            (
              SELECT json_agg(json_build_object('text', ch."text", 'isCorrect', ch."isCorrect"))
              FROM "MockChoice" ch
              WHERE ch."questionId" = q."id"
            ),
            '[]'::json
          ) AS choices,
          COALESCE(
            (
              SELECT json_agg(json_build_object('documentId', cit."documentId", 'pageNumber', cit."pageNumber", 'quote', cit."quote") ORDER BY cit."createdAt" ASC, cit."id" ASC)
              FROM "QuestionCitation" cit
              WHERE cit."questionId" = q."id"
            ),
            '[]'::json
          ) AS citations,
          q."embedding"::text AS "embeddingText",
          q."embeddingModel"
        FROM "MockQuestion" q
        JOIN "SubjectTopic" t ON t."id" = q."topicId"
        WHERE q."jobId" = ${jobId}
          AND q."status" <> 'RETIRED'
        ORDER BY q."createdAt" ASC, q."id" ASC
      `;
      return rows.map(toWrittenQuestion);
    },
    async saveEmbedding(questionId: string, embedding: number[]): Promise<void> {
      const literal = '[' + embedding.join(',') + ']';
      await prisma.$executeRaw`
        UPDATE "MockQuestion"
        SET "embedding" = ${literal}::vector,
            "embeddingModel" = ${EMBEDDING_MODEL}
        WHERE "id" = ${questionId}
      `;
    },
  };
}
