import '../src/config/load-local-env.js';
import { PrismaClient } from '@prisma/client';

const PREFIX = 'ZZ-2c2-';
const apply = process.argv.includes('--apply');

async function main() {
  const prisma = new PrismaClient();
  try {
    const subjects = await prisma.subject.findMany({
      where: { name: { startsWith: PREFIX } },
      select: { id: true, name: true },
    });
    const ids = subjects.map((s) => s.id);
    const docs = await prisma.document.findMany({
      where: { subjectId: { in: ids } },
      select: { id: true },
    });
    const docIds = docs.map((d) => d.id);
    const jobs = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT COUNT(*) AS n FROM "ProcessingJob" WHERE "documentId" = ANY(${docIds}::text[])`;
    console.log(
      `${apply ? 'APPLY' : 'DRY RUN'}: subjects=${subjects.length} documents=${docs.length} jobs=${Number(jobs[0].n)}`,
    );
    for (const s of subjects) console.log('  subject', s.name);
    if (!apply) {
      console.log(
        'Nothing deleted. Re-run with --apply to delete exactly the rows above.',
      );
      return;
    }
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`DELETE FROM "ProcessingJob" WHERE "documentId" = ANY(${docIds}::text[])`;
      await tx.document.deleteMany({ where: { subjectId: { in: ids } } });
      await tx.subject.deleteMany({ where: { id: { in: ids } } });
    });
    console.log('Deleted.');
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((e) => {
  console.error(
    'CLEANUP FAILED:',
    e instanceof Error ? e.message.split('\n').slice(-3).join(' | ') : e,
  );
  process.exit(1);
});
