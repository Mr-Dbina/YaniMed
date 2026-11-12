import type { PrismaService } from '../../../prisma/prisma.service.js';

export interface ReadyDocumentSnapshot {
  id: string;
  title: string;
  pageCount: number | null;
}

export interface SourceChunk {
  documentId: string;
  content: string;
  page: number;
  chunkIndex: number;
  needsReview: boolean;
}

export interface SourcePage {
  documentId: string;
  pageNumber: number;
  text: string;
  needsOcr: boolean;
  ocrUsed: boolean;
}

export interface ReadySnapshot {
  documents: ReadyDocumentSnapshot[];
  chunks: SourceChunk[];
  pages: SourcePage[];
}

/**
 * Read-only snapshot loader. Only READY documents are returned, and the
 * document ids are the job snapshot the generator must stay inside.
 */
export class GenerationSourceLoader {
  constructor(private readonly prisma: PrismaService) {}

  async loadReadySnapshot(subjectId: string): Promise<ReadySnapshot> {
    const documents = await this.prisma.document.findMany({
      where: { subjectId, status: 'READY' },
      select: { id: true, title: true, pageCount: true },
      orderBy: { createdAt: 'asc' },
    });

    if (documents.length === 0) {
      return { documents: [], chunks: [], pages: [] };
    }

    const documentIds = documents.map((document) => document.id);
    const [chunks, pages] = await Promise.all([
      this.prisma.chunk.findMany({
        where: { documentId: { in: documentIds } },
        select: {
          documentId: true,
          content: true,
          page: true,
          chunkIndex: true,
          needsReview: true,
        },
        orderBy: [{ documentId: 'asc' }, { chunkIndex: 'asc' }],
      }),
      this.prisma.documentPage.findMany({
        where: { documentId: { in: documentIds } },
        select: {
          documentId: true,
          pageNumber: true,
          text: true,
          needsOcr: true,
          ocrUsed: true,
        },
        orderBy: [{ documentId: 'asc' }, { pageNumber: 'asc' }],
      }),
    ]);

    return { documents, chunks, pages };
  }
}
