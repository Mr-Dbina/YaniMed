import { describe, expect, it, vi } from 'vitest';
import type { CompleteInput, GenerationAiService } from '../ai/generation-ai.service.js';
import { GenerationError } from '../generation.errors.js';
import { createSeededRng } from '../text/rng.js';
import type { PlannerChunkInput } from './clustering.js';
import {
  GenerationPlanner,
  PlanInsufficientContentError,
  type PlanAiService,
} from './planner.js';

const BODY =
  'Neonatal jaundice is common in the first week of life. ' +
  'A total serum bilirubin should be measured when the clinical level is unclear. ' +
  'Treatment depends on age, gestation and the bilirubin trend over time. ' +
  'Phototherapy is started when the level crosses the age-specific treatment line.';

function chunk(
  index: number,
  embedding: PlannerChunkInput['embedding'],
  overrides: Partial<PlannerChunkInput> = {},
): PlannerChunkInput {
  return {
    id: `chunk-${index}`,
    documentId: 'doc-1',
    content: BODY,
    page: (index % 25) + 1,
    chunkIndex: index,
    needsReview: false,
    embedding,
    ...overrides,
  };
}

function groupedEmbedding(index: number, groups = 15): number[] {
  const dimension = groups + 6;
  const vector = Array.from({ length: dimension }, () => 0);
  vector[index % groups] = 1;
  vector[dimension - 1] = 0.001 * (index + 1);
  return vector;
}

function gaussian(rng: () => number): number {
  return (
    Math.sqrt(-2 * Math.log(Math.max(rng(), 1e-12))) *
    Math.cos(2 * Math.PI * rng())
  );
}

/**
 * Fixed fixture where the first pass (k=13) leaves one empty cluster and the
 * retry (k=16) finds 16 non-empty clusters that can hold all 25 slots.
 */
function retryFixtureEmbeddings(): number[][] {
  const rng = createSeededRng(9000 + 36 * 131 + 12 * 17 + 280);
  const centers = Array.from({ length: 16 }, () =>
    Array.from({ length: 12 }, () => gaussian(rng)),
  );
  return Array.from({ length: 36 }, () => {
    const center = centers[Math.floor(rng() * centers.length)];
    return center.map((value) => value + gaussian(rng) * 0.2);
  });
}

function eligibleChunks(
  count = 30,
  embedding: (index: number) => PlannerChunkInput['embedding'] = groupedEmbedding,
): PlannerChunkInput[] {
  return Array.from({ length: count }, (_, index) =>
    chunk(index, embedding(index)),
  );
}

function defaultNames(input: CompleteInput): string {
  const payload = JSON.parse(input.messages[1].content) as {
    clusters: { clusterId: number }[];
  };
  return JSON.stringify({
    topics: payload.clusters.map((cluster) => ({
      clusterId: cluster.clusterId,
      name: `Topic ${cluster.clusterId + 1}`,
    })),
  });
}

function fakeAi(
  respond: (input: CompleteInput, call: number) => string = defaultNames,
): { complete: ReturnType<typeof vi.fn>; service: PlanAiService } {
  let call = 0;
  const complete = vi.fn(async (input: CompleteInput) => ({
    text: respond(input, call++),
  }));
  return { complete, service: { complete } as unknown as PlanAiService };
}

function plannerFor(service: PlanAiService): GenerationPlanner {
  return new GenerationPlanner(
    service as unknown as GenerationAiService,
  );
}

const INPUT = {
  jobId: 'job-1',
  subjectId: 'subject-1',
};

describe('GenerationPlanner', () => {
  it('builds 25 slots over at least 13 topics with at most 2 each', async () => {
    const chunks = eligibleChunks();
    const { complete, service } = fakeAi();

    const plan = await plannerFor(service).plan({ ...INPUT, chunks });

    expect(plan.stats.eligibleChunks).toBe(30);
    expect(plan.stats.distinctPages).toBe(25);
    expect(plan.stats.clusters).toBeGreaterThanOrEqual(13);
    expect(plan.stats.attempt).toBe(1);
    expect(plan.stats.excludedEmbeddings).toBe(0);

    expect(plan.slots).toHaveLength(25);
    expect(plan.slots.map((slot) => slot.index)).toEqual(
      Array.from({ length: 25 }, (_, index) => index),
    );
    expect(plan.topics.length).toBeGreaterThanOrEqual(13);
    expect(plan.topics.reduce((sum, topic) => sum + topic.slotCount, 0)).toBe(
      25,
    );
    expect(Math.max(...plan.topics.map((topic) => topic.slotCount))).toBe(2);
    expect(new Set(plan.topics.map((topic) => topic.topicKey)).size).toBe(
      plan.topics.length,
    );

    const knownIds = new Set(chunks.map((item) => item.id));
    for (const slot of plan.slots) {
      expect(slot.seedChunkIds.length).toBeGreaterThanOrEqual(1);
      expect(slot.seedChunkIds.length).toBeLessThanOrEqual(3);
      for (const id of slot.seedChunkIds) expect(knownIds.has(id)).toBe(true);
      expect(
        plan.topics.some((topic) => topic.topicKey === slot.topicKey),
      ).toBe(true);
    }

    for (const topic of plan.topics) {
      const candidates = plan.candidates[topic.topicKey];
      expect(candidates.length).toBeGreaterThan(0);
      expect(new Set(candidates).size).toBe(candidates.length);
      for (const id of candidates) expect(knownIds.has(id)).toBe(true);
    }
    expect(Object.keys(plan.candidates).sort()).toEqual(
      plan.topics.map((topic) => topic.topicKey).sort(),
    );

    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'PLAN', jobId: 'job-1' }),
    );
  });

  it('is deterministic for the same input', async () => {
    const chunks = eligibleChunks();
    const first = fakeAi();
    const second = fakeAi();

    const a = await plannerFor(first.service).plan({ ...INPUT, chunks });
    const b = await plannerFor(second.service).plan({ ...INPUT, chunks });

    expect(a).toEqual(b);
  });

  it('fails before any AI call when the content gate fails', async () => {
    const chunks = eligibleChunks(29);
    const { complete, service } = fakeAi();

    await expect(
      plannerFor(service).plan({ ...INPUT, chunks }),
    ).rejects.toMatchObject({
      code: 'INSUFFICIENT_CONTENT',
      details: { eligibleChunks: 29, distinctPages: 25, clusters: 0 },
    });
    expect(complete).not.toHaveBeenCalled();
  });

  it('fails with INSUFFICIENT_CONTENT after two cluster attempts', async () => {
    const chunks = eligibleChunks(30, () => [1, 0, 0, 0, 0, 0]);
    const { complete, service } = fakeAi();

    const error: unknown = await plannerFor(service)
      .plan({ ...INPUT, chunks })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlanInsufficientContentError);
    expect(error).toMatchObject({
      code: 'INSUFFICIENT_CONTENT',
      details: { eligibleChunks: 30, distinctPages: 25, clusters: 1 },
    });
    expect(complete).not.toHaveBeenCalled();
  });

  it('retries clustering with a larger k and succeeds on the second pass', async () => {
    const vectors = retryFixtureEmbeddings();
    const { complete, service } = fakeAi();

    const plan = await plannerFor(service).plan({
      ...INPUT,
      subjectId: 's-6',
      chunks: eligibleChunks(36, (index) => vectors[index]).map(
        (item, index) => ({ ...item, page: index + 1 }),
      ),
    });

    expect(plan.stats.attempt).toBe(2);
    expect(plan.stats.clusters).toBe(16);
    expect(plan.slots).toHaveLength(25);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('retries naming once after invalid JSON and succeeds', async () => {
    const { complete, service } = fakeAi((input, call) =>
      call === 0 ? 'not json' : defaultNames(input),
    );

    const plan = await plannerFor(service).plan({
      ...INPUT,
      chunks: eligibleChunks(),
    });

    expect(plan.slots).toHaveLength(25);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('fails with PROVIDER_UNAVAILABLE after two duplicate-name responses', async () => {
    const { complete, service } = fakeAi((input) =>
      JSON.stringify({
        topics: (
          JSON.parse(input.messages[1].content) as {
            clusters: { clusterId: number }[];
          }
        ).clusters.map((cluster) => ({
          clusterId: cluster.clusterId,
          name: 'Same Topic',
        })),
      }),
    );

    await expect(
      plannerFor(service).plan({ ...INPUT, chunks: eligibleChunks() }),
    ).rejects.toMatchObject({
      code: 'GENERATION_PROVIDER_UNAVAILABLE',
      details: { namingAttempts: 2 },
    });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('propagates an AI service failure without a naming retry', async () => {
    const complete = vi.fn(async () => {
      throw new GenerationError('GENERATION_PROVIDER_UNAVAILABLE', {
        jobId: 'job-1',
      });
    });
    const service = { complete } as unknown as PlanAiService;

    await expect(
      plannerFor(service).plan({ ...INPUT, chunks: eligibleChunks() }),
    ).rejects.toMatchObject({ code: 'GENERATION_PROVIDER_UNAVAILABLE' });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('counts chunks with missing embeddings without dropping them from the gate', async () => {
    const chunks = eligibleChunks(36, (index) =>
      index < 30 ? groupedEmbedding(index) : null,
    );
    const { service } = fakeAi();

    const plan = await plannerFor(service).plan({ ...INPUT, chunks });

    expect(plan.stats.eligibleChunks).toBe(36);
    expect(plan.stats.excludedEmbeddings).toBe(6);
    expect(plan.slots).toHaveLength(25);
  });
});
