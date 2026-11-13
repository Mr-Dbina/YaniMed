import { Injectable } from '@nestjs/common';
import type { CompleteInput } from '../ai/generation-ai.service.js';
import { GenerationAiService } from '../ai/generation-ai.service.js';
import {
  MIN_DISTINCT_TOPICS,
  QUESTIONS_PER_TEST,
} from '../generation.constants.js';
import { GenerationError } from '../generation.errors.js';
import { createSeededRng, seedFromString } from '../text/rng.js';
import {
  kmeans,
  prepareVectors,
  type ChunkCluster,
  type PlannerChunkInput,
} from './clustering.js';
import { classifyChunks, evaluateGate } from './eligibility.js';
import {
  buildTopicMessages,
  parseTopicNames,
  uniqueTopicKey,
} from './prompts.js';
import { allocateSlots, buildSlots, type PlannedSlot } from './slots.js';

const FIRST_K_MAX = 15;
const CHUNKS_PER_CLUSTER = 4;
const RETRY_K_STEP = 3;
const NAMING_ATTEMPTS = 2;
const CLUSTER_ATTEMPTS = 2;

export interface GenerationPlanInput {
  jobId: string;
  subjectId: string;
  chunks: readonly PlannerChunkInput[];
}

export interface PlanTopic {
  topicKey: string;
  name: string;
  clusterId: number;
  slotCount: number;
}

export interface PlanStats {
  eligibleChunks: number;
  distinctPages: number;
  clusters: number;
  /** 1 for the first clustering pass, 2 for the single retry. */
  attempt: number;
  excludedEmbeddings: number;
}

export interface GenerationPlan {
  topics: PlanTopic[];
  slots: PlannedSlot[];
  stats: PlanStats;
}

/** Structural seam so unit tests can inject a fake AI service. */
export interface PlanAiService {
  complete(input: CompleteInput): Promise<{ text: string }>;
}

/**
 * shortcut: generation.errors.ts has no INSUFFICIENT_CONTENT code and this
 * step may not edit it. The worker maps this code to the job failure reason.
 */
export class PlanInsufficientContentError extends Error {
  readonly code = 'INSUFFICIENT_CONTENT';
  readonly details: Record<string, number>;

  constructor(details: Record<string, number>) {
    super('Generation error: INSUFFICIENT_CONTENT');
    this.name = 'PlanInsufficientContentError';
    this.details = details;
  }
}

/**
 * Pure planning except for one naming call. Clustering, allocation and seed
 * selection are deterministic for the same input, subject id and attempt.
 * GenerationAiService is the constructor type so Nest can inject it later.
 */
@Injectable()
export class GenerationPlanner {
  constructor(private readonly ai: GenerationAiService) {}

  async plan(input: GenerationPlanInput): Promise<GenerationPlan> {
    const gate = evaluateGate(input.chunks);
    if (!gate.ok) {
      throw new PlanInsufficientContentError({
        eligibleChunks: gate.eligibleChunks,
        distinctPages: gate.eligiblePages,
        clusters: 0,
      });
    }

    const eligible = classifyChunks(input.chunks)
      .filter((result) => result.eligible)
      .map((result) => result.chunk as PlannerChunkInput);
    const { items, excluded } = prepareVectors(eligible);

    const firstK = Math.max(
      MIN_DISTINCT_TOPICS,
      Math.min(
        FIRST_K_MAX,
        Math.floor(gate.eligibleChunks / CHUNKS_PER_CLUSTER),
      ),
    );

    let clusters: ChunkCluster[] = [];
    let attempt = 1;
    for (; attempt <= CLUSTER_ATTEMPTS; attempt += 1) {
      const k =
        attempt === 1
          ? firstK
          : Math.min(
              firstK + RETRY_K_STEP,
              gate.eligibleChunks,
            );
      const rng = createSeededRng(
        seedFromString(`${input.subjectId}:${attempt}`),
      );
      clusters = kmeans(items, k, rng);
      if (clusters.length >= MIN_DISTINCT_TOPICS) break;
    }

    if (clusters.length < MIN_DISTINCT_TOPICS) {
      throw new PlanInsufficientContentError({
        eligibleChunks: gate.eligibleChunks,
        distinctPages: gate.eligiblePages,
        clusters: clusters.length,
      });
    }

    const names = await this.nameClusters(input, clusters);
    const allocations = allocateSlots(clusters);
    const allocated = allocations.filter(
      (allocation) => allocation.slotCount > 0,
    );
    const totalSlots = allocated.reduce(
      (sum, allocation) => sum + allocation.slotCount,
      0,
    );
    if (totalSlots !== QUESTIONS_PER_TEST) {
      throw new PlanInsufficientContentError({
        eligibleChunks: gate.eligibleChunks,
        distinctPages: gate.eligiblePages,
        clusters: clusters.length,
        slots: totalSlots,
      });
    }

    const usedKeys = new Set<string>();
    const topicKeyByCluster = new Map<number, string>();
    const topics: PlanTopic[] = allocated.map((allocation) => {
      const name = names.get(allocation.cluster.id);
      if (!name) {
        throw new GenerationError('GENERATION_PROVIDER_UNAVAILABLE', {
          jobId: input.jobId,
          details: { clusters: clusters.length },
        });
      }
      const topicKey = uniqueTopicKey(name, usedKeys);
      topicKeyByCluster.set(allocation.cluster.id, topicKey);
      return {
        topicKey,
        name,
        clusterId: allocation.cluster.id,
        slotCount: allocation.slotCount,
      };
    });

    return {
      topics,
      slots: buildSlots(allocations, topicKeyByCluster),
      stats: {
        eligibleChunks: gate.eligibleChunks,
        distinctPages: gate.eligiblePages,
        clusters: clusters.length,
        attempt,
        excludedEmbeddings: excluded,
      },
    };
  }

  private async nameClusters(
    input: GenerationPlanInput,
    clusters: readonly ChunkCluster[],
  ): Promise<Map<number, string>> {
    const messages = buildTopicMessages(clusters);
    const clusterIds = clusters.map((cluster) => cluster.id);

    for (let attempt = 1; attempt <= NAMING_ATTEMPTS; attempt += 1) {
      const result = await this.ai.complete({
        purpose: 'PLAN',
        jobId: input.jobId,
        subjectId: input.subjectId,
        messages,
        temperature: 0,
        jsonMode: true,
      });
      try {
        return parseTopicNames(result.text, clusterIds);
      } catch {
        // Invalid names are retried once; the response text stays out of errors.
      }
    }

    throw new GenerationError('GENERATION_PROVIDER_UNAVAILABLE', {
      jobId: input.jobId,
      details: { clusters: clusters.length, namingAttempts: NAMING_ATTEMPTS },
    });
  }
}
