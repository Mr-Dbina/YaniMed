"use client";

import { useEffect, useRef, useState } from "react";
import {
  getDocumentStatus,
  getSubjectDocuments,
  retryDocument,
  type BackendDocument,
  type BackendDocumentStatus,
  type DocumentProcessingStatus,
} from "@/lib/backend-api";

const STATUS_POLL_INTERVAL_MS = 15_000;

const STATUS_LABELS: Record<DocumentProcessingStatus, string> = {
  QUEUED: "Queued",
  PROCESSING: "Processing",
  READY: "Ready",
  FAILED: "Failed",
};

interface SubjectDocumentsProps {
  subjectId: string;
  refreshToken: number;
}

function isTerminalStatus(status: DocumentProcessingStatus): boolean {
  return status === "READY" || status === "FAILED";
}

function DocumentRow({ item }: { item: BackendDocument }) {
  const [status, setStatus] = useState<DocumentProcessingStatus>(item.status);
  const [details, setDetails] = useState<BackendDocumentStatus | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const retryingRef = useRef(false);
  const didInitialFetch = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const documentId = item.documentId;
    const terminal = isTerminalStatus(status);

    const poll = async () => {
      if (cancelled || inFlight || document.hidden) return;
      inFlight = true;
      try {
        const next = await getDocumentStatus(documentId);
        if (cancelled) return;
        setStatus(next.status);
        setDetails(next);
        setPollError(null);
      } catch (err) {
        if (cancelled) return;
        setPollError(err instanceof Error ? err.message : "Could not check status.");
      } finally {
        inFlight = false;
      }
    };

    const runVisiblePoll = () => {
      if (document.hidden) return;
      didInitialFetch.current = true;
      void poll();
    };

    if (terminal) {
      if (!didInitialFetch.current) {
        if (document.hidden) {
          const onFirstVisible = () => {
            if (document.hidden) return;
            document.removeEventListener("visibilitychange", onFirstVisible);
            runVisiblePoll();
          };
          document.addEventListener("visibilitychange", onFirstVisible);
          return () => {
            cancelled = true;
            document.removeEventListener("visibilitychange", onFirstVisible);
          };
        }
        runVisiblePoll();
      }
      return () => {
        cancelled = true;
      };
    }

    if (!didInitialFetch.current) runVisiblePoll();

    const timer = setInterval(() => {
      void poll();
    }, STATUS_POLL_INTERVAL_MS);
    document.addEventListener("visibilitychange", runVisiblePoll);

    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", runVisiblePoll);
    };
  }, [item.documentId, status]);

  const retry = async () => {
    if (retryingRef.current) return;
    retryingRef.current = true;
    setRetrying(true);
    setRetryError(null);

    try {
      const result = await retryDocument(item.documentId);
      didInitialFetch.current = false;
      setStatus(result.status);
      setDetails({
        ...item,
        status: result.status,
        readyForRetrieval: false,
        retryAllowed: false,
        retryUnavailableReason: "RETRY_IN_PROGRESS",
        failure: null,
      });
      setPollError(null);
    } catch (err) {
      setRetryError(err instanceof Error ? err.message : "Could not retry processing. Please try again.");
    } finally {
      retryingRef.current = false;
      setRetrying(false);
    }
  };

  return (
    <li>
      <p><strong>{item.filename}</strong></p>
      <p aria-live="polite">{STATUS_LABELS[status]}</p>
      {status === "FAILED" && details?.failure?.message && <p>{details.failure.message}</p>}
      {status === "FAILED" && details?.retryAllowed === true && (
        <button type="button" disabled={retrying} onClick={() => void retry()}>
          {retrying ? "Retrying..." : "Retry processing"}
        </button>
      )}
      {retryError && <p role="alert">{retryError}</p>}
      {pollError && <p role="status">Could not check status. {pollError}</p>}
    </li>
  );
}

export function SubjectDocuments({ subjectId, refreshToken }: SubjectDocumentsProps) {
  const [documents, setDocuments] = useState<BackendDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <section className="subject-processing" aria-label="Documents">
      <h2>Documents</h2>
      {loading && documents.length === 0 && <p>Loading documents...</p>}
      {error && <p role="alert">{error}</p>}
      {!loading && !error && documents.length === 0 && <p>No documents yet.</p>}
      {documents.length > 0 && (
        <ul>
          {documents.map((document) => (
            <DocumentRow key={document.documentId} item={document} />
          ))}
        </ul>
      )}
    </section>
  );
}
