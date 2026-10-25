"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import { PdfDropzone } from "@/components/pdf-dropzone";

interface CreateSubjectModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (data: { name: string; file: File }) => Promise<void>;
}

export function CreateSubjectModal({
  open,
  onOpenChange,
  onSubmit,
}: CreateSubjectModalProps) {
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const nameId = useId();

  useEffect(() => {
    if (!open) return undefined;
    nameInputRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !savingRef.current) onOpenChange(false);
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onOpenChange]);

  if (!open) return null;

  const canCreate = name.trim().length > 0 && file !== null && !saving;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canCreate || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await onSubmit({ name: name.trim(), file });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the subject. Please retry.");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <div
      className="subject-modal__overlay"
      onMouseDown={() => { if (!savingRef.current) onOpenChange(false); }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="subject-modal"
        onSubmit={handleSubmit}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="subject-modal__header">
          <h2 id={titleId} className="subject-modal__title">
            Create a subject
          </h2>
          <button
            type="button"
            aria-label="Close"
            disabled={saving}
            className="subject-modal__close"
            onClick={() => onOpenChange(false)}
          >
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M5 5l14 14M19 5L5 19" />
            </svg>
          </button>
        </div>

        <div className="subject-modal__body">
          <div className="subject-modal__group">
            <label htmlFor={nameId} className="subject-modal__label">
              What subject are you studying?
            </label>
            <input
              id={nameId}
              ref={nameInputRef}
              type="text"
              className="subject-modal__input"
              placeholder="Name your subject"
              value={name}
              required
              disabled={saving}
              onChange={(event) => setName(event.target.value)}
            />
          </div>

          <div className="subject-modal__group">
            <span className="subject-modal__label">Attach PDF</span>
            <p className="subject-modal__helper">
              Save a PDF with this subject in this browser. Server processing is not available yet.
            </p>
            <PdfDropzone file={file} onFileSelect={setFile} disabled={saving} />
          </div>
        </div>

        {error && <p className="subject-modal__error" role="alert">{error}</p>}

        <div className="subject-modal__footer">
          <button
            type="button"
            disabled={saving}
            className="subject-modal__btn subject-modal__btn--ghost"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="subject-modal__btn subject-modal__btn--primary"
            disabled={!canCreate}
          >
            {saving ? "Saving locally…" : "Create subject"}
          </button>
        </div>
      </form>
    </div>
  );
}
