import type {
  ClaimedGenerationJob,
  GenerationJobFence,
} from '../generation-job.types.js';
import {
  actionForOutcome,
  actionForThrow,
  errorCode,
  errorName,
  type OutcomeAction,
} from './outcome.js';
import {
  DEFAULT_WORKER_CONFIG,
  type GenerationWorker,
  type GenerationWorkerDeps,
  type RunOnceResult,
  type SafeError,
  type TimerHandle,
  type WorkerConfig,
  type WorkerJobResult,
  type WorkerLogger,
  type WorkerOutcome,
  type WorkerTimers,
} from './worker.types.js';

const SILENT_LOGGER: WorkerLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const DEFAULT_TIMERS: WorkerTimers = {
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle),
};

function safeError(error: unknown): SafeError {
  const code = errorCode(error);
  return {
    name: errorName(error),
    ...(code === undefined ? {} : { code }),
  };
}

type ApplyFields = Pick<
  WorkerJobResult,
  'status' | 'publishError' | 'transitionError'
>;

/**
 * Claims one QUEUED job at a time. All durable work is fenced; a lost fence is
 * treated as "another worker owns this job" and changes nothing.
 */
export function createGenerationWorker(
  deps: GenerationWorkerDeps,
): GenerationWorker {
  const config: WorkerConfig = { ...DEFAULT_WORKER_CONFIG, ...deps.config };
  const timers = deps.timers ?? DEFAULT_TIMERS;
  const clock = deps.clock ?? (() => Date.now());
  const logger = deps.logger ?? SILENT_LOGGER;

  let started = false;
  let stopRequested = false;
  let loopHandle: TimerHandle | null = null;
  let runOnceActive = false;
  let activeController: AbortController | null = null;
  let activePromise: Promise<WorkerJobResult> | null = null;

  const applyAction = async (
    job: ClaimedGenerationJob,
    action: OutcomeAction,
  ): Promise<ApplyFields> => {
    if (action.kind === 'NONE') return { status: 'NOOP' };

    const from = action.kind === 'CANCEL' ? 'CANCELLING' : 'RUNNING';
    const fence: GenerationJobFence = {
      jobId: job.jobId,
      state: from,
      recoveryCount: job.recoveryCount,
    };

    try {
      if (action.kind === 'COMPLETE') {
        await deps.repository.transition(fence, 'COMPLETED');
      } else if (action.kind === 'CANCEL') {
        await deps.repository.transition(fence, 'CANCELLED');
      } else {
        await deps.repository.transition(fence, 'FAILED', {
          failureReason: action.failureReason,
        });
      }
    } catch (error) {
      if (errorCode(error) === 'GENERATION_STALE_WORKER') {
        return { status: 'STALE' };
      }
      const failure = safeError(error);
      logger.error('generation.worker.transition_failed', {
        jobId: job.jobId,
        name: failure.name,
        ...(failure.code === undefined ? {} : { code: failure.code }),
      });
      return { status: 'TRANSITION_FAILED', transitionError: failure };
    }

    // Only a fenced COMPLETED transition may release held questions.
    if (action.kind === 'COMPLETE') {
      try {
        await deps.publishJobQuestions(job.jobId);
      } catch (error) {
        const failure = safeError(error);
        logger.error('generation.worker.publish_failed', {
          jobId: job.jobId,
          name: failure.name,
          ...(failure.code === undefined ? {} : { code: failure.code }),
        });
        return { status: 'PUBLISH_FAILED', publishError: failure };
      }
    }

    return { status: 'APPLIED' };
  };

  const processJob = async (
    job: ClaimedGenerationJob,
    controller: AbortController,
  ): Promise<WorkerJobResult> => {
    const startedAt = clock();
    const fence: GenerationJobFence = {
      jobId: job.jobId,
      state: 'RUNNING',
      recoveryCount: job.recoveryCount,
    };
    const handles: TimerHandle[] = [];
    let finished = false;
    let heartbeatBusy = false;
    let cancelBusy = false;
    const alive = (): boolean => !finished && !controller.signal.aborted;

    const heartbeat = async (): Promise<void> => {
      if (!alive() || heartbeatBusy) return;
      heartbeatBusy = true;
      try {
        await deps.repository.heartbeat(fence);
      } catch (error) {
        if (errorCode(error) === 'GENERATION_STALE_WORKER') {
          controller.abort('STALE_WORKER');
          return;
        }
        logger.warn('generation.worker.heartbeat_failed', {
          jobId: job.jobId,
          name: errorName(error),
        });
      } finally {
        heartbeatBusy = false;
      }
    };

    const cancelPoll = async (): Promise<void> => {
      if (!alive() || cancelBusy) return;
      cancelBusy = true;
      try {
        const state = await deps.readJobState(job.jobId);
        if (!alive() || state === null) return;
        if (state === 'CANCELLING') controller.abort('CANCEL');
      } catch (error) {
        if (alive()) {
          logger.warn('generation.worker.cancel_poll_failed', {
            jobId: job.jobId,
            name: errorName(error),
          });
        }
      } finally {
        cancelBusy = false;
      }
    };

    const deadline = (): void => {
      if (!alive()) return;
      logger.warn('generation.worker.deadline', { jobId: job.jobId });
      controller.abort('DEADLINE');
    };

    handles.push(
      timers.setInterval(() => {
        void heartbeat();
      }, config.heartbeatMs),
    );
    handles.push(
      timers.setInterval(() => {
        void cancelPoll();
      }, config.cancelPollMs),
    );
    handles.push(timers.setInterval(deadline, config.deadlineMs));

    try {
      deps.assertReady();
      const outcome = await deps.runJob(job, controller.signal);
      const action = actionForOutcome(outcome);
      const applied = await applyAction(job, action);
      return { jobId: job.jobId, outcome, action, ...applied };
    } catch (error) {
      const name = errorName(error);
      const code = errorCode(error);
      const action = actionForThrow(error);
      const outcome: WorkerOutcome = {
        kind: 'UNEXPECTED',
        errorName: name,
        ...(code === undefined ? {} : { code }),
      };
      logger.error('generation.worker.unexpected_error', {
        jobId: job.jobId,
        name,
        ...(code === undefined ? {} : { code }),
      });
      const applied = await applyAction(job, action);
      return { jobId: job.jobId, outcome, action, ...applied };
    } finally {
      finished = true;
      for (const handle of handles) timers.clearInterval(handle);
      logger.info('generation.worker.finished', {
        jobId: job.jobId,
        elapsedMs: Math.max(0, clock() - startedAt),
      });
    }
  };

  const runOnce = async (): Promise<RunOnceResult> => {
    if (runOnceActive) return { kind: 'BUSY' };
    runOnceActive = true;
    try {
      const job = await deps.repository.claimNext();
      if (job === null) return { kind: 'IDLE' };

      const controller = new AbortController();
      if (stopRequested) controller.abort('SHUTDOWN');

      activeController = controller;
      const promise = processJob(job, controller);
      activePromise = promise;
      try {
        const result = await promise;
        return { kind: 'PROCESSED', jobId: job.jobId, result };
      } finally {
        activePromise = null;
        activeController = null;
      }
    } finally {
      runOnceActive = false;
    }
  };

  const tick = async (): Promise<void> => {
    if (!started || stopRequested || runOnceActive) return;
    try {
      await runOnce();
    } catch (error) {
      logger.error('generation.worker.loop_failed', {
        name: errorName(error),
      });
    }
  };

  const start = (): void => {
    if (started) return;
    started = true;
    stopRequested = false;
    loopHandle = timers.setInterval(() => {
      void tick();
    }, config.idlePollMs);
    void tick();
  };

  const stop = async (): Promise<void> => {
    stopRequested = true;
    started = false;
    if (loopHandle !== null) {
      timers.clearInterval(loopHandle);
      loopHandle = null;
    }
    if (activeController !== null && !activeController.signal.aborted) {
      activeController.abort('SHUTDOWN');
    }
    if (activePromise !== null) {
      await activePromise.catch(() => undefined);
    }
  };

  return { start, stop, runOnce };
}

export type {
  GenerationWorkerDeps,
  RunOnceResult,
  WorkerConfig,
  WorkerJobResult,
  WorkerLogger,
  WorkerOutcome,
};
