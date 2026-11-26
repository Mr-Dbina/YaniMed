"use client";

import { useEffect, useRef, useState, useCallback, useImperativeHandle, forwardRef } from "react";
import { ChevronLeft, ChevronRight, Minimize2, Maximize2, X, Loader2, AlertCircle, RefreshCw, Minus, Plus } from "lucide-react";
import type { ChatCitation } from "@/lib/types";
import * as pdfjsLib from "pdfjs-dist";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();

export const MIN_ZOOM = 10;
export const MAX_ZOOM = 400;
export const ZOOM_STEP = 10;
const MAX_CANVAS_DIMENSION = 4096;
const MAX_CANVAS_PIXELS = 16_777_216;

export interface PdfPageLayout {
  cssWidth: number;
  cssHeight: number;
  renderScale: number;
  canvasWidth: number;
  canvasHeight: number;
}

export function computePdfPageLayout({
  pageWidth,
  pageHeight,
  availableWidth,
  zoom,
  dpr = 1,
}: {
  pageWidth: number;
  pageHeight: number;
  availableWidth: number;
  zoom: number;
  dpr?: number;
}): PdfPageLayout {
  const safePageWidth = Math.max(1, pageWidth);
  const safePageHeight = Math.max(1, pageHeight);
  const safeAvailableWidth = Math.max(100, availableWidth);
  const safeZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
  const safeDpr = Math.max(1, dpr);

  const fitScale = safeAvailableWidth / safePageWidth;
  const displayScale = fitScale * (safeZoom / 100);
  const cssWidth = safePageWidth * displayScale;
  const cssHeight = safePageHeight * displayScale;

  const idealRenderScale = displayScale * safeDpr;
  const maxScaleByDimension = Math.min(
    MAX_CANVAS_DIMENSION / safePageWidth,
    MAX_CANVAS_DIMENSION / safePageHeight,
  );
  const maxScaleByPixels = Math.sqrt(
    MAX_CANVAS_PIXELS / (safePageWidth * safePageHeight),
  );
  const renderScale = Math.min(idealRenderScale, maxScaleByDimension, maxScaleByPixels);

  return {
    cssWidth,
    cssHeight,
    renderScale,
    canvasWidth: Math.max(1, Math.round(safePageWidth * renderScale)),
    canvasHeight: Math.max(1, Math.round(safePageHeight * renderScale)),
  };
}

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
  const [pageSize, setPageSize] = useState<{ width: number; height: number } | null>(null);
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
  const renderIdRef = useRef(0);
  const lastRenderedWidthRef = useRef(0);

  const renderPage = useCallback(async (page: number) => {
    if (!pdfDoc || page < 1 || page > actualTotalPages) {
      setError("Page out of range");
      return;
    }

    const renderId = ++renderIdRef.current;
    setIsLoading(true);
    setError(null);

    try {
      const activeTask = renderTaskRef.current;
      if (activeTask) {
        try {
          activeTask.cancel();
          await activeTask.promise;
        } catch {}
        if (renderTaskRef.current === activeTask) {
          renderTaskRef.current = null;
        }
        if (renderId !== renderIdRef.current) return;
      }

      const pdfPage = await pdfDoc.getPage(page);
      if (renderId !== renderIdRef.current) return;

      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (!canvas || !container || container.clientWidth <= 0) return;

      lastRenderedWidthRef.current = container.clientWidth;

      const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
      const viewportAt100 = pdfPage.getViewport({ scale: 1 });
      const layout = computePdfPageLayout({
        pageWidth: viewportAt100.width,
        pageHeight: viewportAt100.height,
        availableWidth: container.clientWidth - 48,
        zoom,
        dpr,
      });

      const finalViewport = pdfPage.getViewport({ scale: layout.renderScale });

      canvas.width = layout.canvasWidth;
      canvas.height = layout.canvasHeight;
      canvas.style.width = `${layout.cssWidth}px`;
      canvas.style.height = `${layout.cssHeight}px`;
      setPageSize({ width: layout.cssWidth, height: layout.cssHeight });

      const context = canvas.getContext("2d");
      if (!context) return;

      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);

      const task = pdfPage.render({
        canvas,
        viewport: finalViewport,
      });
      renderTaskRef.current = task;
      await task.promise;
    } catch (e) {
      if (e instanceof Error && e.name === "RenderingCancelledException") {
        return;
      }
      if (renderId === renderIdRef.current) {
        setError("Could not render PDF page");
      }
    } finally {
      if (renderId === renderIdRef.current) {
        setIsLoading(false);
        renderTaskRef.current = null;
      }
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

  const renderPageRef = useRef(renderPage);
  renderPageRef.current = renderPage;
  const currentPageRef = useRef(currentPage);
  currentPageRef.current = currentPage;

  useEffect(() => {
    loadDocument();
    return () => {
      renderIdRef.current += 1;
      if (renderTaskRef.current) {
        try {
          renderTaskRef.current.cancel();
        } catch {}
        renderTaskRef.current = null;
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
  }, [currentPage, pdfDoc, zoom, isExpanded, renderPage, actualTotalPages, onPageChange]);

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
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.target.clientWidth ?? containerRef.current?.clientWidth ?? 0;
      if (width <= 0 || width === lastRenderedWidthRef.current) return;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        void renderPageRef.current(currentPageRef.current);
      }, 100);
    });
    observer.observe(containerRef.current);
    return () => {
      observer.disconnect();
      clearTimeout(resizeTimer);
    };
  }, [pdfDoc]);

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

  const handleZoomOut = () => {
    onZoomChange(Math.max(MIN_ZOOM, zoom - ZOOM_STEP));
  };

  const handleZoomIn = () => {
    onZoomChange(Math.min(MAX_ZOOM, zoom + ZOOM_STEP));
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

  const pageLabel = actualTotalPages > 0 ? `${currentPage} of ${actualTotalPages}` : `Page ${currentPage}`;

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
          <div className="pdf-viewer__page-control" role="group" aria-label="Page navigation">
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
            <span className="pdf-viewer__page-text" aria-live="polite">
              {pageLabel}
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
        </div>

        <div className="pdf-viewer__toolbar-center">
          <div className="pdf-viewer__zoom-control" role="group" aria-label="Zoom controls">
            <button
              type="button"
              className="pdf-viewer__zoom-btn"
              onClick={handleZoomOut}
              disabled={zoom <= MIN_ZOOM}
              aria-label="Zoom out"
              aria-disabled={zoom <= MIN_ZOOM}
            >
              <Minus size={18} strokeWidth={2.5} aria-hidden="true" />
            </button>
            <span className="pdf-viewer__zoom-text" aria-live="polite">
              {zoom}%
            </span>
            <button
              type="button"
              className="pdf-viewer__zoom-btn"
              onClick={handleZoomIn}
              disabled={zoom >= MAX_ZOOM}
              aria-label="Zoom in"
              aria-disabled={zoom >= MAX_ZOOM}
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

      <div
        className="pdf-viewer__canvas"
        role="img"
        aria-label={actualTotalPages > 0 ? `PDF page ${currentPage} of ${actualTotalPages}` : `PDF page ${currentPage}`}
      >
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
              style={pageSize ? { width: `${pageSize.width}px`, height: `${pageSize.height}px` } : undefined}
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