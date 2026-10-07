"use client";

import { useEffect, useId } from "react";

interface DeleteSubjectModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subjectName: string;
  onConfirm: () => void;
}

export function DeleteSubjectModal({
  open,
  onOpenChange,
  subjectName,
  onConfirm,
}: DeleteSubjectModalProps) {
  const titleId = useId();

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onOpenChange]);

  if (!open) return null;

  return (
    <div
      className="subject-modal__overlay subject-modal__overlay--fixed"
      onMouseDown={() => onOpenChange(false)}
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
          &ldquo;{subjectName}&rdquo; and all of its chats will be permanently
          deleted. This can&rsquo;t be undone.
        </p>

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
            className="subject-modal__btn subject-modal__btn--danger"
            onClick={onConfirm}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
