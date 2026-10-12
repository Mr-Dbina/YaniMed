import { connection } from "next/server";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { formatBytes } from "@/lib/format";
import { listLibraryFiles, summarizeStorage } from "@/lib/library";

export default async function StorageSettingsPage() {
  // Usage is summed from disk at request time, so this must not be prerendered.
  // `connection()` is the Cache-Components-compatible opt-out; `export const
  // dynamic` is rejected while cacheComponents is enabled.
  await connection();

  let summary = summarizeStorage([]);
  let fileCount = 0;

  try {
    const files = await listLibraryFiles();
    summary = summarizeStorage(files);
    fileCount = files.length;
  } catch {
    // Library folder unavailable - show zeroes rather than breaking settings.
  }

  return (
    <>
      <h1 className="settings-page-title">Storage</h1>

      <p className="storage__usage">{summary.usedLabel}</p>
      <div
        className="storage__bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(summary.percentUsed)}
        aria-label="Storage used"
      >
        <span className="storage__bar-fill" style={{ width: `${summary.percentUsed}%` }} />
      </div>

      <h2 className="setting-section-title">Manage storage</h2>
      <p className="setting-section-description">Manage your storage to free up space</p>

      <div className="setting-card">
        {/* Whole row navigates to the library. */}
        <Link href="/library" className="setting-row setting-row--link">
          <div className="setting-row__text">
            <span className="setting-row__label">Files</span>
            <span className="setting-row__description">
              {formatBytes(summary.usedBytes)} &middot; {fileCount}{" "}
              {fileCount === 1 ? "file" : "files"}
            </span>
          </div>
          <div className="setting-row__control">
            <ChevronRight size={18} strokeWidth={1.7} className="setting-chevron" aria-hidden="true" />
          </div>
        </Link>
      </div>
    </>
  );
}