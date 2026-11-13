import { describe, expect, it } from 'vitest';
import { createSeededRng, seedFromString } from '../text/rng.js';
import {
  kmeans,
  prepareVectors,
  type PlannerChunkInput,
} from './clustering.js';

function chunk(
  index: number,
  embedding: PlannerChunkInput['embedding'],
): PlannerChunkInput {
  return {
    id: `chunk-${index}`,
    documentId: 'doc-1',
    content: 'body',
    page: index + 1,
    chunkIndex: index,
    needsReview: false,
    embedding,
  };
}

function rng(seed: string): () => number {
  return createSeededRng(seedFromString(seed));
}

describe('prepareVectors', () => {
  it('keeps the dominant dimension and counts every excluded chunk', () => {
    const chunks = [
      chunk(0, [1, 0, 0]),
      chunk(1, [0, 1, 0]),
      chunk(2, '[0,0,1]'),
      chunk(3, [1, 1, 1]),
      chunk(4, [1, 0]),
      chunk(5, [1, 0, 0, 0]),
      chunk(6, null),
      chunk(7, '[0,0,0]'),
      chunk(8, 'not a vector'),
    ];

    const result = prepareVectors(chunks);

    expect(result.items.map((item) => item.chunk.id)).toEqual([
      'chunk-0',
      'chunk-1',
      'chunk-2',
      'chunk-3',
    ]);
    expect(result.excluded).toBe(5);
  });

  it('returns no items when every embedding is unusable', () => {
    expect(prepareVectors([chunk(0, null), chunk(1, '')])).toEqual({
      items: [],
      excluded: 2,
    });
  });
});

describe('kmeans', () => {
  const items = [
    chunk(0, [1, 0, 0]),
    chunk(1, [0.99, 0.01, 0]),
    chunk(2, [0, 1, 0]),
    chunk(3, [0, 0.98, 0.02]),
    chunk(4, [0, 0, 1]),
    chunk(5, [0.02, 0, 0.98]),
    chunk(6, [1, 1, 0]),
  ];
  const { items: vectors } = prepareVectors(items);

  it('is deterministic for the same seed', () => {
    const first = kmeans(vectors, 3, rng('subject-1:1'));
    const second = kmeans(vectors, 3, rng('subject-1:1'));

    expect(first).toEqual(second);
    expect(first.map((cluster) => cluster.members.map((m) => m.chunk.id)))
      .toEqual(second.map((cluster) => cluster.members.map((m) => m.chunk.id)));
  });

  it('assigns every item to exactly one non-empty cluster', () => {
    const clusters = kmeans(vectors, 3, rng('subject-1:1'));
    const assigned = clusters.flatMap((cluster) =>
      cluster.members.map((member) => member.chunk.id),
    );

    expect(clusters.length).toBeGreaterThan(0);
    expect(assigned.sort()).toEqual(vectors.map((item) => item.chunk.id).sort());
    for (const cluster of clusters) {
      expect(cluster.members.length).toBeGreaterThan(0);
      expect(cluster.centroid).toHaveLength(3);
    }
  });

  it('never returns more clusters than requested or than items', () => {
    expect(kmeans(vectors, 99, rng('subject-2:1'))).toHaveLength(
      vectors.length,
    );
    expect(kmeans(vectors, 2, rng('subject-2:1')).length).toBeLessThanOrEqual(2);
  });

  it('collapses identical embeddings into one non-empty cluster', () => {
    const identical = prepareVectors(
      Array.from({ length: 6 }, (_, index) => chunk(index, [1, 2, 3])),
    ).items;

    const clusters = kmeans(identical, 13, rng('subject-3:1'));

    expect(clusters).toHaveLength(1);
    expect(clusters[0].members).toHaveLength(6);
  });

  it('drops empty clusters instead of returning them', () => {
    const duplicated = prepareVectors([
      chunk(0, [1, 0]),
      chunk(1, [1, 0]),
      chunk(2, [0, 1]),
      chunk(3, [0, 1]),
    ]).items;

    const clusters = kmeans(duplicated, 4, rng('subject-4:1'));

    expect(clusters.every((cluster) => cluster.members.length > 0)).toBe(true);
    expect(clusters.length).toBeLessThanOrEqual(4);
  });

  it('returns nothing for no items', () => {
    expect(kmeans([], 13, rng('subject-5:1'))).toEqual([]);
  });
});
