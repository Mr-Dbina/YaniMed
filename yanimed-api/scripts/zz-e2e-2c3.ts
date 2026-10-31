import '../src/config/load-local-env.js';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { StorageService } from '../src/storage/storage.service.js';
import {
  EMBEDDING_DIMENSIONS,
  EmbeddingService,
} from '../src/embeddings/embedding.service.js';

const PREFIX = 'ZZ-e2e-';
const PDF_PREFIX = 'ZZ-e2e-pdf/';
const API_BASE = (process.env.API_BASE ?? 'http://localhost:3000').replace(
  /\/+$/,
  '',
);
const PDF_PATH = resolve(
  process.env.PDF_PATH ??
    'C:\\Users\\chris\\Downloads\\YaniMed_Test_First_10_Pages.pdf',
);
const CHECK_ONLY = process.argv.includes('--check');
const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MIN = readTimeoutMinutes();
const POLL_TIMEOUT_MS = POLL_TIMEOUT_MIN * 60_000;
const GUARD_WAIT_MS = 61_000;
const SECRET = 'ZZ-e2e-SECRET-DETAIL';
const EXPECTED_FAILURE_MESSAGE =
  'Document processing failed. Retry the document.';
const FAILURE_CODES = new Set([
  'OCR_PAGE_LIMIT_EXCEEDED',
  'OCR_PAGE_TIMEOUT',
  'OCR_TIME_BUDGET_EXCEEDED',
  'PROCESSING_TIME_BUDGET_EXCEEDED',
  'LEASE_EXPIRED_MAX_ATTEMPTS',
  'EMBEDDING_TRANSIENT',
  'EMBEDDING_PERMANENT',
  'STORAGE_TRANSIENT',
  'STORAGE_PERMANENT',
  'DB_TRANSIENT',
  'PROCESSING_FAILED',
]);
const DOCUMENT_STATUSES = new Set(['QUEUED', 'PROCESSING', 'READY', 'FAILED']);

const prisma = new PrismaClient();
const runStamp = Date.now().toString();

let checks = 0;
let failures = 0;
let pdfBytes = Buffer.alloc(0);
let pdfName = '';
let pdfSha = '';
let storageService: StorageService | null = null;

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

function readTimeoutMinutes(): number {
  const index = process.argv.indexOf('--timeout-min');
  if (index === -1) return 10;
  const parsed = Number(process.argv[index + 1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function describeError(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

interface ApiResult {
  status: number;
  body: unknown;
  text: string;
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
  duplicateAction?: string,
): Promise<ApiResult> {
  return apiRequest(label, 'POST', '/documents/upload', () => {
    const form = new FormData();
    form.append('subjectId', subjectId);
    if (duplicateAction !== undefined)
      form.append('duplicateAction', duplicateAction);
    form.append(
      'file',
      new Blob([new Uint8Array(pdfBytes)], { type: 'application/pdf' }),
      pdfName,
    );
    return { method: 'POST', body: form };
  });
}

async function loadDocument(id: string) {
  return prisma.document.findUnique({
    where: { id },
    select: {
      id: true,
      subjectId: true,
      title: true,
      status: true,
      fileUrl: true,
      fileSize: true,
      pdfObjectId: true,
      pageCount: true,
      processedPages: true,
      embeddedChunks: true,
      ocrPages: true,
      errorMessage: true,
      pdfObject: {
        select: { id: true, r2Key: true, sizeBytes: true, sha256: true },
      },
    },
  });
}

async function subjectDocumentCounts(subjectId: string) {
  const [documents, jobs] = await Promise.all([
    prisma.document.count({ where: { subjectId } }),
    prisma.processingJob.count({ where: { document: { subjectId } } }),
  ]);
  return { documents, jobs };
}

async function createSubject(label: string) {
  return prisma.subject.create({
    data: { name: `${PREFIX}${runStamp}-${label}` },
    select: { id: true, name: true },
  });
}

async function verifyCreatedUpload(
  label: string,
  result: ApiResult,
  subjectId: string,
) {
  check(
    `${label} HTTP 201`,
    result.status === 201,
    `got ${result.status} ${json(result.body)}`,
  );
  const body = record(result.body);
  const fields = Object.keys(body).sort();
  check(
    `${label} returns exactly the five public fields`,
    json(fields) ===
      json(
        ['documentId', 'filename', 'subjectId', 'status', 'storageKey'].sort(),
      ),
    json(body),
  );
  check(
    `${label} subjectId is correct`,
    body.subjectId === subjectId,
    json(body),
  );
  check(
    `${label} filename is present`,
    text(body.filename).length > 0,
    json(body),
  );
  check(
    `${label} status is a DocumentStatus`,
    typeof body.status === 'string' && DOCUMENT_STATUSES.has(body.status),
    json(body),
  );

  const document = await loadDocument(text(body.documentId));
  check(
    `${label} Document row exists`,
    document !== null,
    `documentId=${text(body.documentId)}`,
  );
  if (document) {
    check(
      `${label} Document subject matches`,
      document.subjectId === subjectId,
      json(document),
    );
    check(
      `${label} Document title matches`,
      document.title === body.filename,
      json(document),
    );
    check(
      `${label} Document status is valid`,
      DOCUMENT_STATUSES.has(document.status),
      json(document),
    );
    check(
      `${label} storageKey is Document.fileUrl`,
      document.fileUrl === body.storageKey,
      json(document),
    );
    check(
      `${label} fileSize matches uploaded bytes`,
      document.fileSize === pdfBytes.length,
      json(document),
    );
    check(
      `${label} storageKey is the PdfObject r2Key`,
      document.pdfObject?.r2Key === body.storageKey,
      json(document),
    );
  }
  return { body, document };
}

async function waitForTerminal(documentId: string, label = 'A') {
  const startedAt = Date.now();
  const seen = new Set<string>();
  let last: ApiResult | null = null;
  if (!documentId) {
    console.log(`  ${label} has no Document id to poll`);
    return { result: last, elapsedMs: 0 };
  }
  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    const result = await statusRequest(documentId);
    last = result;
    if (result.status !== 200) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    const body = record(result.body);
    const key = json({
      status: body.status,
      processing: body.processing ?? null,
    });
    if (!seen.has(key)) {
      seen.add(key);
      console.log(
        `  ${label} t=${((Date.now() - startedAt) / 1_000).toFixed(1)}s ${key}`,
      );
    }
    if (body.status === 'READY' || body.status === 'FAILED') {
      return { result, elapsedMs: Date.now() - startedAt };
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return { result: last, elapsedMs: Date.now() - startedAt };
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
        select: {
          id: true,
          r2Key: true,
          _count: { select: { documents: true } },
        },
      });
      if (existing) {
        check(
          'PDF SHA-256 is not already present',
          false,
          `PdfObject id=${existing.id} r2Key=${existing.r2Key} documents=${existing._count.documents}`,
        );
        ok = false;
      } else {
        check('PDF SHA-256 is not already present', true);
      }
    } catch (error) {
      check('PDF SHA-256 duplicate check', false, describeError(error));
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
        stale.length === 0 ? '' : json(stale),
      );
      if (stale.length > 0) {
        console.log(
          `  Run: npx tsx scripts/zz-cleanup-e2e.ts --apply  (current matches: ${stale.length})`,
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
    const embeddings = new EmbeddingService(undefined, {
      requestsPerMinute: 60,
      maxAttempts: 1,
    });
    const vector = await embeddings.embedText(
      'YaniMed e2e embedding connectivity probe.',
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

async function main(): Promise<void> {
  console.log(`ZZ-e2e live verification (API ${API_BASE}, prefix ${PREFIX})`);
  console.log(
    'ChatGuard: no auth/token header; loopback-only; 10 guarded requests/min; waiting on HTTP 429.',
  );
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

  console.log('\nS1. Upload the PDF to Subject A; create Subjects B and C');
  const subjectA = await createSubject('A');
  const subjectB = await createSubject('B');
  const subjectC = await createSubject('C');
  console.log(`  Subject A: ${subjectA.name} (${subjectA.id})`);
  console.log(`  Subject B: ${subjectB.name} (${subjectB.id})`);
  console.log(`  Subject C: ${subjectC.name} (${subjectC.id})`);

  const uploadA = await uploadPdf('S1 A upload', subjectA.id);
  const verifiedA = await verifyCreatedUpload('S1 A', uploadA, subjectA.id);
  const documentAId = text(verifiedA.body.documentId);

  const pdfObjects = await prisma.pdfObject.findMany({
    where: { sha256: pdfSha },
    select: {
      id: true,
      r2Key: true,
      sizeBytes: true,
      _count: { select: { documents: true } },
    },
  });
  check(
    'S1 exactly one PdfObject exists for the PDF',
    pdfObjects.length === 1,
    json(pdfObjects),
  );
  check(
    'S1 exactly one Document references the PdfObject',
    pdfObjects[0]?._count.documents === 1,
    json(pdfObjects),
  );

  console.log('\nS2. Poll Subject A Document until terminal');
  const terminal = await waitForTerminal(documentAId);
  const terminalBody = record(terminal.result?.body);
  const terminalStatus = text(terminalBody.status);
  console.log(
    `  A elapsed=${(terminal.elapsedMs / 1_000).toFixed(1)}s status=${terminalStatus}`,
  );
  check(
    'S2 A Document reached READY or FAILED',
    terminalStatus === 'READY' || terminalStatus === 'FAILED',
    `status=${terminalStatus}`,
  );
  if (terminalStatus === 'FAILED') {
    const failure = record(terminalBody.failure);
    console.log(`  A failure code: ${text(failure.code)}`);
    check(
      'S2 A failure code is whitelisted',
      typeof failure.code === 'string' && FAILURE_CODES.has(failure.code),
      json(failure),
    );
  }

  console.log('\nS3. Persisted processing state for Subject A');
  const documentA = await loadDocument(documentAId);
  check(
    'S3 A Document is READY',
    documentA?.status === 'READY',
    json(documentA),
  );
  if (documentA?.status === 'READY') {
    const pageRows = await prisma.documentPage.count({
      where: { documentId: documentAId },
    });
    const chunkRows = await prisma.chunk.count({
      where: { documentId: documentAId },
    });
    const embeddingRows = await prisma.$queryRaw<
      Array<{ total: number; embedded: number }>
    >`
      SELECT COUNT(*)::int AS "total", COUNT("embedding")::int AS "embedded"
      FROM "Chunk"
      WHERE "documentId" = ${documentAId}
    `;
    const embedding = embeddingRows[0] ?? { total: 0, embedded: 0 };

    console.log(
      `  pageCount=${json(documentA.pageCount)} processedPages=${documentA.processedPages} pageRows=${pageRows} chunkRows=${chunkRows} embeddedChunks=${documentA.embeddedChunks}`,
    );
    check(
      'S3 pageCount is present and positive',
      documentA.pageCount !== null && documentA.pageCount > 0,
      json(documentA.pageCount),
    );
    console.log(`  pageCount === 10: ${documentA.pageCount === 10}`);
    check(
      'S3 processedPages equals pageCount',
      documentA.pageCount !== null &&
        documentA.processedPages === documentA.pageCount,
      `processedPages=${documentA.processedPages} pageCount=${json(documentA.pageCount)}`,
    );
    check(
      'S3 DocumentPage rows equal pageCount',
      documentA.pageCount !== null && pageRows === documentA.pageCount,
      `pageRows=${pageRows} pageCount=${json(documentA.pageCount)}`,
    );
    check('S3 Chunk rows exist', chunkRows > 0, `chunkRows=${chunkRows}`);
    check(
      'S3 every Chunk has a non-null embedding',
      embedding.total === chunkRows && embedding.embedded === chunkRows,
      json(embedding),
    );
    check(
      'S3 embeddedChunks equals Chunk rows',
      documentA.embeddedChunks === chunkRows,
      `embeddedChunks=${documentA.embeddedChunks} chunkRows=${chunkRows}`,
    );

    const latestJob = await prisma.processingJob.findFirst({
      where: { documentId: documentAId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, documentId: true, status: true, errorCode: true },
    });
    check(
      'S3 latest ProcessingJob is SUCCEEDED for the Document',
      latestJob?.documentId === documentAId && latestJob.status === 'SUCCEEDED',
      json(latestJob),
    );

    const documentPdfObjects = await prisma.pdfObject.findMany({
      where: {
        OR: [{ id: documentA.pdfObjectId ?? '' }, { r2Key: documentA.fileUrl }],
      },
      select: { id: true, r2Key: true },
    });
    check(
      'S3 exactly one PdfObject matches Document.fileUrl',
      documentPdfObjects.length === 1 &&
        documentPdfObjects[0]?.r2Key === documentA.fileUrl,
      json(documentPdfObjects),
    );
    check(
      'S3 Document.fileUrl equals PdfObject.r2Key',
      documentA.pdfObject?.r2Key === documentA.fileUrl,
      json(documentA),
    );
    check(
      'S3 Document.errorMessage is null',
      documentA.errorMessage === null,
      json(documentA.errorMessage),
    );

    const [ocrUsed, needsOcr] = await Promise.all([
      prisma.documentPage.count({
        where: { documentId: documentAId, ocrUsed: true },
      }),
      prisma.documentPage.count({
        where: { documentId: documentAId, needsOcr: true },
      }),
    ]);
    console.log(
      `  OCR observations: ocrPages=${documentA.ocrPages} pagesWithOcrUsed=${ocrUsed} pagesWithNeedsOcr=${needsOcr}`,
    );
  }

  console.log('\nS4. Same-Subject duplicate to A without duplicateAction');
  const countsA = await subjectDocumentCounts(subjectA.id);
  const duplicateSame = await uploadPdf('S4 duplicate', subjectA.id);
  const sameBody = record(duplicateSame.body);
  check(
    'S4 HTTP 409',
    duplicateSame.status === 409,
    `got ${duplicateSame.status} ${json(sameBody)}`,
  );
  check(
    'S4 code is DUPLICATE_PDF',
    sameBody.code === 'DUPLICATE_PDF',
    json(sameBody),
  );
  check(
    'S4 scope is same_subject',
    sameBody.scope === 'same_subject',
    json(sameBody),
  );
  check(
    'S4 existingDocumentId is A',
    sameBody.existingDocumentId === documentAId,
    json(sameBody),
  );
  check(
    'S4 existingSubjectId is A',
    sameBody.existingSubjectId === subjectA.id,
    json(sameBody),
  );
  check(
    'S4 allowedActions is keep_existing only',
    json(sameBody.allowedActions) === json(['keep_existing']),
    json(sameBody),
  );
  const countsAAfter = await subjectDocumentCounts(subjectA.id);
  check(
    'S4 Document count did not change',
    countsAAfter.documents === countsA.documents,
    json({ countsA, countsAAfter }),
  );
  check(
    'S4 ProcessingJob count did not change',
    countsAAfter.jobs === countsA.jobs,
    json({ countsA, countsAAfter }),
  );

  console.log('\nS5. Same-Subject duplicate actions on A');
  const countsAKeepBefore = await subjectDocumentCounts(subjectA.id);
  const keepSame = await uploadPdf(
    'S5 keep_existing',
    subjectA.id,
    'keep_existing',
  );
  const keepSameBody = record(keepSame.body);
  check(
    'S5 keep_existing HTTP 200',
    keepSame.status === 200,
    `got ${keepSame.status} ${json(keepSameBody)}`,
  );
  check(
    'S5 keep_existing returns existing A Document',
    keepSameBody.documentId === documentAId,
    json(keepSameBody),
  );
  const countsAKeepAfter = await subjectDocumentCounts(subjectA.id);
  check(
    'S5 keep_existing did not create a Document or job',
    countsAKeepAfter.documents === countsAKeepBefore.documents &&
      countsAKeepAfter.jobs === countsAKeepBefore.jobs,
    json({ countsAKeepBefore, countsAKeepAfter }),
  );

  const countsAReplaceBefore = await subjectDocumentCounts(subjectA.id);
  const replaceSame = await uploadPdf(
    'S5 replace_existing same subject',
    subjectA.id,
    'replace_existing',
  );
  const replaceSameBody = record(replaceSame.body);
  check(
    'S5 same-subject replace_existing is HTTP 400',
    replaceSame.status === 400,
    `got ${replaceSame.status} ${json(replaceSameBody)}`,
  );
  check(
    'S5 same-subject replace_existing is rejected',
    text(replaceSameBody.message) ===
      'duplicateAction is not valid for this upload.',
    json(replaceSameBody),
  );
  const countsAReplaceAfter = await subjectDocumentCounts(subjectA.id);
  check(
    'S5 rejected replace did not create a Document or job',
    countsAReplaceAfter.documents === countsAReplaceBefore.documents &&
      countsAReplaceAfter.jobs === countsAReplaceBefore.jobs,
    json({ countsAReplaceBefore, countsAReplaceAfter }),
  );

  console.log('\nS6. Other-Subject duplicate to B, then keep_existing');
  const other = await uploadPdf('S6 other-subject duplicate', subjectB.id);
  const otherBody = record(other.body);
  check(
    'S6 HTTP 409',
    other.status === 409,
    `got ${other.status} ${json(otherBody)}`,
  );
  check(
    'S6 code is DUPLICATE_PDF',
    otherBody.code === 'DUPLICATE_PDF',
    json(otherBody),
  );
  check(
    'S6 scope is other_subject',
    otherBody.scope === 'other_subject',
    json(otherBody),
  );
  check(
    'S6 existingDocumentId is A',
    otherBody.existingDocumentId === documentAId,
    json(otherBody),
  );
  check(
    'S6 existingSubjectId is A',
    otherBody.existingSubjectId === subjectA.id,
    json(otherBody),
  );
  check(
    'S6 allowedActions is keep_existing and replace_existing',
    json(otherBody.allowedActions) ===
      json(['keep_existing', 'replace_existing']),
    json(otherBody),
  );

  const keepB = await uploadPdf(
    'S6 B keep_existing',
    subjectB.id,
    'keep_existing',
  );
  const verifiedKeepB = await verifyCreatedUpload(
    'S6 B keep',
    keepB,
    subjectB.id,
  );
  const documentBId = text(verifiedKeepB.body.documentId);
  check(
    'S6 keep_existing creates a new B Document',
    documentBId !== documentAId,
    json(verifiedKeepB.body),
  );
  check(
    'S6 keep_existing reuses A filename',
    verifiedKeepB.body.filename === text(verifiedA.body.filename),
    json(verifiedKeepB.body),
  );
  check(
    'S6 keep_existing reuses the same PdfObject',
    verifiedKeepB.document?.pdfObjectId === verifiedA.document?.pdfObjectId,
    `${json(verifiedKeepB.document?.pdfObjectId)} vs ${json(verifiedA.document?.pdfObjectId)}`,
  );
  const pdfCountAfterB = await prisma.pdfObject.count({
    where: { sha256: pdfSha },
  });
  check(
    'S6 still exactly one PdfObject for the sha256',
    pdfCountAfterB === 1,
    `pdfObjects=${pdfCountAfterB}`,
  );
  const bCounts = await subjectDocumentCounts(subjectB.id);
  check('S6 B has one Document', bCounts.documents === 1, json(bCounts));

  const bTerminal = await waitForTerminal(documentBId, 'B');
  const bTerminalBody = record(bTerminal.result?.body);
  const bTerminalStatus = text(bTerminalBody.status);
  console.log(
    `  B elapsed=${(bTerminal.elapsedMs / 1_000).toFixed(1)}s status=${bTerminalStatus}`,
  );
  check(
    'S6 B Document is READY',
    bTerminalStatus === 'READY',
    `status=${bTerminalStatus}`,
  );

  console.log('\nS6b. Other-Subject duplicate to C with replace_existing');
  const replaceC = await uploadPdf(
    'S6b C replace_existing',
    subjectC.id,
    'replace_existing',
  );
  const verifiedReplaceC = await verifyCreatedUpload(
    'S6b C replace',
    replaceC,
    subjectC.id,
  );
  const documentCId = text(verifiedReplaceC.body.documentId);
  check(
    'S6b replace_existing creates a new C Document',
    documentCId !== documentAId && documentCId !== documentBId,
    json(verifiedReplaceC.body),
  );
  check(
    'S6b replace_existing uses the uploaded filename',
    verifiedReplaceC.body.filename === pdfName,
    json(verifiedReplaceC.body),
  );
  check(
    'S6b replace_existing reuses the same PdfObject',
    verifiedReplaceC.document?.pdfObjectId === verifiedA.document?.pdfObjectId,
    `${json(verifiedReplaceC.document?.pdfObjectId)} vs ${json(verifiedA.document?.pdfObjectId)}`,
  );
  const cCounts = await subjectDocumentCounts(subjectC.id);
  check('S6b C has one Document', cCounts.documents === 1, json(cCounts));

  const cTerminal = await waitForTerminal(documentCId, 'C');
  const cTerminalBody = record(cTerminal.result?.body);
  const cTerminalStatus = text(cTerminalBody.status);
  console.log(
    `  C elapsed=${(cTerminal.elapsedMs / 1_000).toFixed(1)}s status=${cTerminalStatus}`,
  );
  check(
    'S6b C Document reached a terminal status',
    cTerminalStatus === 'READY' || cTerminalStatus === 'FAILED',
    `status=${cTerminalStatus}`,
  );

  console.log('\nS7. Retry a READY Document');
  if (documentA?.status === 'READY') {
    const readyStatus = await statusRequest(documentAId);
    const readyBody = record(readyStatus.body);
    check(
      'S7 status HTTP 200',
      readyStatus.status === 200,
      `got ${readyStatus.status}`,
    );
    check('S7 status is READY', readyBody.status === 'READY', json(readyBody));
    check(
      'S7 retryAllowed is false',
      readyBody.retryAllowed === false,
      json(readyBody),
    );
    check(
      'S7 retryUnavailableReason is NOT_FAILED',
      readyBody.retryUnavailableReason === 'NOT_FAILED',
      json(readyBody),
    );

    const countsABeforeRetry = await subjectDocumentCounts(subjectA.id);
    const retryReady = await apiRequest(
      'S7 retry READY',
      'POST',
      `/documents/${documentAId}/retry`,
    );
    const retryReadyBody = record(retryReady.body);
    check(
      'S7 READY retry is HTTP 409',
      retryReady.status === 409,
      `got ${retryReady.status} ${json(retryReadyBody)}`,
    );
    check(
      'S7 error code is RETRY_NOT_ALLOWED',
      retryReadyBody.code === 'RETRY_NOT_ALLOWED',
      json(retryReadyBody),
    );
    check(
      'S7 error reason is NOT_FAILED',
      retryReadyBody.reason === 'NOT_FAILED',
      json(retryReadyBody),
    );
    const countsAAfterRetry = await subjectDocumentCounts(subjectA.id);
    check(
      'S7 rejected retry did not create a job',
      countsAAfterRetry.documents === countsABeforeRetry.documents &&
        countsAAfterRetry.jobs === countsABeforeRetry.jobs,
      json({ countsABeforeRetry, countsAAfterRetry }),
    );
  } else {
    check(
      'S7 A Document is READY for retry check',
      false,
      `status=${json(documentA?.status)}`,
    );
  }

  console.log('\nS8. Retry validation');
  const unknownId = randomUUID();
  const unknown = await apiRequest(
    'S8 unknown UUID',
    'POST',
    `/documents/${unknownId}/retry`,
  );
  check(
    'S8 unknown UUID is HTTP 404',
    unknown.status === 404,
    `got ${unknown.status} ${json(unknown.body)}`,
  );
  const malformed = await apiRequest(
    'S8 malformed UUID',
    'POST',
    '/documents/not-a-uuid/retry',
  );
  check(
    'S8 malformed UUID is HTTP 400',
    malformed.status === 400,
    `got ${malformed.status} ${json(malformed.body)}`,
  );

  console.log('\nS9. Retry a controlled FAILED Document');
  const subjectE = await createSubject('S9');
  console.log(`  Subject S9: ${subjectE.name} (${subjectE.id})`);
  const fakeTag = `${runStamp}-${randomUUID()}`;
  const fakeKey = `${PDF_PREFIX}${fakeTag}.pdf`;
  if (!storageService?.isAvailable())
    throw new Error('R2 storage is not available for the S9 object.');
  await storageService.putCanonicalPdf(fakeKey, pdfBytes);
  console.log(`  S9 fake R2 key: ${fakeKey}`);
  const fake = await prisma.$transaction(async (tx) => {
    const pdfObject = await tx.pdfObject.create({
      data: {
        sha256: createHash('sha256')
          .update(`${PREFIX}fake-${fakeTag}`)
          .digest('hex'),
        r2Key: fakeKey,
        sizeBytes: pdfBytes.length,
      },
    });
    const document = await tx.document.create({
      data: {
        subjectId: subjectE.id,
        pdfObjectId: pdfObject.id,
        title: `${PREFIX}fake-${fakeTag}.pdf`,
        fileUrl: pdfObject.r2Key,
        fileSize: pdfBytes.length,
        status: 'FAILED',
        errorMessage: SECRET,
      },
    });
    const job = await tx.processingJob.create({
      data: {
        documentId: document.id,
        status: 'FAILED',
        attempt: 1,
        maxAttempts: 4,
        errorCode: 'PROCESSING_FAILED',
        errorMessage: SECRET,
        startedAt: new Date(Date.now() - 60_000),
        finishedAt: new Date(),
      },
    });
    return { document, pdfObject, job };
  });

  const failedStatus = await statusRequest(fake.document.id);
  const failedBody = record(failedStatus.body);
  const failure = record(failedBody.failure);
  check(
    'S9 status HTTP 200',
    failedStatus.status === 200,
    `got ${failedStatus.status}`,
  );
  check(
    'S9 status is FAILED',
    failedBody.status === 'FAILED',
    `observed=${text(failedBody.status)}`,
  );
  check(
    'S9 retryAllowed is true',
    failedBody.retryAllowed === true,
    `observed=${json(failedBody.retryAllowed)}`,
  );
  check(
    'S9 failure code is whitelisted',
    FAILURE_CODES.has(text(failure.code)),
    `observed=${text(failure.code)}`,
  );
  check(
    'S9 failure code is PROCESSING_FAILED',
    failure.code === 'PROCESSING_FAILED',
    `observed=${text(failure.code)}`,
  );
  check(
    'S9 failure message is fixed',
    failure.message === EXPECTED_FAILURE_MESSAGE,
    `matches=${failure.message === EXPECTED_FAILURE_MESSAGE}`,
  );
  check(
    'S9 failure.retryAllowed is true',
    failure.retryAllowed === true,
    `observed=${json(failure.retryAllowed)}`,
  );
  check(
    'S9 status response does not contain the raw errorMessage',
    !failedStatus.text.includes(SECRET),
    'secret leaked',
  );
  console.log(
    `  S9 status: status=${text(failedBody.status)} retryAllowed=${json(failedBody.retryAllowed)} failureCode=${text(failure.code)} fixedMessage=${failure.message === EXPECTED_FAILURE_MESSAGE} secretLeaked=${failedStatus.text.includes(SECRET)}`,
  );

  const jobCountBeforeRetry = await prisma.processingJob.count({
    where: { documentId: fake.document.id },
  });
  const retryFailed = await apiRequest(
    'S9 retry FAILED',
    'POST',
    `/documents/${fake.document.id}/retry`,
  );
  const retryFailedBody = record(retryFailed.body);
  check(
    'S9 retry is HTTP 202',
    retryFailed.status === 202,
    `got ${retryFailed.status} ${json(retryFailedBody)}`,
  );
  check(
    'S9 retry returns the Document id',
    retryFailedBody.documentId === fake.document.id,
    json(retryFailedBody),
  );
  check(
    'S9 retry returns QUEUED',
    retryFailedBody.status === 'QUEUED',
    json(retryFailedBody),
  );

  const [afterRetryDocument, afterRetryJob, jobCountAfterRetry] =
    await Promise.all([
      loadDocument(fake.document.id),
      prisma.processingJob.findFirst({
        where: { documentId: fake.document.id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: {
          id: true,
          documentId: true,
          status: true,
          attempt: true,
          errorCode: true,
        },
      }),
      prisma.processingJob.count({ where: { documentId: fake.document.id } }),
    ]);
  console.log(
    `  S9 post-retry observed: document=${json(afterRetryDocument?.status)} job=${json(afterRetryJob?.status)} attempt=${json(afterRetryJob?.attempt)} jobCount=${jobCountAfterRetry}`,
  );
  check(
    'S9 exactly one new ProcessingJob was created',
    jobCountAfterRetry === jobCountBeforeRetry + 1,
    `before=${jobCountBeforeRetry} after=${jobCountAfterRetry}`,
  );
  check(
    'S9 latest ProcessingJob belongs to the Document',
    afterRetryJob?.documentId === fake.document.id,
    json(afterRetryJob),
  );
  check(
    'S9 latest ProcessingJob is not the old terminal job',
    afterRetryJob !== null && afterRetryJob.id !== fake.job.id,
    json(afterRetryJob),
  );
  check(
    'S9 Document was queued or claimed for processing',
    afterRetryDocument?.status === 'QUEUED' ||
      afterRetryDocument?.status === 'PROCESSING',
    `observed document=${json(afterRetryDocument?.status)}`,
  );
  check(
    'S9 new ProcessingJob is QUEUED at attempt 0 or already claimed at attempt 1',
    afterRetryJob !== null &&
      (afterRetryJob.attempt === 0
        ? afterRetryJob.status === 'QUEUED'
        : afterRetryJob.attempt === 1 && afterRetryJob.status === 'RUNNING'),
    json(afterRetryJob),
  );

  const immediateRetry = await apiRequest(
    'S9 immediate retry',
    'POST',
    `/documents/${fake.document.id}/retry`,
  );
  const immediateRetryBody = record(immediateRetry.body);
  check(
    'S9 immediate second retry is HTTP 409',
    immediateRetry.status === 409,
    `got ${immediateRetry.status} ${json(immediateRetryBody)}`,
  );
  check(
    'S9 immediate retry code is RETRY_NOT_ALLOWED',
    immediateRetryBody.code === 'RETRY_NOT_ALLOWED',
    json(immediateRetryBody),
  );
  check(
    'S9 immediate retry reason is NOT_FAILED or RETRY_IN_PROGRESS',
    immediateRetryBody.reason === 'NOT_FAILED' ||
      immediateRetryBody.reason === 'RETRY_IN_PROGRESS',
    json(immediateRetryBody),
  );

  const s9Terminal = await waitForTerminal(fake.document.id, 'S9');
  const s9TerminalBody = record(s9Terminal.result?.body);
  const s9TerminalStatus = text(s9TerminalBody.status);
  console.log(
    `  S9 final elapsed=${(s9Terminal.elapsedMs / 1_000).toFixed(1)}s status=${s9TerminalStatus}`,
  );
  check(
    'S9 Document reached a terminal status',
    s9TerminalStatus === 'READY' || s9TerminalStatus === 'FAILED',
    `status=${s9TerminalStatus}`,
  );
  console.log('  S9 is terminal; the backend should now be idle for cleanup.');

  const [finalA, finalB, finalC, finalS9] = await Promise.all([
    loadDocument(documentAId),
    loadDocument(documentBId),
    loadDocument(documentCId),
    loadDocument(fake.document.id),
  ]);
  console.log('\nDocument summary:');
  console.log('  label  documentId                              status');
  for (const [label, document] of [
    ['A', finalA],
    ['B', finalB],
    ['C', finalC],
    ['S9', finalS9],
  ] as const) {
    console.log(
      `  ${label.padEnd(5)}  ${(document?.id ?? '<missing>').padEnd(42)}  ${document?.status ?? '<missing>'}`,
    );
  }

  console.log(
    `\nZZ-e2e Subjects created: ${[subjectA, subjectB, subjectC, subjectE].map((subject) => `${subject.name} (${subject.id})`).join(', ')}`,
  );
}

main()
  .catch((error) => {
    failures += 1;
    console.error(
      'E2E ERROR:',
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
    if (!CHECK_ONLY) {
      console.log('Cleanup: npx tsx scripts/zz-cleanup-e2e.ts');
      console.log('Apply cleanup: npx tsx scripts/zz-cleanup-e2e.ts --apply');
    }
    await prisma.$disconnect();
    process.exit(failures === 0 ? 0 : 1);
  });
