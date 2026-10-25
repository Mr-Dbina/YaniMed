import type { Subject } from "@/lib/types";

/** No status is authoritative until a real backend document/status API exists. */
export function processingPresentation(subject: Subject) {
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
