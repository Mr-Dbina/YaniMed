import { afterAll, afterEach, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { GenerationJobRepository } from '../../src/mock-test/generation/generation-job.repository.js';

export function assertTestDb(): void {
  if (process.env.YANIMED_TEST_DB !== '1') {
    throw new Error(
      'Refusing to run M5 database tests: YANIMED_TEST_DB is not 1. Load src/config/load-test-env.ts first.',
    );
  }
}

export const prisma = new PrismaService();
export const repository = new GenerationJobRepository(prisma);

// claimNext is global: any leftover claimable job on the test DB would be
// picked up before the fixture's own job. Only these states are claimable.
const CLAIMABLE_STATES = ['QUEUED', 'RUNNING', 'STALLED', 'CANCELLING'] as const;

export async function deleteClaimableGenerationJobs(): Promise<number> {
  assertTestDb();
  const { count } = await prisma.generationJob.deleteMany({
    where: { state: { in: [...CLAIMABLE_STATES] } },
  });
  return count;
}

const createdSubjectIds: string[] = [];

afterEach(async () => {
  if (createdSubjectIds.length === 0) return;
  await prisma.subject.deleteMany({
    where: { id: { in: createdSubjectIds } },
  });
  createdSubjectIds.length = 0;
});

beforeAll(async () => {
  await deleteClaimableGenerationJobs();
});

afterAll(async () => {
  await deleteClaimableGenerationJobs();
  await prisma.$disconnect();
});

export async function createReadySubject(documentCount = 1) {
  assertTestDb();

  const subject = await prisma.subject.create({
    data: { name: `ZZ-m5-${randomUUID()}` },
  });
  createdSubjectIds.push(subject.id);

  const documents = [];
  for (let index = 0; index < documentCount; index += 1) {
    documents.push(
      await prisma.document.create({
        data: {
          subjectId: subject.id,
          title: `ZZ-m5 document ${index + 1}`,
          fileUrl: `ZZ-m5/${randomUUID()}.pdf`,
          fileSize: 1,
          pageCount: 60,
          status: 'READY',
        },
      }),
    );
  }

  return { subject, documents };
}
