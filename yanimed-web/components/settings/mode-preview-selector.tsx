"use client";

import { useRef } from "react";
import type { KeyboardEvent } from "react";

const MODES = [
  { id: "system", label: "System", image: "/images/mode-system.png" },
  { id: "light", label: "Light", image: "/images/mode-light.png" },
  { id: "dark", label: "Dark", image: "/images/mode-dark.png" },
] as const;

type ModeId = (typeof MODES)[number]["id"];

interface ModePreviewSelectorProps {
  value: ModeId;
  onChange: (next: ModeId) => void;
}

/**
 * Single-select mode picker built from preview images. Uses the radiogroup
 * pattern with a roving tabindex: one stop in the tab order, arrows to move,
 * Home/End to jump, Enter/Space to select.
 */
export function ModePreviewSelector({ value, onChange }: ModePreviewSelectorProps) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const focusAt = (index: number) => {
    const wrapped = (index + MODES.length) % MODES.length;
    refs.current[wrapped]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, index: number) => {
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        event.preventDefault();
        focusAt(index + 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        event.preventDefault();
        focusAt(index - 1);
        break;
      case "Home":
        event.preventDefault();
        focusAt(0);
        break;
      case "End":
        event.preventDefault();
        focusAt(MODES.length - 1);
        break;
      default:
        break;
    }
  };

  return (
    <div className="mode-selector" role="radiogroup" aria-label="Mode">
      {MODES.map((mode, index) => {
        const selected = mode.id === value;
        return (
          <button
            key={mode.id}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={mode.label}
            tabIndex={selected ? 0 : -1}
            ref={(node) => {
              refs.current[index] = node;
            }}
            onClick={() => onChange(mode.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={`mode-preview${selected ? " mode-preview--selected" : ""}`}
          >
            <img
              src={mode.image}
              alt={`${mode.label} mode preview`}
              className="mode-preview__image"
            />
          </button>
        );
      })}
    </div>
  );
}