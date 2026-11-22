"use client";

import { useEffect, useId } from "react";

interface DeleteSubjectModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subjectName: string;
  onConfirm: () => void;
  busy?: boolean;
  error?: string | null;
}

export function DeleteSubjectModal({
  open,
  onOpenChange,
  subjectName,
  onConfirm,
  busy = false,
  error = null,
}: DeleteSubjectModalProps) {
  const titleId = useId();

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onOpenChange(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, busy, onOpenChange]);

  if (!open) return null;

  return (
    <div
      className="subject-modal__overlay subject-modal__overlay--fixed"
      onMouseDown={() => {
        if (!busy) onOpenChange(false);
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="subject-modal subject-modal--sm"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id={titleId} className="subject-modal__title subject-modal__title--sm">
          Delete subject
        </h2>
        <p className="subject-modal__confirm-text">
          &ldquo;{subjectName}&rdquo; will be removed from this device. Chats
          saved only in this browser are cleared too. This can&rsquo;t be undone.
        </p>

        {error && (
          <p role="alert" className="subject-modal__error">
            {error}
          </p>
        )}

        <div className="subject-modal__footer">
          <button
            type="button"
            className="subject-modal__btn subject-modal__btn--ghost"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="subject-modal__btn subject-modal__btn--danger"
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}
