/**
 * pgvector returns a string such as "[0.1,0.2,...]". Invalid entries are
 * dropped; an empty result means "not embedded", never a zero vector.
 */
export function parseEmbedding(
  raw: string | null | undefined,
): number[] {
  if (!raw) return [];
  const inside = raw.trim().replace(/^\[/, '').replace(/\]$/, '');
  if (!inside) return [];
  return inside
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value));
}
