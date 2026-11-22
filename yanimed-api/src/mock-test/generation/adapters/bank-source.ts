import type { PrismaService } from '../../../prisma/prisma.service.js';
import { EMBEDDING_MODEL } from '../../../embeddings/embedding.service.js';
import { BANK_EMBED_CAP, DUPLICATE_EMBEDDING_DIMENSIONS } from '../generation.constants.js';
import { getGenerationPrisma } from '../persist/question-writer.js';
import { parseEmbedding } from '../text/embedding.js';
import type { EmbedPort } from '../runner/ports.js';
import type { AcceptedQuestionRef, BankSource } from '../validate/check-c.js';

export interface BankQuestionRow {
  id: string;
  stem: string;
  leadIn: string | null;
  educationalObjective: string;
  topicKey: string;
  correctChoiceText: string | null;
  documentId: string | null;
  pageNumber: number | null;
  quote: string | null;
  embeddingText: string | null;
  embeddingModel: string | null;
}

export interface BankSourceOptions {
  prisma?: PrismaService;
  subjectId: string;
  jobId: string;
  embed: EmbedPort;
  cap?: number;
}

type BankRef = Omit<AcceptedQuestionRef, 'embedding'> & {
  embedding: number[] | null;
};

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
    const rows = await prisma.$queryRaw<Array<{
      id: string;
      stem: string;
      leadIn: string | null;
      educationalObjective: string;
      topicKey: string;
      correctChoiceText: string | null;
      documentId: string | null;
      pageNumber: number | null;
      quote: string | null;
      embeddingText: string | null;
      embeddingModel: string | null;
    }>>`
      SELECT
        q."id",
        q."stem",
        q."leadIn",
        q."educationalObjective",
        t."key" AS "topicKey",
        c."text" AS "correctChoiceText",
        cit."documentId",
        cit."pageNumber",
        cit."quote",
        q."embedding"::text AS "embeddingText",
        q."embeddingModel"
      FROM "MockQuestion" q
      JOIN "SubjectTopic" t ON t."id" = q."topicId"
      LEFT JOIN LATERAL (
        SELECT ch."text"
        FROM "MockChoice" ch
        WHERE ch."questionId" = q."id" AND ch."isCorrect" = true
        ORDER BY ch."position" ASC
        LIMIT 1
      ) c ON true
      LEFT JOIN LATERAL (
        SELECT cit."documentId", cit."pageNumber", cit."quote"
        FROM "QuestionCitation" cit
        WHERE cit."questionId" = q."id"
        ORDER BY cit."createdAt" ASC, cit."id" ASC
        LIMIT 1
      ) cit ON true
      WHERE q."subjectId" = ${subjectId}
        AND q."status" = 'ACTIVE'
        AND (q."jobId" IS NULL OR q."jobId" <> ${jobId})
        AND EXISTS (
          SELECT 1 FROM "QuestionCitation" cit2 WHERE cit2."questionId" = q."id"
        )
      ORDER BY q."createdAt" DESC, q."id" DESC
    `;

    const refs: BankRef[] = rows.map((row) => {
      const parsed = parseEmbedding(row.embeddingText);
      const valid =
        parsed.length === DUPLICATE_EMBEDDING_DIMENSIONS &&
        row.embeddingModel === EMBEDDING_MODEL;
      return {
        key: row.id,
        embedding: valid ? parsed : null,
        topicKey: row.topicKey,
        objective: row.educationalObjective,
        documentId: row.documentId ?? '',
        page: row.pageNumber ?? 0,
        quote: row.quote ?? '',
        keyChoiceText: row.correctChoiceText ?? '',
      };
    });

    let newlyEmbedded = 0;
    const embedCount = Math.max(0, Math.min(cap, refs.length));
    for (let index = 0; index < refs.length && newlyEmbedded < embedCount; index += 1) {
      if (refs[index].embedding === null) {
        const row = rows[index];
        const vector = await embed({
          jobId,
          text: `${row.stem}\n${row.leadIn ?? ''}`,
        });
        refs[index].embedding = vector;
        newlyEmbedded += 1;

        const literal = '[' + vector.join(',') + ']';
        await prisma.$executeRaw`
          UPDATE "MockQuestion"
          SET "embedding" = ${literal}::vector,
              "embeddingModel" = ${EMBEDDING_MODEL}
          WHERE "id" = ${row.id}
        `;
      }
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
