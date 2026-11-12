import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../../prisma/prisma.service.js';
import { GenerationSourceLoader } from './source-loader.js';

function makePrisma() {
  return {
    document: { findMany: vi.fn() },
    chunk: { findMany: vi.fn() },
    documentPage: { findMany: vi.fn() },
  };
}

function loaderFor(prisma: ReturnType<typeof makePrisma>) {
  return new GenerationSourceLoader(prisma as unknown as PrismaService);
}

describe('GenerationSourceLoader', () => {
  it('returns an empty snapshot when the subject has no READY documents', async () => {
    const prisma = makePrisma();
    prisma.document.findMany.mockResolvedValue([]);

    const snapshot = await loaderFor(prisma).loadReadySnapshot('subject-1');

    expect(snapshot).toEqual({ documents: [], chunks: [], pages: [] });
    expect(prisma.document.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { subjectId: 'subject-1', status: 'READY' },
      }),
    );
    expect(prisma.chunk.findMany).not.toHaveBeenCalled();
    expect(prisma.documentPage.findMany).not.toHaveBeenCalled();
  });

  it('loads chunks and pages only for the READY snapshot', async () => {
    const prisma = makePrisma();
    prisma.document.findMany.mockResolvedValue([
      { id: 'doc-1', title: 'Pediatrics', pageCount: 60 },
    ]);
    prisma.chunk.findMany.mockResolvedValue([
      {
        documentId: 'doc-1',
        content: 'A chunk',
        page: 3,
        chunkIndex: 0,
        needsReview: false,
      },
    ]);
    prisma.documentPage.findMany.mockResolvedValue([
      {
        documentId: 'doc-1',
        pageNumber: 3,
        text: 'A page',
        needsOcr: false,
        ocrUsed: false,
      },
    ]);

    const snapshot = await loaderFor(prisma).loadReadySnapshot('subject-1');

    expect(snapshot.documents).toEqual([
      { id: 'doc-1', title: 'Pediatrics', pageCount: 60 },
    ]);
    expect(snapshot.chunks).toHaveLength(1);
    expect(snapshot.pages).toHaveLength(1);
    expect(prisma.chunk.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { documentId: { in: ['doc-1'] } },
      }),
    );
    expect(prisma.documentPage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { documentId: { in: ['doc-1'] } },
      }),
    );
  });
});
