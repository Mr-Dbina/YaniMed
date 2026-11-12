export type MessageRole = "user" | "assistant";

export interface ChatCitation {
  sourceId: string;
  chapter: string | null;
  /** Physical, 1-based PDF page index. */
  page: number;
  snippet?: string;
}

export interface ChatAnswerResponse {
  answer: string;
  citations: ChatCitation[];
  grounding: "ungrounded" | "grounded" | "insufficient_evidence";
  metadata: {
    gateway: "omniroute";
    requestedModel: string;
    servedModel: string | null;
    provider: string | null;
    durationMs: number;
  };
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  citations?: ChatCitation[];
  grounding?: ChatAnswerResponse["grounding"];
  metadata?: ChatAnswerResponse["metadata"];
  rating?: 1 | -1 | null;
  isStreaming?: boolean;
  replyToId?: string;
}

export interface Subject {
  id: string;
  name: string;
  file: File | null;
  instructions: string;
  /**
   * Most recent question asked in this subject, shown under the sidebar row.
   * Undefined until the first question - the row renders without a preview.
   */
  lastMessage?: string;
  /** Browser-local state only until a backend processing API is connected. */
  processingStatus?: "unavailable" | "processing" | "failed" | "ready";
  processingError?: string;
  backendSubjectId?: string;
  /** PDF count reported by the backend for a synced subject. */
  documentCount?: number;
  documentId?: string | null;
  idempotencyKey?: string;
  uploadName?: string;
  uploadStatus?: "PENDING" | "UPLOADING" | "AWAITING_RETRY" | "CLEANUP_PENDING" | "UPLOADED";
  syncError?: {
    kind: "name_conflict" | "duplicate_pdf" | "key_conflict" | "network" | "rejected";
    message: string;
  };
}
