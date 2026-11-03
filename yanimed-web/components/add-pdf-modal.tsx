"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import { PdfDropzone } from "@/components/pdf-dropzone";
import {
  InitialUploadDuplicateError,
  uploadPdfToSubject,
  type DuplicateAction,
} from "@/lib/backend-api";

interface AddPdfModalProps {
  subjectId: string;
  subjectName: string;
  onClose: () => void;
}

type SuccessState = "created" | "existing";

export function AddPdfModal({ subjectId, subjectName, onClose }: AddPdfModalProps) {
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<InitialUploadDuplicateError | null>(null);
  const [success, setSuccess] = useState<SuccessState | null>(null);
  const savingRef = useRef(false);
  const titleId = useId();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !savingRef.current) onClose();
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  const canSubmit = file !== null && !saving;

  const chooseFile = (nextFile: File) => {
    setFile(nextFile);
    setError(null);
    setDuplicate(null);
  };

  const chooseAnotherFile = () => {
    setFile(null);
    setError(null);
    setDuplicate(null);
    setSuccess(null);
  };

  const submit = async (duplicateAction?: DuplicateAction) => {
    if (savingRef.current || !file) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);

    try {
      const result = await uploadPdfToSubject({
        subjectId,
        file,
        ...(duplicateAction ? { duplicateAction } : {}),
      });
      setDuplicate(null);
      setSuccess(result.created ? "created" : "existing");
    } catch (err) {
      if (err instanceof InitialUploadDuplicateError) {
        setDuplicate(err);
        if (!err.allowedActions.includes("keep_existing")) setError(err.message);
        return;
      }
      setDuplicate(null);
      setError(err instanceof Error ? err.message : "Could not add the PDF. Please try again.");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (duplicate || success) return;
    void submit();
  };

  const canKeepExisting = duplicate?.allowedActions.includes("keep_existing") ?? false;
  const duplicateAction = duplicate?.scope === "same_subject"
    ? "Use existing PDF"
    : "Add separate copy";

  return (
    <div
      className="subject-modal__overlay"
      onMouseDown={() => { if (!savingRef.current) onClose(); }}
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
            Add a PDF
          </h2>
          <button
            type="button"
            aria-label="Close"
            disabled={saving}
            className="subject-modal__close"
            onClick={onClose}
          >
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M5 5l14 14M19 5L5 19" />
            </svg>
          </button>
        </div>

        <div className="subject-modal__body">
          {success ? (
            <div className="subject-modal__group">
              <p className="subject-modal__helper">
                {success === "created"
                  ? "PDF added to this subject. It will be processed on the server."
                  : "This PDF is already on this subject. No new document was created."}
              </p>
            </div>
          ) : duplicate ? (
            <div className="subject-modal__group">
              <span className="subject-modal__label">
                {duplicate.scope === "same_subject"
                  ? "This PDF is already on this subject."
                  : "This PDF already exists on another subject."}
              </span>
              <p className="subject-modal__helper">
                {duplicate.scope === "same_subject"
                  ? "If an earlier attempt timed out, it did reach the server."
                  : `A separate copy will be added to ${subjectName}. It may appear under the existing filename. The other subject is unchanged.`}
              </p>
            </div>
          ) : (
            <div className="subject-modal__group">
              <span className="subject-modal__label">Choose a PDF</span>
              <p className="subject-modal__helper">
                Add another PDF to {subjectName}. Existing PDFs are not changed.
              </p>
              <PdfDropzone
                file={file}
                onFileSelect={chooseFile}
                disabled={saving}
                selectedSubtitle="Ready to upload to this subject."
              />
            </div>
          )}
        </div>

        {error && <p className="subject-modal__error" role="alert">{error}</p>}

        <div className="subject-modal__footer">
          {success ? (
            <button
              type="button"
              className="subject-modal__btn subject-modal__btn--primary"
              onClick={onClose}
            >
              Close
            </button>
          ) : duplicate ? (
            <>
              <button
                type="button"
                disabled={saving}
                className="subject-modal__btn subject-modal__btn--ghost"
                onClick={chooseAnotherFile}
              >
                Choose another file
              </button>
              {canKeepExisting && (
                <button
                  type="button"
                  className="subject-modal__btn subject-modal__btn--primary"
                  disabled={saving}
                  onClick={() => void submit("keep_existing")}
                >
                  {saving ? "Adding..." : duplicateAction}
                </button>
              )}
            </>
          ) : (
            <>
              <button
                type="button"
                disabled={saving}
                className="subject-modal__btn subject-modal__btn--ghost"
                onClick={onClose}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="subject-modal__btn subject-modal__btn--primary"
                disabled={!canSubmit}
              >
                {saving ? "Adding..." : "Add PDF"}
              </button>
            </>
          )}
        </div>
      </form>
    </div>
  );
}
