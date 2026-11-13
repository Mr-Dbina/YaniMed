import {
  MAX_QUESTIONS_PER_TOPIC,
  MIN_DISTINCT_TOPICS,
  QUESTIONS_PER_TEST,
} from '../generation.constants.js';
import { cosine } from '../text/similarity.js';
import type { ChunkCluster, VectorChunk } from './clustering.js';

export interface SlotAllocation {
  cluster: ChunkCluster;
  slotCount: number;
}

export interface PlannedSlot {
  index: number;
  topicKey: string;
  seedChunkIds: string[];
}

function compareChunks(a: VectorChunk, b: VectorChunk): number {
  return (
    a.chunk.documentId.localeCompare(b.chunk.documentId) ||
    a.chunk.page - b.chunk.page ||
    a.chunk.chunkIndex - b.chunk.chunkIndex ||
    a.chunk.id.localeCompare(b.chunk.id)
  );
}

/**
 * The 13 largest clusters get one slot each. The remaining slots go one at a
 * time to the largest clusters that can still take one. A cluster with fewer
 * than two chunks can never take a second slot.
 */
export function allocateSlots(
  clusters: readonly ChunkCluster[],
  target: number = QUESTIONS_PER_TEST,
): SlotAllocation[] {
  const sorted = [...clusters].sort(
    (a, b) => b.members.length - a.members.length || a.id - b.id,
  );
  const allocations = sorted.map((cluster, rank) => ({
    cluster,
    slotCount: rank < MIN_DISTINCT_TOPICS ? 1 : 0,
  }));

  let remaining =
    target - allocations.reduce((sum, item) => sum + item.slotCount, 0);
  if (remaining <= 0) return allocations;

  for (const allocation of allocations) {
    if (remaining === 0) break;
    if (allocation.slotCount >= MAX_QUESTIONS_PER_TOPIC) continue;
    if (allocation.cluster.members.length < 2) continue;
    allocation.slotCount += 1;
    remaining -= 1;
  }
  return allocations;
}

/** Members nearest the centroid first; chunk order breaks equal scores. */
export function membersByCentroid(
  cluster: ChunkCluster,
): VectorChunk[] {
  return [...cluster.members].sort(
    (a, b) =>
      cosine(b.vector, cluster.centroid) -
        cosine(a.vector, cluster.centroid) || compareChunks(a, b),
  );
}

/**
 * Primary is the nth chunk closest to the centroid (n = slot ordinal), so two
 * slots in one topic never share a primary. Neighbours come from the same
 * cluster, same document, same or adjacent page, and at most two are added.
 */
export function selectSeedChunkIds(
  cluster: ChunkCluster,
  primaryOrdinal: number,
  maxNeighbours = 2,
): string[] {
  const ordered = membersByCentroid(cluster);
  const primary = ordered[primaryOrdinal];
  if (!primary) return [];

  const neighbours = ordered
    .filter(
      (item) =>
        item !== primary &&
        item.chunk.documentId === primary.chunk.documentId &&
        Math.abs(item.chunk.page - primary.chunk.page) <= 1,
    )
    .sort(
      (a, b) =>
        Math.abs(a.chunk.page - primary.chunk.page) -
          Math.abs(b.chunk.page - primary.chunk.page) ||
        Math.abs(a.chunk.chunkIndex - primary.chunk.chunkIndex) -
          Math.abs(b.chunk.chunkIndex - primary.chunk.chunkIndex) ||
        compareChunks(a, b),
    )
    .slice(0, maxNeighbours);

  return [
    primary.chunk.id,
    ...neighbours.map((item) => item.chunk.id),
  ];
}

export function buildSlots(
  allocations: readonly SlotAllocation[],
  topicKeyByCluster: ReadonlyMap<number, string>,
): PlannedSlot[] {
  const slots: PlannedSlot[] = [];
  for (const allocation of allocations) {
    const topicKey = topicKeyByCluster.get(allocation.cluster.id);
    if (!topicKey) continue;
    for (let ordinal = 0; ordinal < allocation.slotCount; ordinal += 1) {
      const seedChunkIds = selectSeedChunkIds(allocation.cluster, ordinal);
      if (seedChunkIds.length === 0) continue;
      slots.push({
        index: slots.length,
        topicKey,
        seedChunkIds,
      });
    }
  }
  return slots;
}
