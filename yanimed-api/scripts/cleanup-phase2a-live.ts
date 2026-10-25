import { PrismaClient } from '@prisma/client';
import { S3Client, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';

const execute = process.argv.includes('--execute');
const ids = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
if (ids.length !== 2) {
  console.error('Usage: npx tsx cleanup-phase2a-live.ts <subjectAId> <subjectBId> [--execute]');
  process.exit(1);
}

const prisma = new PrismaClient();
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
  const subjects = await prisma.subject.findMany({ where: { id: { in: ids } } });
  if (subjects.length !== 2 || subjects.some(subject => !subject.name.startsWith('ZZ-PHASE2A-TEST'))) {
    throw new Error('Refusing cleanup: subjects must exist and both names must start with ZZ-PHASE2A-TEST.');
  }

  const documents = await prisma.document.findMany({ where: { subjectId: { in: ids } } });
  const uploadAttempts = await prisma.uploadAttempt.findMany({ where: { subjectId: { in: ids } } });
  const pdfObjectIds = [...new Set(documents.map(document => document.pdfObjectId).filter(Boolean))] as string[];
  const pdfObjects = pdfObjectIds.length ? await prisma.pdfObject.findMany({ where: { id: { in: pdfObjectIds } } }) : [];

  console.log('DRY RUN:', !execute);
  console.log('SUBJECTS:', subjects.map(s => s.id));
  console.log('DOCUMENTS:', documents.map(d => d.id));
  console.log('UPLOAD_ATTEMPTS:', uploadAttempts.map(a => a.id));
  console.log('PDF_OBJECTS:', pdfObjects.map(p => p.id));
  console.log('STAGING_KEYS:', uploadAttempts.map(a => a.objectKey));
  console.log('CANONICAL_KEYS:', pdfObjects.map(p => p.r2Key));

  if (!execute) {
    console.log('No changes made. Re-run with --execute to delete.');
    return;
  }

  await prisma.$transaction(async tx => {
    await tx.messageCitation.deleteMany({ where: { documentId: { in: documents.map(d => d.id) } } });
    await tx.message.deleteMany({ where: { chatId: { in: (await tx.chat.findMany({ where: { subjectId: { in: ids } }, select: { id: true } })).map(c => c.id) } } });
    await tx.chat.deleteMany({ where: { subjectId: { in: ids } } });
    await tx.chunk.deleteMany({ where: { documentId: { in: documents.map(d => d.id) } } });
    await tx.documentPage.deleteMany({ where: { documentId: { in: documents.map(d => d.id) } } });
    await tx.uploadAttempt.deleteMany({ where: { subjectId: { in: ids } } });
    await tx.deletionJob.deleteMany({ where: { subjectId: { in: ids } } });
    await tx.document.deleteMany({ where: { subjectId: { in: ids } } });
    await tx.subject.deleteMany({ where: { id: { in: ids } } });

    for (const pdfObject of pdfObjects) {
      const remaining = await tx.document.count({ where: { pdfObjectId: pdfObject.id } });
      if (remaining === 0) {
        await tx.pdfObject.delete({ where: { id: pdfObject.id } });
      } else {
        console.log('KEEPING_PDF_OBJECT_WITH_REMAINING_REFERENCES:', pdfObject.id, remaining);
      }
    }
  });

  for (const attempt of uploadAttempts) {
    const existing = await head(attempt.objectKey);
    if (existing.exists) {
      console.log('DELETING_STAGING:', attempt.objectKey);
      await r2.send(new DeleteObjectCommand({ Bucket: bucket, Key: attempt.objectKey }));
    }
  }

  for (const pdfObject of pdfObjects) {
    const remaining = await prisma.document.count({ where: { pdfObjectId: pdfObject.id } });
    if (remaining === 0 && pdfObject.r2Key === `pdfs/${pdfObject.sha256}.pdf`) {
      const existing = await head(pdfObject.r2Key);
      if (existing.exists) {
        console.log('DELETING_CANONICAL:', pdfObject.r2Key);
        await r2.send(new DeleteObjectCommand({ Bucket: bucket, Key: pdfObject.r2Key }));
      }
    } else {
      console.log('KEEPING_CANONICAL:', pdfObject.r2Key, 'remainingDocuments=' + remaining);
    }
  }
}

main().catch(error => {
  console.error('CLEANUP FAILED:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
