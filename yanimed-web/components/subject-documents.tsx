"use client";

import { useCallback, useEffect, useState } from "react";
import {
  getDocumentStatus,
  getSubjectDocuments,
  retryDocument,
  type BackendDocument,
  type BackendDocumentStatus,
  type DocumentProcessingStatus,
} from "@/lib/backend-api";

const STATUS_POLL_INTERVAL_MS = 15_000;

export interface SubjectDocumentsSummary {
  loading: boolean;
  error: boolean;
  documentCount: number;
  hasReady: boolean;
}

interface SubjectDocumentsProps {
  subjectId: string;
  refreshToken: number;
  onSummary?: (summary: SubjectDocumentsSummary) => void;
}

function isTerminalStatus(status: DocumentProcessingStatus): boolean {
  return status === "READY" || status === "FAILED";
}

export function SubjectDocuments({ subjectId, refreshToken, onSummary }: SubjectDocumentsProps) {
  const [documents, setDocuments] = useState<BackendDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<Record<string, DocumentProcessingStatus>>({});
  const [details, setDetails] = useState<Record<string, BackendDocumentStatus>>({});
  const [pollError, setPollError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  const statusOf = useCallback(
    (item: BackendDocument) => statuses[item.documentId] ?? item.status,
    [statuses],
  );

  const reportSummary = useCallback(
    (next: SubjectDocumentsSummary) => onSummary?.(next),
    [onSummary],
  );

  useEffect(() => {
    reportSummary({
      loading,
      error: Boolean(error),
      documentCount: documents.length,
      hasReady: documents.some((document) => statusOf(document) === "READY"),
    });
  }, [documents, statuses, loading, error, statusOf, reportSummary]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const next = await getSubjectDocuments(subjectId);
        if (!cancelled) {
          setDocuments(next);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Could not load documents. Please try again.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [subjectId, refreshToken]);

  // Poll non-terminal documents (and failures still missing details) until done.
  useEffect(() => {
    const needsPoll = documents.some((item) => !isTerminalStatus(statusOf(item)));
    const needsDetail = documents.some(
      (item) => statusOf(item) === "FAILED" && !details[item.documentId],
    );
    if (!needsPoll && !needsDetail) return undefined;

    let cancelled = false;
    let inFlight = false;

    const poll = async () => {
      if (cancelled || inFlight || document.hidden) return;
      inFlight = true;
      try {
        for (const item of documents) {
          const status = statusOf(item);
          const missingDetail = status === "FAILED" && !details[item.documentId];
          if (isTerminalStatus(status) && !missingDetail) continue;
          const next = await getDocumentStatus(item.documentId);
          if (cancelled) return;
          setStatuses((current) =>
            current[item.documentId] === next.status
              ? current
              : { ...current, [item.documentId]: next.status },
          );
          setDetails((current) =>
            current[item.documentId] === next ? current : { ...current, [item.documentId]: next },
          );
        }
        setPollError(null);
      } catch (err) {
        if (!cancelled) {
          setPollError(err instanceof Error ? err.message : "Could not check status.");
        }
      } finally {
        inFlight = false;
      }
    };

    void poll();
    const timer = setInterval(() => void poll(), STATUS_POLL_INTERVAL_MS);
    const runVisiblePoll = () => {
      if (!document.hidden) void poll();
    };
    document.addEventListener("visibilitychange", runVisiblePoll);

    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", runVisiblePoll);
    };
  }, [documents, statuses, details, statusOf]);

  const retry = async (documentId: string) => {
    if (retrying) return;
    setRetrying(true);
    setRetryError(null);
    try {
      const result = await retryDocument(documentId);
      setStatuses((current) => ({ ...current, [documentId]: result.status }));
      setDetails((current) => {
        const next = { ...current };
        delete next[documentId];
        return next;
      });
    } catch (err) {
      setRetryError(err instanceof Error ? err.message : "Could not retry processing. Please try again.");
    } finally {
      setRetrying(false);
    }
  };

  if (loading && documents.length === 0) return null;

  const active = documents.filter((item) => {
    const status = statusOf(item);
    return status === "QUEUED" || status === "PROCESSING" || status === "FAILED";
  });
  const processingCount = active.filter((item) => {
    const status = statusOf(item);
    return status === "QUEUED" || status === "PROCESSING";
  }).length;
  const failed = active.filter((item) => statusOf(item) === "FAILED");

  if (!error && !pollError && active.length === 0) return null;

  return (
    <div className="subject-docstatus" role="status">
      {processingCount > 0 && (
        <span>
          {processingCount === 1
            ? "Processing PDF…"
            : `Processing ${processingCount} PDFs…`}
        </span>
      )}
      {failed.map((item) => (
        <span key={item.documentId} className="subject-docstatus__failed">
          {item.filename}: processing failed.
          {details[item.documentId]?.retryAllowed === true && (
            <button type="button" disabled={retrying} onClick={() => void retry(item.documentId)}>
              {retrying ? "Retrying…" : "Retry"}
            </button>
          )}
        </span>
      ))}
      {error && <span>{error}</span>}
      {pollError && <span>{pollError}</span>}
      {retryError && <span role="alert">{retryError}</span>}
    </div>
  );
}
