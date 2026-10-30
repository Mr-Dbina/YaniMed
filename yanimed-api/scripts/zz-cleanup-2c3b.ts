import '../src/config/load-local-env.js';
import { PrismaClient } from '@prisma/client';

const PREFIX = 'ZZ-2c3b-';
const PDF_PREFIX = `${PREFIX}pdf/`;
const apply = process.argv.includes('--apply');

async function main() {
  const prisma = new PrismaClient();
  try {
    const subjects = await prisma.subject.findMany({
      where: { name: { startsWith: PREFIX } },
      select: { id: true, name: true },
    });
    const subjectIds = subjects.map((subject) => subject.id);

    const docs = await prisma.document.findMany({
      where: { subjectId: { in: subjectIds } },
      select: { id: true, title: true, pdfObjectId: true },
    });
    const docIds = docs.map((doc) => doc.id);
    const docPdfIds = [
      ...new Set(
        docs
          .map((doc) => doc.pdfObjectId)
          .filter((value): value is string => value !== null),
      ),
    ];

    const jobs = await prisma.processingJob.findMany({
      where: { documentId: { in: docIds } },
      select: { id: true },
    });
    const uploads = await prisma.uploadAttempt.findMany({
      where: {
        OR: [
          { subjectId: { in: subjectIds } },
          { documentId: { in: docIds } },
        ],
      },
      select: { id: true },
    });
    const pdfs = await prisma.pdfObject.findMany({
      where: {
        OR: [
          { id: { in: docPdfIds } },
          { r2Key: { startsWith: PDF_PREFIX } },
        ],
      },
      select: { id: true, r2Key: true },
    });
    const pdfIds = pdfs.map((pdf) => pdf.id);
    const sharedPdfObjects = await prisma.document.count({
      where: {
        pdfObjectId: { in: pdfIds },
        NOT: { subjectId: { in: subjectIds } },
      },
    });

    console.log(
      `${apply ? 'APPLY' : 'DRY RUN'}: subjects=${subjects.length} documents=${docs.length} jobs=${jobs.length} uploadAttempts=${uploads.length} pdfObjects=${pdfs.length} sharedPdfObjects=${sharedPdfObjects}`,
    );
    for (const subject of subjects) {
      console.log('  subject', subject.id, subject.name);
    }
    for (const doc of docs) {
      console.log('  document', doc.id, doc.title);
    }
    for (const job of jobs) {
      console.log('  processingJob', job.id);
    }
    for (const upload of uploads) {
      console.log('  uploadAttempt', upload.id);
    }
    for (const pdf of pdfs) {
      console.log('  pdfObject', pdf.id, pdf.r2Key);
    }
    console.log(
      `  Shared-PdfObject check: ${sharedPdfObjects === 0
        ? `no non-${PREFIX} Document references selected PdfObjects`
        : `${sharedPdfObjects} non-${PREFIX} Document(s) reference selected PdfObjects`}`,
    );
    if (sharedPdfObjects > 0) {
      console.log(
        `WARNING: ${sharedPdfObjects} Document(s) outside ${PREFIX} subjects reference these PdfObjects; --apply will refuse to delete.`,
      );
    }

    if (!apply) {
      console.log(
        'Nothing deleted. Re-run with --apply to delete exactly the rows above.',
      );
      return;
    }

    await prisma.$transaction(async (tx) => {
      const sharedPdf = await tx.document.count({
        where: {
          pdfObjectId: { in: pdfIds },
          NOT: { subjectId: { in: subjectIds } },
        },
      });
      if (sharedPdf > 0) {
        throw new Error(
          `Refusing to delete ${sharedPdf} PdfObject reference(s) owned by non-${PREFIX} documents.`,
        );
      }

      if (jobs.length > 0) {
        await tx.processingJob.deleteMany({
          where: { id: { in: jobs.map((job) => job.id) } },
        });
      }
      if (uploads.length > 0) {
        await tx.uploadAttempt.deleteMany({
          where: { id: { in: uploads.map((upload) => upload.id) } },
        });
      }
      if (docIds.length > 0) {
        await tx.document.deleteMany({ where: { id: { in: docIds } } });
      }
      if (pdfIds.length > 0) {
        await tx.pdfObject.deleteMany({ where: { id: { in: pdfIds } } });
      }
      if (subjectIds.length > 0) {
        await tx.subject.deleteMany({ where: { id: { in: subjectIds } } });
      }
    }, { timeout: 60000, maxWait: 10000 });

    const remaining = {
      subjects: await prisma.subject.count({
        where: { name: { startsWith: PREFIX } },
      }),
      documents: await prisma.document.count({
        where: { subjectId: { in: subjectIds } },
      }),
      jobs: await prisma.processingJob.count({
        where: { documentId: { in: docIds } },
      }),
      uploadAttempts: await prisma.uploadAttempt.count({
        where: {
          OR: [
            { subjectId: { in: subjectIds } },
            { documentId: { in: docIds } },
          ],
        },
      }),
      pdfObjects: await prisma.pdfObject.count({
        where: {
          OR: [
            { id: { in: pdfIds } },
            { r2Key: { startsWith: PDF_PREFIX } },
          ],
        },
      }),
    };
    console.log('Remaining after delete:', remaining);

    if (Object.values(remaining).some((count) => count !== 0)) {
      throw new Error(
        `Cleanup left rows behind: ${JSON.stringify(remaining)}`,
      );
    }
    console.log('Deleted.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(
    'CLEANUP FAILED:',
    error instanceof Error
      ? error.message.split('\n').slice(-3).join(' | ')
      : error,
  );
  process.exit(1);
});
