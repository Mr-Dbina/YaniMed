import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { DocumentProcessingService } from './document-processing.service.js';
import { sanitizeProcessingMessage } from './processing-error.js';

const RECONCILE_DELAY_MS = 30_000;
const ORPHAN_BATCH_SIZE = 20;
const DRAIN_BATCH_SIZE = 5;
const CONNECTION_STRING = /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqp|https?):\/\/[^\s]+/gi;

function errorName(error: unknown): string {
  if (error instanceof Error) return error.name;
  if (typeof error === 'object' && error !== null && typeof (error as { name?: unknown }).name === 'string') {
    return String((error as { name: string }).name);
  }
  return 'Error';
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string') {
    return String((error as { code: string }).code);
  }
  return 'none';
}

function redactConnectionStrings(message: string): string {
  return message.replace(CONNECTION_STRING, '[REDACTED_CONNECTION_STRING]');
}

function errorSummary(error: unknown): string {
  const message = sanitizeProcessingMessage(error instanceof Error ? error.message : String(error));
  return `name=${errorName(error)} code=${errorCode(error)} message=${redactConnectionStrings(message)}`;
}

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
      .catch(error => {
        this.logger.warn(`Document processing reconciliation unavailable; will resume on the next sweep. ${errorSummary(error)}`);
      })
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
