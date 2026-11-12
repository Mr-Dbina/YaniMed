import type { Cluster, EmbeddedChunk } from './types.js';
import { cosine, normalizeVector } from './text.js';

function nearestCentroid(vector: number[], centroids: number[][]): number {
  let bestIndex = 0;
  let bestSimilarity = -Infinity;
  for (let i = 0; i < centroids.length; i++) {
    const similarity = cosine(vector, centroids[i]);
    if (similarity > bestSimilarity) {
      bestSimilarity = similarity;
      bestIndex = i;
    }
  }
  return bestIndex;
}

function meanVector(vectors: number[][]): number[] {
  if (vectors.length === 0) return [];
  const dimension = vectors[0].length;
  const sum = new Array<number>(dimension).fill(0);
  for (const vector of vectors) {
    for (let i = 0; i < dimension; i++) sum[i] += vector[i];
  }
  return sum.map(value => value / vectors.length);
}

// Spec 2: seeded deterministic k-means over stored embeddings.
export function kmeans(items: EmbeddedChunk[], requestedK: number, rng: () => number): Cluster[] {
  if (items.length === 0) return [];
  const vectors = items.map(item => normalizeVector(item.vector));
  const k = Math.min(requestedK, vectors.length);

  const centroids: number[][] = [];
  centroids.push([...vectors[Math.floor(rng() * vectors.length)]]);

  while (centroids.length < k) {
    const distances = vectors.map(vector => {
      let nearest = Infinity;
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
    for (let i = 0; i < distances.length; i++) {
      target -= distances[i];
      if (target <= 0) {
        picked = i;
        break;
      }
    }
    centroids.push([...vectors[picked]]);
  }

  let assignments: number[] = [];
  for (let iteration = 0; iteration < 50; iteration++) {
    const nextAssignments = vectors.map(vector => nearestCentroid(vector, centroids));
    const unchanged =
      assignments.length === nextAssignments.length &&
      assignments.every((value, index) => value === nextAssignments[index]);
    assignments = nextAssignments;
    if (unchanged) break;

    const nextCentroids = centroids.map((centroid, index) => {
      const members = vectors.filter((_, vectorIndex) => assignments[vectorIndex] === index);
      return members.length > 0 ? normalizeVector(meanVector(members)) : centroid;
    });
    centroids.splice(0, centroids.length, ...nextCentroids);
  }

  const clusters: Cluster[] = centroids.map((centroid, index) => ({
    id: index,
    centroid,
    members: items.filter((_, itemIndex) => assignments[itemIndex] === index),
  }));

  return clusters.filter(cluster => cluster.members.length > 0);
}

// Spec 2: merge clusters under 3 chunks into the nearest centroid.
export function mergeSmallClusters(clusters: Cluster[], minSize: number = 3): Cluster[] {
  let active = clusters
    .filter(cluster => cluster.members.length > 0)
    .map(cluster => ({
      id: cluster.id,
      centroid: [...cluster.centroid],
      members: [...cluster.members],
    }));

  while (active.length > 1) {
    const smallIndex = active.findIndex(cluster => cluster.members.length < minSize);
    if (smallIndex === -1) break;
    const small = active[smallIndex];

    let targetIndex = -1;
    let targetSimilarity = -Infinity;
    active.forEach((cluster, index) => {
      if (index === smallIndex) return;
      const similarity = cosine(small.centroid, cluster.centroid);
      if (similarity > targetSimilarity) {
        targetSimilarity = similarity;
        targetIndex = index;
      }
    });
    if (targetIndex === -1) break;

    const target = active[targetIndex];
    target.members.push(...small.members);
    target.centroid = normalizeVector(meanVector(target.members.map(member => member.vector)));
    active = active.filter((_, index) => index !== smallIndex);
  }

  return active
    .map((cluster, index) => ({ ...cluster, id: index }))
    .sort((a, b) => {
      const aFirst = a.members[0]?.chunk;
      const bFirst = b.members[0]?.chunk;
      if (!aFirst || !bFirst) return 0;
      return (
        aFirst.documentId.localeCompare(bFirst.documentId) ||
        aFirst.page - bFirst.page ||
        aFirst.chunkIndex - bFirst.chunkIndex
      );
    })
    .map((cluster, index) => ({ ...cluster, id: index }));
}
