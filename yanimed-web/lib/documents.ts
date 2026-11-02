import type { LibraryFile } from "@/lib/format";
import type { Subject } from "@/lib/types";
import { getLibraryDir, listLibraryFiles, summarizeStorage } from "@/lib/library";
import { API_BASE_URL } from "@/lib/api";

export interface DocumentStatus {
  documentId: string;
  subjectId: string;
  filename: string;
  status: "QUEUED" | "PROCESSING" | "READY" | "FAILED";
}

export class DuplicatePdfError extends Error {
  constructor(
    readonly scope: string,
    readonly existingDocumentId: string,
    readonly existingSubjectId: string,
    readonly existingFilename: string,
    readonly allowedActions: string[],
  ) {
    super("Duplicate PDF");
    this.name = "DuplicatePdfError";
  }
}

interface DuplicatePdfBody {
  code: "DUPLICATE_PDF";
  scope: string;
  existingDocumentId: string;
  existingSubjectId: string;
  existingFilename: string;
  allowedActions: string[];
}

function isDuplicatePdfBody(value: unknown): value is DuplicatePdfBody {
  if (typeof value !== "object" || value === null) return false;
  const body = value as Record<string, unknown>;
  return body.code === "DUPLICATE_PDF"
    && typeof body.scope === "string"
    && typeof body.existingDocumentId === "string"
    && typeof body.existingSubjectId === "string"
    && typeof body.existingFilename === "string"
    && Array.isArray(body.allowedActions)
    && body.allowedActions.every((action) => typeof action === "string");
}

export async function uploadSubjectPdf(
  subjectId: string,
  file: File,
  duplicateAction?: string,
): Promise<DocumentStatus> {
  const form = new FormData();
  form.append("subjectId", subjectId);
  if (duplicateAction !== undefined) form.append("duplicateAction", duplicateAction);
  form.append("file", file, file.name);
  const response = await fetch(`${API_BASE_URL}/documents/upload`, { method: "POST", body: form });
  const text = await response.text();
  if (!response.ok) {
    if (response.status === 409) {
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
      if (isDuplicatePdfBody(body)) {
        throw new DuplicatePdfError(
          body.scope,
          body.existingDocumentId,
          body.existingSubjectId,
          body.existingFilename,
          body.allowedActions,
        );
      }
    }
    throw new Error(text || "Upload failed");
  }
  return JSON.parse(text) as DocumentStatus;
}

export async function getSubjectDocuments(subjectId: string): Promise<DocumentStatus[]> {
  const response = await fetch(`/api/documents?subjectId=${encodeURIComponent(subjectId)}`);
  if (!response.ok) throw new Error(await response.text() || "Could not load documents");
  return response.json();
}
