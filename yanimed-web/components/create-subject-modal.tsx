"use client";

import { useEffect, useId, useRef, useState } from "react";
import { PdfDropzone } from "@/components/pdf-dropzone";

interface CreateSubjectModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (data: { name: string; file: File | null }) => void;
}

export function CreateSubjectModal({
  open,
  onOpenChange,
  onSubmit,
}: CreateSubjectModalProps) {
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const nameId = useId();

  useEffect(() => {
    if (!open) return undefined;
    setName("");
    setFile(null);
    nameInputRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
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

  const canCreate = name.trim().length > 0;

  const handleSubmit = () => {
    if (!canCreate) return;
    onSubmit({ name: name.trim(), file });
    onOpenChange(false);
  };

  return (
    <div
      className="subject-modal__overlay"
      onMouseDown={() => onOpenChange(false)}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="subject-modal"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="subject-modal__header">
          <h2 id={titleId} className="subject-modal__title">
            Create a subject
          </h2>
          <button
            type="button"
            aria-label="Close"
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
              onChange={(event) => setName(event.target.value)}
            />
          </div>

          <div className="subject-modal__group">
            <span className="subject-modal__label">Upload PDF</span>
            <p className="subject-modal__helper">
              Upload your reviewer, notes, or any PDF file.
            </p>
            <PdfDropzone file={file} onFileSelect={setFile} />
          </div>
        </div>

        <div className="subject-modal__footer">
          <button
            type="button"
            className="subject-modal__btn subject-modal__btn--ghost"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="subject-modal__btn subject-modal__btn--primary"
            disabled={!canCreate}
            onClick={handleSubmit}
          >
            Create subject
          </button>
        </div>
      </div>
    </div>
  );
}
