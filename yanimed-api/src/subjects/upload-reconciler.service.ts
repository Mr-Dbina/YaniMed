import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { InitialUploadService, UPLOAD_RECONCILE_DELAY_MS } from './initial-upload.service.js';

@Injectable()
export class UploadReconciler implements OnApplicationBootstrap, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private readonly logger = new Logger(UploadReconciler.name);
  constructor(@Inject(InitialUploadService) private readonly uploads: InitialUploadService) {}

  onApplicationBootstrap() {
    this.timer = setInterval(() => { void this.tick(); }, UPLOAD_RECONCILE_DELAY_MS);
    this.timer.unref();
    void this.tick();
  }

  tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.uploads.reconcileBatch()
      .catch(() => { this.logger.warn('Upload reconciliation unavailable; will resume on the next sweep.'); })
      .finally(() => { this.running = undefined; });
    return this.running;
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
}
