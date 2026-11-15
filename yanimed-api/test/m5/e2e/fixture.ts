import { randomUUID } from 'node:crypto';
import { assertTestDb, prisma } from '../helpers.js';

/**
 * M5 step 14a fixture. One READY document with 30 eligible chunks on 30
 * distinct pages, grouped into 13 well-separated embedding clusters.
 *
 * Page text and chunk text are identical, so a sentence the fake AI copies
 * from a seed chunk is always present on the cited page.
 */
export const E2E_PREFIX = 'ZZ-e2e-';

/** Four clusters of 3 chunks and nine of 2: 30 chunks, every cluster >= 2. */
const GROUP_SIZES = [3, 3, 3, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2] as const;

export const E2E_PAGE_COUNT = GROUP_SIZES.reduce((sum, size) => sum + size, 0);

export const E2E_EMBEDDING_DIMENSIONS = 768;

/** One page of plain, quotable prose. No headings, tags, lists or dot leaders. */
export function e2ePageText(group: number, page: number): string {
  const label = group + 1;
  return [
    `Page ${page} of the review describes topic group ${label}.`,
    `The essential finding on page ${page} is that marker ${label} stays stable during routine review.`,
    `Reviewers record this observation for topic group ${label} on every pass.`,
    `The supporting note confirms that marker ${label} remains unchanged after the follow-up check.`,
  ].join(' ');
}

/** Two dominant dimensions per group, all groups far apart in cosine distance. */
export function e2eEmbedding(group: number, chunkIndex: number): number[] {
  const vector = Array.from(
    { length: E2E_EMBEDDING_DIMENSIONS },
    () => 0,
  );
  vector[group * 50] = 1;
  vector[group * 50 + 1] = 0.85 + 0.01 * chunkIndex;
  return vector;
}

function toVectorText(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}

export interface E2eFixture {
  subjectId: string;
  subjectName: string;
  documentId: string;
  documentTitle: string;
  pageCount: number;
  /** Physical page -> embedding group, for assertions and debugging. */
  groupOfPage: Map<number, number>;
}

export async function createE2eFixture(): Promise<E2eFixture> {
  assertTestDb();

  const pages: { pageNumber: number; text: string; group: number }[] = [];
  for (let group = 0; group < GROUP_SIZES.length; group += 1) {
    for (let index = 0; index < GROUP_SIZES[group]; index += 1) {
      const pageNumber = pages.length + 1;
      pages.push({
        pageNumber,
        text: e2ePageText(group, pageNumber),
        group,
      });
    }
  }

  const subjectName = `${E2E_PREFIX}${randomUUID()}`;
  const subject = await prisma.subject.create({ data: { name: subjectName } });

  const documentTitle = `ZZ-e2e source ${randomUUID()}`;
  const document = await prisma.document.create({
    data: {
      subjectId: subject.id,
      title: documentTitle,
      fileUrl: `ZZ-e2e/${randomUUID()}.pdf`,
      fileSize: 1,
      pageCount: E2E_PAGE_COUNT,
      status: 'READY',
    },
  });

  await prisma.documentPage.createMany({
    data: pages.map((page) => ({
      documentId: document.id,
      pageNumber: page.pageNumber,
      text: page.text,
      charCount: page.text.length,
    })),
  });

  await prisma.chunk.createMany({
    data: pages.map((page) => ({
      documentId: document.id,
      content: page.text,
      page: page.pageNumber,
      chunkIndex: page.pageNumber,
      needsReview: false,
    })),
  });

  const chunkRows = await prisma.chunk.findMany({
    where: { documentId: document.id },
    select: { id: true, page: true },
    orderBy: { page: 'asc' },
  });

  const groupOfPage = new Map(pages.map((page) => [page.pageNumber, page.group]));
  await prisma.$transaction(
    chunkRows.map((chunk) => {
      const group = groupOfPage.get(chunk.page) ?? 0;
      return prisma.$executeRaw`
        UPDATE "Chunk"
        SET "embedding" = ${toVectorText(e2eEmbedding(group, chunk.page))}::vector
        WHERE "id" = ${chunk.id}
      `;
    }),
  );

  return {
    subjectId: subject.id,
    subjectName,
    documentId: document.id,
    documentTitle,
    pageCount: E2E_PAGE_COUNT,
    groupOfPage,
  };
}

/** Removes only ZZ-e2e- subjects. The Subject cascade clears the rest. */
export async function deleteE2eFixtures(): Promise<void> {
  assertTestDb();
  await prisma.subject.deleteMany({
    where: { name: { startsWith: E2E_PREFIX } },
  });
}
