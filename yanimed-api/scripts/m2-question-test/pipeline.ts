import type { PrismaClient } from '@prisma/client';
import { AiCallError, AiCapReachedError, StallWatchdogError, type AiClient } from './ai.js';
import { mergeSmallClusters, kmeans } from './clustering.js';
import { findActiveSubject, loadChunks, loadPages, loadReadyDocuments } from './db.js';
import { draftMessages, topicNameMessages, verifyMessages } from './prompts.js';
import {
  balancedLetters,
  classifyChunk,
  cosine,
  countSentences,
  distinctChoices,
  extractJsonObject,
  fuzzyQuoteSimilarity,
  isBannedChoice,
  mean,
  normalizeObjective,
  percentile,
  placeholderTopicName,
  round4,
  seedFromString,
  mulberry32,
} from './text.js';
import type {
  ChunkRow,
  Citation,
  Cluster,
  DocumentRow,
  Draft,
  EmbeddedChunk,
  GateResult,
  Letter,
  Metrics,
  PageRow,
  Question,
  RejectionCounts,
  SeedChunk,
  Slot,
  SubjectRow,
  Topic,
} from './types.js';
import { LETTERS } from './types.js';

// Spec 1: fixed gates.
const MIN_ELIGIBLE_CHUNKS = 60;
const MIN_DISTINCT_PAGES = 40;
const REQUESTED_TOPICS = 20;
const MIN_TOPICS = 17;
const TOTAL_SLOTS = 50;
const DEFAULT_TOPIC_CAP = 3;
const MAX_DRAFT_ATTEMPTS = 3;
const MAX_REPLACEMENTS = 5;
const DUPLICATE_THRESHOLD = 0.9;

export interface LoadedSubject {
  subject: SubjectRow;
  documents: DocumentRow[];
  chunks: ChunkRow[];
  pages: PageRow[];
  pageMap: Map<string, PageRow>;
}

export interface EligibilityReport {
  gate: GateResult;
  exclusions: Record<string, number>;
  eligible: EmbeddedChunk[];
}

export interface PlannedTopics {
  topics: Topic[];
  perTopicCap: number;
  raisedCap: boolean;
}

export interface DraftAttempt {
  ok: true;
  question: Question;
}

export interface DraftRejection {
  ok: false;
  layer: 'A' | 'B' | 'C';
  reason: string;
}

export type DraftOutcome = DraftAttempt | DraftRejection;

function pageKey(documentId: string, page: number): string {
  return `${documentId}:${page}`;
}

// Keep the failure type, status and redacted body in the slot reason,
// so a resumed checkpoint shows why the call actually failed.
function describeCallFailure(error: unknown): string {
  if (error instanceof AiCallError) return error.describe();
  return error instanceof Error ? error.message : String(error);
}

export async function loadSubject(prisma: PrismaClient, name: string): Promise<LoadedSubject> {
  const subject = await findActiveSubject(prisma, name);
  const documents = await loadReadyDocuments(prisma, subject.id);
  const chunks = await loadChunks(prisma, subject.id);
  const pages = await loadPages(prisma, subject.id);
  const pageMap = new Map<string, PageRow>();
  for (const page of pages) pageMap.set(pageKey(page.documentId, page.pageNumber), page);
  return { subject, documents, chunks, pages, pageMap };
}

// Spec 1: gate plus exclusion report. Missing vectors cannot be clustered, so
// they are excluded and reported rather than being counted as usable.
export function evaluateGate(chunks: ChunkRow[]): EligibilityReport {
  const exclusions: Record<string, number> = {};
  const eligible: EmbeddedChunk[] = [];
  const pages = new Set<string>();

  for (const chunk of chunks) {
    const verdict = classifyChunk(chunk.content);
    if (!verdict.eligible) {
      const reason = verdict.reason ?? 'unknown';
      exclusions[reason] = (exclusions[reason] ?? 0) + 1;
      continue;
    }
    if (chunk.embedding.length === 0) {
      exclusions['missing-embedding'] = (exclusions['missing-embedding'] ?? 0) + 1;
      continue;
    }
    eligible.push({ chunk, vector: chunk.embedding });
    pages.add(pageKey(chunk.documentId, chunk.page));
  }

  const gate: GateResult = {
    eligibleChunks: eligible.length,
    distinctPages: pages.size,
    minChunks: MIN_ELIGIBLE_CHUNKS,
    minPages: MIN_DISTINCT_PAGES,
    passes: eligible.length >= MIN_ELIGIBLE_CHUNKS && pages.size >= MIN_DISTINCT_PAGES,
    exclusions,
  };
  return { gate, exclusions, eligible };
}

function clusterToTopic(cluster: Cluster, name: string): Topic {
  return {
    id: cluster.id,
    name,
    members: cluster.members.map(member => member.chunk),
    centroid: cluster.centroid,
  };
}

// Spec 2: seeded k-means, merge small clusters, report when fewer than 17 topics.
export function planTopics(eligible: EmbeddedChunk[], subjectId: string): PlannedTopics {
  const rng = mulberry32(seedFromString(`m2:${subjectId}`));
  const clusters = mergeSmallClusters(kmeans(eligible, REQUESTED_TOPICS, rng), 3);
  const topics = clusters.map((cluster, index) =>
    clusterToTopic(cluster, placeholderTopicName(cluster.members[0]?.chunk.content ?? '')),
  );

  const perTopicCap =
    topics.length >= MIN_TOPICS ? DEFAULT_TOPIC_CAP : Math.ceil(TOTAL_SLOTS / Math.max(1, topics.length));
  return { topics, perTopicCap, raisedCap: topics.length < MIN_TOPICS };
}

export async function nameTopics(ai: AiClient, topics: Topic[]): Promise<void> {
  for (const topic of topics) {
    const samples = topic.members.slice(0, 3).map(member => ({
      page: member.page,
      text: member.content.slice(0, 1200),
    }));
    const raw = await ai.chat(topicNameMessages(samples), 'topic', {
      temperature: 0.2,
      verifier: false,
      slotNumber: `topic-${topic.id + 1}`,
    });
    const name = raw.trim().replace(/^["'`]+|["'`]+$/g, '').replace(/\s+/g, ' ').slice(0, 80);
    if (!name) throw new Error(`Topic naming returned an empty name for cluster ${topic.id + 1}.`);
    topic.name = name;
  }
}

function sortChunks(chunks: ChunkRow[]): ChunkRow[] {
  return [...chunks].sort(
    (a, b) =>
      a.documentId.localeCompare(b.documentId) ||
      a.page - b.page ||
      a.chunkIndex - b.chunkIndex,
  );
}

function toSeed(chunk: ChunkRow): SeedChunk {
  return {
    chunkId: chunk.id,
    documentId: chunk.documentId,
    documentTitle: chunk.documentTitle,
    page: chunk.page,
    chunkIndex: chunk.chunkIndex,
    text: chunk.content,
  };
}

// Spec 3: proportional allocation with a hard per-topic cap, then adjacent seeds.
export function allocateSlots(topics: Topic[], perTopicCap: number): Slot[] {
  const quotas = new Map<number, number>();
  for (const topic of topics) quotas.set(topic.id, 0);

  for (let slot = 0; slot < TOTAL_SLOTS; slot++) {
    let bestTopic: Topic | null = null;
    let bestPriority = -Infinity;
    for (const topic of topics) {
      const assigned = quotas.get(topic.id) ?? 0;
      const capacity = Math.min(perTopicCap, topic.members.length);
      if (assigned >= capacity) continue;
      const priority = topic.members.length / (assigned + 1);
      if (priority > bestPriority) {
        bestPriority = priority;
        bestTopic = topic;
      }
    }
    if (!bestTopic) break;
    quotas.set(bestTopic.id, (quotas.get(bestTopic.id) ?? 0) + 1);
  }

  const rng = mulberry32(seedFromString(`letters:${topics.map(topic => topic.id).join(',')}`));
  const letters = balancedLetters(TOTAL_SLOTS, rng);
  const slots: Slot[] = [];

  for (const topic of topics) {
    const quota = quotas.get(topic.id) ?? 0;
    if (quota === 0) continue;
    const members = sortChunks(topic.members);

    for (let index = 0; index < quota; index++) {
      const windowSize = 1 + (index % 3);
      let start = Math.floor((index * members.length) / quota);
      start = Math.min(start, Math.max(0, members.length - windowSize));
      const seeds: SeedChunk[] = [];
      for (let offset = 0; offset < windowSize && start + offset < members.length; offset++) {
        const current = members[start + offset];
        if (offset > 0) {
          const previous = members[start + offset - 1];
          if (current.documentId !== previous.documentId || current.chunkIndex !== previous.chunkIndex + 1) {
            break;
          }
        }
        seeds.push(toSeed(current));
      }
      if (seeds.length === 0) seeds.push(toSeed(members[start]));

      const slotIndex = slots.length;
      slots.push({
        slotIndex,
        topicId: topic.id,
        topicName: topic.name,
        letter: letters[slotIndex] ?? 'A',
        seedChunks: seeds,
      });
    }
  }

  return slots.map((slot, index) => ({ ...slot, slotIndex: index }));
}

function choicesWithKey(
  key: Letter,
  correctAnswer: string,
  distractors: string[],
): Record<Letter, string> {
  const choices = {} as Record<Letter, string>;
  let distractorIndex = 0;
  for (const letter of LETTERS) {
    choices[letter] = letter === key ? correctAnswer : distractors[distractorIndex++];
  }
  return choices;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

interface ParsedDraft {
  draft: Draft;
  citationPage: number;
  quote: string;
}

function parseDraft(raw: string): ParsedDraft {
  const parsed = JSON.parse(extractJsonObject(raw)) as Record<string, unknown>;
  const citation = parsed.citation as Record<string, unknown> | undefined;
  const distractors = parsed.distractors;
  const distractorExplanations = parsed.distractorExplanations;

  const draft: Draft = {
    vignette: asString(parsed.vignette) ?? '',
    leadIn: asString(parsed.leadIn) ?? '',
    correctAnswer: asString(parsed.correctAnswer) ?? '',
    distractors: Array.isArray(distractors) ? distractors.map(value => asString(value) ?? '') : [],
    educationalObjective: asString(parsed.educationalObjective) ?? '',
    keyExplanation: asString(parsed.keyExplanation) ?? '',
    distractorExplanations: Array.isArray(distractorExplanations)
      ? distractorExplanations.map(value => asString(value) ?? '')
      : [],
    topic: asString(parsed.topic) ?? '',
    citation: {
      page: typeof citation?.page === 'number' ? citation.page : Number.NaN,
      quote: typeof citation?.quote === 'string' ? citation.quote.trim() : '',
    },
  };

  return { draft, citationPage: draft.citation.page, quote: draft.citation.quote };
}

function checkA(
  parsed: ParsedDraft,
  slot: Slot,
  pageMap: Map<string, PageRow>,
): { ok: true; citation: Citation } | { ok: false; reason: string } {
  const { draft, citationPage, quote } = parsed;

  if (
    !draft.vignette ||
    !draft.leadIn ||
    !draft.correctAnswer ||
    draft.distractors.length !== 3 ||
    draft.distractors.some(value => !value) ||
    !draft.educationalObjective ||
    !draft.keyExplanation ||
    !draft.topic ||
    draft.distractorExplanations.length !== 3 ||
    draft.distractorExplanations.some(value => !value) ||
    !quote ||
    !Number.isInteger(citationPage)
  ) {
    return { ok: false, reason: 'schema' };
  }

  if (countSentences(draft.vignette) !== 5) return { ok: false, reason: 'vignette-sentences' };

  const choices = [draft.correctAnswer, ...draft.distractors];
  if (!distinctChoices(choices)) return { ok: false, reason: 'duplicate-choices' };
  if (choices.some(isBannedChoice)) return { ok: false, reason: 'banned-choice' };

  const seedPages = new Set(slot.seedChunks.map(seed => `${seed.documentId}:${seed.page}`));
  const seed = slot.seedChunks.find(candidate => candidate.page === citationPage);
  if (!seed) return { ok: false, reason: 'page-not-seed' };
  if (!seedPages.has(pageKey(seed.documentId, citationPage))) {
    return { ok: false, reason: 'page-not-seed' };
  }

  const page = pageMap.get(pageKey(seed.documentId, citationPage));
  if (!page) return { ok: false, reason: 'page-missing' };

  const similarity = fuzzyQuoteSimilarity(page.text, quote);
  if (similarity < 0.9) return { ok: false, reason: 'quote-mismatch' };

  return {
    ok: true,
    citation: {
      documentId: seed.documentId,
      documentTitle: seed.documentTitle,
      page: citationPage,
      quote,
    },
  };
}

interface VerifierResult {
  choices: Record<string, { status: string; quote: string }>;
  flags: string[];
}

function parseVerifier(raw: string): VerifierResult {
  const parsed = JSON.parse(extractJsonObject(raw)) as Record<string, unknown>;
  const rawChoices = (parsed.choices ?? {}) as Record<string, unknown>;
  const choices: Record<string, { status: string; quote: string }> = {};
  for (const letter of LETTERS) {
    const entry = rawChoices[letter] as Record<string, unknown> | undefined;
    choices[letter] = {
      status: typeof entry?.status === 'string' ? entry.status : '',
      quote: typeof entry?.quote === 'string' ? entry.quote : '',
    };
  }
  const flags = Array.isArray(parsed.flags)
    ? parsed.flags.filter((flag): flag is string => typeof flag === 'string')
    : ['INVALID_FLAGS'];
  return { choices, flags };
}

// Spec 6: verifier sees only page text, vignette, lead-in and choices.
async function checkB(
  ai: AiClient,
  pageText: string,
  draft: Draft,
  choices: Record<Letter, string>,
  key: Letter,
  slotIndex?: number,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let raw: string;
  try {
    raw = await ai.chat(
      verifyMessages({
        pageText,
        vignette: draft.vignette,
        leadIn: draft.leadIn,
        choices,
      }),
      'verify',
      { temperature: 0, verifier: true, slotNumber: slotIndex !== undefined ? slotIndex + 1 : 'n/a' },
    );
  } catch (error) {
    if (error instanceof AiCapReachedError || error instanceof StallWatchdogError) throw error;
    return { ok: false, reason: `verifier-call-failed (${describeCallFailure(error)})` };
  }

  let result: VerifierResult;
  try {
    result = parseVerifier(raw);
  } catch {
    return { ok: false, reason: 'invalid-verifier-json' };
  }

  const statuses = LETTERS.map(letter => result.choices[letter]?.status ?? '');
  const validStatuses = new Set(['SUPPORTED', 'CONTRADICTED', 'NOT_ADDRESSED']);
  if (statuses.some(status => !validStatuses.has(status))) {
    return { ok: false, reason: 'invalid-verifier-status' };
  }
  if (result.choices[key].status !== 'SUPPORTED') return { ok: false, reason: 'key-not-supported' };
  if (!result.choices[key].quote.trim()) return { ok: false, reason: 'missing-support-quote' };

  const otherSupported = LETTERS.filter(letter => letter !== key && result.choices[letter].status === 'SUPPORTED');
  if (otherSupported.length > 0) return { ok: false, reason: 'multiple-supported' };

  for (const flag of result.flags) {
    if (flag === 'AMBIGUOUS' || flag === 'NEEDS_OUTSIDE_KNOWLEDGE') {
      return { ok: false, reason: `flag:${flag}` };
    }
    return { ok: false, reason: 'invalid-verifier-flag' };
  }

  return { ok: true };
}

// Spec 7: semantic duplicate check and same-topic objective check.
async function checkC(
  ai: AiClient,
  draft: Draft,
  slot: Slot,
  accepted: Question[],
): Promise<{ ok: true; vector: number[] } | { ok: false; reason: string }> {
  const objective = normalizeObjective(draft.educationalObjective);
  for (const question of accepted) {
    if (question.topic === slot.topicName && normalizeObjective(question.educationalObjective) === objective) {
      return { ok: false, reason: 'duplicate-objective' };
    }
  }

  let vector: number[];
  try {
    vector = await ai.embed(`${draft.vignette}\n${draft.leadIn}`, slot.slotIndex + 1);
  } catch (error) {
    if (error instanceof AiCapReachedError || error instanceof StallWatchdogError) throw error;
    return { ok: false, reason: `embedding-call-failed (${describeCallFailure(error)})` };
  }

  const highest = accepted.reduce((best, question) => Math.max(best, cosine(vector, question.vector)), 0);
  if (highest >= DUPLICATE_THRESHOLD) return { ok: false, reason: 'duplicate-embedding' };

  return { ok: true, vector };
}

function incrementRejection(
  rejections: RejectionCounts,
  layer: 'A' | 'B' | 'C' | 'D',
  reason: string,
): void {
  rejections[layer][reason] = (rejections[layer][reason] ?? 0) + 1;
}

export function emptyRejections(): RejectionCounts {
  return { A: {}, B: {}, C: {}, D: {} };
}

export interface AttemptContext {
  ai: AiClient;
  pageMap: Map<string, PageRow>;
  accepted: Question[];
  rejections: RejectionCounts;
}

export async function attemptSlot(slot: Slot, context: AttemptContext): Promise<DraftOutcome> {
  const seedBlocks = slot.seedChunks.map(seed => ({ page: seed.page, text: seed.text }));
  const attemptReasons: string[] = [];

  for (let attempt = 0; attempt < MAX_DRAFT_ATTEMPTS; attempt++) {
    let raw: string;
    try {
      raw = await context.ai.chat(draftMessages(slot, seedBlocks), 'draft', {
        temperature: 0.3,
        verifier: false,
        slotNumber: slot.slotIndex + 1,
      });
    } catch (error) {
      if (error instanceof AiCapReachedError || error instanceof StallWatchdogError) throw error;
      const reason = `draft-call-failed (${describeCallFailure(error)})`;
      incrementRejection(context.rejections, 'A', reason);
      attemptReasons.push(reason);
      continue;
    }

    let parsed: ParsedDraft;
    try {
      parsed = parseDraft(raw);
    } catch {
      // Spec 4: an unparseable draft is a rejected draft.
      incrementRejection(context.rejections, 'A', 'invalid-json');
      attemptReasons.push('invalid-json');
      continue;
    }

    const checkedA = checkA(parsed, slot, context.pageMap);
    if (!checkedA.ok) {
      incrementRejection(context.rejections, 'A', checkedA.reason);
      attemptReasons.push(checkedA.reason);
      continue;
    }

    const choices = choicesWithKey(slot.letter, parsed.draft.correctAnswer, parsed.draft.distractors);
    const page = context.pageMap.get(pageKey(checkedA.citation.documentId, checkedA.citation.page))!;

    const checkedB = await checkB(context.ai, page.text, parsed.draft, choices, slot.letter, slot.slotIndex);
    if (!checkedB.ok) {
      incrementRejection(context.rejections, 'B', checkedB.reason);
      attemptReasons.push(checkedB.reason);
      continue;
    }

    const comparison = context.accepted.filter(question => question.slotIndex !== slot.slotIndex);
    const checkedC = await checkC(context.ai, parsed.draft, slot, comparison);
    if (!checkedC.ok) {
      incrementRejection(context.rejections, 'C', checkedC.reason);
      attemptReasons.push(checkedC.reason);
      continue;
    }

    const question: Question = {
      id: context.accepted.length + 1,
      slotIndex: slot.slotIndex,
      topic: slot.topicName,
      vignette: parsed.draft.vignette,
      leadIn: parsed.draft.leadIn,
      choices,
      key: slot.letter,
      correctAnswer: parsed.draft.correctAnswer,
      educationalObjective: parsed.draft.educationalObjective,
      keyExplanation: parsed.draft.keyExplanation,
      distractorExplanations: parsed.draft.distractorExplanations,
      citation: checkedA.citation,
      seedPages: [...new Set(slot.seedChunks.map(seed => seed.page))],
      quoteSimilarity: fuzzyQuoteSimilarity(page.text, parsed.draft.citation.quote),
      vector: checkedC.vector,
    };

    return { ok: true, question };
  }

  const uniqueReasons = [...new Set(attemptReasons)];
  return {
    ok: false,
    layer: 'A',
    reason: `draft-attempts-exhausted${uniqueReasons.length > 0 ? ` (${uniqueReasons.join(', ')})` : ''}`,
  };
}

export interface CheckDIssue {
  slotIndex: number;
  reason: string;
}

// Spec 8: post-set integrity check.
export function checkD(
  questions: Question[],
  perTopicCap: number,
  minDistinctTopics: number,
  pageMap: Map<string, PageRow>,
): CheckDIssue[] {
  const issues: CheckDIssue[] = [];
  const seen = new Map<string, number>();
  const topicCounts = new Map<string, number>();
  const letterCounts: Record<Letter, number> = { A: 0, B: 0, C: 0, D: 0 };

  for (const question of questions) {
    letterCounts[question.key] += 1;
    topicCounts.set(question.topic, (topicCounts.get(question.topic) ?? 0) + 1);

    const fingerprint = normalizeObjective(`${question.vignette} ${question.leadIn}`);
    if (seen.has(fingerprint)) {
      issues.push({ slotIndex: question.slotIndex, reason: 'duplicate-question' });
    } else {
      seen.set(fingerprint, question.slotIndex);
    }

    const page = pageMap.get(pageKey(question.citation.documentId, question.citation.page));
    if (
      !page ||
      !question.seedPages.includes(question.citation.page) ||
      fuzzyQuoteSimilarity(page.text, question.citation.quote) < 0.9
    ) {
      issues.push({ slotIndex: question.slotIndex, reason: 'invalid-citation' });
    }
  }

  for (const [topic, count] of topicCounts) {
    if (count > perTopicCap) {
      const offenders = questions.filter(question => question.topic === topic).slice(perTopicCap);
      for (const offender of offenders) {
        issues.push({ slotIndex: offender.slotIndex, reason: 'topic-cap' });
      }
    }
  }

  if (topicCounts.size < minDistinctTopics) {
    issues.push({ slotIndex: -1, reason: 'too-few-topics' });
  }

  for (const letter of LETTERS) {
    if (letterCounts[letter] < 10 || letterCounts[letter] > 15) {
      issues.push({ slotIndex: -1, reason: `letter-count-${letter}` });
    }
  }

  if (questions.length !== TOTAL_SLOTS) {
    issues.push({ slotIndex: -1, reason: `question-count-${questions.length}` });
  }

  for (let i = 0; i < questions.length; i++) {
    for (let j = i + 1; j < questions.length; j++) {
      if (cosine(questions[i].vector, questions[j].vector) >= DUPLICATE_THRESHOLD) {
        issues.push({ slotIndex: questions[j].slotIndex, reason: 'duplicate-embedding-pair' });
      }
    }
  }

  return issues;
}

export function similarityStats(questions: Question[]): { max: number | null; p95: number | null; mean: number | null } {
  const values: number[] = [];
  for (let i = 0; i < questions.length; i++) {
    for (let j = i + 1; j < questions.length; j++) {
      values.push(cosine(questions[i].vector, questions[j].vector));
    }
  }
  return {
    max: round4(values.length > 0 ? Math.max(...values) : null),
    p95: round4(percentile(values, 95)),
    mean: round4(mean(values)),
  };
}

export function buildMetrics(input: {
  loaded: LoadedSubject;
  gate: GateResult;
  topics: Topic[];
  slots: Slot[];
  perTopicCap: number;
  accepted: Question[];
  rejections: RejectionCounts;
  ai: AiClient;
  ocrSeedUsed: boolean;
  runTimeMs: number;
  incompleteReason: string | null;
  resumes: number;
}): Metrics {
  const usage = input.ai.getUsage();
  const letters: Record<Letter, number> = { A: 0, B: 0, C: 0, D: 0 };
  for (const question of input.accepted) letters[question.key] += 1;

  return {
    subject: { id: input.loaded.subject.id, name: input.loaded.subject.name },
    documents: input.loaded.documents.map(document => ({
      id: document.id,
      title: document.title,
      pageCount: document.pageCount,
      embeddedChunks: document.embeddedChunks,
    })),
    gate: input.gate,
    topics: input.topics.map(topic => ({
      id: topic.id,
      name: topic.name,
      size: topic.members.length,
    })),
    slots: {
      total: input.slots.length,
      perTopicCap: input.perTopicCap,
      minDistinctTopics: MIN_TOPICS,
    },
    accepted: input.accepted.length,
    rejections: input.rejections,
    aiCalls: {
      total: usage.total,
      chat: usage.chat,
      embedding: usage.embedding,
      byPurpose: usage.byPurpose,
    },
    callsPerAcceptedQuestion:
      input.accepted.length > 0 ? round4(usage.total / input.accepted.length) : null,
    similarity: similarityStats(input.accepted),
    failureDetails: input.ai.getFailureDetails(),
    failureCounts: input.ai.getFailureCounts(),
    resumes: input.resumes,
    answerLetters: letters,
    verifierMode: input.ai.getVerifierMode(),
    ocrSeedUsed: input.ocrSeedUsed,
    runTimeMs: input.runTimeMs,
    incompleteReason: input.incompleteReason,
  };
}

export function seedsFromOcr(slots: Slot[], loaded: LoadedSubject, questions: Question[]): boolean {
  for (const question of questions) {
    const slot = slots.find(candidate => candidate.slotIndex === question.slotIndex);
    if (!slot) continue;
    for (const seed of slot.seedChunks) {
      const chunk = loaded.chunks.find(candidate => candidate.id === seed.chunkId);
      const page = loaded.pageMap.get(pageKey(seed.documentId, seed.page));
      if (chunk && chunk.extractionMethod !== 'TEXT') return true;
      if (page && (page.ocrUsed || page.extractionMethod !== 'TEXT')) return true;
    }
  }
  return false;
}

export function distributeSlotSummary(slots: Slot[]): Array<{ topic: string; slots: number; seeds: number }> {
  const summary = new Map<string, { topic: string; slots: number; seeds: number }>();
  for (const slot of slots) {
    const current = summary.get(slot.topicName) ?? { topic: slot.topicName, slots: 0, seeds: 0 };
    current.slots += 1;
    current.seeds += slot.seedChunks.length;
    summary.set(slot.topicName, current);
  }
  return [...summary.values()];
}

export { TOTAL_SLOTS, MIN_TOPICS };
