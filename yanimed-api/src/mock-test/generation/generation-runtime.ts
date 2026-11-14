import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service.js';
import { createBankSource } from './adapters/bank-source.js';
import { createJobSource } from './adapters/job-source.js';
import { createPlanStore } from './adapters/plan-store.js';
import { createWrittenStore } from './adapters/written-store.js';
import { GenerationAiService } from './ai/generation-ai.service.js';
import { draftQuestion } from './draft/draft.service.js';
import type { ClaimedGenerationJob, GenerationJobState } from './generation-job.types.js';
import { GenerationJobRepository } from './generation-job.repository.js';
import { GenerationPlanner } from './plan/planner.js';
import { ensureSubjectTopics } from './persist/topics.js';
import {
  publishJobQuestions,
  writeQuestion,
} from './persist/question-writer.js';
import { createReconciler } from './reconciler/reconciler.js';
import type { Reconciler } from './reconciler/reconciler.types.js';
import { runJob } from './runner/job-runner.js';
import type { RunnerDeps } from './runner/ports.js';
import { validateDraft } from './validate/check-a.js';
import { verifyDraft } from './validate/check-b.js';
import { checkDuplicates } from './validate/check-c.js';
import { validateSet } from './validate/check-d.js';
import { createGenerationWorker } from './worker/generation-worker.js';
import type { GenerationWorker, WorkerLogger } from './worker/worker.types.js';

export interface GenerationRuntimeComponents {
  reconciler: Pick<Reconciler, 'recoverOnBoot' | 'start' | 'stop'>;
  worker: Pick<GenerationWorker, 'start' | 'stop'>;
}

export interface GenerationRuntimeOptions {
  components: GenerationRuntimeComponents;
  /** MOCK_TEST_ENABLED, read through ConfigService. */
  enabled: boolean;
  /** The worker never starts inside the test runner. */
  underTest: boolean;
}

export interface GenerationRuntimeHandle {
  bootstrap(): Promise<void>;
  shutdown(): Promise<void>;
}

/**
 * The only start path: boot recovery first, then the reconciler and the
 * worker. Shutdown reverses the order so no sweep claims a job the worker is
 * still unwinding.
 */
export function createGenerationRuntime(
  options: GenerationRuntimeOptions,
): GenerationRuntimeHandle {
  const { components } = options;
  let started = false;
  let booting: Promise<void> | null = null;

  const bootstrap = (): Promise<void> => {
    if (started || !options.enabled || options.underTest) {
      return Promise.resolve();
    }
    if (booting !== null) return booting;

    booting = components.reconciler
      .recoverOnBoot()
      .then(() => {
        if (started || !options.enabled || options.underTest) return;
        components.reconciler.start();
        components.worker.start();
        started = true;
      })
      .finally(() => {
        booting = null;
      });
    return booting;
  };

  const shutdown = async (): Promise<void> => {
    started = false;
    await components.worker.stop();
    components.reconciler.stop();
  };

  return { bootstrap, shutdown };
}

/** Log fields are ids, codes and numbers only. */
function runtimeLogger(logger: Logger): WorkerLogger {
  const write = (
    level: 'log' | 'warn' | 'error',
    event: string,
    fields?: Record<string, string | number | undefined>,
  ): void => {
    logger[level](fields === undefined ? event : `${event} ${JSON.stringify(fields)}`);
  };
  return {
    info: (event, fields) => write('log', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
  };
}

function runnerDeps(
  prisma: PrismaService,
  ai: GenerationAiService,
  planner: GenerationPlanner,
  config: ConfigService | undefined,
  job: ClaimedGenerationJob,
): RunnerDeps {
  const embed = (input: { jobId: string; text: string }) => ai.embed(input);

  return {
    source: createJobSource(prisma),
    planStore: createPlanStore(prisma),
    writtenStore: createWrittenStore(prisma),
    ensureTopics: (subjectId, topics) =>
      ensureSubjectTopics(subjectId, topics, prisma),
    planner: { plan: (input) => planner.plan(input) },
    draft: (args) => draftQuestion(args, ai),
    checkA: validateDraft,
    checkB: (draft, pageText, opts) => verifyDraft(draft, pageText, ai, opts),
    checkC: (draft, ctx) => checkDuplicates(draft, ctx),
    checkD: validateSet,
    writeQuestion: (args) => writeQuestion(args, prisma),
    embed,
    bank: createBankSource({
      prisma,
      subjectId: job.subjectId,
      jobId: job.jobId,
      embed,
    }),
    models: {
      verifier: config?.get<string>('OMNIROUTE_VERIFIER_MODEL')?.trim() ?? '',
    },
  };
}

/** Builds the real worker and reconciler once, and owns their lifecycle. */
@Injectable()
export class GenerationRuntime
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly runtime: GenerationRuntimeHandle;

  constructor(
    @Optional() @Inject(ConfigService) config: ConfigService | undefined,
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(GenerationJobRepository)
    repository: GenerationJobRepository,
    @Inject(GenerationAiService) ai: GenerationAiService,
    @Inject(GenerationPlanner) planner: GenerationPlanner,
  ) {
    const logger = runtimeLogger(new Logger(GenerationRuntime.name));
    const worker = createGenerationWorker({
      repository,
      runJob: (job, signal) =>
        runJob(
          {
            job: {
              id: job.jobId,
              subjectId: job.subjectId,
              requestedCount: job.requestedCount,
            },
            fence: {
              jobId: job.jobId,
              recoveryCount: job.recoveryCount,
            },
            signal,
          },
          runnerDeps(prisma, ai, planner, config, job),
        ),
      publishJobQuestions: (jobId) => publishJobQuestions(jobId, prisma),
      readJobState: async (jobId) => {
        const row = await prisma.generationJob.findUnique({
          where: { id: jobId },
          select: { state: true },
        });
        return row === null ? null : (row.state as GenerationJobState);
      },
      assertReady: () => ai.assertReady(),
      logger,
    });
    const reconciler = createReconciler({ repository, logger });

    this.runtime = createGenerationRuntime({
      components: { worker, reconciler },
      enabled: config?.get<boolean>('mockTestEnabled') === true,
      // No ConfigService means a bare test module, never a production boot.
      underTest: (config?.get<string>('NODE_ENV') ?? 'test') === 'test',
    });
  }

  onApplicationBootstrap(): Promise<void> {
    return this.runtime.bootstrap();
  }

  onModuleDestroy(): Promise<void> {
    return this.runtime.shutdown();
  }
}
