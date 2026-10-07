import { useEffect, useId, useRef, useState } from "react";
import "./CreateSubjectModal.css";

const PLACEHOLDER =
  "Think step by step and show reasoning for complex problems. Use specific example";

export function SetInstructionsModal({ open, onOpenChange, subjectName, value, onSave }) {
  const [text, setText] = useState("");
  const textareaRef = useRef(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return undefined;
    setText(value || "");
    textareaRef.current?.focus();

    const onKeyDown = (event) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, value, onOpenChange]);

  if (!open) return null;

  const canSave = text.trim().length > 0;

  return (
    <div
      className="subject-modal__overlay subject-modal__overlay--fixed"
      onMouseDown={() => onOpenChange(false)}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="subject-modal subject-modal--wide"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id={titleId} className="subject-modal__title">
          Set subject instructions
        </h2>
        <p className="subject-modal__description">
          Provide Yanimed with relevant instructions and information for chats
          within {subjectName}. This will work alongside your{" "}
          <button type="button" className="subject-modal__link">
            profile instructions
          </button>{" "}
          and the selected style in a chat.
        </p>

        <textarea
          ref={textareaRef}
          className="subject-modal__textarea"
          placeholder={PLACEHOLDER}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />

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
            disabled={!canSave}
            onClick={() => onSave(text.trim())}
          >
            Save instructions
          </button>
        </div>
      </div>
    </div>
  );
}
