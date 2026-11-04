import type { Subject } from "@/lib/types";

interface ProcessingPresentation {
  title: string;
  detail: string;
  retrySync?: boolean;
}

function uploadPresentation(subject: Subject): ProcessingPresentation {
  switch (subject.syncError?.kind) {
    case "name_conflict":
      // Renaming changes only the local label; the frozen upload name still
      // determines retry identity.
      return { title: "Upload needs attention", detail: subject.syncError.message };
    case "duplicate_pdf":
      return { title: "Upload needs attention", detail: subject.syncError.message };
    case "key_conflict":
      return { title: "Upload needs attention", detail: subject.syncError.message };
    case "network":
      return { title: "Upload not finished", detail: "Could not reach the server.", retrySync: true };
    case "rejected":
      return { title: "Upload not finished", detail: subject.syncError.message, retrySync: true };
  }

  switch (subject.uploadStatus) {
    case "PENDING":
    case "UPLOADING":
      return { title: "Uploading to server...", detail: "Your subject is saved in this browser. Keep this tab open while the PDF uploads." };
    case "AWAITING_RETRY":
      return { title: "Upload not finished", detail: "The PDF is saved in this browser. Retry the upload to finish syncing.", retrySync: true };
    case "CLEANUP_PENDING":
      return { title: "Finishing up on the server", detail: "No action needed. The server will finish cleaning up this upload." };
    case "UPLOADED":
      return {
        title: "Uploaded - waiting to be processed",
        detail: subject.documentId
          ? "The PDF is on the server. See the documents below for live processing status."
          : "The PDF is on the server. Live processing status is not available yet.",
      };
    default:
      return { title: "Uploading to server...", detail: "Your subject is saved in this browser." };
  }
}

/** Local saved status is not authoritative; backend documents use the live status view. */
export function processingPresentation(subject: Subject): ProcessingPresentation {
  if (subject.idempotencyKey) return uploadPresentation(subject);

  switch (subject.processingStatus) {
    case "processing":
      return { title: "Processing status unavailable", detail: "Processing was previously recorded. Live progress cannot be checked until the PDF processing service is connected." };
    case "failed":
      return { title: "PDF processing failed", detail: subject.processingError || "Your subject and PDF are preserved. Processing can be retried once the server processing service is available." };
    case "ready":
      return { title: "Index verification required", detail: "A saved ready status is not proof of indexing. Chat stays disabled until the server verifies this PDF and grounded answering is available." };
    default:
      return { title: "Saved locally · not processed", detail: "Your subject and PDF are saved in this browser, not uploaded or indexed. PDF processing is not available yet." };
  }
}
