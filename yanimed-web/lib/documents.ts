import type { LibraryFile } from "@/lib/format";
import type { Subject } from "@/lib/types";
import { getLibraryDir, listLibraryFiles, summarizeStorage } from "@/lib/library";

export interface DocumentStatus {
  documentId: string;
  subjectId: string;
  filename: string;
  status: "UPLOADED" | "PROCESSING" | "READY" | "FAILED";
}

export async function uploadSubjectPdf(subjectId: string, file: File): Promise<DocumentStatus> {
  const form = new FormData();
  form.append("subjectId", subjectId);
  form.append("file", file, file.name);
  const response = await fetch("http://localhost:3000/documents/upload", { method: "POST", body: form });
  if (!response.ok) throw new Error(await response.text() || "Upload failed");
  return response.json();
}

export async function getSubjectDocuments(subjectId: string): Promise<DocumentStatus[]> {
  const response = await fetch(`/api/documents?subjectId=${encodeURIComponent(subjectId)}`);
  if (!response.ok) throw new Error(await response.text() || "Could not load documents");
  return response.json();
}
