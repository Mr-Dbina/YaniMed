"use client";

import { useRef, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";

const PDF_MIME = "application/pdf";

function isPdf(file: File) {
  return file.type === PDF_MIME;
}

interface PdfDropzoneProps {
  file: File | null;
  onFileSelect: (file: File) => void;
  title?: string;
  subtitle?: string;
  disabled?: boolean;
}

export function PdfDropzone({ file, onFileSelect, title, subtitle, disabled = false }: PdfDropzoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const handleFiles = (files: FileList | null) => {
    const candidate = files && files[0];
    if (disabled || !candidate) return;
    if (!isPdf(candidate) || candidate.size === 0) {
      setError("Select a nonempty PDF file.");
      return;
    }
    setError(null);
    onFileSelect(candidate);
  };

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        className={`pdf-dropzone${isDragging ? " pdf-dropzone--active" : ""}`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(event: DragEvent<HTMLButtonElement>) => {
          event.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={(event: DragEvent<HTMLButtonElement>) => {
          event.preventDefault();
          setIsDragging(false);
        }}
        onDrop={(event: DragEvent<HTMLButtonElement>) => {
          event.preventDefault();
          setIsDragging(false);
          handleFiles(event.dataTransfer.files);
        }}
      >
        <span className="pdf-dropzone__icon" aria-hidden="true">
          <svg viewBox="0 0 40 48" width="48" height="56" fill="none">
            <path
              d="M6 2h20l8 8v36a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z"
              fill="currentColor"
              fillOpacity="0.08"
            />
            <path
              d="M6 2h20l8 8v36a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z"
              stroke="currentColor"
              strokeWidth="2"
            />
            <path d="M26 2v8h8" stroke="currentColor" strokeWidth="2" />
            <rect x="3" y="26" width="27" height="15" rx="3" fill="#e5484d" />
            <text
              x="16.5"
              y="37"
              textAnchor="middle"
              fontFamily="Arial, sans-serif"
              fontSize="9"
              fontWeight="700"
              fill="#ffffff"
            >
              PDF
            </text>
          </svg>
        </span>
        <span className="pdf-dropzone__primary">
          {file ? file.name : title || "Drag and drop your PDF here"}
        </span>
        <span className="pdf-dropzone__secondary">
          {file ? "Selected locally, not used for AI answers yet." : subtitle || "or click to browse"}
        </span>
      </button>

      <input
        ref={inputRef}
        type="file"
        disabled={disabled}
        accept={PDF_MIME}
        className="pdf-dropzone__input"
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          handleFiles(event.target.files);
          event.target.value = "";
        }}
      />
      {error && <p role="alert" className="subject-modal__error">{error}</p>}
    </>
  );
}
