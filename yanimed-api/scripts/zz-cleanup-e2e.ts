import '../src/config/load-local-env.js';
import { PrismaClient } from '@prisma/client';

const PREFIX = 'ZZ-e2e-';
const PDF_PREFIX = 'ZZ-e2e-pdf/';
const apply = process.argv.includes('--apply');
const prisma = new PrismaClient();

async function main(): Promise<void> {
  try {
    const subjects = await prisma.subject.findMany({
      where: { name: { startsWith: PREFIX } },
      select: { id: true, name: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const subjectIds = subjects.map((subject) => subject.id);

    const docs = await prisma.document.findMany({
      where: { subjectId: { in: subjectIds } },
      select: { id: true, title: true, fileUrl: true, pdfObjectId: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const docIds = docs.map((doc) => doc.id);
    const docPdfIds = [
      ...new Set(
        docs
          .map((doc) => doc.pdfObjectId)
          .filter((value): value is string => value !== null),
      ),
    ];

    const [pages, chunks, jobs, uploads, pdfs] = await Promise.all([
      prisma.documentPage.findMany({
        where: { documentId: { in: docIds } },
        select: { id: true, documentId: true, pageNumber: true },
        orderBy: [{ documentId: 'asc' }, { pageNumber: 'asc' }],
      }),
      prisma.chunk.findMany({
        where: { documentId: { in: docIds } },
        select: { id: true, documentId: true, chunkIndex: true },
        orderBy: [{ documentId: 'asc' }, { chunkIndex: 'asc' }],
      }),
      prisma.processingJob.findMany({
        where: { documentId: { in: docIds } },
        select: { id: true, documentId: true, status: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      prisma.uploadAttempt.findMany({
        where: {
          OR: [
            { subjectId: { in: subjectIds } },
            { documentId: { in: docIds } },
          ],
        },
        select: {
          id: true,
          subjectId: true,
          documentId: true,
          objectKey: true,
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      prisma.pdfObject.findMany({
        where: {
          OR: [
            { id: { in: docPdfIds } },
            { r2Key: { startsWith: PDF_PREFIX } },
          ],
        },
        select: { id: true, r2Key: true, sizeBytes: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    ]);

    const pageIds = pages.map((page) => page.id);
    const chunkIds = chunks.map((chunk) => chunk.id);
    const citations = await prisma.messageCitation.findMany({
      where: {
        OR: [{ documentId: { in: docIds } }, { chunkId: { in: chunkIds } }],
      },
      select: { id: true, messageId: true, documentId: true, chunkId: true },
      orderBy: { id: 'asc' },
    });
    const jobIds = jobs.map((job) => job.id);
    const uploadIds = uploads.map((upload) => upload.id);
    const citationIds = citations.map((citation) => citation.id);
    const pdfIds = pdfs.map((pdf) => pdf.id);

    const sharedPdfObjects =
      pdfIds.length === 0
        ? 0
        : await prisma.document.count({
            where: {
              pdfObjectId: { in: pdfIds },
              NOT: { subjectId: { in: subjectIds } },
            },
          });

    console.log(
      `${apply ? 'APPLY' : 'DRY RUN'}: subjects=${subjects.length} documents=${docs.length} pages=${pages.length} chunks=${chunks.length} jobs=${jobs.length} citations=${citations.length} uploadAttempts=${uploads.length} pdfObjects=${pdfs.length} sharedPdfObjects=${sharedPdfObjects}`,
    );

    for (const subject of subjects)
      console.log('  subject', subject.id, subject.name);
    for (const doc of docs)
      console.log('  document', doc.id, doc.title, doc.fileUrl);
    for (const page of pages)
      console.log(
        '  documentPage',
        page.id,
        page.documentId,
        `page=${page.pageNumber}`,
      );
    for (const chunk of chunks)
      console.log(
        '  chunk',
        chunk.id,
        chunk.documentId,
        `index=${chunk.chunkIndex}`,
      );
    for (const job of jobs)
      console.log('  processingJob', job.id, job.documentId, job.status);
    for (const citation of citations)
      console.log(
        '  messageCitation',
        citation.id,
        citation.documentId,
        citation.chunkId,
      );
    for (const upload of uploads)
      console.log(
        '  uploadAttempt',
        upload.id,
        upload.subjectId,
        upload.documentId,
        upload.objectKey,
      );
    for (const pdf of pdfs)
      console.log('  pdfObject', pdf.id, pdf.r2Key, pdf.sizeBytes);

    if (sharedPdfObjects > 0) {
      console.log(
        `WARNING: ${sharedPdfObjects} Document(s) outside ${PREFIX} subjects reference selected PdfObjects; --apply will refuse to delete.`,
      );
    }

    if (!apply) {
      console.log(
        'Nothing deleted. Re-run with --apply to delete exactly the rows above.',
      );
      if (pdfs.length > 0) {
        console.log(
          'R2 objects are not deleted by this script. Remaining keys to review:',
        );
        for (const pdf of pdfs) console.log('  r2Key', pdf.r2Key);
      }
      return;
    }

    await prisma.$transaction(
      async (tx) => {
        const sharedPdf =
          pdfIds.length === 0
            ? 0
            : await tx.document.count({
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

        if (citationIds.length > 0) {
          await tx.messageCitation.deleteMany({
            where: { id: { in: citationIds } },
          });
        }
        if (chunkIds.length > 0) {
          await tx.chunk.deleteMany({ where: { id: { in: chunkIds } } });
        }
        if (pageIds.length > 0) {
          await tx.documentPage.deleteMany({ where: { id: { in: pageIds } } });
        }
        if (jobIds.length > 0) {
          await tx.processingJob.deleteMany({ where: { id: { in: jobIds } } });
        }
        if (uploadIds.length > 0) {
          await tx.uploadAttempt.deleteMany({
            where: { id: { in: uploadIds } },
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
      },
      { timeout: 60_000, maxWait: 10_000 },
    );

    const remaining = {
      subjects: await prisma.subject.count({
        where: { name: { startsWith: PREFIX } },
      }),
      documents: await prisma.document.count({
        where: { subjectId: { in: subjectIds } },
      }),
      pages: await prisma.documentPage.count({
        where: { id: { in: pageIds } },
      }),
      chunks: await prisma.chunk.count({
        where: { id: { in: chunkIds } },
      }),
      jobs: await prisma.processingJob.count({
        where: { id: { in: jobIds } },
      }),
      citations: await prisma.messageCitation.count({
        where: { id: { in: citationIds } },
      }),
      uploadAttempts: await prisma.uploadAttempt.count({
        where: {
          OR: [
            { id: { in: uploadIds } },
            { subjectId: { in: subjectIds } },
            { documentId: { in: docIds } },
          ],
        },
      }),
      pdfObjects: await prisma.pdfObject.count({
        where: {
          OR: [{ id: { in: pdfIds } }, { r2Key: { startsWith: PDF_PREFIX } }],
        },
      }),
    };

    console.log('Remaining after delete:', remaining);
    if (Object.values(remaining).some((count) => count !== 0)) {
      throw new Error(`Cleanup left rows behind: ${JSON.stringify(remaining)}`);
    }

    console.log('Deleted database rows.');
    if (pdfs.length > 0) {
      console.log('R2 objects were not deleted. Keys left for manual review:');
      for (const pdf of pdfs) console.log('  r2Key', pdf.r2Key);
    }
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
