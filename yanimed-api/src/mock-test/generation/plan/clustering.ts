import { parseEmbedding } from '../text/embedding.js';
import { cosine } from '../text/similarity.js';
import type { ChunkInput } from './eligibility.js';

export type RawEmbedding = string | readonly number[] | null | undefined;

/** A chunk as the worker will hand it to the planner: source fields plus id and embedding. */
export interface PlannerChunkInput extends ChunkInput {
  id: string;
  embedding: RawEmbedding;
}

export interface VectorChunk {
  chunk: PlannerChunkInput;
  vector: number[];
}

export interface ChunkCluster {
  id: number;
  centroid: number[];
  members: VectorChunk[];
}

function toVector(raw: RawEmbedding): number[] {
  if (typeof raw === 'string') return parseEmbedding(raw);
  if (Array.isArray(raw)) {
    return raw.filter((value) => Number.isFinite(value));
  }
  return [];
}

function isZeroVector(vector: readonly number[]): boolean {
  return vector.every((value) => value === 0);
}

function dominantDimension(
  parsed: readonly { vector: number[] }[],
): number {
  const counts = new Map<number, { count: number; first: number }>();
  parsed.forEach((item, index) => {
    if (item.vector.length === 0 || isZeroVector(item.vector)) return;
    const entry = counts.get(item.vector.length) ?? {
      count: 0,
      first: index,
    };
    entry.count += 1;
    counts.set(item.vector.length, entry);
  });

  let dimension = 0;
  let best = { count: 0, first: Number.POSITIVE_INFINITY };
  for (const [size, entry] of counts) {
    if (
      entry.count > best.count ||
      (entry.count === best.count && entry.first < best.first)
    ) {
      dimension = size;
      best = entry;
    }
  }
  return dimension;
}

/**
 * Parses embeddings and drops chunks that are missing, all-zero or not in the
 * dominant dimension. The excluded count is reported, never the content.
 */
export function prepareVectors(chunks: readonly PlannerChunkInput[]): {
  items: VectorChunk[];
  excluded: number;
} {
  const parsed = chunks.map((chunk) => ({
    chunk,
    vector: toVector(chunk.embedding),
  }));
  const dimension = dominantDimension(parsed);
  const items =
    dimension === 0
      ? []
      : parsed
          .filter(
            (item) =>
              item.vector.length === dimension && !isZeroVector(item.vector),
          )
          .map((item) => ({ chunk: item.chunk, vector: [...item.vector] }));

  return { items, excluded: chunks.length - items.length };
}

function normalizeVector(vector: readonly number[]): number[] {
  let norm = 0;
  for (const value of vector) norm += value * value;
  if (norm === 0) return [...vector];
  const divisor = Math.sqrt(norm);
  return vector.map((value) => value / divisor);
}

function meanVector(vectors: readonly number[][]): number[] {
  if (vectors.length === 0) return [];
  const dimension = vectors[0].length;
  const sum = Array.from({ length: dimension }, () => 0);
  for (const vector of vectors) {
    for (let index = 0; index < dimension; index += 1) {
      sum[index] += vector[index];
    }
  }
  return sum.map((value) => value / vectors.length);
}

function nearestCentroid(
  vector: readonly number[],
  centroids: readonly number[][],
): number {
  let bestIndex = 0;
  let bestSimilarity = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < centroids.length; index += 1) {
    const similarity = cosine(vector, centroids[index]);
    if (similarity > bestSimilarity) {
      bestSimilarity = similarity;
      bestIndex = index;
    }
  }
  return bestIndex;
}

/**
 * Ported from scripts/m2-question-test/clustering.ts: seeded k-means++ over
 * normalized vectors, at most 50 Lloyd iterations, then empty clusters are
 * dropped. The input order is the deterministic tie-break, so the same items
 * and rng always give the same clusters.
 */
export function kmeans(
  items: readonly VectorChunk[],
  requestedK: number,
  rng: () => number,
): ChunkCluster[] {
  if (items.length === 0 || requestedK < 1) return [];

  const vectors = items.map((item) => normalizeVector(item.vector));
  const k = Math.min(requestedK, vectors.length);

  const centroids: number[][] = [
    [...vectors[Math.floor(rng() * vectors.length)]],
  ];

  while (centroids.length < k) {
    const distances = vectors.map((vector) => {
      let nearest = Number.POSITIVE_INFINITY;
      for (const centroid of centroids) {
        const distance = 1 - cosine(vector, centroid);
        if (distance < nearest) nearest = distance;
      }
      return nearest * nearest;
    });
    const total = distances.reduce((sum, value) => sum + value, 0);

    if (total <= 0) {
      const index = Math.floor(rng() * vectors.length);
      centroids.push([...vectors[index]]);
      continue;
    }

    let target = rng() * total;
    let picked = 0;
    for (let index = 0; index < distances.length; index += 1) {
      target -= distances[index];
      if (target <= 0) {
        picked = index;
        break;
      }
    }
    centroids.push([...vectors[picked]]);
  }

  let assignments: number[] = [];
  for (let iteration = 0; iteration < 50; iteration += 1) {
    const nextAssignments = vectors.map((vector) =>
      nearestCentroid(vector, centroids),
    );
    const unchanged =
      assignments.length === nextAssignments.length &&
      assignments.every(
        (value, index) => value === nextAssignments[index],
      );
    assignments = nextAssignments;
    if (unchanged) break;

    const nextCentroids = centroids.map((centroid, index) => {
      const members = vectors.filter(
        (_, vectorIndex) => assignments[vectorIndex] === index,
      );
      return members.length > 0
        ? normalizeVector(meanVector(members))
        : centroid;
    });
    centroids.splice(0, centroids.length, ...nextCentroids);
  }

  return centroids
    .map((centroid, index) => ({
      id: index,
      centroid,
      members: items.filter(
        (_, itemIndex) => assignments[itemIndex] === index,
      ),
    }))
    .filter((cluster) => cluster.members.length > 0);
}
