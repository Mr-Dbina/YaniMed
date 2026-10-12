import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { formatBytes, LIBRARY_CAPACITY_BYTES } from "@/lib/format";
import type { LibraryFile } from "@/lib/format";

export type { LibraryFile } from "@/lib/format";

/**
 * Server-only helpers. Client components must import the pure formatters from
 * ./format instead - importing this file from the browser pulls node:fs into
 * the bundle.
 */

/**
 * Root of the library. Override with LIBRARY_DIR. When the API's Document
 * endpoint lands this is the only call that needs to change.
 */
export function getLibraryDir(): string {
  const configured = process.env.LIBRARY_DIR?.trim();
  return configured || join(homedir(), "YaniMed", "Library");
}

export async function listLibraryFiles(): Promise<LibraryFile[]> {
  const dir = getLibraryDir();
  // Throws when the folder is missing or unreadable; callers render an
  // empty/error state rather than silently showing nothing.
  // turbopackIgnore: the library folder is user-configurable at runtime, so
  // Turbopack cannot statically scope it. Without this the production build
  // traces the entire project into the output.
  const entries = await readdir(/* turbopackIgnore: true */ dir, { withFileTypes: true });

  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry, index) => {
        const full = join(dir, entry.name);
        const info = await stat(full);
        const dot = entry.name.lastIndexOf(".");
        return {
          id: `${index}-${entry.name}`,
          name: entry.name,
          extension: dot > 0 ? entry.name.slice(dot + 1).toLowerCase() : "",
          size: info.size,
          modifiedAt: info.mtime.toISOString(),
        };
      }),
  );

  // Most recently touched first, matching the reference listing.
  return files.sort(
    (a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime(),
  );
}

export interface StorageSummary {
  usedBytes: number;
  capacityBytes: number;
  fileCount: number;
  /** 0-100, clamped for the progress bar. */
  percentUsed: number;
  usedLabel: string;
}

export function summarizeStorage(files: LibraryFile[]): StorageSummary {
  const usedBytes = files.reduce((sum, file) => sum + file.size, 0);
  const capacityBytes = LIBRARY_CAPACITY_BYTES;
  return {
    usedBytes,
    capacityBytes,
    fileCount: files.length,
    percentUsed: Math.min(100, (usedBytes / capacityBytes) * 100),
    usedLabel: `${formatBytes(usedBytes)} of ${formatBytes(capacityBytes)} used`,
  };
}