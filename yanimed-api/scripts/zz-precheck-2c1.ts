import '../src/config/load-local-env.js';
import { PrismaClient } from '@prisma/client';

async function main() {
  const prisma = new PrismaClient();
  try {
    const tz = await prisma.$queryRaw<
      Array<{ TimeZone: string }>
    >`SHOW timezone`;
    console.log('timezone:', JSON.stringify(tz));

    const tbl = await prisma.$queryRaw<Array<{ exists: boolean }>>`
      SELECT to_regclass('public."ProcessingJob"') IS NOT NULL AS exists`;
    console.log('ProcessingJob table exists:', JSON.stringify(tbl));

    const typ = await prisma.$queryRaw<Array<{ exists: boolean }>>`
      SELECT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ProcessingJobStatus') AS exists`;
    console.log('ProcessingJobStatus type exists:', JSON.stringify(typ));

    const dup1 = await prisma.$queryRaw<
      Array<{ subjectId: string; pdfObjectId: string; n: bigint }>
    >`
      SELECT "subjectId", "pdfObjectId", COUNT(*) AS n FROM "Document"
      WHERE "pdfObjectId" IS NOT NULL GROUP BY 1, 2 HAVING COUNT(*) > 1`;
    console.log('duplicate (subjectId, pdfObjectId) groups:', dup1.length);

    const byStatus = await prisma.$queryRaw<
      Array<{ status: string; n: bigint }>
    >`
      SELECT "status"::text AS status, COUNT(*) AS n FROM "Document" GROUP BY 1`;
    console.log(
      'documents by status:',
      JSON.stringify(byStatus, (_, v) =>
        typeof v === 'bigint' ? Number(v) : v,
      ),
    );

    const mig = await prisma.$queryRaw<
      Array<{ migration_name: string; finished_at: Date | null }>
    >`
      SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY started_at`;
    console.log('applied migrations:', mig.length);
    for (const m of mig)
      console.log(' ', m.migration_name, m.finished_at ? 'ok' : 'NOT FINISHED');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(
    'PRECHECK FAILED:',
    e instanceof Error ? e.message.split('\n').slice(-3).join(' | ') : e,
  );
  process.exit(1);
});
