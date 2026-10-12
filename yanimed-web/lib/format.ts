export interface LibraryFile {
  id: string;
  name: string;
  extension: string;
  /** Size in bytes. */
  size: number;
  /** ISO timestamp of the last modification. */
  modifiedAt: string;
}

export const LIBRARY_CAPACITY_BYTES = 512 * 1024 * 1024;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let i = 1; i < units.length && value >= 1024; i += 1) {
    value /= 1024;
    unit = units[i];
  }
  return `${value.toFixed(1)} ${unit}`;
}

export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return "Modified just now";
  if (minutes < 60) return `Modified ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Modified ${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `Modified ${days}d ago`;
  return `Modified on ${new Date(iso).toLocaleDateString()}`;
}