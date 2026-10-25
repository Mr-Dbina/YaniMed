import { ForbiddenException, Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { EmbeddingService, EMBEDDING_DIMENSIONS } from '../embeddings/embedding.service.js';

export interface RetrievalMatch {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  pageNumber: number;
  content: string;
  score: number;
  extractionMethod: string;
}

export interface RetrievalResult {
  subjectId: string;
  question: string;
  matches: RetrievalMatch[];
  hasReadyDocuments: boolean;
}

export interface RetrievalOptions {
  topK?: number;
  minScore?: number;
}

@Injectable()
export class RetrievalService {
  private readonly logger = new Logger(RetrievalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly embeddings: EmbeddingService,
  ) {}

  async retrieve(subjectId: string, question: string, options: RetrievalOptions = {}): Promise<RetrievalResult> {
    const trimmedQuestion = question?.trim();
    if (!trimmedQuestion) throw new ForbiddenException('A question is required.');
    const topK = Math.min(Math.max(options.topK ?? 5, 1), 50);
    const minScore = options.minScore ?? 0;

    const subject = await this.prisma.subject.findUnique({ where: { id: subjectId } });
    if (!subject) throw new ForbiddenException('Subject is not accessible.');

    const readyCount = await this.prisma.document.count({
      where: { subjectId, status: 'READY' },
    });
    if (readyCount === 0) {
      return { subjectId, question: trimmedQuestion, matches: [], hasReadyDocuments: false };
    }

    const queryVector = await this.embeddings.embedText(trimmedQuestion, 'RETRIEVAL_QUERY');
    if (!Array.isArray(queryVector) || queryVector.length !== EMBEDDING_DIMENSIONS ||
        !queryVector.every(value => typeof value === 'number' && Number.isFinite(value))) {
      throw new Error('Invalid query embedding.');
    }

    const literal = `[${queryVector.join(',')}]`;
    const rows = await this.prisma.$queryRaw<
      Array<{
        chunkId: string;
        documentId: string;
        documentTitle: string;
        pageNumber: number;
        content: string;
        extractionMethod: string;
        score: number;
      }>
    >`
      SELECT c."id" AS "chunkId",
             c."documentId" AS "documentId",
             d."title" AS "documentTitle",
             c."page" AS "pageNumber",
             c."content" AS "content",
             c."extractionMethod"::text AS "extractionMethod",
             (1 - (c."embedding" <=> ${literal}::vector))::float8 AS "score"
      FROM "Chunk" c
      JOIN "Document" d ON d."id" = c."documentId"
      WHERE d."subjectId" = ${subjectId}
        AND d."status" = 'READY'
        AND c."embedding" IS NOT NULL
      ORDER BY c."embedding" <=> ${literal}::vector ASC, c."id" ASC
      LIMIT ${topK}
    `;

    const matches: RetrievalMatch[] = [];
    for (const row of rows) {
      if (row.score < minScore) continue;
      const pageExists = await this.prisma.$queryRaw<Array<{ exists: boolean }>>`
        SELECT EXISTS (
          SELECT 1 FROM "DocumentPage"
          WHERE "documentId" = ${row.documentId} AND "pageNumber" = ${row.pageNumber}
        ) AS "exists"
      `;
      if (!pageExists[0]?.exists) continue;
      matches.push({
        chunkId: row.chunkId,
        documentId: row.documentId,
        documentTitle: row.documentTitle,
        pageNumber: row.pageNumber,
        content: row.content,
        score: row.score,
        extractionMethod: row.extractionMethod,
      });
    }

    matches.sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId));
    return { subjectId, question: trimmedQuestion, matches, hasReadyDocuments: true };
  }
}
