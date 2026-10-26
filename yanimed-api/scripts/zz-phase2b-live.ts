import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { StorageService } from '../src/storage/storage.service.js';
import { PdfObjectService } from '../src/pdf-objects/pdf-object.service.js';
import { ChunkingService } from '../src/chunking/chunking.service.js';
import { PdfExtractionService, isPageComplete } from '../src/pdf-extraction/pdf-extraction.service.js';
import { EMBEDDING_MODEL } from '../src/embeddings/embedding.service.js';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';
import { createWorker, type Worker } from 'tesseract.js';
import { renderPageAsImage } from 'unpdf';
import { existsSync, readFileSync } from 'node:fs';

for (const envFile of ['.env.local', '.env']) {
  if (!existsSync(envFile)) continue;
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const key = match[1];
    const value = match[2].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
    if (!(key in process.env)) process.env[key] = value;
  }
}

const run = process.argv.includes('--run');
const prismaClient = new PrismaClient();
const prisma = prismaClient as unknown as PrismaService;
const config = { get: (key: string) => ({ r2Endpoint: process.env.R2_ENDPOINT, r2BucketName: process.env.R2_BUCKET_NAME, r2Jurisdiction: process.env.R2_JURISDICTION, r2AccessKeyId: process.env.R2_ACCESS_KEY_ID, r2SecretAccessKey: process.env.R2_SECRET_ACCESS_KEY }[key]) };
const storage = new StorageService(config as never);
storage.onModuleInit();
const pdfObjects = new PdfObjectService(prisma, storage);
const chunking = new ChunkingService(prisma);
const extraction = new PdfExtractionService(prisma, storage, chunking);

let failed = false;
function check(name: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? 'PASS' : 'FAIL'}: ${name} (actual=${JSON.stringify(actual)}, expected=${JSON.stringify(expected)})`);
  if (!pass) failed = true;
}

async function makePdf(nonce: string): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.setTitle('ZZ-PHASE2B-TEST ' + nonce);
  const page1 = pdf.addPage();
  page1.drawText(`ZZPHASE2B ${nonce} PAGE ONE TEXT`, { x: 50, y: 700, size: 12, font });
  const page2 = pdf.addPage();
  page2.drawText(`ZZPHASE2B ${nonce} PAGE TWO TEXT`, { x: 50, y: 700, size: 12, font });

  for (let i = 3; i <= 6; i++) {
    const canvas = createCanvas(600, 200);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, 600, 200);
    ctx.fillStyle = 'black';
    ctx.font = '48px sans-serif';
    ctx.fillText(`PAGE ${i} SCAN`, 80, 110);
    const png = canvas.toBuffer('image/png');
    const image = await pdf.embedPng(png);
    const page = pdf.addPage([600, 200]);
    page.drawImage(image, { x: 0, y: 0, width: 600, height: 200 });
  }
  return Buffer.from(await pdf.save());
}

async function main() {
  if (!run) {
    console.log('DRY RUN: no writes. Re-run with --run to execute Phase 2B-1 live check.');
    console.log('Planned: create ZZ-PHASE2B-TEST Subject, upload canonical PDF, crash after page 3, resume, verify idempotency, chunk edits, rerun.');
    return;
  }

  const nonce = Date.now().toString();
  const pdf = await makePdf(nonce);
  const sha256 = (await import('node:crypto')).createHash('sha256').update(pdf).digest('hex');
  const canonicalKey = `pdfs/${sha256}.pdf`;
  const subjectName = `ZZ-PHASE2B-TEST-${nonce}`;

  const subject = await prisma.subject.create({ data: { name: subjectName } });
  const pdfObject = await pdfObjects.ensureFromBuffer(pdf, sha256, pdf.length);
  const canonicalHead = await storage.inspectReservedPdf(pdfObject.r2Key);
  check('canonical R2 object exists', canonicalHead !== null, true);
  check('canonical R2 size matches', canonicalHead?.bytes, pdf.length);
  const document = await prisma.document.create({
    data: {
      subjectId: subject.id,
      title: 'zz-phase2b.pdf',
      fileUrl: pdfObject.r2Key,
      fileSize: pdf.length,
      status: 'QUEUED',
      pdfObjectId: pdfObject.id,
    },
  });

  console.log('SUBJECT_ID=' + subject.id);
  console.log('DOCUMENT_ID=' + document.id);
  console.log('PDFOBJECT_ID=' + pdfObject.id);
  console.log('CANONICAL_KEY=' + pdfObject.r2Key);
  console.log('SHA256=' + sha256);

  // Crash run: persistPage throws on page 4.
  const prismaProxy = new Proxy(prisma, {
    get(target, prop) {
      if (prop === 'documentPage') {
        return new Proxy(target.documentPage, {
          get(t, p) {
            if (p === 'upsert') {
              return async (args: any) => {
                if (args?.where?.documentId_pageNumber?.pageNumber === 4) throw new Error('crash on page 4');
                return t.upsert(args);
              };
            }
            const value = t[p as keyof typeof t];
            return typeof value === 'function' ? (value as any).bind(t) : value;
          },
        });
      }
      const value = target[prop as keyof typeof target];
      return typeof value === 'function' ? (value as any).bind(target) : value;
    },
  });
  const crashingExtraction = new PdfExtractionService(prismaProxy as any, storage, chunking);

  let crashError: unknown;
  try {
    await crashingExtraction.processDocument(document.id);
  } catch (error) {
    crashError = error;
  }
  check('crash run rejects', crashError instanceof Error, true);

  const pagesAfterCrash = await prisma.documentPage.findMany({ where: { documentId: document.id }, orderBy: { pageNumber: 'asc' } });
  check('pages after crash', pagesAfterCrash.map(p => p.pageNumber), [1, 2, 3]);
  const documentAfterCrash = await prisma.document.findUniqueOrThrow({ where: { id: document.id } });
  check('document status after crash', documentAfterCrash.status, 'FAILED');
  console.log('DOCUMENT_STATUS_AFTER_CRASH=' + documentAfterCrash.status);

  // Resume run with real Tesseract OCR seam.
  const ocrCalls: number[] = [];
  const worker = await createWorker('eng');
  try {
  const ocrPage = async (pageNumber: number, bytes: Uint8Array) => {
    ocrCalls.push(pageNumber);
    const image = await renderPageAsImage(bytes, pageNumber, { scale: 2, canvasImport: () => import('@napi-rs/canvas') });
    const { data } = await worker.recognize(Buffer.from(image));
    return (data.text ?? '').trim();
  };
  const originalExtractWithOcr = extraction.extractWithOcr.bind(extraction);
  extraction.extractWithOcr = async (buffer, options, skipPages, persistPage) =>
    originalExtractWithOcr(buffer, options, skipPages, persistPage, ocrPage);

  await extraction.processDocument(document.id);
  const pagesAfterResume = await prisma.documentPage.findMany({ where: { documentId: document.id }, orderBy: { pageNumber: 'asc' } });
  check('resume OCR calls', ocrCalls, [4, 5, 6]);
  check('resume page count', pagesAfterResume.length, 6);
  check('resume page numbers', pagesAfterResume.map(p => p.pageNumber), [1, 2, 3, 4, 5, 6]);
  check('resume no duplicate page numbers', new Set(pagesAfterResume.map(p => p.pageNumber)).size, 6);
  const scannedPages = pagesAfterResume.filter(p => p.pageNumber >= 3);
  check('resume scanned pages have ocrUsed true', scannedPages.every(p => p.ocrUsed), true);
  check('resume scanned pages have no ocrError', scannedPages.every(p => p.ocrError == null), true);

  const documentAfterResume = await prisma.document.findUniqueOrThrow({ where: { id: document.id } });
  check('resume pageCount', documentAfterResume.pageCount, 6);
  check('resume processedPages', documentAfterResume.processedPages, 6);
  check('resume ocrPages', documentAfterResume.ocrPages, 4);

  const chunksBefore = await prisma.chunk.findMany({ where: { documentId: document.id }, orderBy: { chunkIndex: 'asc' } });
  check('chunks exist', chunksBefore.length > 0, true);
  const chunkIdsBefore = chunksBefore.map(c => c.id);
  const chunkCountBefore = chunksBefore.length;
  const uniqueChunkIndexes = new Set(chunksBefore.map(c => c.chunkIndex));
  check('no duplicate chunkIndex', uniqueChunkIndexes.size, chunksBefore.length);

  const embeddingLiteral = `[${Array(768).fill(0.1).join(',')}]`;
  await prisma.$executeRaw`UPDATE "Chunk" SET "embedding" = ${embeddingLiteral}::vector, "embeddingModel" = ${EMBEDDING_MODEL} WHERE "chunkIndex" = 0 AND "documentId" = ${document.id}`;
  const chunkZeroBefore = await prisma.chunk.findFirstOrThrow({ where: { documentId: document.id, chunkIndex: 0 } });
  check('chunk 0 embedding set before rerun', chunkZeroBefore.embeddingModel, EMBEDDING_MODEL);

  await chunking.chunkDocument(document.id);
  const chunksAfterIdempotency = await prisma.chunk.findMany({ where: { documentId: document.id }, orderBy: { chunkIndex: 'asc' } });
  check('chunk ids unchanged on identical rerun', chunksAfterIdempotency.map(c => c.id), chunkIdsBefore);
  check('chunk count unchanged on identical rerun', chunksAfterIdempotency.length, chunkCountBefore);
  const chunkZeroAfterIdempotency = chunksAfterIdempotency.find(c => c.chunkIndex === 0)!;
  const embeddingAfterIdempotency = await prisma.$queryRaw<Array<{ has_embedding: boolean }>>`SELECT ("embedding" IS NOT NULL) AS has_embedding FROM "Chunk" WHERE "id" = ${chunkZeroAfterIdempotency.id}`;
  check('unchanged chunk keeps embedding', embeddingAfterIdempotency[0]?.has_embedding, true);

  const pageOne = await prisma.documentPage.findFirstOrThrow({ where: { documentId: document.id, pageNumber: 1 } });
  await prisma.documentPage.update({ where: { id: pageOne.id }, data: { text: pageOne.text + ' ZZEXTRAWORDEXTRA' } });
  await chunking.chunkDocument(document.id);
  const chunksAfterEdit = await prisma.chunk.findMany({ where: { documentId: document.id }, orderBy: { chunkIndex: 'asc' } });
  const editedChunk = chunksAfterEdit.find(c => c.chunkIndex === 0)!;
  check('edited chunk keeps id', editedChunk.id, chunkZeroAfterIdempotency.id);
  check('chunk count unchanged after edit', chunksAfterEdit.length, chunksAfterIdempotency.length);
  const embeddingAfterEdit = await prisma.$queryRaw<Array<{ has_embedding: boolean; model: string | null }>>`SELECT ("embedding" IS NOT NULL) AS has_embedding, "embeddingModel" AS model FROM "Chunk" WHERE "id" = ${editedChunk.id}`;
  check('changed chunk clears embedding', embeddingAfterEdit[0]?.has_embedding, false);
  check('changed chunk clears embeddingModel', embeddingAfterEdit[0]?.model, null);
  const tsvResult = await prisma.$queryRaw<Array<{ matches: boolean }>>`SELECT ("tsv" @@ to_tsquery('english', 'ZZEXTRAWORDEXTRA')) AS matches FROM "Chunk" WHERE "id" = ${editedChunk.id}`;
  check('tsv reflects edited content', tsvResult[0]?.matches, true);
  check('unchanged chunks keep ids after edit', chunksAfterEdit.map(c => c.id), chunksAfterIdempotency.map(c => c.id));

  const ocrCallsBeforeThirdRun = ocrCalls.length;
  await extraction.processDocument(document.id);
  const pagesAfterThirdRun = await prisma.documentPage.findMany({ where: { documentId: document.id } });
  const chunksAfterThirdRun = await prisma.chunk.findMany({ where: { documentId: document.id } });
  check('third run adds no OCR calls', ocrCalls.length - ocrCallsBeforeThirdRun, 0);
  check('third run page count unchanged', pagesAfterThirdRun.length, 6);
  check('third run chunk count unchanged', chunksAfterThirdRun.length, chunksAfterEdit.length);

  } finally {
    await worker.terminate();
  }

  console.log('FINAL_SUBJECT_ID=' + subject.id);
  console.log('FINAL_DOCUMENT_ID=' + document.id);
  console.log('FINAL_PDF_OBJECT_ID=' + pdfObject.id);
  console.log('FINAL_CANONICAL_KEY=' + pdfObject.r2Key);
  console.log('FINAL_SHA256=' + sha256);

  if (failed) process.exitCode = 1;
}

main().catch(error => {
  console.error('PHASE2B LIVE CHECK FAILED:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}).finally(async () => {
  await prismaClient.$disconnect();
});
