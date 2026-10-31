import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { EmbeddingService, EMBEDDING_DIMENSIONS } from '../embeddings/embedding.service.js';

const RRF_K = 60;

interface RetrievalRow {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  pageNumber: number;
  content: string;
  extractionMethod: string;
}

interface VectorRow extends RetrievalRow {
  score: number;
}

interface FusionCandidate {
  row: RetrievalRow;
  score: number;
  vectorRank: number | null;
  keywordRank: number | null;
}

export interface RetrievalMatch {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  pageNumber: number;
  content: string;
  score: number;
  extractionMethod: string;
  fusedScore?: number;
  matchedBy?: 'vector' | 'keyword' | 'both';
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
    const candidateLimit = Math.min(Math.max(topK * 4, 20), 100);

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
    const [vectorRows, keywordRows] = await Promise.all([
      this.prisma.$queryRaw<VectorRow[]>`
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
        LIMIT ${candidateLimit}
      `,
      this.prisma.$queryRaw<RetrievalRow[]>`
        SELECT c."id" AS "chunkId",
               c."documentId" AS "documentId",
               d."title" AS "documentTitle",
               c."page" AS "pageNumber",
               c."content" AS "content",
               c."extractionMethod"::text AS "extractionMethod"
        FROM "Chunk" c
        JOIN "Document" d ON d."id" = c."documentId"
        WHERE d."subjectId" = ${subjectId}
          AND d."status" = 'READY'
          AND c."tsv" @@ websearch_to_tsquery('english', ${trimmedQuestion})
        ORDER BY ts_rank_cd(c."tsv", websearch_to_tsquery('english', ${trimmedQuestion})) DESC,
                 c."id" ASC
        LIMIT ${candidateLimit}
      `,
    ]);

    const vectorChunkIds = new Set(vectorRows.map(row => row.chunkId));
    const keywordOnlyIds = [...new Set(
      keywordRows.map(row => row.chunkId).filter(chunkId => !vectorChunkIds.has(chunkId)),
    )];
    const keywordOnlyScores = new Map<string, number>();
    if (keywordOnlyIds.length > 0) {
      const scoreRows = await this.prisma.$queryRaw<Array<{ chunkId: string; score: number }>>`
        SELECT c."id" AS "chunkId",
               (1 - (c."embedding" <=> ${literal}::vector))::float8 AS "score"
        FROM "Chunk" c
        JOIN "Document" d ON d."id" = c."documentId"
        WHERE d."subjectId" = ${subjectId}
          AND d."status" = 'READY'
          AND c."embedding" IS NOT NULL
          AND c."id" IN (${Prisma.join(keywordOnlyIds)})
      `;
      for (const row of scoreRows) keywordOnlyScores.set(row.chunkId, row.score);
    }

    const candidates = new Map<string, FusionCandidate>();
    for (const [index, row] of vectorRows.entries()) {
      candidates.set(row.chunkId, {
        row,
        score: row.score,
        vectorRank: index + 1,
        keywordRank: null,
      });
    }
    for (const [index, row] of keywordRows.entries()) {
      const existing = candidates.get(row.chunkId);
      if (existing) {
        existing.keywordRank = index + 1;
      } else {
        candidates.set(row.chunkId, {
          row,
          score: keywordOnlyScores.get(row.chunkId) ?? 0,
          vectorRank: null,
          keywordRank: index + 1,
        });
      }
    }

    // minScore is a cosine gate for vector-only hits. Hits matched by keyword
    // are exempt, so keyword-only and both-leg hits survive a strict minScore.
    const eligible = [...candidates.values()].filter(candidate =>
      candidate.keywordRank !== null || candidate.score >= minScore,
    );
    const withExistingPages = await this.existingPageCandidates(eligible);

    const matches = withExistingPages
      .map<RetrievalMatch>(candidate => {
        const vectorPart = candidate.vectorRank === null ? 0 : 1 / (RRF_K + candidate.vectorRank);
        const keywordPart = candidate.keywordRank === null ? 0 : 1 / (RRF_K + candidate.keywordRank);
        return {
          chunkId: candidate.row.chunkId,
          documentId: candidate.row.documentId,
          documentTitle: candidate.row.documentTitle,
          pageNumber: candidate.row.pageNumber,
          content: candidate.row.content,
          score: candidate.score,
          extractionMethod: candidate.row.extractionMethod,
          fusedScore: vectorPart + keywordPart,
          matchedBy: candidate.vectorRank !== null && candidate.keywordRank !== null
            ? 'both'
            : candidate.keywordRank !== null
              ? 'keyword'
              : 'vector',
        };
      })
      .sort((a, b) =>
        (b.fusedScore ?? 0) - (a.fusedScore ?? 0) ||
        b.score - a.score ||
        a.chunkId.localeCompare(b.chunkId),
      )
      .slice(0, topK);

    return { subjectId, question: trimmedQuestion, matches, hasReadyDocuments: true };
  }

  private async existingPageCandidates(candidates: FusionCandidate[]): Promise<FusionCandidate[]> {
    if (candidates.length === 0) return candidates;
    const documentIds = [...new Set(candidates.map(candidate => candidate.row.documentId))];
    const pageRows = await this.prisma.$queryRaw<Array<{ documentId: string; pageNumber: number }>>`
      SELECT "documentId", "pageNumber"
      FROM "DocumentPage"
      WHERE "documentId" IN (${Prisma.join(documentIds)})
    `;
    const existingPages = new Set(
      pageRows.map(page => `${page.documentId}:${page.pageNumber}`),
    );
    return candidates.filter(candidate =>
      existingPages.has(`${candidate.row.documentId}:${candidate.row.pageNumber}`),
    );
  }
}
