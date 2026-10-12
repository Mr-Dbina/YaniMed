import { useRef, useState } from "react";
import "./PdfDropzone.css";

const PDF_MIME = "application/pdf";

function isPdf(file) {
  return file.type === PDF_MIME;
}

export function PdfDropzone({ file, onFileSelect, title, subtitle }) {
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef(null);

  const handleFiles = (files) => {
    const candidate = files && files[0];
    if (candidate && isPdf(candidate)) onFileSelect(candidate);
  };

  return (
    <>
      <button
        type="button"
        className={`pdf-dropzone${isDragging ? " pdf-dropzone--active" : ""}`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(event) => {
          event.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={(event) => {
          event.preventDefault();
          setIsDragging(false);
        }}
        onDrop={(event) => {
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
          {file ? "PDF ready to upload" : subtitle || "or click to browse"}
        </span>
      </button>

      <input
        ref={inputRef}
        type="file"
        accept={PDF_MIME}
        className="pdf-dropzone__input"
        onChange={(event) => {
          handleFiles(event.target.files);
          event.target.value = "";
        }}
      />
    </>
  );
}
