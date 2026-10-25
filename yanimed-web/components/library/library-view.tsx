"use client";

import { useMemo, useState } from "react";
import { LayoutGrid, List, Search } from "lucide-react";
import type { LibraryFile } from "@/lib/format";
import { formatBytes, relativeTime } from "@/lib/format";
import { FileIcon } from "@/components/library/file-icon";
import Link from "next/link";
import { useSubjectsStore } from "@/lib/stores/subjects-store";

type View = "list" | "grid";

export function LibraryView({ files }: { files: LibraryFile[] }) {
  const subjects = useSubjectsStore(state => state.subjects);
  const setActiveSubject = useSubjectsStore(state => state.setActiveSubject);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<View>("list");

  // The search query survives a view switch because it lives here, not in the
  // list or grid branches.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return files;
    return files.filter((file) => file.name.toLowerCase().includes(q));
  }, [files, query]);

  return (
    <section className="library">
      <header className="library__header">
        <h1 className="library__title">Library</h1>

        <div className="library__controls">
          <div className="library__view-controls" role="group" aria-label="View">
            <button
              type="button"
              aria-label="List view"
              aria-pressed={view === "list"}
              onClick={() => setView("list")}
              className={`library__view-button${view === "list" ? " library__view-button--active" : ""}`}
            >
              <List size={18} strokeWidth={1.7} aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label="Grid view"
              aria-pressed={view === "grid"}
              onClick={() => setView("grid")}
              className={`library__view-button${view === "grid" ? " library__view-button--active" : ""}`}
            >
              <LayoutGrid size={18} strokeWidth={1.7} aria-hidden="true" />
            </button>
          </div>

          <div className="library__search">
            <Search size={16} strokeWidth={1.7} aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search library"
              aria-label="Search library"
              className="library__search-input"
            />
          </div>
        </div>
      </header>

      <p className="library__notice">Local files are not uploaded or indexed. PDF processing is not connected yet.</p>
      {subjects.some(subject => subject.file) && <section aria-label="PDFs saved in this browser" className="library__local">
        <h2>Saved in this browser</h2>
        <ul>{subjects.filter(subject => subject.file && (!query || subject.file.name.toLowerCase().includes(query.toLowerCase()))).map(subject => <li key={subject.id}>
          <Link href="/subjects" onClick={() => setActiveSubject(subject.id)}>{subject.file?.name} — {subject.name}</Link>
          <span> · Local copy; not indexed</span>
        </li>)}</ul>
      </section>}

      <h2>Library folder files</h2>

      {filtered.length === 0 ? (
        <div className="library__empty">
          {files.length === 0 ? (
            <>
              <p className="library__empty-title">No files in the library folder</p>
              <p className="library__empty-text">
                Files placed in the library folder will appear here.
              </p>
            </>
          ) : (
            <>
              <p className="library__empty-title">No files match</p>
              <p className="library__empty-text">
                Nothing here matches &ldquo;{query}&rdquo;.
              </p>
            </>
          )}
        </div>
      ) : view === "list" ? (
        <>
          <div className="library__columns" aria-hidden="true">
            <span>Name</span>
            <span>Last activity</span>
          </div>
          <ul className="library__list">
            {filtered.map((file) => (
              <li key={file.id} className="library__row">
                <div className="library__row-name">
                  <FileIcon extension={file.extension} />
                  <span className="library__row-label">{file.name}</span>
                </div>
                <span className="library__row-meta">
                  <span className="library__row-activity">
                    {relativeTime(file.modifiedAt)}
                  </span>
                  <span className="library__row-size">{formatBytes(file.size)}</span>
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <ul className="library__grid">
          {filtered.map((file) => (
            <li key={file.id} className="library__card">
              <FileIcon extension={file.extension} size="lg" />
              <span className="library__card-name">{file.name}</span>
              <span className="library__card-meta">
                {relativeTime(file.modifiedAt)} &middot; {formatBytes(file.size)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
