import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { DocumentProcessingService } from './document-processing.service.js';

const RECONCILE_DELAY_MS = 30_000;
const ORPHAN_BATCH_SIZE = 20;
const DRAIN_BATCH_SIZE = 5;

@Injectable()
export class DocumentProcessingReconciler implements OnApplicationBootstrap, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private readonly logger = new Logger(DocumentProcessingReconciler.name);

  constructor(
    @Inject(DocumentProcessingService) private readonly processing: DocumentProcessingService,
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
    await this.processing.enqueueOrphans(ORPHAN_BATCH_SIZE);
    await this.processing.drain(DRAIN_BATCH_SIZE);
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
}
