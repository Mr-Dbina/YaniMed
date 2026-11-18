"use client";

import { useEffect, useId, useRef, useState } from "react";
import { AddPdfModal } from "@/components/add-pdf-modal";
import { DeleteSubjectModal } from "@/components/delete-subject-modal";
import { EmptyState } from "@/components/empty-state";
import { getSubjectDocuments } from "@/lib/backend-api";
import type { Subject } from "@/lib/types";

interface SubjectGridProps {
  subjects: Subject[];
  onOpenSubject: (id: string) => void;
  onCreateSubject: () => void;
  onUpdateSubject: (id: string, patch: Partial<Omit<Subject, "id">>) => void;
  onDeleteSubject: (id: string) => void;
}

function pdfCount(subject: Subject): number {
  return subject.documentCount ?? (subject.file ? 1 : 0);
}

type SortKey = "recent" | "name" | "pdfs";

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "recent", label: "Recent" },
  { key: "name", label: "Name" },
  { key: "pdfs", label: "PDFs" },
];

function compareNames(a: Subject, b: Subject): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

export function SubjectGrid({
  subjects,
  onOpenSubject,
  onCreateSubject,
  onUpdateSubject,
  onDeleteSubject,
}: SubjectGridProps) {
  const [query, setQuery] = useState("");
  const [menuId, setMenuId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [pendingOpenId, setPendingOpenId] = useState<string | null>(null);
  const [addPdfId, setAddPdfId] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("recent");
  const [sortOpen, setSortOpen] = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const sortWrapRef = useRef<HTMLDivElement>(null);
  const sortButtonRef = useRef<HTMLButtonElement>(null);
  const openTitleId = useId();

  useEffect(() => {
    if (renamingId) renameInputRef.current?.focus();
  }, [renamingId]);

  useEffect(() => {
    if (!pendingOpenId) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPendingOpenId(null);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [pendingOpenId]);

  useEffect(() => {
    if (!sortOpen) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      if (!sortWrapRef.current?.contains(event.target as Node)) setSortOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setSortOpen(false);
      sortButtonRef.current?.focus();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [sortOpen]);

  const trimmed = query.trim().toLowerCase();
  const visible = trimmed
    ? subjects.filter((subject) => subject.name.toLowerCase().includes(trimmed))
    : subjects;

  const sorted = [...visible];
  if (sort === "name") {
    sorted.sort(compareNames);
  } else if (sort === "pdfs") {
    sorted.sort((a, b) => pdfCount(b) - pdfCount(a) || compareNames(a, b));
  } else {
    sorted.reverse();
  }

  const pendingDelete = subjects.find((subject) => subject.id === pendingDeleteId) ?? null;
  const pendingOpen = subjects.find((subject) => subject.id === pendingOpenId) ?? null;
  const addPdf = subjects.find((subject) => subject.id === addPdfId) ?? null;

  const startRename = (subject: Subject) => {
    setRenameValue(subject.name);
    setRenamingId(subject.id);
  };

  const commitRename = (id: string) => {
    const next = renameValue.trim();
    if (next) {
      // Rename is local-only: uploadName, idempotencyKey, file and filename stay frozen.
      onUpdateSubject(id, { name: next });
    }
    setRenamingId(null);
  };

  if (subjects.length === 0) {
    return <EmptyState onCreateSubject={onCreateSubject} />;
  }

  return (
    <div className="subject-grid">
      <header className="subject-grid__header">
        <div className="subject-grid__heading">
          <span className="subject-grid__icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            </svg>
          </span>
          <div className="subject-grid__heading-text">
            <h1 className="subject-grid__title">Subjects</h1>
            <p className="subject-grid__subtitle">
              Manage your medical subjects and uploaded study PDFs
            </p>
          </div>
        </div>
        <div className="subject-grid__actions">
          <div className="subject-grid__search-wrap">
            <svg className="subject-grid__search-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              type="search"
              className="subject-grid__search"
              placeholder="Search subjects..."
              aria-label="Search subjects"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <button type="button" className="subject-grid__new" onClick={onCreateSubject}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
            New Subject
          </button>
          <div className="subject-grid__sort-wrap" ref={sortWrapRef}>
            <button
              ref={sortButtonRef}
              type="button"
              className="subject-grid__filter"
              aria-label="Sort subjects"
              aria-haspopup="menu"
              aria-expanded={sortOpen}
              onClick={() => setSortOpen((next) => !next)}
            >
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
                <circle cx="16" cy="7" r="2" />
                <circle cx="8" cy="17" r="2" />
              </svg>
            </button>

            {sortOpen && (
              <div className="subject-grid__sort-menu" role="menu" aria-label="Sort subjects">
                <p className="subject-grid__sort-heading">Sort by</p>
                {SORT_OPTIONS.map((option) => (
                  <button
                    key={option.key}
                    type="button"
                    role="menuitemradio"
                    aria-checked={sort === option.key}
                    className="subject-grid__sort-option"
                    onClick={() => {
                      setSort(option.key);
                      setSortOpen(false);
                      sortButtonRef.current?.focus();
                    }}
                  >
                    <span className="subject-grid__sort-label">{option.label}</span>
                    {sort === option.key ? (
                      <svg className="subject-grid__sort-check" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="m5 13 4 4L19 7" />
                      </svg>
                    ) : null}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </header>

      {visible.length === 0 ? (
        <p className="subject-grid__empty" role="status">
          No subjects match your search.
        </p>
      ) : (
        <div className="subject-grid__cards">
          {sorted.map((subject) => {
            const count = pdfCount(subject);
            return (
              <div
                key={subject.id}
                className="subject-card"
                onClick={() => {
                  if (renamingId !== subject.id) setPendingOpenId(subject.id);
                }}
              >
                <div className="subject-card__head">
                  {renamingId === subject.id ? (
                    <input
                      ref={renameInputRef}
                      className="subject-card__rename"
                      value={renameValue}
                      aria-label={`Rename ${subject.name}`}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => setRenameValue(event.target.value)}
                      onBlur={() => commitRename(subject.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") commitRename(subject.id);
                        if (event.key === "Escape") setRenamingId(null);
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="subject-card__name"
                      onClick={(event) => {
                        event.stopPropagation();
                        setPendingOpenId(subject.id);
                      }}
                    >
                      {subject.name}
                    </button>
                  )}

                  <div
                    className="subject-detail__menu-wrap"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <button
                      type="button"
                      className="subject-detail__menu"
                      aria-label={`Actions for ${subject.name}`}
                      aria-haspopup="menu"
                      aria-expanded={menuId === subject.id}
                      onClick={() =>
                        setMenuId(menuId === subject.id ? null : subject.id)
                      }
                    >
                      <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
                        <circle cx="12" cy="5" r="1.8" />
                        <circle cx="12" cy="12" r="1.8" />
                        <circle cx="12" cy="19" r="1.8" />
                      </svg>
                    </button>

                    {menuId === subject.id && (
                      <>
                        <button
                          type="button"
                          className="subject-detail__menu-backdrop"
                          aria-label="Close menu"
                          tabIndex={-1}
                          onClick={() => setMenuId(null)}
                        />
                        <div role="menu" className="subject-detail__menu-dropdown">
                          <button
                            type="button"
                            role="menuitem"
                            className="subject-detail__menu-item"
                            onClick={() => {
                              setMenuId(null);
                              startRename(subject);
                            }}
                          >
                            <span className="subject-detail__menu-label">Rename</span>
                          </button>
                          <div className="subject-detail__menu-divider" />
                          <button
                            type="button"
                            role="menuitem"
                            className="subject-detail__menu-item"
                            onClick={() => {
                              setMenuId(null);
                              setPendingDeleteId(subject.id);
                            }}
                          >
                            <span className="subject-detail__menu-label">Delete</span>
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                </div>

                <div className="subject-card__body">
                  <p className="subject-card__meta">
                    {count} PDF{count === 1 ? "" : "s"}
                  </p>
                  {subject.backendSubjectId && (
                    <button
                      type="button"
                      className="subject-card__add-pdf"
                      onClick={(event) => {
                        event.stopPropagation();
                        setAddPdfId(subject.id);
                      }}
                    >
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <path d="M12 5v14M5 12h14" />
                      </svg>
                      Add PDF
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {pendingOpen && (
        <div
          className="subject-modal__overlay subject-modal__overlay--fixed"
          onMouseDown={() => setPendingOpenId(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={openTitleId}
            className="subject-modal subject-modal--sm"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2 id={openTitleId} className="subject-modal__title subject-modal__title--sm">
              Open chat for &ldquo;{pendingOpen.name}&rdquo;?
            </h2>
            <p className="subject-modal__confirm-text">
              Continue in this subject&apos;s chat.
            </p>
            <div className="subject-modal__footer">
              <button
                type="button"
                className="subject-modal__btn subject-modal__btn--ghost"
                onClick={() => setPendingOpenId(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="subject-modal__btn subject-modal__btn--primary"
                onClick={() => {
                  const id = pendingOpenId;
                  setPendingOpenId(null);
                  if (id) onOpenSubject(id);
                }}
              >
                Open chat
              </button>
            </div>
          </div>
        </div>
      )}

      <DeleteSubjectModal
        open={pendingDelete !== null}
        onOpenChange={(next) => {
          if (!next) setPendingDeleteId(null);
        }}
        subjectName={pendingDelete?.name ?? ""}
        onConfirm={() => {
          if (pendingDeleteId) onDeleteSubject(pendingDeleteId);
          setPendingDeleteId(null);
        }}
      />

      {addPdf && addPdf.backendSubjectId && (
        <AddPdfModal
          subjectId={addPdf.backendSubjectId}
          subjectName={addPdf.name}
          onClose={() => setAddPdfId(null)}
          onUploaded={() => {
            const backendId = addPdf.backendSubjectId;
            if (!backendId) return;
            const id = addPdf.id;
            void getSubjectDocuments(backendId)
              .then((docs) => onUpdateSubject(id, { documentCount: docs.length }))
              .catch(() => undefined);
          }}
        />
      )}
    </div>
  );
}
