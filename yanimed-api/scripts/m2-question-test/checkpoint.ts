import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type {
  AiCallCounts,
  Checkpoint,
  FailureCounts,
  Question,
  RejectionCounts,
  Slot,
  SlotStatus,
  Topic,
} from './types.js';

export const CHECKPOINT_VERSION = 2;

// Explicit UTF-8: Windows PowerShell may display non-ASCII text as mojibake,
// but the files themselves stay valid UTF-8 without a BOM.
export function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8' });
}

export function readCheckpoint(file: string): Checkpoint | null {
  if (!existsSync(file)) return null;
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Checkpoint;
  if (parsed.version !== 1 && parsed.version !== 2) {
    throw new Error(`Checkpoint version is not supported: ${String(parsed.version)}.`);
  }
  return parsed;
}

export interface ResumeSelection {
  completed: Set<number>;
  skippedRejected: number[];
}

// Default resume skips everything already attempted, including rejected slots.
// --retry-rejected keeps only accepted slots completed so rejected slots run again.
export function resumeSelection(checkpoint: Checkpoint, retryRejected: boolean): ResumeSelection {
  const accepted = new Set(checkpoint.accepted.map(question => question.slotIndex));
  if (retryRejected) return { completed: accepted, skippedRejected: [] };

  if (checkpoint.slotStatuses) {
    const entries = Object.entries(checkpoint.slotStatuses);
    return {
      completed: new Set(entries.map(([index]) => Number(index))),
      skippedRejected: entries
        .filter(([, status]) => status.status === 'rejected')
        .map(([index]) => Number(index)),
    };
  }

  // Version 1 checkpoints only recorded completed indexes.
  return { completed: new Set(checkpoint.completedSlotIndexes), skippedRejected: [] };
}

export interface CheckpointInput {
  loaded: { subject: { id: string; name: string } };
  topics: Topic[];
  slots: Slot[];
  accepted: Question[];
  completed: Set<number>;
  slotStatuses?: Record<number, SlotStatus>;
  perTopicCap: number;
  minDistinctTopics: number;
  startedAt: string;
  aiCalls: AiCallCounts;
  rejections: RejectionCounts;
  failureCounts: FailureCounts;
  resumes: number;
  incompleteReason: string | null;
}

export function checkpointFor(input: CheckpointInput): Checkpoint {
  return {
    version: CHECKPOINT_VERSION,
    subject: { id: input.loaded.subject.id, name: input.loaded.subject.name },
    topics: input.topics.map(topic => ({ id: topic.id, name: topic.name, size: topic.members.length })),
    slots: input.slots,
    accepted: input.accepted,
    completedSlotIndexes: [...input.completed].sort((a, b) => a - b),
    slotStatuses: input.slotStatuses,
    perTopicCap: input.perTopicCap,
    minDistinctTopics: input.minDistinctTopics,
    startedAt: input.startedAt,
    aiCalls: input.aiCalls,
    rejections: input.rejections,
    failureCounts: input.failureCounts,
    resumes: input.resumes,
    incompleteReason: input.incompleteReason,
  };
}
