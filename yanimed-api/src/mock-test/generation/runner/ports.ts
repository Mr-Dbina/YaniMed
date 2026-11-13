import type { DraftQuestionArgs, DraftResult } from '../draft/draft.service.js';
import type {
  GenerationPlan,
  GenerationPlanInput,
  PlanTopic,
} from '../plan/planner.js';
import type { PlannerChunkInput } from '../plan/clustering.js';
import type {
  WriteQuestionArgs,
  WriteQuestionResult,
} from '../persist/question-writer.js';
import type { PlanTopicInput } from '../persist/topics.js';
import type { GenerationFailureReason } from '../generation-job.types.js';
import type { BankSource, CheckCContext, CheckCResult } from '../validate/check-c.js';
import type {
  CheckAContext,
  CheckAResult,
  DraftQuestion,
} from '../validate/types.js';
import type {
  CheckDContext,
  CheckDResult,
  SetQuestionRef,
} from '../validate/check-d.js';
import type { CheckBResult, VerifyDraftOptions } from '../validate/check-b.js';

/** Everything the runner needs from outside the job row for this job. */
export interface JobInputs {
  subjectId: string;
  subjectName: string;
  styleHint: 'SHORT_RECALL' | 'CLINICAL_STEM';
  requestedCount: number;
  snapshotDocumentIds: Set<string>;
  documents: Map<string, { title: string; pageCount: number }>;
  /** Key is documentId + ':' + page. */
  pages: Map<string, { text: string; needsOcr: boolean }>;
  chunks: PlannerChunkInput[];
}

export interface JobSource {
  /** Throws GENERATION_NOT_FOUND when a snapshot document no longer exists. */
  load(jobId: string): Promise<JobInputs>;
}

/** The fence fields a plan save needs. */
export interface RunnerFence {
  jobId: string;
  recoveryCount: number;
}

export interface PlanStore {
  load(jobId: string): Promise<GenerationPlan | null>;
  save(fence: RunnerFence, plan: GenerationPlan): Promise<void>;
}

export interface WrittenQuestion {
  questionId: string;
  status: string;
  topicKey: string;
  stem: string;
  leadIn: string | null;
  objective: string;
  keyChoiceText: string;
  citations: { documentId: string | null; page: number; quote: string }[];
}

export interface WrittenStore {
  listWritten(jobId: string): Promise<WrittenQuestion[]>;
}

export type PlannerPort = {
  plan(input: GenerationPlanInput): Promise<GenerationPlan>;
};

export type DraftPort = (args: DraftQuestionArgs) => Promise<DraftResult>;

export type CheckAPort = (draft: unknown, ctx: CheckAContext) => CheckAResult;

export type CheckBPort = (
  draft: DraftQuestion,
  pageText: string,
  opts: VerifyDraftOptions,
) => Promise<CheckBResult>;

export type CheckCPort = (
  draft: DraftQuestion,
  ctx: CheckCContext,
) => Promise<CheckCResult>;

export type CheckDPort = (
  questions: SetQuestionRef[],
  ctx: CheckDContext,
) => CheckDResult;

export type WriteQuestionPort = (
  args: WriteQuestionArgs,
) => Promise<WriteQuestionResult>;

export type EmbedPort = (input: { jobId: string; text: string }) => Promise<number[]>;

export type ProgressPhase =
  | 'PLANNING'
  | 'DRAFTING'
  | 'VALIDATING'
  | 'FINALIZING';

export interface Progress {
  phase: ProgressPhase;
  acceptedCount: number;
}

export interface RunnerDeps {
  source: JobSource;
  planStore: PlanStore;
  writtenStore: WrittenStore;
  ensureTopics(
    subjectId: string,
    planTopics: PlanTopicInput[],
  ): Promise<Map<string, string>>;
  planner: PlannerPort;
  draft: DraftPort;
  checkA: CheckAPort;
  checkB: CheckBPort;
  checkC: CheckCPort;
  checkD: CheckDPort;
  writeQuestion: WriteQuestionPort;
  embed: EmbedPort;
  bank: BankSource;
  models: { verifier: string };
  onProgress?: (progress: Progress) => void;
}

export type StopCause = 'CANCEL' | 'DEADLINE' | 'SHUTDOWN' | 'STALE_WORKER';

export type RunOutcome =
  | { kind: 'COMPLETED'; acceptedCount: number }
  | {
      kind: 'FAILED';
      reason: GenerationFailureReason;
      code?: string;
      detail?: string;
    }
  | { kind: 'STOPPED'; cause: StopCause };

export type { GenerationPlan, PlanTopic };
