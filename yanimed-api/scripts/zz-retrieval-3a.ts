import '../src/config/load-local-env.js';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import {
  EMBEDDING_DIMENSIONS,
  EmbeddingService,
} from '../src/embeddings/embedding.service.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import {
  RetrievalService,
  type RetrievalMatch,
  type RetrievalResult,
} from '../src/retrieval/retrieval.service.js';
import { StorageService } from '../src/storage/storage.service.js';

const PREFIX = 'ZZ-ret-';
const API_BASE = (process.env.API_BASE ?? 'http://localhost:3000').replace(
  /\/+$/,
  '',
);
const CHECK_ONLY = process.argv.includes('--check');
const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MIN = readTimeoutMinutes();
const POLL_TIMEOUT_MS = POLL_TIMEOUT_MIN * 60_000;
const GUARD_WAIT_MS = 61_000;
const PDF_PATH = resolve(readPdfPath());
const RUN_STAMP = Date.now().toString();

const prisma = new PrismaClient();
const embeddings = new EmbeddingService(undefined, {
  requestsPerMinute: 60,
  maxAttempts: 1,
});
const retrieval = new RetrievalService(
  prisma as unknown as PrismaService,
  embeddings,
);

let checks = 0;
let failures = 0;
let pdfBytes = Buffer.alloc(0);
let pdfName = '';
let pdfSha = '';
let storageService: StorageService | null = null;

interface ApiResult {
  status: number;
  body: unknown;
  text: string;
}

interface ChunkRow {
  id: string;
  page: number;
  content: string;
  chunkIndex: number;
}

interface PageRow {
  pageNumber: number;
  ocrUsed: boolean;
  needsOcr: boolean;
}

interface TargetChunk {
  chunk: ChunkRow;
  sentence: string;
  reason: string;
}

function readPdfPath(): string {
  const index = process.argv.indexOf('--pdf');
  if (index !== -1 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return (
    process.env.PDF_PATH ??
    'C:\\Users\\chris\\Downloads\\YaniMed_Test_First_10_Pages.pdf'
  );
}

function readTimeoutMinutes(): number {
  const index = process.argv.indexOf('--timeout-min');
  if (index === -1) return 10;
  const parsed = Number(process.argv[index + 1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
}

function check(name: string, ok: boolean, detail = ''): void {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${detail}`}`);
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function describeError(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function normalizeContent(content: string): string {
  return content.replace(/\s+/g, ' ').trim();
}

function middleSentence(content: string): string | null {
  const words = normalizeContent(content).split(' ').filter(Boolean);
  if (words.length < 12) return null;
  const fragmentWords = Math.min(14, Math.max(8, Math.floor(words.length / 2)));
  const maxStart = words.length - fragmentWords;
  const start = Math.max(0, Math.floor(maxStart / 2));
  return words.slice(start, start + fragmentWords).join(' ');
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function selectTargets(chunks: ChunkRow[], pages: PageRow[]): TargetChunk[] {
  const ocrPages = new Set(
    pages.filter((page) => page.ocrUsed).map((page) => page.pageNumber),
  );
  const eligible = chunks
    .map((chunk) => ({ chunk, sentence: middleSentence(chunk.content) }))
    .filter(
      (entry): entry is { chunk: ChunkRow; sentence: string } =>
        entry.sentence !== null,
    );
  const selected: TargetChunk[] = [];
  const usedChunks = new Set<string>();
  const usedPages = new Set<number>();

  const add = (chunk: ChunkRow, sentence: string, reason: string): void => {
    if (selected.length >= 5 || usedChunks.has(chunk.id)) return;
    selected.push({ chunk, sentence, reason });
    usedChunks.add(chunk.id);
    usedPages.add(chunk.page);
  };

  const ocrCandidate = eligible.find(
    ({ chunk }) =>
      ocrPages.has(chunk.page) &&
      normalizeContent(chunk.content).length >= 80,
  );
  if (ocrCandidate) {
    add(ocrCandidate.chunk, ocrCandidate.sentence, 'OCR-page preference');
  }

  const pageNumbers = [
    ...new Set(eligible.map((entry) => entry.chunk.page)),
  ].sort((a, b) => a - b);
  const desiredPages = [
    pageNumbers[0],
    pageNumbers[Math.floor((pageNumbers.length - 1) / 2)],
    pageNumbers[pageNumbers.length - 1],
  ].filter((page): page is number => typeof page === 'number');

  for (const page of [...new Set(desiredPages)]) {
    if (usedPages.has(page)) continue;
    const candidate = eligible.find(
      (entry) => entry.chunk.page === page && !usedChunks.has(entry.chunk.id),
    );
    if (candidate) {
      add(
        candidate.chunk,
        candidate.sentence,
        'lowest/middle/highest page sample',
      );
    }
  }

  for (const page of pageNumbers) {
    if (selected.length >= 5) break;
    if (usedPages.has(page)) continue;
    const candidate = eligible.find(
      (entry) => entry.chunk.page === page && !usedChunks.has(entry.chunk.id),
    );
    if (candidate) add(candidate.chunk, candidate.sentence, 'additional page');
  }

  return selected;
}

function rareTokenByChunk(chunks: ChunkRow[]): Map<string, string> {
  const tokenChunks = new Map<string, Set<string>>();
  for (const chunk of chunks) {
    const tokens = new Set(
      normalizeContent(chunk.content).toLowerCase().match(/[a-z]{8,}/g) ?? [],
    );
    for (const token of tokens) {
      const owners = tokenChunks.get(token) ?? new Set<string>();
      owners.add(chunk.id);
      tokenChunks.set(token, owners);
    }
  }

  const result = new Map<string, string>();
  for (const chunk of chunks) {
    const tokens = new Set(
      normalizeContent(chunk.content).toLowerCase().match(/[a-z]{8,}/g) ?? [],
    );
    let best = '';
    for (const token of tokens) {
      if ((tokenChunks.get(token)?.size ?? 0) === 1 && token.length > best.length) {
        best = token;
      }
    }
    if (best) result.set(chunk.id, best);
  }
  return result;
}

async function guardedFetch(
  label: string,
  url: string,
  makeInit: () => RequestInit,
): Promise<Response> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(url, makeInit());
    if (response.status !== 429) return response;
    await response.text();
    console.log(
      `  ${label}: HTTP 429; waiting ${GUARD_WAIT_MS / 1_000}s for ChatGuard reset`,
    );
    await sleep(GUARD_WAIT_MS);
  }
  throw new Error(`${label}: ChatGuard kept returning HTTP 429.`);
}

async function apiRequest(
  label: string,
  method: string,
  path: string,
  makeInit: () => RequestInit = () => ({ method }),
): Promise<ApiResult> {
  const response = await guardedFetch(label, `${API_BASE}${path}`, makeInit);
  const bodyText = await response.text();
  let body: unknown = null;
  if (bodyText.length > 0) {
    try {
      body = JSON.parse(bodyText);
    } catch {
      body = bodyText;
    }
  }
  const result = { status: response.status, body, text: bodyText };
  console.log(`  ${label}: HTTP ${result.status} ${json(body)}`);
  return result;
}

async function statusRequest(id: string): Promise<ApiResult> {
  const response = await guardedFetch(
    `status ${id}`,
    `${API_BASE}/documents/${id}/status`,
    () => ({ method: 'GET' }),
  );
  const bodyText = await response.text();
  let body: unknown = null;
  if (bodyText.length > 0) {
    try {
      body = JSON.parse(bodyText);
    } catch {
      body = bodyText;
    }
  }
  return { status: response.status, body, text: bodyText };
}

async function uploadPdf(
  label: string,
  subjectId: string,
): Promise<ApiResult> {
  return apiRequest(label, 'POST', '/documents/upload', () => {
    const form = new FormData();
    form.append('subjectId', subjectId);
    form.append(
      'file',
      new Blob([new Uint8Array(pdfBytes)], { type: 'application/pdf' }),
      pdfName,
    );
    return { method: 'POST', body: form };
  });
}

async function waitForReady(documentId: string): Promise<{
  result: ApiResult | null;
  elapsedMs: number;
  status: string;
}> {
  const startedAt = Date.now();
  const seen = new Set<string>();
  let last: ApiResult | null = null;
  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    const result = await statusRequest(documentId);
    last = result;
    if (result.status !== 200) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    const body = record(result.body);
    const status = text(body.status);
    const key = json({ status, processing: body.processing ?? null });
    if (!seen.has(key)) {
      seen.add(key);
      console.log(
        `  A t=${((Date.now() - startedAt) / 1_000).toFixed(1)}s ${key}`,
      );
    }
    if (status === 'READY' || status === 'FAILED') {
      return { result, elapsedMs: Date.now() - startedAt, status };
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return {
    result: last,
    elapsedMs: Date.now() - startedAt,
    status: text(record(last?.body).status),
  };
}

async function preflight(): Promise<boolean> {
  console.log('0. Preflight');
  let ok = true;

  let dbOk = false;
  try {
    const rows = await prisma.$queryRaw<
      Array<{ ok: number }>
    >`SELECT 1::int AS ok`;
    dbOk = rows[0]?.ok === 1;
    check('DB SELECT 1', dbOk, json(rows));
  } catch (error) {
    check('DB SELECT 1', false, describeError(error));
  }
  if (!dbOk) ok = false;

  try {
    pdfBytes = await readFile(PDF_PATH);
    pdfName = basename(PDF_PATH);
    pdfSha = createHash('sha256').update(pdfBytes).digest('hex');
    console.log(`  PDF: ${PDF_PATH}`);
    console.log(`  bytes=${pdfBytes.length} sha256=${pdfSha}`);
    check(
      'PDF file has bytes',
      pdfBytes.length > 0,
      `bytes=${pdfBytes.length}`,
    );
    check(
      'PDF signature is %PDF-',
      pdfBytes.subarray(0, 5).toString('latin1') === '%PDF-',
      pdfBytes.subarray(0, 8).toString('hex'),
    );
  } catch (error) {
    check('PDF file is readable', false, describeError(error));
    ok = false;
  }

  if (dbOk && pdfSha.length > 0) {
    try {
      const existing = await prisma.pdfObject.findFirst({
        where: { sha256: pdfSha },
        select: { id: true, r2Key: true },
      });
      check(
        'PDF SHA-256 is not already present as a PdfObject',
        existing === null,
        json(existing),
      );
      if (existing) ok = false;
    } catch (error) {
      check(
        'PDF SHA-256 is not already present as a PdfObject',
        false,
        describeError(error),
      );
      ok = false;
    }
  }

  if (dbOk) {
    try {
      const stale = await prisma.subject.findMany({
        where: { name: { startsWith: PREFIX } },
        select: { id: true, name: true },
        orderBy: { createdAt: 'asc' },
      });
      check(
        `No existing ${PREFIX} Subject`,
        stale.length === 0,
        json(stale),
      );
      if (stale.length > 0) {
        console.log(
          `  Run: npx tsx scripts/zz-cleanup-retrieval.ts --apply  (current matches: ${stale.length})`,
        );
        ok = false;
      }
    } catch (error) {
      check(`No existing ${PREFIX} Subject`, false, describeError(error));
      ok = false;
    }
  }

  try {
    storageService = new StorageService({
      get: (key: string) =>
        (
          ({
            r2AccountId: process.env.R2_ACCOUNT_ID,
            r2AccessKeyId: process.env.R2_ACCESS_KEY_ID,
            r2SecretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
            r2Endpoint: process.env.R2_ENDPOINT,
            r2BucketName: process.env.R2_BUCKET_NAME,
            r2Jurisdiction: process.env.R2_JURISDICTION,
          }) as Record<string, string | undefined>
        )[key],
    } as unknown as ConfigService);
    storageService.onModuleInit();
    check(
      'R2 storage is configured',
      storageService.isAvailable(),
      'isAvailable() === false',
    );
    if (storageService.isAvailable()) {
      const probeKey = `${PREFIX}probe/${randomUUID()}.pdf`;
      const probe = await storageService.inspectReservedPdf(probeKey);
      check('R2 read-only HEAD probe succeeds', probe === null, json(probe));
    } else {
      ok = false;
    }
  } catch (error) {
    check('R2 read-only HEAD probe succeeds', false, describeError(error));
    ok = false;
  }

  try {
    const vector = await embeddings.embedText(
      'YaniMed retrieval 3a embedding connectivity probe.',
    );
    console.log(`  Gemini embedding vector length: ${vector.length}`);
    check(
      'Gemini embedding returns expected dimensions',
      vector.length === EMBEDDING_DIMENSIONS,
      `length=${vector.length} expected=${EMBEDDING_DIMENSIONS}`,
    );
  } catch (error) {
    check('Gemini embedding connectivity', false, describeError(error));
    ok = false;
  }

  try {
    const response = await fetch(`${API_BASE}/`);
    const body = await response.text();
    console.log(`  API root: HTTP ${response.status} ${body.slice(0, 200)}`);
    check(
      'API root is reachable',
      response.status === 200,
      `HTTP ${response.status}`,
    );
  } catch (error) {
    check('API root is reachable', false, describeError(error));
    ok = false;
  }

  return ok;
}

async function expectForbidden(
  label: string,
  work: () => Promise<unknown>,
  expectedMessage: string,
): Promise<void> {
  try {
    await work();
    check(label, false, 'did not throw');
  } catch (error) {
    check(
      label,
      error instanceof ForbiddenException && error.message === expectedMessage,
      `${describeError(error)} expected=${expectedMessage}`,
    );
  }
}

async function main(): Promise<void> {
  console.log(`ZZ-ret retrieval 3a (API ${API_BASE}, prefix ${PREFIX})`);
  console.log(`Polling timeout: ${POLL_TIMEOUT_MIN} min per Document`);
  if (!(await preflight())) {
    console.log('PREFLIGHT FAILED: aborting before any Subject is created.');
    return;
  }
  if (CHECK_ONLY) {
    console.log(
      'PREFLIGHT OK: --check requested; no Subjects or Documents created.',
    );
    return;
  }

  console.log('\nR1. Create Subjects, upload to A, and poll READY');
  const subjectA = await prisma.subject.create({
    data: { name: `${PREFIX}${RUN_STAMP}-A` },
    select: { id: true, name: true },
  });
  const subjectB = await prisma.subject.create({
    data: { name: `${PREFIX}${RUN_STAMP}-B` },
    select: { id: true, name: true },
  });
  console.log(`  Subject A: ${subjectA.name} (${subjectA.id})`);
  console.log(`  Subject B: ${subjectB.name} (${subjectB.id})`);
  check('R1 Subject A is ready', subjectA.id.length > 0);
  check('R1 Subject B is empty and ready', subjectB.id.length > 0);

  const upload = await uploadPdf('R1 A upload', subjectA.id);
  const uploadBody = record(upload.body);
  check(
    'R1 upload HTTP 201',
    upload.status === 201,
    `got ${upload.status} ${json(uploadBody)}`,
  );
  const documentId = text(uploadBody.documentId);
  check(
    'R1 upload returns A documentId',
    documentId.length > 0 && uploadBody.subjectId === subjectA.id,
    json(uploadBody),
  );
  if (!documentId) throw new Error('R1 upload did not return a Document id.');

  const readyPoll = await waitForReady(documentId);
  console.log(
    `  A elapsed=${(readyPoll.elapsedMs / 1_000).toFixed(1)}s status=${readyPoll.status}`,
  );
  check(
    'R1 A Document status READY',
    readyPoll.status === 'READY',
    `status=${readyPoll.status}`,
  );

  const document = await prisma.document.findUnique({
    where: { id: documentId },
    select: {
      id: true,
      subjectId: true,
      status: true,
      pageCount: true,
      pdfObjectId: true,
      processedPages: true,
    },
  });
  check(
    'R1 A Document is persisted as READY',
    document?.status === 'READY' && document.subjectId === subjectA.id,
    json(document),
  );
  const pageCount = document?.pageCount ?? 0;
  check('R1 A Document pageCount is positive', pageCount > 0, `pageCount=${pageCount}`);

  console.log('\nR2. Discover Chunks and DocumentPages for A');
  const chunks = await prisma.chunk.findMany({
    where: { documentId },
    select: { id: true, page: true, content: true, chunkIndex: true },
    orderBy: [{ chunkIndex: 'asc' }, { id: 'asc' }],
  });
  const pages = await prisma.documentPage.findMany({
    where: { documentId },
    select: { pageNumber: true, ocrUsed: true, needsOcr: true },
    orderBy: { pageNumber: 'asc' },
  });
  const pagesWithChunks = [...new Set(chunks.map((chunk) => chunk.page))].sort(
    (a, b) => a - b,
  );
  const ocrPages = pages
    .filter((page) => page.ocrUsed)
    .map((page) => page.pageNumber);
  const needsOcrPages = pages
    .filter((page) => page.needsOcr)
    .map((page) => page.pageNumber);
  console.log(`  chunks=${chunks.length}`);
  console.log(`  pagesWithChunks=${json(pagesWithChunks)}`);
  console.log(`  ocrUsedPages=${json(ocrPages)}`);
  console.log(`  needsOcrPages=${json(needsOcrPages)}`);
  check('R2 Document has Chunks', chunks.length > 0, `chunks=${chunks.length}`);
  check('R2 Document has DocumentPages', pages.length > 0, `pages=${pages.length}`);

  const targets = selectTargets(chunks, pages);
  check(
    'R2 selected at least one target chunk',
    targets.length > 0,
    `chunks=${chunks.length}`,
  );
  if (targets.length === 0) {
    throw new Error('R2 selected no eligible target chunks.');
  }
  console.log(`  targets=${targets.length}`);
  for (const [index, target] of targets.entries()) {
    console.log(
      `  target ${index + 1}: chunkId=${target.chunk.id} page=${target.chunk.page} reason=${target.reason} words=${target.sentence.split(' ').length} query="${target.sentence}"`,
    );
  }

  console.log('\nR3. Retrieval for each target query');
  const r3TopScores: number[] = [];
  const r3Matches: RetrievalMatch[] = [];
  for (const [index, target] of targets.entries()) {
    const label = `R3 query ${index + 1}`;
    const result = await retrieval.retrieve(subjectA.id, target.sentence, {
      topK: 5,
    });
    r3Matches.push(...result.matches);
    const topScore = result.matches[0]?.score ?? 0;
    r3TopScores.push(topScore);
    const targetIndex = result.matches.findIndex(
      (match) => match.chunkId === target.chunk.id,
    );
    const targetMatch = targetIndex === -1 ? null : result.matches[targetIndex];
    console.log(
      `  ${label} targetRank=${targetIndex === -1 ? 'not in top 5' : targetIndex + 1} targetScore=${targetMatch ? targetMatch.score.toFixed(6) : 'n/a'} topScore=${topScore.toFixed(6)}`,
    );
    console.log(
      `  ${label} top5: ${result.matches.map((match) => `${match.chunkId}/p${match.pageNumber}/${match.score.toFixed(6)}`).join(' | ')}`,
    );
    check(
      `${label} has matches`,
      result.matches.length > 0,
      `matches=${result.matches.length}`,
    );
    check(
      `${label} hasReadyDocuments`,
      result.hasReadyDocuments === true,
      `hasReadyDocuments=${json(result.hasReadyDocuments)}`,
    );
    check(
      `${label} every match documentId is A`,
      result.matches.every((match) => match.documentId === documentId),
      json(result.matches.map((match) => match.documentId)),
    );
    check(
      `${label} every pageNumber is within 1..pageCount`,
      pageCount > 0 &&
        result.matches.every(
          (match) => match.pageNumber >= 1 && match.pageNumber <= pageCount,
        ),
      json({
        pageCount,
        pages: result.matches.map((match) => match.pageNumber),
      }),
    );
    check(
      `${label} target chunk is in top 3`,
      targetIndex >= 0 && targetIndex < 3,
      `targetRank=${targetIndex === -1 ? 'not in top 5' : targetIndex + 1}`,
    );
    check(
      `${label} top score >= 0.5 (hypothesis)`,
      topScore >= 0.5,
      `topScore=${topScore.toFixed(6)}`,
    );
  }

  console.log('\nR4. Physical-page proof');
  const allChunkIds = [...new Set(r3Matches.map((match) => match.chunkId))];
  const dbChunks = await prisma.chunk.findMany({
    where: { id: { in: allChunkIds } },
    select: { id: true, documentId: true, page: true },
  });
  const chunkById = new Map(dbChunks.map((chunk) => [chunk.id, chunk]));
  for (const match of r3Matches) {
    const dbChunk = chunkById.get(match.chunkId);
    check(
      `R4 ${match.chunkId} page matches Chunk.page`,
      dbChunk?.documentId === match.documentId &&
        dbChunk?.page === match.pageNumber,
      json({ match, dbChunk }),
    );
    const page = await prisma.documentPage.findUnique({
      where: {
        documentId_pageNumber: {
          documentId: match.documentId,
          pageNumber: match.pageNumber,
        },
      },
      select: { id: true },
    });
    check(
      `R4 ${match.chunkId} DocumentPage exists`,
      page !== null,
      json({ documentId: match.documentId, pageNumber: match.pageNumber }),
    );
  }
  for (const target of targets) {
    const dbChunk = chunkById.get(target.chunk.id);
    const page = await prisma.documentPage.findUnique({
      where: {
        documentId_pageNumber: {
          documentId,
          pageNumber: target.chunk.page,
        },
      },
      select: { id: true },
    });
    check(
      `R4 target ${target.chunk.id} source page ${target.chunk.page} matches Chunk and DocumentPage`,
      dbChunk?.page === target.chunk.page && page !== null,
      json({ targetChunk: target.chunk, dbChunk, page }),
    );
  }

  console.log('\nR5. Nonsense and off-topic queries');
  const nonsense = await retrieval.retrieve(
    subjectA.id,
    'zzqx vlorp blenthic quarmo frindle',
    { topK: 5 },
  );
  const offTopic = await retrieval.retrieve(
    subjectA.id,
    'How do I bake sourdough bread at home?',
    { topK: 5 },
  );
  const nonsenseTop = nonsense.matches[0]?.score ?? 0;
  const offTopicTop = offTopic.matches[0]?.score ?? 0;
  const r3MedianTop = median(r3TopScores);
  console.log(
    `  nonsense topScore=${nonsenseTop.toFixed(6)} matches=${nonsense.matches.length}`,
  );
  console.log(
    `  off-topic topScore=${offTopicTop.toFixed(6)} matches=${offTopic.matches.length}`,
  );
  console.log(`  R3 median topScore=${r3MedianTop.toFixed(6)}`);
  check(
    'R5 nonsense top score < R3 median top score',
    nonsenseTop < r3MedianTop,
    `nonsense=${nonsenseTop.toFixed(6)} median=${r3MedianTop.toFixed(6)}`,
  );
  check(
    'R5 off-topic top score < R3 median top score',
    offTopicTop < r3MedianTop,
    `offTopic=${offTopicTop.toFixed(6)} median=${r3MedianTop.toFixed(6)}`,
  );

  console.log('\nR6. Empty Subject B');
  try {
    const empty = await retrieval.retrieve(
      subjectB.id,
      'What does the uploaded PDF say?',
      { topK: 5 },
    );
    check(
      'R6 B hasReadyDocuments false',
      empty.hasReadyDocuments === false,
      json(empty),
    );
    check('R6 B matches empty', empty.matches.length === 0, json(empty));
  } catch (error) {
    check('R6 B returns without throwing', false, describeError(error));
  }

  console.log('\nR7. Forbidden inputs');
  await expectForbidden(
    'R7 unknown Subject throws ForbiddenException',
    () =>
      retrieval.retrieve(randomUUID(), 'What does the PDF say?', { topK: 5 }),
    'Subject is not accessible.',
  );
  await expectForbidden(
    'R7 blank question throws ForbiddenException',
    () => retrieval.retrieve(subjectA.id, '   ', { topK: 5 }),
    'A question is required.',
  );

  console.log('\nR8. READY filter');
  const r8Query = targets[0].sentence;
  let blocked: RetrievalResult | null = null;
  try {
    await prisma.document.update({
      where: { id: documentId },
      data: { status: 'PROCESSING' },
    });
    blocked = await retrieval.retrieve(subjectA.id, r8Query, { topK: 5 });
  } finally {
    await prisma.document.update({
      where: { id: documentId },
      data: { status: 'READY' },
    });
  }
  check(
    'R8 PROCESSING Document is excluded',
    blocked !== null &&
      blocked.hasReadyDocuments === false &&
      blocked.matches.length === 0,
    json(blocked),
  );
  const restored = await retrieval.retrieve(subjectA.id, r8Query, {
    topK: 5,
  });
  check(
    'R8 restored READY Document is searchable',
    restored.hasReadyDocuments === true && restored.matches.length > 0,
    json({
      hasReadyDocuments: restored.hasReadyDocuments,
      matches: restored.matches.length,
    }),
  );

  console.log('\nR9. topK clamp');
  const topKZero = await retrieval.retrieve(subjectA.id, r8Query, { topK: 0 });
  const topKThousand = await retrieval.retrieve(subjectA.id, r8Query, {
    topK: 1000,
  });
  console.log(
    `  topK=0 matches=${topKZero.matches.length} topK=1000 matches=${topKThousand.matches.length} chunks=${chunks.length}`,
  );
  check(
    'R9 topK 0 returns at most 1 match',
    topKZero.matches.length <= 1,
    `matches=${topKZero.matches.length}`,
  );
  check(
    'R9 topK 1000 returns at most 50 and at most chunk count',
    topKThousand.matches.length <= 50 &&
      topKThousand.matches.length <= chunks.length,
    `matches=${topKThousand.matches.length} chunks=${chunks.length}`,
  );

  console.log('\nR10. minScore');
  const minScoreZero = await retrieval.retrieve(subjectA.id, r8Query, {
    topK: 5,
    minScore: 0,
  });
  const minScoreStrict = await retrieval.retrieve(subjectA.id, r8Query, {
    topK: 5,
    minScore: 0.99999,
  });
  console.log(
    `  minScore=0 matches=${minScoreZero.matches.length} minScore=0.99999 matches=${minScoreStrict.matches.length}`,
  );
  check(
    'R10 strict minScore returns fewer matches',
    minScoreStrict.matches.length < minScoreZero.matches.length,
    `zero=${minScoreZero.matches.length} strict=${minScoreStrict.matches.length}`,
  );

  console.log('\nR11. Exact-term baseline');
  const rareTokens = rareTokenByChunk(chunks);
  const baselineCandidates: ChunkRow[] = [];
  const seenBaseline = new Set<string>();
  for (const chunk of [...targets.map((target) => target.chunk), ...chunks]) {
    if (baselineCandidates.length >= 3) break;
    if (seenBaseline.has(chunk.id) || !rareTokens.has(chunk.id)) continue;
    seenBaseline.add(chunk.id);
    baselineCandidates.push(chunk);
  }
  let exactTermFirst = 0;
  for (const chunk of baselineCandidates) {
    const token = rareTokens.get(chunk.id);
    if (!token) continue;
    const result = await retrieval.retrieve(subjectA.id, token, { topK: 5 });
    const rank = result.matches.findIndex((match) => match.chunkId === chunk.id);
    const sourceScore = rank === -1 ? 0 : result.matches[rank].score;
    if (rank === 0) exactTermFirst += 1;
    console.log(
      `  token="${token}" sourceChunkId=${chunk.id} sourcePage=${chunk.page} rank=${rank === -1 ? 'not in top 5' : rank + 1} sourceScore=${rank === -1 ? 'n/a' : sourceScore.toFixed(6)} topScore=${(result.matches[0]?.score ?? 0).toFixed(6)}`,
    );
  }
  console.log(
    `BASELINE for 3b hybrid search: ${exactTermFirst}/3 exact-term queries ranked the source chunk first`,
  );

  console.log('\nStop the backend (Ctrl+C) BEFORE running cleanup.');
}

main()
  .catch((error) => {
    failures += 1;
    console.error(
      'RETRIEVAL ERROR:',
      error instanceof Error
        ? error.message.split('\n').slice(-6).join(' | ')
        : error,
    );
  })
  .finally(async () => {
    console.log(
      `\n${checks} checks, ${checks - failures} passed, ${failures} failed`,
    );
    console.log(
      failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`,
    );
    await prisma.$disconnect();
    process.exitCode = failures === 0 ? 0 : 1;
  });
