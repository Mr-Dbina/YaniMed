import { PrismaClient } from '@prisma/client';
import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3';

const prisma = new PrismaClient();
const subjectIds = process.argv.slice(2);
if (subjectIds.length !== 2) {
  console.error('Usage: npx tsx verify-phase2a-live.ts <subjectAId> <subjectBId>');
  process.exit(1);
}

import { readFileSync } from 'node:fs';
for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (!match) continue;
  const key = match[1];
  const value = match[2].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  if (!(key in process.env)) process.env[key] = value;
}

const r2 = new S3Client({
  maxAttempts: 1,
  region: process.env.R2_JURISDICTION || 'auto',
  endpoint: process.env.R2_ENDPOINT!,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});
const bucket = process.env.R2_BUCKET_NAME!;

async function head(key: string) {
  try {
    const result = await r2.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return { exists: true, size: result.ContentLength ?? -1 };
  } catch (error) {
    if ((error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 404) return { exists: false, size: -1 };
    throw error;
  }
}

async function main() {
  const subjects = await prisma.subject.findMany({ where: { id: { in: subjectIds } }, include: { documents: true, initialUpload: true } });
  console.log('COUNTS:', JSON.stringify({
    subjects: await prisma.subject.count(),
    documents: await prisma.document.count(),
    pdfObjects: await prisma.pdfObject.count(),
    uploadAttempts: await prisma.uploadAttempt.count(),
    documentPages: await prisma.documentPage.count(),
    chunks: await prisma.chunk.count(),
    deletionJobs: await prisma.deletionJob.count(),
  }));

  for (const subject of subjects) {
    console.log('SUBJECT:', subject.id, subject.name, 'documents=' + subject.documents.length);
    for (const document of subject.documents) {
      console.log('  DOCUMENT:', document.id, document.title, document.status, 'fileUrl=' + document.fileUrl, 'pdfObjectId=' + document.pdfObjectId);
      const pdfObject = document.pdfObjectId ? await prisma.pdfObject.findUnique({ where: { id: document.pdfObjectId } }) : null;
      console.log('  PDF_OBJECT:', pdfObject ? `${pdfObject.id} sha256=${pdfObject.sha256} r2Key=${pdfObject.r2Key} sizeBytes=${pdfObject.sizeBytes}` : 'MISSING');
      if (pdfObject) {
        const canonicalHead = await head(pdfObject.r2Key);
        console.log('  CANONICAL_HEAD:', pdfObject.r2Key, canonicalHead.exists ? `exists size=${canonicalHead.size}` : 'MISSING');
        console.log('  ASSERT canonical key equals pdfs/<sha256>.pdf:', pdfObject.r2Key === `pdfs/${pdfObject.sha256}.pdf` ? 'PASS' : 'FAIL');
        console.log('  ASSERT document.fileUrl equals pdfObject.r2Key:', document.fileUrl === pdfObject.r2Key ? 'PASS' : 'FAIL');
        console.log('  ASSERT canonical size equals sizeBytes:', canonicalHead.exists && canonicalHead.size === pdfObject.sizeBytes ? 'PASS' : 'FAIL');
      }
      if (subject.initialUpload?.objectKey) {
        const stagingHead = await head(subject.initialUpload.objectKey);
        console.log('  STAGING_HEAD:', subject.initialUpload.objectKey, stagingHead.exists ? 'EXISTS (unexpected)' : 'absent (expected)');
      }
    }
  }

  const allDocuments = subjects.flatMap(subject => subject.documents);
  const pdfObjectIds = allDocuments.map(document => document.pdfObjectId).filter(Boolean) as string[];
  const samePdfObject = pdfObjectIds.length > 0 && pdfObjectIds.every(id => id === pdfObjectIds[0]);
  const sha256 = pdfObjectIds.length ? (await prisma.pdfObject.findUnique({ where: { id: pdfObjectIds[0] } }))?.sha256 : null;
  const pdfObjectCount = sha256 ? await prisma.pdfObject.count({ where: { sha256 } }) : 0;
  const titles = allDocuments.map(document => document.title);
  const sameTitle = titles.length > 1 && titles.every(title => title === titles[0]);

  console.log('ASSERT both Documents share one pdfObjectId:', samePdfObject ? 'PASS' : 'FAIL');
  console.log('ASSERT exactly one PdfObject for sha256:', pdfObjectCount === 1 ? 'PASS' : 'FAIL');
  console.log('ASSERT Document B title equals Document A title (keep_existing):', sameTitle ? 'PASS' : 'FAIL');

  const shared = await prisma.pdfObject.groupBy({ by: ['sha256'], _count: { sha256: true }, having: { sha256: { _count: { gt: 1 } } } });
  console.log('DUPLICATE_PDF_OBJECT_SHA256_ROWS:', shared.length === 0 ? 'PASS' : 'FAIL');
}

main().catch(error => {
  console.error('VERIFY FAILED:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
