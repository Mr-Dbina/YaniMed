import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { MockTestError } from '../exam.errors.js';
import {
  type ActiveGenerationJobResponse,
  type CancelGenerationJobResponse,
  type CreateGenerationJobResponse,
  type GenerationJobSummary,
  type GenerationProgressDto,
  toGenerationProgressDto,
} from './generation.dto.js';
import { GenerationError } from './generation.errors.js';
import { GenerationJobRepository } from './generation-job.repository.js';
import {
  TERMINAL_GENERATION_JOB_STATES,
  type GenerationJobState,
} from './generation-job.types.js';

const ACTIVE_STATES = { notIn: [...TERMINAL_GENERATION_JOB_STATES] };

function toSummary(job: {
  id: string;
  state: GenerationJobState;
  acceptedCount: number;
  requestedCount: number;
}): GenerationJobSummary {
  return {
    jobId: job.id,
    state: job.state,
    acceptedCount: job.acceptedCount,
    requestedCount: job.requestedCount,
  };
}

/** Job commands for the Mock Test screen. Every read is scoped by id. */
@Injectable()
export class GenerationService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(GenerationJobRepository)
    private readonly repository: GenerationJobRepository,
  ) {}

  /**
   * Snapshots the subject's READY documents. The one-active-job unique rule
   * makes a second create GENERATION_IN_PROGRESS; a repeated idempotencyKey
   * returns the first job instead.
   */
  async createJob(
    subjectId: string,
    idempotencyKey?: string,
  ): Promise<CreateGenerationJobResponse> {
    const subject = await this.prisma.subject.findUnique({
      where: { id: subjectId },
      select: { id: true },
    });
    if (!subject) throw new MockTestError('SUBJECT_NOT_FOUND');

    const documents = await this.prisma.document.findMany({
      where: { subjectId, status: 'READY' },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    if (documents.length === 0) {
      throw new GenerationError('NO_READY_DOCUMENTS');
    }

    const { job } = await this.repository.createJob({
      subjectId,
      documentIds: documents.map((document) => document.id),
      ...(idempotencyKey === undefined || idempotencyKey === ''
        ? {}
        : { idempotencyKey }),
    });

    return {
      jobId: job.id,
      state: job.state,
      requestedCount: job.requestedCount,
      acceptedCount: job.acceptedCount,
    };
  }

  /** The newest unfinished job of the subject, or null. */
  async getActiveJob(subjectId: string): Promise<ActiveGenerationJobResponse> {
    const job = await this.prisma.generationJob.findFirst({
      where: { subjectId, state: ACTIVE_STATES },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        state: true,
        acceptedCount: true,
        requestedCount: true,
      },
    });
    return { job: job ? toSummary(job) : null };
  }

  async getProgress(jobId: string): Promise<GenerationProgressDto> {
    const job = await this.prisma.generationJob.findUnique({
      where: { id: jobId },
      select: {
        id: true,
        subjectId: true,
        state: true,
        requestedCount: true,
        acceptedCount: true,
        aiCallCount: true,
        recoveryCount: true,
        failureReason: true,
        planJson: true,
        startedAt: true,
        heartbeatAt: true,
        finishedAt: true,
        documents: {
          orderBy: { documentId: 'asc' },
          select: { document: { select: { id: true, title: true } } },
        },
      },
    });
    if (!job) throw new GenerationError('GENERATION_NOT_FOUND', { jobId });

    return toGenerationProgressDto({
      ...job,
      state: job.state as GenerationJobState,
    });
  }

  /**
   * Only QUEUED, RUNNING and STALLED jobs may start cancelling. A repeat while
   * CANCELLING returns the same answer; a finished job is refused.
   */
  async cancelJob(jobId: string): Promise<CancelGenerationJobResponse> {
    const job = await this.repository.requestCancel(jobId);
    if (job.state !== 'CANCELLING') {
      throw new GenerationError('GENERATION_NOT_CANCELLABLE', { jobId });
    }
    return { jobId, state: 'CANCELLING' };
  }
}
