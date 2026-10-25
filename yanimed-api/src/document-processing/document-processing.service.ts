import { Inject, Injectable, Logger, NotFoundException, Optional, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { PdfExtractionService } from '../pdf-extraction/pdf-extraction.service.js';
import { EmbeddingService } from '../embeddings/embedding.service.js';

@Injectable()
export class DocumentProcessingService {
  private readonly logger = new Logger(DocumentProcessingService.name);
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Optional() private readonly extraction?: PdfExtractionService,
    @Optional() private readonly embeddings?: EmbeddingService,
  ) {}

  schedule(documentId: string): void {
    void this.processDocument(documentId).catch(error => {
      this.logger.warn(`Document processing failed for ${documentId}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  async processDocument(documentId: string): Promise<void> {
    const previous = this.locks.get(documentId) ?? Promise.resolve();
    let resolveLock!: () => void;
    const current = new Promise<void>(resolve => { resolveLock = resolve; });
    this.locks.set(documentId, previous.then(() => current));
    try {
      await previous;
      await this.run(documentId);
    } finally {
      resolveLock();
      if (this.locks.get(documentId) === previous.then(() => current)) {
        this.locks.delete(documentId);
      }
    }
  }

  private async run(documentId: string): Promise<void> {
    const document = await this.prisma.document.findUnique({ where: { id: documentId } });
    if (!document) return;
    if (document.status === 'READY') return;

    const claimed = await this.prisma.document.updateMany({
      where: { id: documentId, status: { in: ['UPLOADED', 'PROCESSING', 'FAILED'] } },
      data: { status: 'PROCESSING', errorMessage: null },
    });
    if (claimed.count === 0) return;

    try {
      if (this.extraction) {
        await this.extraction.processDocument(documentId);
      } else {
        throw new Error('PDF extraction service is not available.');
      }
      if (this.embeddings) {
        await this.embeddings.embedDocument(documentId);
        const integrity = await this.embeddings.verifyDocumentEmbeddings(documentId);
        if (integrity.totalChunks === 0) {
          throw new Error('Document contains no extractable text.');
        }
        if (!integrity.isComplete) {
          throw new Error('Embedding integrity verification failed.');
        }
      } else {
        throw new Error('Embedding service is not available.');
      }

      await this.prisma.document.update({
        where: { id: documentId },
        data: { status: 'READY', errorMessage: null },
      });
    } catch (error) {
      await this.prisma.document.update({
        where: { id: documentId },
        data: {
          status: 'FAILED',
          errorMessage: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }
  }
}
