export type Letter = 'A' | 'B' | 'C' | 'D';

export const LETTERS: Letter[] = ['A', 'B', 'C', 'D'];

export interface SubjectRow {
  id: string;
  name: string;
  status: string;
}

export interface DocumentRow {
  id: string;
  title: string;
  status: string;
  pageCount: number | null;
  embeddedChunks: number;
}

export interface ChunkRow {
  id: string;
  documentId: string;
  documentTitle: string;
  content: string;
  page: number;
  chunkIndex: number;
  embeddingRaw: string | null;
  embedding: number[];
  extractionMethod: string;
  needsReview: boolean;
}

export interface PageRow {
  documentId: string;
  pageNumber: number;
  text: string;
  extractionMethod: string;
  ocrUsed: boolean;
}

export interface EmbeddedChunk {
  chunk: ChunkRow;
  vector: number[];
}

export interface Cluster {
  id: number;
  members: EmbeddedChunk[];
  centroid: number[];
}

export interface Topic {
  id: number;
  name: string;
  members: ChunkRow[];
  centroid: number[];
}

export interface SeedChunk {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  page: number;
  chunkIndex: number;
  text: string;
}

export interface Slot {
  slotIndex: number;
  topicId: number;
  topicName: string;
  letter: Letter;
  seedChunks: SeedChunk[];
}

export interface Citation {
  documentId: string;
  documentTitle: string;
  page: number;
  quote: string;
}

export interface Draft {
  vignette: string;
  leadIn: string;
  correctAnswer: string;
  distractors: string[];
  educationalObjective: string;
  keyExplanation: string;
  distractorExplanations: string[];
  topic: string;
  citation: {
    page: number;
    quote: string;
  };
}

export interface Question {
  id: number;
  slotIndex: number;
  topic: string;
  vignette: string;
  leadIn: string;
  choices: Record<Letter, string>;
  key: Letter;
  correctAnswer: string;
  educationalObjective: string;
  keyExplanation: string;
  distractorExplanations: string[];
  citation: Citation;
  seedPages: number[];
  quoteSimilarity: number;
  vector: number[];
}

export interface GateResult {
  eligibleChunks: number;
  distinctPages: number;
  minChunks: number;
  minPages: number;
  passes: boolean;
  exclusions: Record<string, number>;
}

export interface RejectionCounts {
  A: Record<string, number>;
  B: Record<string, number>;
  C: Record<string, number>;
  D: Record<string, number>;
}

export interface SimilarityStats {
  max: number | null;
  p95: number | null;
  mean: number | null;
}

export interface FailureCounts {
  byStatus: Record<string, number>;
  byType: Record<string, number>;
}

export interface AiCallCounts {
  total: number;
  chat: number;
  embedding: number;
  byPurpose: Record<string, number>;
}

export interface Metrics {
  subject: { id: string; name: string };
  documents: Array<{ id: string; title: string; pageCount: number | null; embeddedChunks: number }>;
  gate: GateResult;
  topics: Array<{ id: number; name: string; size: number }>;
  slots: { total: number; perTopicCap: number; minDistinctTopics: number };
  accepted: number;
  rejections: RejectionCounts;
  aiCalls: AiCallCounts;
  callsPerAcceptedQuestion: number | null;
  similarity: SimilarityStats;
  failureDetails?: Array<{ errorType: string; status: number | null; bodySnippet: string }>;
  failureCounts?: FailureCounts;
  resumes?: number;
  answerLetters: Record<Letter, number>;
  verifierMode: 'dedicated' | 'same-model-fallback';
  ocrSeedUsed: boolean;
  runTimeMs: number;
  incompleteReason: string | null;
}

export interface SlotStatus {
  status: 'accepted' | 'rejected';
  reason?: string;
}

// Version 2 adds slot statuses, cumulative counters and resume bookkeeping.
// Version 1 checkpoints still load because every new field is optional.
export interface Checkpoint {
  version: 1 | 2;
  subject: { id: string; name: string };
  topics: Array<{ id: number; name: string; size: number }>;
  slots: Slot[];
  accepted: Question[];
  completedSlotIndexes: number[];
  slotStatuses?: Record<number, SlotStatus>;
  perTopicCap: number;
  minDistinctTopics: number;
  startedAt: string;
  aiCalls?: AiCallCounts;
  rejections?: RejectionCounts;
  failureCounts?: FailureCounts;
  resumes?: number;
  incompleteReason?: string | null;
}
