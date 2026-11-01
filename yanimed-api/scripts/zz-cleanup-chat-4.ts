/// <reference types="node" />
import '../src/config/load-local-env.js';
import { PrismaClient } from '@prisma/client';

const PREFIX = 'ZZ-chat4-';
const apply = process.argv.includes('--apply');
const prisma = new PrismaClient();

function json(value: unknown): string {
  return JSON.stringify(value) ?? 'null';
}

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
      select: { id: true, pdfObjectId: true },
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

    const [pages, chunks, jobs, uploads, chats, pdfs] = await Promise.all([
      prisma.documentPage.findMany({
        where: { documentId: { in: docIds } },
        select: { id: true },
      }),
      prisma.chunk.findMany({
        where: { documentId: { in: docIds } },
        select: { id: true },
      }),
      prisma.processingJob.findMany({
        where: { documentId: { in: docIds } },
        select: { id: true },
      }),
      prisma.uploadAttempt.findMany({
        where: {
          OR: [
            { subjectId: { in: subjectIds } },
            { documentId: { in: docIds } },
          ],
        },
        select: { id: true },
      }),
      prisma.chat.findMany({
        where: { subjectId: { in: subjectIds } },
        select: { id: true },
      }),
      prisma.pdfObject.findMany({
        where: { id: { in: docPdfIds } },
        select: { id: true, r2Key: true, sizeBytes: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    ]);

    const pageIds = pages.map((page) => page.id);
    const chunkIds = chunks.map((chunk) => chunk.id);
    const jobIds = jobs.map((job) => job.id);
    const uploadIds = uploads.map((upload) => upload.id);
    const chatIds = chats.map((chat) => chat.id);
    const pdfIds = pdfs.map((pdf) => pdf.id);

    const messages = await prisma.message.findMany({
      where: { chatId: { in: chatIds } },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    const messageIds = messages.map((message) => message.id);

    const citations = await prisma.messageCitation.findMany({
      where: { messageId: { in: messageIds } },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    const citationIds = citations.map((citation) => citation.id);

    const sharedPdfObjects =
      pdfIds.length === 0
        ? 0
        : await prisma.document.count({
            where: {
              pdfObjectId: { in: pdfIds },
              NOT: { subjectId: { in: subjectIds } },
            },
          });

    const counts = {
      subjects: subjects.length,
      documents: docs.length,
      pages: pages.length,
      chunks: chunks.length,
      jobs: jobs.length,
      chats: chats.length,
      messages: messages.length,
      citations: citations.length,
      uploadAttempts: uploads.length,
      pdfObjects: pdfs.length,
      sharedPdfObjects,
    };

    console.log(`${apply ? 'APPLY' : 'DRY RUN'}: ${json(counts)}`);

    if (!apply) return;

    if (sharedPdfObjects > 0) {
      throw new Error(
        `Refusing to delete ${sharedPdfObjects} Document(s) outside ${PREFIX} subjects that reference selected PdfObjects.`,
      );
    }

    await prisma.$transaction(
      async (tx) => {
        if (citationIds.length > 0) {
          await tx.messageCitation.deleteMany({
            where: { id: { in: citationIds } },
          });
        }
        if (messageIds.length > 0) {
          await tx.message.deleteMany({ where: { id: { in: messageIds } } });
        }
        if (chatIds.length > 0) {
          await tx.chat.deleteMany({ where: { id: { in: chatIds } } });
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
      chats: await prisma.chat.count({
        where: { id: { in: chatIds } },
      }),
      messages: await prisma.message.count({
        where: { id: { in: messageIds } },
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
        where: { id: { in: pdfIds } },
      }),
    };

    console.log('Remaining after delete:', json(remaining));
    if (Object.values(remaining).some((count) => count !== 0)) {
      throw new Error(`Cleanup left rows behind: ${json(remaining)}`);
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

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((error) => {
    console.error(
      'CLEANUP FAILED:',
      error instanceof Error
        ? error.message.split('\n').slice(-3).join(' | ')
        : error,
    );
    process.exitCode = 1;
  });
