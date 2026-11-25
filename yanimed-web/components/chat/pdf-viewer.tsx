"use client";

import { useEffect, useRef, useState, useCallback, useImperativeHandle, forwardRef } from "react";
import { ChevronLeft, ChevronRight, Minimize2, Maximize2, X, BookOpen, Loader2, AlertCircle, RefreshCw } from "lucide-react";
import type { ChatCitation } from "@/lib/types";
import { getSubjectDocuments } from "@/lib/backend-api";
import * as pdfjsLib from "pdfjs-dist";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();

interface PDFViewerProps {
  citations: ChatCitation[];
  activeCitationIndex: number;
  onPageChange: (page: number) => void;
  onClose: () => void;
  onToggleExpand: () => void;
  isExpanded: boolean;
  totalPages: number;
  currentPage: number;
  zoom: number;
  onZoomChange: (zoom: number) => void;
  documentId: string;
  subjectId?: string;
}

export interface PDFViewerRef {
  refresh: () => void;
}

export const PDFViewer = forwardRef<PDFViewerRef, PDFViewerProps>(({
  citations,
  activeCitationIndex,
  onPageChange,
  onClose,
  onToggleExpand,
  isExpanded,
  totalPages,
  currentPage,
  zoom,
  onZoomChange,
  documentId,
  subjectId,
}, ref) => {
  const [isLoading, setIsLoading] = useState(true);
  const [pageImageSrc, setPageImageSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sourceUnavailable, setSourceUnavailable] = useState(false);
  const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [actualTotalPages, setActualTotalPages] = useState(totalPages);
  const [fallbackAttempted, setFallbackAttempted] = useState(false);
  const [fallbackLoading, setFallbackLoading] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const activeCitation = citations[activeCitationIndex];
  const targetPageRef = useRef(currentPage);

  const fetchPdfDoc = useCallback(async (docId: string) => {
    try {
      const response = await fetch(`/api/documents/${docId}/file`);
      if (!response.ok) {
        if (response.status === 404) {
          return false;
        }
        throw new Error("Failed to load PDF");
      }
      const arrayBuffer = await response.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      setPdfDoc(pdf);
      setActualTotalPages(pdf.numPages);
      setSourceUnavailable(false);
      return true;
    } catch {
      return false;
    }
  }, []);

  const fetchWithFallback = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    const success = await fetchPdfDoc(documentId);
    const targetPageExceedsPages = targetPageRef.current > actualTotalPages && actualTotalPages > 0;
    
    // Treat as failure if: load failed, OR PDF has 1 page but target page > 1
    if (success && !targetPageExceedsPages) {
      setIsLoading(false);
      return;
    }

    if (subjectId && !fallbackAttempted) {
      setFallbackAttempted(true);
      setFallbackLoading(true);
      try {
        const documents = await getSubjectDocuments(subjectId);
        const readyDocs = documents.filter(d => d.status === 'READY' && (d.pageCount ?? 0) > 0);
        if (readyDocs.length > 0) {
          readyDocs.sort((a, b) => (b.pageCount ?? 0) - (a.pageCount ?? 0));
          for (const doc of readyDocs) {
            const fallbackSuccess = await fetchPdfDoc(doc.documentId);
            if (fallbackSuccess) {
              setFallbackLoading(false);
              setIsLoading(false);
              return;
            }
          }
        }
      } catch {
        // Fallback failed, will show source unavailable
      }
      setFallbackLoading(false);
    }
    setSourceUnavailable(true);
    setIsLoading(false);
  }, [documentId, subjectId, fallbackAttempted, fetchPdfDoc, pdfDoc, actualTotalPages]);

  const renderPage = useCallback(async (page: number) => {
    if (!pdfDoc || page < 1 || page > actualTotalPages) {
      setError("Page out of range");
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const pdfPage = await pdfDoc.getPage(page);
      const scale = zoom / 100;
      const viewport = pdfPage.getViewport({ scale });
      
      const canvas = canvasRef.current;
      if (!canvas) return;
      
      const context = canvas.getContext("2d");
      if (!context) return;
      
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      
      await pdfPage.render({
        canvas,
        viewport,
      }).promise;
      
      setPageImageSrc(canvas.toDataURL());
    } catch {
      setError("Could not render PDF page");
    } finally {
      setIsLoading(false);
    }
  }, [pdfDoc, actualTotalPages, zoom]);

  useEffect(() => {
    if (!pdfDoc) {
      fetchWithFallback();
    }
    return () => {
      if (pageImageSrc) {
        setPageImageSrc(null);
      }
    };
  }, [fetchWithFallback]);

  useEffect(() => {
    if (pdfDoc && currentPage > 0) {
      const clampedPage = Math.min(Math.max(1, currentPage), actualTotalPages);
      if (clampedPage !== currentPage) {
        onPageChange(clampedPage);
      } else {
        renderPage(currentPage);
      }
    }
    // Trigger fallback if we have a PDF but it has <= 1 page and target page > 1
    if (pdfDoc && actualTotalPages <= 1 && targetPageRef.current > 1 && subjectId && !fallbackAttempted) {
      fetchWithFallback();
    }
  }, [currentPage, pdfDoc, zoom, renderPage, actualTotalPages, onPageChange, subjectId, fallbackAttempted, fetchWithFallback]);

  useEffect(() => {
    if (actualTotalPages > 0 && targetPageRef.current > actualTotalPages) {
      onPageChange(actualTotalPages);
    }
    targetPageRef.current = currentPage;
  }, [actualTotalPages, currentPage, onPageChange]);

  // Clamp current page when total pages changes (e.g., after fallback loads multi-page PDF)
  useEffect(() => {
    if (pdfDoc && actualTotalPages > 0 && currentPage > actualTotalPages) {
      onPageChange(actualTotalPages);
    }
  }, [actualTotalPages, currentPage, onPageChange, pdfDoc]);

  useEffect(() => {
    if (activeCitation && activeCitation.page !== currentPage) {
      onPageChange(activeCitation.page);
    }
  }, [activeCitation, currentPage, onPageChange]);

  const handlePrevPage = () => {
    if (currentPage > 1) onPageChange(currentPage - 1);
  };

  const handleNextPage = () => {
    if (currentPage < actualTotalPages) onPageChange(currentPage + 1);
  };

  const handleZoomChange = (newZoom: number) => {
    onZoomChange(newZoom);
  };

  const handleRetry = () => {
    setSourceUnavailable(false);
    setFallbackAttempted(false);
    fetchWithFallback();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowLeft") handlePrevPage();
    if (e.key === "ArrowRight") handleNextPage();
    if (e.key === "Escape") onClose();
  };

  const isMobile = typeof window !== "undefined" && window.innerWidth <= 860;

  useImperativeHandle(ref, () => ({
    refresh: handleRetry,
  }));

  return (
    <div
      ref={containerRef}
      className={`pdf-viewer-pane ${isExpanded ? "pdf-viewer--expanded" : ""} ${isMobile ? "pdf-viewer--mobile" : ""}`}
      onKeyDown={handleKeyDown}
      tabIndex={0}
      role="region"
      aria-label="PDF Viewer"
    >
      <div className="pdf-viewer__toolbar" role="toolbar" aria-label="PDF viewer controls">
        <div className="pdf-viewer__toolbar-left">
          <button
            type="button"
            className="pdf-viewer__nav-btn"
            onClick={handlePrevPage}
            disabled={currentPage <= 1}
            aria-label="Previous page"
            aria-disabled={currentPage <= 1}
          >
            <ChevronLeft size={20} strokeWidth={2.5} aria-hidden="true" />
          </button>
          <span className="pdf-viewer__page-info" aria-live="polite">
            {currentPage} / {actualTotalPages}
          </span>
          <button
            type="button"
            className="pdf-viewer__nav-btn"
            onClick={handleNextPage}
            disabled={currentPage >= actualTotalPages}
            aria-label="Next page"
            aria-disabled={currentPage >= actualTotalPages}
          >
            <ChevronRight size={20} strokeWidth={2.5} aria-hidden="true" />
          </button>
        </div>

        <div className="pdf-viewer__toolbar-center">
          <select
            className="pdf-viewer__zoom-select"
            value={zoom}
            onChange={(e) => handleZoomChange(Number(e.target.value))}
            aria-label="Zoom level"
          >
            <option value={75}>75%</option>
            <option value={100}>100%</option>
            <option value={125}>125%</option>
            <option value={150}>150%</option>
          </select>
        </div>

        <div className="pdf-viewer__toolbar-right">
          {!isMobile && (
            <button
              type="button"
              className="pdf-viewer__expand-btn"
              onClick={onToggleExpand}
              aria-label={isExpanded ? "Collapse PDF viewer" : "Expand PDF viewer"}
              aria-pressed={isExpanded}
            >
              {isExpanded ? (
                <Minimize2 size={20} strokeWidth={2.5} aria-hidden="true" />
              ) : (
                <Maximize2 size={20} strokeWidth={2.5} aria-hidden="true" />
              )}
            </button>
          )}
          <button
            type="button"
            className="pdf-viewer__close-btn"
            onClick={onClose}
            aria-label="Close PDF viewer"
          >
            <X size={20} strokeWidth={2.5} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="pdf-viewer__canvas" role="img" aria-label={`PDF page ${currentPage} of ${actualTotalPages}`}>
        {sourceUnavailable && !fallbackLoading && (
          <div className="pdf-viewer__error" role="alert" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "16px", padding: "24px" }}>
            <AlertCircle size={48} style={{ color: "hsl(var(--destructive))" }} aria-hidden="true" />
            <div style={{ textAlign: "center" }}>
              <p style={{ fontSize: "16px", fontWeight: "500", margin: "0 0 8px" }}>Source Unavailable</p>
              <p style={{ fontSize: "14px", color: "hsl(var(--muted-foreground))", margin: "0 0 16px" }}>
                The referenced source document or page could not be loaded.
              </p>
              <div style={{ display: "flex", gap: "8px" }}>
                <button
                  type="button"
                  className="pdf-viewer__nav-btn"
                  onClick={handleRetry}
                  style={{ width: "auto", height: "auto", padding: "10px 16px", borderRadius: "8px" }}
                >
                  <RefreshCw size={16} strokeWidth={2.5} aria-hidden="true" />
                  <span style={{ marginLeft: "8px" }}>Retry</span>
                </button>
                <button
                  type="button"
                  className="pdf-viewer__nav-btn"
                  onClick={onClose}
                  style={{ width: "auto", height: "auto", padding: "10px 16px", borderRadius: "8px" }}
                >
                  <span>Close</span>
                </button>
              </div>
            </div>
          </div>
        )}
        {!sourceUnavailable && (
          <>
            {(isLoading || fallbackLoading) && (
              <div className="pdf-viewer__loader" aria-live="polite">
                <Loader2 size={32} className="animate-spin" aria-hidden="true" />
                <span className="sr-only">{fallbackLoading ? "Finding alternate source..." : `Loading page ${currentPage}...`}</span>
              </div>
            )}
            {error && (
              <div className="pdf-viewer__error" role="alert">
                {error}
              </div>
            )}
            <canvas
              ref={canvasRef}
              className="pdf-viewer__page"
              style={{ transform: `scale(${zoom / 100})`, transformOrigin: "top center", maxWidth: "820px", width: "100%" }}
            />
            {activeCitation && (
              <div
                className="pdf-viewer__citation-highlight"
                style={{} as React.CSSProperties}
                aria-hidden="true"
              />
            )}
          </>
        )}
      </div>

      <div className="pdf-viewer__citation-info" aria-live="polite">
        <BookOpen size={14} aria-hidden="true" />
        <span>
          {activeCitation?.chapter ? `${activeCitation.chapter} · ` : ""}
          Page {activeCitation?.page ?? currentPage}
        </span>
      </div>
    </div>
  );
});

PDFViewer.displayName = "PDFViewer";