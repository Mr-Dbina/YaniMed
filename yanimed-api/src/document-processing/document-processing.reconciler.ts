import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { DocumentProcessingService } from './document-processing.service.js';

const RECONCILE_DELAY_MS = 30_000;
const BATCH_SIZE = 5;

@Injectable()
export class DocumentProcessingReconciler implements OnApplicationBootstrap, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private readonly logger = new Logger(DocumentProcessingReconciler.name);

  constructor(
    @Inject(DocumentProcessingService) private readonly processing: DocumentProcessingService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  onApplicationBootstrap() {
    this.timer = setInterval(() => { void this.tick(); }, RECONCILE_DELAY_MS);
    this.timer.unref();
    void this.tick();
  }

  tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.runBatch()
      .catch(() => { this.logger.warn('Document processing reconciliation unavailable; will resume on the next sweep.'); })
      .finally(() => { this.running = undefined; });
    return this.running;
  }

  private async runBatch() {
    const documents = await this.prisma.document.findMany({
      where: { status: { in: ['UPLOADED', 'PROCESSING'] } },
      orderBy: { updatedAt: 'asc' },
      take: BATCH_SIZE,
      select: { id: true },
    });
    for (const document of documents) {
      try {
        await this.processing.processDocument(document.id);
      } catch {
        this.logger.warn(`Document processing deferred for ${document.id}.`);
      }
    }
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
}
