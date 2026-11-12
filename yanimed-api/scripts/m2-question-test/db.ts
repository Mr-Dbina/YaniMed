import { PrismaClient } from '@prisma/client';
import type { ChunkRow, DocumentRow, PageRow, SubjectRow } from './types.js';
import { parseEmbedding } from './text.js';

// Spec constraints: one read helper, SELECT-only.
export function assertSelectOnly(sql: string): string {
  const trimmed = sql.trim();
  if (!/^select\b/i.test(trimmed)) {
    throw new Error('Refusing non-SELECT SQL statement.');
  }
  return trimmed;
}

export async function selectOnly<T>(
  prisma: PrismaClient,
  sql: string,
  ...params: unknown[]
): Promise<T[]> {
  const statement = assertSelectOnly(sql);
  return prisma.$queryRawUnsafe<T[]>(statement, ...params);
}

export async function findActiveSubject(prisma: PrismaClient, name: string): Promise<SubjectRow> {
  const rows = await selectOnly<SubjectRow>(
    prisma,
    `SELECT s.id, s.name, s.status
     FROM "Subject" s
     WHERE s.name = $1 AND s.status = 'ACTIVE'
     ORDER BY s."createdAt" ASC`,
    name,
  );
  if (rows.length !== 1) {
    throw new Error(`Expected exactly one ACTIVE Subject named "${name}", found ${rows.length}.`);
  }
  return rows[0];
}

export async function loadReadyDocuments(prisma: PrismaClient, subjectId: string): Promise<DocumentRow[]> {
  return selectOnly<DocumentRow>(
    prisma,
    `SELECT d.id, d.title, d.status,
            d."pageCount" AS "pageCount",
            d."embeddedChunks" AS "embeddedChunks"
     FROM "Document" d
     WHERE d."subjectId" = $1 AND d.status = 'READY'
     ORDER BY d.title`,
    subjectId,
  );
}

interface RawChunkRow extends Omit<ChunkRow, 'embedding' | 'embeddingRaw'> {
  embeddingText: string | null;
}

export async function loadChunks(prisma: PrismaClient, subjectId: string): Promise<ChunkRow[]> {
  const rows = await selectOnly<RawChunkRow>(
    prisma,
    `SELECT c.id, c."documentId", d.title AS "documentTitle",
            c.content, c.page, c."chunkIndex",
            c.embedding::text AS "embeddingText",
            c."extractionMethod", c."needsReview"
     FROM "Chunk" c
     JOIN "Document" d ON d.id = c."documentId"
     WHERE d."subjectId" = $1 AND d.status = 'READY'
     ORDER BY c."documentId", c.page, c."chunkIndex"`,
    subjectId,
  );

  return rows.map(row => ({
    ...row,
    embeddingRaw: row.embeddingText,
    embedding: parseEmbedding(row.embeddingText),
  }));
}

export async function loadPages(prisma: PrismaClient, subjectId: string): Promise<PageRow[]> {
  return selectOnly<PageRow>(
    prisma,
    `SELECT p."documentId", p."pageNumber", p.text,
            p."extractionMethod", p."ocrUsed"
     FROM "DocumentPage" p
     JOIN "Document" d ON d.id = p."documentId"
     WHERE d."subjectId" = $1 AND d.status = 'READY'
     ORDER BY p."documentId", p."pageNumber"`,
    subjectId,
  );
}
