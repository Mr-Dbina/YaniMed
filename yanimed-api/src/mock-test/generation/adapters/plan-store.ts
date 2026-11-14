import type { PrismaService } from '../../../prisma/prisma.service.js';
import { GenerationError } from '../generation.errors.js';
import { getGenerationPrisma } from '../persist/question-writer.js';
import type { GenerationPlan, PlanStats, PlanTopic } from '../plan/planner.js';
import type { PlannedSlot } from '../plan/slots.js';
import type { PlanStore, RunnerFence } from '../runner/ports.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function toTopic(value: unknown): PlanTopic | null {
  if (!isRecord(value)) return null;
  const { topicKey, name, clusterId, slotCount } = value;
  if (
    typeof topicKey !== 'string' ||
    typeof name !== 'string' ||
    !isInteger(clusterId) ||
    !isInteger(slotCount)
  ) {
    return null;
  }
  return { topicKey, name, clusterId, slotCount };
}

function toSlot(value: unknown): PlannedSlot | null {
  if (!isRecord(value)) return null;
  const { index, topicKey, seedChunkIds } = value;
  if (
    !isInteger(index) ||
    typeof topicKey !== 'string' ||
    !isStringArray(seedChunkIds) ||
    seedChunkIds.length === 0
  ) {
    return null;
  }
  return { index, topicKey, seedChunkIds };
}

function toCandidates(value: unknown): Record<string, string[]> | null {
  if (!isRecord(value)) return null;
  const candidates: Record<string, string[]> = {};
  for (const [key, ids] of Object.entries(value)) {
    if (!isStringArray(ids)) return null;
    candidates[key] = ids;
  }
  return candidates;
}

function toStats(value: unknown): PlanStats | null {
  if (!isRecord(value)) return null;
  const { eligibleChunks, distinctPages, clusters, attempt, excludedEmbeddings } =
    value;
  if (
    !isInteger(eligibleChunks) ||
    !isInteger(distinctPages) ||
    !isInteger(clusters) ||
    !isInteger(attempt) ||
    !isInteger(excludedEmbeddings)
  ) {
    return null;
  }
  return {
    eligibleChunks,
    distinctPages,
    clusters,
    attempt,
    excludedEmbeddings,
  };
}

function toPlanArray<T>(
  value: unknown,
  convert: (item: unknown) => T | null,
): T[] | null {
  if (!Array.isArray(value)) return null;
  const items: T[] = [];
  for (const item of value) {
    const converted = convert(item);
    if (converted === null) return null;
    items.push(converted);
  }
  return items;
}

/**
 * Structural validation of the stored plan. Returns a rebuilt object, so
 * unknown keys (and any text a caller slipped in) are dropped on save.
 */
export function parsePlan(raw: unknown): GenerationPlan | null {
  if (!isRecord(raw)) return null;
  const topics = toPlanArray(raw.topics, toTopic);
  const slots = toPlanArray(raw.slots, toSlot);
  const candidates = toCandidates(raw.candidates);
  const stats = toStats(raw.stats);
  if (topics === null || slots === null || candidates === null || stats === null) {
    return null;
  }
  return { topics, slots, candidates, stats };
}

/**
 * Persists the plan once per job and only while the worker still owns the
 * recovery epoch. A zero-row update means another worker took over.
 */
export function createPlanStore(
  prisma: PrismaService = getGenerationPrisma(),
): PlanStore {
  return {
    async load(jobId: string): Promise<GenerationPlan | null> {
      const job = await prisma.generationJob.findUnique({
        where: { id: jobId },
        select: { planJson: true },
      });
      if (!job) {
        throw new GenerationError('GENERATION_NOT_FOUND', { jobId });
      }
      if (job.planJson === null) return null;

      const plan = parsePlan(job.planJson);
      if (plan === null) {
        throw new GenerationError('GENERATION_INVALID_PLAN', { jobId });
      }
      return plan;
    },

    async save(fence: RunnerFence, plan: GenerationPlan): Promise<void> {
      const valid = parsePlan(plan);
      if (valid === null) {
        throw new GenerationError('GENERATION_INVALID_PLAN', {
          jobId: fence.jobId,
        });
      }

      const changed = await prisma.$executeRaw`
        UPDATE "GenerationJob"
        SET "planJson" = ${JSON.stringify(valid)}::jsonb
        WHERE "id" = ${fence.jobId}
          AND "state" = 'RUNNING'
          AND "recoveryCount" = ${fence.recoveryCount}
      `;
      if (changed === 0) {
        throw new GenerationError('GENERATION_STALE_WORKER', {
          jobId: fence.jobId,
        });
      }
    },
  };
}
