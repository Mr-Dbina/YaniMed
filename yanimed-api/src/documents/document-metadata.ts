import type { Prisma } from '@prisma/client';

export const documentMetadataSelect = {
  id: true, subjectId: true, title: true, status: true, createdAt: true, updatedAt: true,
  pageCount: true, processedPages: true, embeddedChunks: true, ocrPages: true,
} satisfies Prisma.DocumentSelect;

export function documentMetadata(row: Prisma.DocumentGetPayload<{ select: typeof documentMetadataSelect }>) {
  return { documentId: row.id, subjectId: row.subjectId, filename: row.title,
    status: row.status, createdAt: row.createdAt, updatedAt: row.updatedAt,
    pageCount: row.pageCount, processedPages: row.processedPages,
    embeddedChunks: row.embeddedChunks, ocrPages: row.ocrPages };
}
