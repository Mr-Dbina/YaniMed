import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type { GenerationJobState } from './generation-job.types.js';

/** Optional client key. A replay with the same key returns the same job. */
export class CreateGenerationJobBody {
  @ApiProperty({ required: false, minLength: 8, maxLength: 64 })
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  idempotencyKey?: string;
}

export interface CreateGenerationJobResponse {
  jobId: string;
  state: GenerationJobState;
  requestedCount: number;
  acceptedCount: number;
}

/** Small overview of the one active job of a subject. */
export interface GenerationJobSummary {
  jobId: string;
  state: GenerationJobState;
  acceptedCount: number;
  requestedCount: number;
}

export interface ActiveGenerationJobResponse {
  job: GenerationJobSummary | null;
}

export type GenerationPhase =
  | 'PLANNING'
  | 'DRAFTING'
  | 'VALIDATING'
  | 'FINALIZING';

export interface GenerationProgressDocumentDto {
  id: string;
  title: string;
}

/** Progress only. Question text, keys, explanations, citations stay out. */
export interface GenerationProgressDto {
  jobId: string;
  subjectId: string;
  state: GenerationJobState;
  requestedCount: number;
  acceptedCount: number;
  aiCallCount: number;
  recoveryCount: number;
  failureReason: string | null;
  phase: GenerationPhase;
  startedAt: Date | null;
  heartbeatAt: Date | null;
  finishedAt: Date | null;
  documents: GenerationProgressDocumentDto[];
}

export interface CancelGenerationJobResponse {
  jobId: string;
  state: 'CANCELLING';
}

export interface GenerationJobProgressSource {
  id: string;
  subjectId: string;
  state: GenerationJobState;
  requestedCount: number;
  acceptedCount: number;
  aiCallCount: number;
  recoveryCount: number;
  failureReason: string | null;
  planJson: unknown;
  startedAt: Date | null;
  heartbeatAt: Date | null;
  finishedAt: Date | null;
  documents: { document: { id: string; title: string } }[];
}

/**
 * No column stores the phase. planJson is written before drafting starts, so
 * null means PLANNING. acceptedCount then separates DRAFTING from FINALIZING.
 * VALIDATING is reserved: slot progress is not persisted.
 */
export function deriveGenerationPhase(job: {
  planJson: unknown;
  acceptedCount: number;
  requestedCount: number;
}): GenerationPhase {
  if (job.planJson === null || job.planJson === undefined) return 'PLANNING';
  if (job.acceptedCount < job.requestedCount) return 'DRAFTING';
  return 'FINALIZING';
}

/** Maps a job row plus its document snapshot to the progress contract. */
export function toGenerationProgressDto(
  job: GenerationJobProgressSource,
): GenerationProgressDto {
  return {
    jobId: job.id,
    subjectId: job.subjectId,
    state: job.state,
    requestedCount: job.requestedCount,
    acceptedCount: job.acceptedCount,
    aiCallCount: job.aiCallCount,
    recoveryCount: job.recoveryCount,
    failureReason: job.failureReason,
    phase: deriveGenerationPhase(job),
    startedAt: job.startedAt,
    heartbeatAt: job.heartbeatAt,
    finishedAt: job.finishedAt,
    documents: job.documents.map((link) => ({
      id: link.document.id,
      title: link.document.title,
    })),
  };
}
