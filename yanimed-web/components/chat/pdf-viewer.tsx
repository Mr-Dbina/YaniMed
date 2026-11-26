"use client";

import { useEffect, useRef, useState, useCallback, useImperativeHandle, forwardRef } from "react";
import { ChevronLeft, ChevronRight, Minimize2, Maximize2, X, BookOpen, Loader2, AlertCircle, RefreshCw, Minus, Plus } from "lucide-react";
import type { ChatCitation } from "@/lib/types";
import * as pdfjsLib from "pdfjs-dist";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();

interface PDFViewerProps {
  citations: ChatCitation[];
  activeCitationIndex: number;
  onPageChange: (page: number) => void;
  onClose: () => void;
  onToggleExpand: () => void;
  isExpanded: boolean;
  currentPage: number;
  zoom: number;
  onZoomChange: (zoom: number) => void;
  documentId: string;
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
  currentPage,
  zoom,
  onZoomChange,
  documentId,
}, ref) => {
  const [isLoading, setIsLoading] = useState(true);
  const [pageImageSrc, setPageImageSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sourceUnavailable, setSourceUnavailable] = useState(false);
  const [noDocumentId, setNoDocumentId] = useState(false);
  const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [actualTotalPages, setActualTotalPages] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const activeCitation = citations[activeCitationIndex];
  const targetPageRef = useRef(currentPage);
  const userNavigatingRef = useRef(false);

  const renderTaskRef = useRef<pdfjsLib.RenderTask | null>(null);

  const renderPage = useCallback(async (page: number) => {
    if (!pdfDoc || page < 1 || page > actualTotalPages) {
      setError("Page out of range");
      return;
    }
    if (renderTaskRef.current) {
      try { renderTaskRef.current.cancel(); } catch {}
      renderTaskRef.current = null;
    }
    setIsLoading(true);
    setError(null);
    try {
      const pdfPage = await pdfDoc.getPage(page);
      const dpr = typeof window !== "undefined" ? window.devicePixelRatio : 1;
      const baseScale = zoom / 100;
      const canvas = canvasRef.current;
      if (!canvas) return;

      const container = containerRef.current;
      if (!container) return;

      const containerWidth = container.clientWidth - 48;
      const viewportAt100 = pdfPage.getViewport({ scale: 1 });
      const fitScaleAt100 = containerWidth / viewportAt100.width;
      const finalScale = Math.min(baseScale, fitScaleAt100) * dpr;
      const finalViewport = pdfPage.getViewport({ scale: finalScale });

      canvas.width = finalViewport.width;
      canvas.height = finalViewport.height;
      canvas.style.width = `${finalViewport.width / dpr}px`;
      canvas.style.height = `${finalViewport.height / dpr}px`;

      const context = canvas.getContext("2d");
      if (!context) return;

      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);

      renderTaskRef.current = pdfPage.render({
        canvas,
        viewport: finalViewport,
      });
      await renderTaskRef.current.promise;

      setPageImageSrc(canvas.toDataURL());
    } catch (e) {
      if (e instanceof Error && e.name === "RenderingCancelledException") {
        return;
      }
      setError("Could not render PDF page");
    } finally {
      setIsLoading(false);
      renderTaskRef.current = null;
    }
  }, [pdfDoc, actualTotalPages, zoom]);

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

  const loadDocument = useCallback(async () => {
    if (!documentId) {
      setNoDocumentId(true);
      setSourceUnavailable(true);
      setIsLoading(false);
      return;
    }
    setNoDocumentId(false);
    setIsLoading(true);
    setError(null);
    const success = await fetchPdfDoc(documentId);
    if (success) {
      setIsLoading(false);
    } else {
      setSourceUnavailable(true);
      setIsLoading(false);
    }
  }, [documentId, fetchPdfDoc]);

  useEffect(() => {
    loadDocument();
    return () => {
      if (pageImageSrc) {
        setPageImageSrc(null);
      }
    };
  }, [loadDocument]);

  useEffect(() => {
    if (pdfDoc && currentPage > 0) {
      const clampedPage = Math.min(Math.max(1, currentPage), actualTotalPages);
      if (clampedPage !== currentPage) {
        onPageChange(clampedPage);
      } else {
        renderPage(currentPage);
      }
    }
  }, [currentPage, pdfDoc, zoom, renderPage, actualTotalPages, onPageChange]);

  useEffect(() => {
    if (actualTotalPages > 0 && targetPageRef.current > actualTotalPages) {
      onPageChange(actualTotalPages);
    }
    targetPageRef.current = currentPage;
  }, [actualTotalPages, currentPage, onPageChange]);

  useEffect(() => {
    if (activeCitation && activeCitation.page !== currentPage && !userNavigatingRef.current) {
      onPageChange(activeCitation.page);
    }
    userNavigatingRef.current = false;
  }, [activeCitation, currentPage, onPageChange]);

  useEffect(() => {
    if (!pdfDoc || !containerRef.current) return;
    let resizeTimer: ReturnType<typeof setTimeout>;
    const handleResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => renderPage(currentPage), 100);
    };
    const observer = new ResizeObserver(handleResize);
    observer.observe(containerRef.current);
    return () => {
      observer.disconnect();
      clearTimeout(resizeTimer);
    };
  }, [pdfDoc, currentPage, renderPage]);

  const handlePrevPage = () => {
    if (currentPage > 1) {
      userNavigatingRef.current = true;
      onPageChange(currentPage - 1);
    }
  };

  const handleNextPage = () => {
    if (currentPage < actualTotalPages) {
      userNavigatingRef.current = true;
      onPageChange(currentPage + 1);
    }
  };

  const handleZoomChange = (newZoom: number) => {
    onZoomChange(newZoom);
  };

  const handleZoomOut = () => {
    handleZoomChange(Math.max(10, zoom - 10));
  };

  const handleZoomIn = () => {
    handleZoomChange(Math.min(400, zoom + 10));
  };

  const zoomInputRef = useRef<HTMLInputElement>(null);
  const zoomInputValueRef = useRef<string | number>(zoom);
  const isEditingZoomRef = useRef(false);

  const pageInputRef = useRef<HTMLInputElement>(null);
  const pageInputValueRef = useRef<string | number>(currentPage);
  const isEditingPageRef = useRef(false);

  const handleZoomInputFocus = () => {
    isEditingZoomRef.current = true;
    zoomInputValueRef.current = zoom;
    setTimeout(() => zoomInputRef.current?.select(), 0);
  };

  const handleZoomInputBlur = () => {
    isEditingZoomRef.current = false;
    const value = parseInt(zoomInputValueRef.current.toString().replace('%', ''), 10);
    if (!isNaN(value)) {
      handleZoomChange(Math.min(400, Math.max(10, value)));
    } else {
      zoomInputRef.current?.focus();
    }
  };

  const handleZoomInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      handleZoomInputBlur();
      e.currentTarget.blur();
    } else if (e.key === "Escape") {
      e.stopPropagation();
      zoomInputValueRef.current = zoom;
      e.currentTarget.value = `${zoom}%`;
      e.currentTarget.blur();
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.stopPropagation();
    }
  };

  const handleZoomInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    zoomInputValueRef.current = e.target.value;
  };

  const handlePageInputFocus = () => {
    isEditingPageRef.current = true;
    pageInputValueRef.current = currentPage;
    pageInputRef.current?.select();
  };

  const handlePageInputBlur = () => {
    isEditingPageRef.current = false;
    const value = parseInt(pageInputValueRef.current.toString(), 10);
    if (!isNaN(value) && actualTotalPages > 0) {
      const clamped = Math.min(Math.max(1, value), actualTotalPages);
      onPageChange(clamped);
    } else if (!isNaN(value)) {
      onPageChange(Math.max(1, value));
    } else {
      pageInputRef.current?.focus();
    }
  };

  const handlePageInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      handlePageInputBlur();
      e.currentTarget.blur();
    } else if (e.key === "Escape") {
      e.stopPropagation();
      pageInputValueRef.current = currentPage;
      e.currentTarget.value = String(currentPage);
      e.currentTarget.blur();
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.stopPropagation();
    }
  };

  const handlePageInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    pageInputValueRef.current = e.target.value;
  };

  const handleRetry = () => {
    setSourceUnavailable(false);
    loadDocument();
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
          <div className="pdf-viewer__page-control" role="group" aria-label="Page navigation">
            <input
              ref={pageInputRef}
              type="text"
              className="pdf-viewer__page-input"
              value={isEditingPageRef.current ? pageInputValueRef.current : currentPage}
              onChange={handlePageInputChange}
              onFocus={handlePageInputFocus}
              onBlur={handlePageInputBlur}
              onKeyDown={handlePageInputKeyDown}
              aria-label="Page number"
              aria-valuemin={1}
              aria-valuemax={actualTotalPages || 1}
              aria-valuenow={currentPage}
              spellCheck={false}
              inputMode="numeric"
              disabled={actualTotalPages === 0}
            />
            <span className="pdf-viewer__page-sep" aria-hidden="true">of {actualTotalPages}</span>
          </div>
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
          <div className="pdf-viewer__zoom-control" role="group" aria-label="Zoom controls">
            <button
              type="button"
              className="pdf-viewer__zoom-btn"
              onClick={handleZoomOut}
              disabled={zoom <= 10}
              aria-label="Zoom out"
              aria-disabled={zoom <= 10}
            >
              <Minus size={18} strokeWidth={2.5} aria-hidden="true" />
            </button>
            <input
              ref={zoomInputRef}
              type="text"
              className="pdf-viewer__zoom-input"
              value={`${zoom}%`}
              onChange={handleZoomInputChange}
              onFocus={handleZoomInputFocus}
              onBlur={handleZoomInputBlur}
              onKeyDown={handleZoomInputKeyDown}
              aria-label="Zoom percentage"
              aria-valuemin={10}
              aria-valuemax={400}
              aria-valuenow={zoom}
              spellCheck={false}
              inputMode="numeric"
            />
            <button
              type="button"
              className="pdf-viewer__zoom-btn"
              onClick={handleZoomIn}
              disabled={zoom >= 400}
              aria-label="Zoom in"
              aria-disabled={zoom >= 400}
            >
              <Plus size={18} strokeWidth={2.5} aria-hidden="true" />
            </button>
          </div>
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
        {(sourceUnavailable || noDocumentId) && !isLoading && (
          <div className="pdf-viewer__error" role="alert" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "16px", padding: "24px" }}>
            <AlertCircle size={48} style={{ color: "hsl(var(--destructive))" }} aria-hidden="true" />
            <div style={{ textAlign: "center" }}>
              <p style={{ fontSize: "16px", fontWeight: "500", margin: "0 0 8px" }}>
                {noDocumentId ? "No Source Document" : "Source Unavailable"}
              </p>
              <p style={{ fontSize: "14px", color: "hsl(var(--muted-foreground))", margin: "0 0 16px" }}>
                {noDocumentId
                  ? "This citation does not have a linked source document."
                  : "The referenced source document or page could not be loaded."}
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
        {!sourceUnavailable && !noDocumentId && (
          <>
            {isLoading && (
              <div className="pdf-viewer__loader" aria-live="polite">
                <Loader2 size={32} className="animate-spin" aria-hidden="true" />
                <span className="sr-only">Loading page {currentPage}...</span>
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
              style={{ maxWidth: "none", width: "auto", height: "auto" }}
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
    </div>
  );
});

PDFViewer.displayName = "PDFViewer";