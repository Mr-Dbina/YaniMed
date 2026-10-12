"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Search } from "lucide-react";

const AUTO = "Auto detect";

const LANGUAGES = [
  "Albanian",
  "Armenian",
  "Bahasa Melayu",
  "bosanski",
  "Burmese",
  "català",
  "čeština",
  "dansk",
  "Deutsch",
  "Eesti",
  "Español",
  "Esperanto",
  "Filipino",
  "Français",
  "한국어",
  "Italiano",
  "עברית",
  "Magyar",
  "Nederlands",
  "Norsk",
  "Polski",
  "Português",
  "Русский",
  "Suomi",
  "Svenska",
  "Tagalog",
  "Taglish",
  "Türkçe",
  "Українська",
  "việt",
];

interface LanguageSelectProps {
  value: string;
  onChange: (value: string) => void;
}

export function LanguageSelect({ value, onChange }: LanguageSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const options = useMemo(() => {
    const all = [AUTO, ...LANGUAGES];
    const q = query.trim().toLowerCase();
    return q ? all.filter((l) => l.toLowerCase().includes(q)) : all;
  }, [query]);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        setQuery("");
        triggerRef.current?.focus();
      }
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    // Seed the highlight from the current value here rather than in an effect,
    // which would cascade renders. The input uses autoFocus instead.
    const selected = options.indexOf(value);
    setActiveIndex(selected >= 0 ? selected : 0);
    setOpen(true);
  };

  const choose = (next: string) => {
    onChange(next);
    setOpen(false);
    setQuery("");
    triggerRef.current?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      const next = options.length === 0 ? 0 : (activeIndex + 1) % options.length;
      setActiveIndex(next);
      optionRefs.current[next]?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      const next =
        options.length === 0 ? 0 : (activeIndex - 1 + options.length) % options.length;
      setActiveIndex(next);
      optionRefs.current[next]?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter") {
      event.preventDefault();
      const picked = options[activeIndex];
      if (picked) choose(picked);
    }
  };

  return (
    <div className="lang-select" ref={rootRef} onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        className="lang-select__trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={toggle}
      >
        {value}
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open ? (
        <div className="lang-select__panel">
          <div className="lang-select__search">
            <Search size={15} strokeWidth={1.7} aria-hidden="true" />
            <input
              ref={inputRef}
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActiveIndex(0);
              }}
              placeholder="Search languages"
              aria-label="Search languages"
              className="lang-select__input"
            />
          </div>

          <div role="listbox" aria-label="Language" className="lang-select__list">
            {options.length === 0 ? (
              <p className="lang-select__empty">No languages found</p>
            ) : (
              options.map((lang, index) => (
                <button
                  key={lang}
                  type="button"
                  role="option"
                  aria-selected={lang === value}
                  ref={(node) => {
                    optionRefs.current[index] = node;
                  }}
                  className={`lang-select__option${index === activeIndex ? " lang-select__option--active" : ""}`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => choose(lang)}
                >
                  {lang}
                  {lang === value ? (
                    <Check size={15} strokeWidth={1.9} aria-hidden="true" />
                  ) : null}
                </button>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}