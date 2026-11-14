import type { PrismaService } from '../../../prisma/prisma.service.js';
import { GenerationError } from '../generation.errors.js';
import { getGenerationPrisma } from '../persist/question-writer.js';
import type { PlannerChunkInput } from '../plan/clustering.js';
import { parseEmbedding } from '../text/embedding.js';
import type { JobInputs, JobSource } from '../runner/ports.js';

export type StyleHint = JobInputs['styleHint'];

/**
 * Placeholder until per-subject style exists: every subject currently gets a
 * clinical stem. Kept as one function so only this line changes later.
 */
export function resolveStyleHint(subjectName: string): StyleHint {
  void subjectName;
  return 'CLINICAL_STEM';
}

export interface SnapshotPageRow {
  documentId: string;
  pageNumber: number;
  text: string;
  needsOcr: boolean;
  ocrUsed: boolean;
}

export interface SnapshotChunkRow {
  id: string;
  documentId: string;
  content: string;
  page: number;
  chunkIndex: number;
  needsReview: boolean;
  /** pgvector text form from `embedding::text`; null when not embedded. */
  embeddingText: string | null;
}

export function pageKey(documentId: string, pageNumber: number): string {
  return `${documentId}:${pageNumber}`;
}

/** Pages keyed by documentId:page. Missing rows are simply absent. */
export function pagesByKey(
  rows: readonly SnapshotPageRow[],
): JobInputs['pages'] {
  const pages: JobInputs['pages'] = new Map();
  for (const row of rows) {
    pages.set(pageKey(row.documentId, row.pageNumber), {
      text: row.text,
      needsOcr: row.needsOcr || row.ocrUsed,
    });
  }
  return pages;
}

/** parseEmbedding never throws; an empty result means "not embedded". */
export function toPlannerChunk(row: SnapshotChunkRow): PlannerChunkInput {
  const embedding = parseEmbedding(row.embeddingText);
  return {
    id: row.id,
    documentId: row.documentId,
    content: row.content,
    page: row.page,
    chunkIndex: row.chunkIndex,
    needsReview: row.needsReview,
    embedding: embedding.length === 0 ? null : embedding,
  };
}

function notFound(
  jobId: string,
  details: Record<string, number>,
  missingIds?: string[],
): GenerationError {
  return new GenerationError('GENERATION_NOT_FOUND', {
    jobId,
    details,
    ...(missingIds === undefined ? {} : { missingIds }),
  });
}

/**
 * Loads everything the runner needs inside the job's document snapshot. Any
 * missing or non-READY snapshot document invalidates the whole load, because
 * a citation outside the snapshot can never be written.
 */
export function createJobSource(
  prisma: PrismaService = getGenerationPrisma(),
): JobSource {
  return {
    async load(jobId: string): Promise<JobInputs> {
      const job = await prisma.generationJob.findUnique({
        where: { id: jobId },
        select: {
          subjectId: true,
          requestedCount: true,
          subject: { select: { name: true } },
          documents: { select: { documentId: true } },
        },
      });
      if (!job) throw notFound(jobId, { snapshotDocuments: 0 });

      const snapshotDocumentIds = new Set(
        job.documents.map((link) => link.documentId),
      );
      if (snapshotDocumentIds.size === 0) {
        throw notFound(jobId, { snapshotDocuments: 0 });
      }

      const ids = [...snapshotDocumentIds];
      const documents = await prisma.document.findMany({
        where: { id: { in: ids }, subjectId: job.subjectId },
        select: { id: true, title: true, pageCount: true, status: true },
        orderBy: { id: 'asc' },
      });

      const found = new Set(documents.map((document) => document.id));
      const missingIds = ids.filter((id) => !found.has(id));
      const notReady = documents.filter(
        (document) => document.status !== 'READY',
      ).length;
      if (missingIds.length > 0 || notReady > 0) {
        throw notFound(
          jobId,
          {
            snapshotDocuments: ids.length,
            missingDocuments: missingIds.length,
            notReadyDocuments: notReady,
          },
          missingIds.length === 0 ? undefined : missingIds,
        );
      }

      const [pageRows, chunkRows] = await Promise.all([
        prisma.documentPage.findMany({
          where: { documentId: { in: ids } },
          select: {
            documentId: true,
            pageNumber: true,
            text: true,
            needsOcr: true,
            ocrUsed: true,
          },
          orderBy: [{ documentId: 'asc' }, { pageNumber: 'asc' }],
        }),
        // Prisma cannot select Unsupported() columns; embedding is read as text.
        prisma.$queryRaw<SnapshotChunkRow[]>`
          SELECT "id", "documentId", "content", "page", "chunkIndex",
                 "needsReview", "embedding"::text AS "embeddingText"
          FROM "Chunk"
          WHERE "documentId" = ANY(${ids}::text[])
          ORDER BY "documentId" ASC, "page" ASC, "chunkIndex" ASC
        `,
      ]);

      const documentMap: JobInputs['documents'] = new Map(
        documents.map((document) => [
          document.id,
          {
            title: document.title,
            pageCount: document.pageCount ?? 0,
          },
        ]),
      );

      return {
        subjectId: job.subjectId,
        subjectName: job.subject.name,
        styleHint: resolveStyleHint(job.subject.name),
        requestedCount: job.requestedCount,
        snapshotDocumentIds,
        documents: documentMap,
        pages: pagesByKey(pageRows),
        chunks: chunkRows.map(toPlannerChunk),
      };
    },
  };
}
