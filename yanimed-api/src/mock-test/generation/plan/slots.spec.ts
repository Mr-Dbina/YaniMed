import { describe, expect, it } from 'vitest';
import type {
  ChunkCluster,
  PlannerChunkInput,
  VectorChunk,
} from './clustering.js';
import {
  allocateSlots,
  buildSlots,
  membersByCentroid,
  selectSeedChunkIds,
} from './slots.js';

function member(
  id: string,
  options: Partial<PlannerChunkInput> = {},
): VectorChunk {
  return {
    chunk: {
      id,
      documentId: 'doc-1',
      content: 'body',
      page: 1,
      chunkIndex: 0,
      needsReview: false,
      embedding: null,
      ...options,
    },
    vector: [1, 0],
  };
}

function cluster(id: number, size: number): ChunkCluster {
  return {
    id,
    centroid: [1, 0],
    members: Array.from({ length: size }, (_, index) =>
      member(`c${id}-${index}`, { page: index + 1, chunkIndex: index }),
    ),
  };
}

function total(allocations: ReturnType<typeof allocateSlots>): number {
  return allocations.reduce((sum, item) => sum + item.slotCount, 0);
}

describe('allocateSlots', () => {
  it('spreads 25 slots over the 13 largest of 15 topics', () => {
    const clusters = Array.from({ length: 15 }, (_, index) =>
      cluster(index, 20 - index),
    );

    const allocations = allocateSlots(clusters);
    const active = allocations.filter((item) => item.slotCount > 0);

    expect(active).toHaveLength(13);
    expect(total(allocations)).toBe(25);
    expect(active[0].slotCount).toBe(2);
    expect(active[11].slotCount).toBe(2);
    expect(active[12].slotCount).toBe(1);
    expect(Math.max(...allocations.map((item) => item.slotCount))).toBe(2);
  });

  it('reaches exactly 25 slots with only 13 clusters', () => {
    const clusters = Array.from({ length: 13 }, (_, index) =>
      cluster(index, 20 - index),
    );

    const allocations = allocateSlots(clusters);

    expect(total(allocations)).toBe(25);
    expect(allocations).toHaveLength(13);
    expect(allocations.filter((item) => item.slotCount === 2)).toHaveLength(12);
    expect(allocations.filter((item) => item.slotCount === 1)).toHaveLength(1);
  });

  it('uses only the 13 largest clusters when 20 are available', () => {
    const clusters = Array.from({ length: 20 }, (_, index) =>
      cluster(index, 5),
    );

    const allocations = allocateSlots(clusters);
    const active = allocations.filter((item) => item.slotCount > 0);

    expect(total(allocations)).toBe(25);
    expect(active).toHaveLength(13);
    expect(active.map((item) => item.cluster.id)).toEqual(
      Array.from({ length: 13 }, (_, index) => index),
    );
    expect(active.filter((item) => item.slotCount === 2)).toHaveLength(12);
  });

  it('breaks equal sizes by clusterId', () => {
    const ids = [12, 3, 8, 0, 5, 11, 2, 9, 1, 7, 4, 10, 6];
    const clusters = ids.map((id) => cluster(id, 4));

    const allocations = allocateSlots(clusters);

    expect(allocations.map((item) => item.cluster.id)).toEqual(
      [...ids].sort((a, b) => a - b),
    );
  });

  it('gives a single-chunk cluster at most one slot and moves the rest', () => {
    const clusters = [
      cluster(0, 1),
      ...Array.from({ length: 12 }, (_, index) => cluster(index + 1, 3)),
    ];

    const allocations = allocateSlots(clusters);
    const single = allocations.find((item) => item.cluster.id === 0);

    expect(single?.slotCount).toBe(1);
    expect(total(allocations)).toBe(25);
    expect(
      allocations.filter((item) => item.cluster.id !== 0 && item.slotCount === 2),
    ).toHaveLength(12);
  });

  it('never assigns a third slot to one topic', () => {
    const clusters = [
      cluster(0, 30),
      ...Array.from({ length: 12 }, (_, index) => cluster(index + 1, 2)),
    ];

    const allocations = allocateSlots(clusters);

    expect(allocations[0].slotCount).toBe(2);
    expect(Math.max(...allocations.map((item) => item.slotCount))).toBe(2);
  });
});

describe('membersByCentroid', () => {
  it('orders the closest member first', () => {
    const items: VectorChunk[] = [
      { chunk: member('far').chunk, vector: [0, 1] },
      { chunk: member('near').chunk, vector: [1, 0.1] },
      { chunk: member('middle').chunk, vector: [1, 0.5] },
    ];
    const target: ChunkCluster = { id: 0, centroid: [1, 0], members: items };

    expect(membersByCentroid(target).map((item) => item.chunk.id)).toEqual([
      'near',
      'middle',
      'far',
    ]);
  });
});

describe('selectSeedChunkIds', () => {
  it('uses a different primary chunk for the second slot of a topic', () => {
    const target: ChunkCluster = {
      id: 0,
      centroid: [1, 0],
      members: [
        { chunk: member('c-a').chunk, vector: [1, 0] },
        { chunk: member('c-b').chunk, vector: [1, 0.2] },
        { chunk: member('c-c').chunk, vector: [1, 0.4] },
      ],
    };

    const first = selectSeedChunkIds(target, 0);
    const second = selectSeedChunkIds(target, 1);

    expect(first[0]).toBe('c-a');
    expect(second[0]).toBe('c-b');
  });

  it('adds up to two neighbours from the same cluster and adjacent pages', () => {
    const withVector = (
      id: string,
      options: Partial<PlannerChunkInput>,
      second: number,
    ): VectorChunk => ({
      ...member(id, options),
      vector: [1, second],
    });
    const target: ChunkCluster = {
      id: 0,
      centroid: [1, 0],
      members: [
        withVector('primary', { page: 5, chunkIndex: 10 }, 0),
        withVector('same-page', { page: 5, chunkIndex: 11 }, 0.2),
        withVector('previous-page', { page: 4, chunkIndex: 9 }, 0.2),
        withVector(
          'other-document',
          { documentId: 'doc-2', page: 5, chunkIndex: 10 },
          0.2,
        ),
        withVector('far-page', { page: 9, chunkIndex: 20 }, 0.2),
      ],
    };

    const ids = selectSeedChunkIds(target, 0);

    expect(ids).toHaveLength(3);
    expect(ids[0]).toBe('primary');
    expect(ids.slice(1).sort()).toEqual(['previous-page', 'same-page']);
  });

  it('returns only the primary when no member is adjacent', () => {
    const target: ChunkCluster = {
      id: 0,
      centroid: [1, 0],
      members: [
        member('primary', { page: 5 }),
        member('far-page', { page: 9 }),
      ],
    };

    expect(selectSeedChunkIds(target, 0)).toEqual(['primary']);
  });

  it('returns no ids when the slot ordinal has no member', () => {
    expect(selectSeedChunkIds(cluster(0, 1), 1)).toEqual([]);
  });
});

describe('buildSlots', () => {
  it('indexes slots in order and carries the topic key', () => {
    const first = cluster(3, 3);
    const second = cluster(7, 2);
    const topicKeys = new Map([
      [3, 'alpha'],
      [7, 'beta'],
    ]);

    const slots = buildSlots(
      [
        { cluster: first, slotCount: 2 },
        { cluster: second, slotCount: 1 },
      ],
      topicKeys,
    );

    expect(slots.map((slot) => slot.index)).toEqual([0, 1, 2]);
    expect(slots.map((slot) => slot.topicKey)).toEqual([
      'alpha',
      'alpha',
      'beta',
    ]);
    expect(slots[0].seedChunkIds[0]).not.toBe(slots[1].seedChunkIds[0]);
  });
});
