import '../src/config/load-local-env.js';
import { createHash } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';

const PREFIX = 'ZZ-2c3b-';
const PDF_PREFIX = `${PREFIX}pdf/`;
const TX_OPTIONS = { timeout: 60000, maxWait: 10000 };
const prisma = new PrismaClient();

let checks = 0;
let failures = 0;
let seq = 0;
const runStamp = Date.now();

function check(name: string, ok: boolean, detail = '') {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${detail}`}`);
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return '<unserializable>';
  }
}

function nextTag(label: string): string {
  seq += 1;
  return `${label}-${runStamp}-${seq}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error);
}

function errorDetails(error: unknown) {
  const record = (
    typeof error === 'object' && error !== null ? error : {}
  ) as {
    name?: unknown;
    code?: unknown;
    meta?: unknown;
    message?: unknown;
  };
  return {
    constructorName: error === null
      ? 'null'
      : error instanceof Error
        ? error.constructor.name
        : typeof error,
    name: String(record.name),
    code: String(record.code),
    meta: json(record.meta),
    message: String(record.message),
  };
}

async function capture<T>(
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error };
  }
}

function isDocumentSubjectPdfUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return false;
  const target = error.meta?.target;
  const text = Array.isArray(target) ? target.join(',') : typeof target === 'string' ? target : '';
  return text.includes('Document_subjectId_pdfObjectId_key')
    || (text.includes('subjectId') && text.includes('pdfObjectId'));
}

async function newSubject(label: string) {
  const tag = nextTag(label);
  return prisma.subject.create({
    data: { name: `${PREFIX}${tag}` },
  });
}

interface SeededDoc {
  docId: string;
  pdfObjectId: string;
  sha256: string;
  r2Key: string;
  title: string;
}

async function newDoc(label: string, subjectId: string): Promise<SeededDoc> {
  const tag = nextTag(label);
  const sha256 = createHash('sha256').update(`${PREFIX}${tag}`).digest('hex');
  const r2Key = `${PDF_PREFIX}${tag}.pdf`;
  const title = `${PREFIX}${tag}.pdf`;
  const fileUrl = `${PREFIX}${tag}`;

  return prisma.$transaction(async (tx) => {
    const pdfObject = await tx.pdfObject.create({
      data: { sha256, r2Key, sizeBytes: 1 },
    });
    const document = await tx.document.create({
      data: {
        subjectId,
        pdfObjectId: pdfObject.id,
        title,
        fileUrl,
        fileSize: 1,
        status: 'QUEUED',
      },
    });
    return {
      docId: document.id,
      pdfObjectId: pdfObject.id,
      sha256,
      r2Key,
      title,
    };
  }, TX_OPTIONS);
}

async function scenarioA() {
  console.log('\nA. unique index exists on public.Document');
  const rows = await prisma.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'Document'
      AND indexname = 'Document_subjectId_pdfObjectId_key'
  `;
  const row = rows[0];
  const indexdef = row?.indexdef ?? '<none>';
  const normalized = indexdef.replace(/"/g, '').replace(/\s+/g, ' ');
  const unique = /\bUNIQUE\b/i.test(normalized);
  const covers = normalized.includes('(subjectId, pdfObjectId)');

  console.log('  indexname:', row?.indexname ?? '<none>');
  console.log('  indexdef:', indexdef);

  check('A1 index exists', Boolean(row), indexdef);
  check('A2 index is UNIQUE', unique, indexdef);
  check('A3 index covers (subjectId, pdfObjectId)', covers, indexdef);
}

async function scenarioB() {
  console.log('\nB. same (Subject, PdfObject) twice -> P2002');
  const subject = await newSubject('b');
  const first = await newDoc('b-first', subject.id);

  const duplicate = await capture(() => prisma.document.create({
    data: {
      subjectId: subject.id,
      pdfObjectId: first.pdfObjectId,
      title: `${PREFIX}${nextTag('b-second')}.pdf`,
      fileUrl: `${PREFIX}${nextTag('b-second-url')}`,
      fileSize: 1,
      status: 'QUEUED',
    },
  }));

  const details = errorDetails(duplicate.ok ? null : duplicate.error);
  console.log('  error.constructor.name:', details.constructorName);
  console.log('  error.name:', details.name);
  console.log('  error.code:', details.code);
  console.log('  error.meta:', details.meta);
  console.log('  error.message:', details.message);

  check(
    'B1 second same (Subject, PdfObject) create throws',
    !duplicate.ok,
    duplicate.ok ? `created ${duplicate.value.id}` : '',
  );
  check('B2 error code is P2002', !duplicate.ok && details.code === 'P2002', details.code);

  const recognized = !duplicate.ok && isDocumentSubjectPdfUniqueViolation(duplicate.error);
  console.log('  helper recognizes error:', recognized ? 'YES' : 'NO');
  check('B3 copied helper recognizes P2002', recognized, details.meta);

  const count = await prisma.document.count({
    where: { subjectId: subject.id, pdfObjectId: first.pdfObjectId },
  });
  check('B4 exactly 1 Document row for the pair', count === 1, `count=${count}`);
}

async function scenarioC() {
  console.log('\nC. same PdfObject in two different Subjects -> both created');
  const subjectOne = await newSubject('c-one');
  const subjectTwo = await newSubject('c-two');
  const tag = nextTag('c-shared');
  const sha256 = createHash('sha256').update(`${PREFIX}${tag}`).digest('hex');
  const r2Key = `${PDF_PREFIX}${tag}.pdf`;

  const seeded = await prisma.$transaction(async (tx) => {
    const pdfObject = await tx.pdfObject.create({
      data: { sha256, r2Key, sizeBytes: 1 },
    });
    const first = await tx.document.create({
      data: {
        subjectId: subjectOne.id,
        pdfObjectId: pdfObject.id,
        title: `${PREFIX}${tag}-subject-one.pdf`,
        fileUrl: `${PREFIX}${tag}-subject-one`,
        fileSize: 1,
        status: 'QUEUED',
      },
    });
    const second = await tx.document.create({
      data: {
        subjectId: subjectTwo.id,
        pdfObjectId: pdfObject.id,
        title: `${PREFIX}${tag}-subject-two.pdf`,
        fileUrl: `${PREFIX}${tag}-subject-two`,
        fileSize: 1,
        status: 'QUEUED',
      },
    });
    return { pdfObject, first, second };
  }, TX_OPTIONS);

  console.log('  pdfObjectId:', seeded.pdfObject.id);
  console.log('  document ids:', json([seeded.first.id, seeded.second.id]));
  check('C1 first Subject Document created', Boolean(seeded.first.id), seeded.first.id);
  check('C2 second Subject Document created', Boolean(seeded.second.id), seeded.second.id);

  const count = await prisma.document.count({
    where: { pdfObjectId: seeded.pdfObject.id },
  });
  check('C3 both Documents share the PdfObject', count === 2, `count=${count}`);
}

async function scenarioD() {
  console.log('\nD. two NULL pdfObjectId Documents in one Subject -> both created');
  const subject = await newSubject('d');
  const firstTag = nextTag('d-null-first');
  const secondTag = nextTag('d-null-second');

  const docs = await prisma.$transaction(async (tx) => {
    const first = await tx.document.create({
      data: {
        subjectId: subject.id,
        pdfObjectId: null,
        title: `${PREFIX}${firstTag}.pdf`,
        fileUrl: `${PREFIX}${firstTag}`,
        fileSize: 1,
        status: 'QUEUED',
      },
    });
    const second = await tx.document.create({
      data: {
        subjectId: subject.id,
        pdfObjectId: null,
        title: `${PREFIX}${secondTag}.pdf`,
        fileUrl: `${PREFIX}${secondTag}`,
        fileSize: 1,
        status: 'QUEUED',
      },
    });
    return [first, second];
  }, TX_OPTIONS);

  console.log('  document ids:', json(docs.map((doc) => doc.id)));
  check('D1 first NULL pdfObjectId Document created', Boolean(docs[0]?.id), docs[0]?.id ?? '');
  check('D2 second NULL pdfObjectId Document created', Boolean(docs[1]?.id), docs[1]?.id ?? '');

  const count = await prisma.document.count({
    where: { subjectId: subject.id, pdfObjectId: null },
  });
  check('D3 exactly 2 NULL pdfObjectId Documents exist', count === 2, `count=${count}`);
}

async function scenarioE() {
  console.log('\nE. five concurrent creates for one fresh (Subject, PdfObject) pair');
  const subject = await newSubject('e');
  const tag = nextTag('e-race');
  const sha256 = createHash('sha256').update(`${PREFIX}${tag}`).digest('hex');
  const r2Key = `${PDF_PREFIX}${tag}.pdf`;
  const pdfObject = await prisma.$transaction(
    (tx) => tx.pdfObject.create({ data: { sha256, r2Key, sizeBytes: 1 } }),
    TX_OPTIONS,
  );

  const results = await Promise.allSettled(
    Array.from({ length: 5 }, (_, index) => prisma.document.create({
      data: {
        subjectId: subject.id,
        pdfObjectId: pdfObject.id,
        title: `${PREFIX}${tag}-race-${index + 1}.pdf`,
        fileUrl: `${PREFIX}${tag}-race-${index + 1}`,
        fileSize: 1,
        status: 'QUEUED',
      },
    })),
  );

  const fulfilled = results.filter(
    (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof prisma.document.create>>> =>
      result.status === 'fulfilled',
  );
  const rejected = results.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );

  console.log('  fulfilled ids:', json(fulfilled.map((result) => result.value.id)));
  console.log('  rejected count:', rejected.length);
  const rejectionDetails = rejected.map((result) => {
    const details = errorDetails(result.reason);
    return {
      constructorName: details.constructorName,
      code: details.code,
      meta: details.meta,
      recognized: isDocumentSubjectPdfUniqueViolation(result.reason),
    };
  });
  console.log('  rejections:', json(rejectionDetails));

  check('E1 exactly 1 of 5 calls fulfilled', fulfilled.length === 1, `fulfilled=${fulfilled.length}`);
  check('E2 exactly 4 of 5 calls rejected', rejected.length === 4, `rejected=${rejected.length}`);

  const recognized = rejected.length === 4
    && rejected.every((result) => isDocumentSubjectPdfUniqueViolation(result.reason));
  check('E3 every rejection is P2002 recognized by copied helper', recognized, json(rejectionDetails));

  const count = await prisma.document.count({
    where: { subjectId: subject.id, pdfObjectId: pdfObject.id },
  });
  check('E4 exactly 1 Document row exists for the pair', count === 1, `count=${count}`);
}

async function main() {
  console.log(`ZZ-2c3b live verification (prefix ${PREFIX})`);

  const existing = await prisma.subject.findFirst({
    where: { name: { startsWith: PREFIX } },
    select: { name: true },
  });
  if (existing) {
    throw new Error(
      `A ${PREFIX} Subject already exists (${existing.name}). Run "npx tsx scripts/zz-cleanup-2c3b.ts --apply" first.`,
    );
  }

  await scenarioA();
  await scenarioB();
  await scenarioC();
  await scenarioD();
  await scenarioE();
}

main()
  .catch((error) => {
    checks++;
    failures++;
    console.error(
      'LIVE TEST ERROR:',
      error instanceof Error
        ? error.message.split('\n').slice(-6).join(' | ')
        : describeError(error),
    );
  })
  .finally(async () => {
    if (failures === 0) {
      console.log('\nALL CHECKS PASSED');
    } else {
      console.log('\nRe-run cleanup: npx tsx scripts/zz-cleanup-2c3b.ts --apply');
    }
    console.log(`${checks} checks, ${checks - failures} passed, ${failures} failed`);
    await prisma.$disconnect();
    process.exit(failures === 0 ? 0 : 1);
  });
