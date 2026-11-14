import { describe, expect, it } from 'vitest';
import type {
  CompleteInput,
  GenerationAiService,
} from '../ai/generation-ai.service.js';
import type { PlannerChunkInput } from '../plan/clustering.js';
import {
  GenerationPlanner,
  type GenerationPlan,
} from '../plan/planner.js';
import { parsePlan } from './plan-store.js';

const BODY =
  'Neonatal jaundice is common in the first week of life. ' +
  'A total serum bilirubin should be measured when the clinical level is unclear. ' +
  'Treatment depends on age, gestation and the bilirubin trend over time. ' +
  'Phototherapy is started when the level crosses the age-specific treatment line.';

function chunk(index: number): PlannerChunkInput {
  const dimension = 21;
  const vector = Array.from({ length: dimension }, () => 0);
  vector[index % 15] = 1;
  vector[dimension - 1] = 0.001 * (index + 1);
  return {
    id: `chunk-${index}`,
    documentId: 'doc-1',
    content: BODY,
    page: (index % 25) + 1,
    chunkIndex: index,
    needsReview: false,
    embedding: vector,
  };
}

function namesFor(input: CompleteInput): string {
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

async function realPlan(): Promise<GenerationPlan> {
  const complete = async (input: CompleteInput) => ({ text: namesFor(input) });
  const planner = new GenerationPlanner(
    { complete } as unknown as GenerationAiService,
  );
  return planner.plan({
    jobId: 'job-1',
    subjectId: 'subject-1',
    chunks: Array.from({ length: 30 }, (_, index) => chunk(index)),
  });
}

describe('plan shape validation', () => {
  it('accepts a real planner output unchanged', async () => {
    const plan = await realPlan();

    expect(parsePlan(plan)).toEqual(plan);
    expect(parsePlan(plan)?.slots).toHaveLength(25);
  });

  it('accepts a plan that went through JSON', async () => {
    const plan = await realPlan();
    const stored: unknown = JSON.parse(JSON.stringify(plan));

    expect(parsePlan(stored)).toEqual(plan);
  });

  it('rejects a plan that is not an object', () => {
    expect(parsePlan(null)).toBeNull();
    expect(parsePlan('{}')).toBeNull();
    expect(parsePlan([])).toBeNull();
  });

  it('rejects each missing top-level field', async () => {
    const plan = await realPlan();
    for (const field of ['topics', 'slots', 'candidates', 'stats'] as const) {
      const broken: Record<string, unknown> = { ...plan };
      delete broken[field];
      expect(parsePlan(broken)).toBeNull();
    }
  });

  it('rejects a slot without seed chunk ids', async () => {
    const plan = await realPlan();
    const slots = plan.slots.map((slot, index) =>
      index === 0 ? { ...slot, seedChunkIds: [] } : slot,
    );

    expect(parsePlan({ ...plan, slots })).toBeNull();
    expect(
      parsePlan({
        ...plan,
        slots: [{ index: 0, topicKey: 'topic' }],
      }),
    ).toBeNull();
  });

  it('rejects a malformed topic or stats entry', async () => {
    const plan = await realPlan();
    const topics = plan.topics.map((topic, index) =>
      index === 0 ? { ...topic, clusterId: 'one' } : topic,
    );
    const stats = { ...plan.stats, attempt: Number.NaN };

    expect(parsePlan({ ...plan, topics })).toBeNull();
    expect(parsePlan({ ...plan, stats })).toBeNull();
  });

  it('rejects non-string candidate ids and unknown extra text', async () => {
    const plan = await realPlan();
    const [key] = Object.keys(plan.candidates);
    const candidates = { ...plan.candidates, [key]: [1, 2] };

    expect(parsePlan({ ...plan, candidates })).toBeNull();

    const parsed = parsePlan({ ...plan, sourceText: 'ZZ-m5 never stored' });
    expect(parsed).not.toBeNull();
    expect(parsed).not.toHaveProperty('sourceText');
  });
});
