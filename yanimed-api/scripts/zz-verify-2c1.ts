import '../src/config/load-local-env.js';
import { PrismaClient } from '@prisma/client';

async function main() {
  const prisma = new PrismaClient();
  try {
    const mig = await prisma.$queryRaw<
      Array<{
        migration_name: string;
        finished_at: Date | null;
        rolled_back_at: Date | null;
      }>
    >`
      SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations
      WHERE migration_name = '20261028120000_processing_jobs'`;
    console.log('ledger:', JSON.stringify(mig));

    const enumVals = await prisma.$queryRaw<Array<{ enumlabel: string }>>`
      SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'ProcessingJobStatus' ORDER BY e.enumsortorder`;
    console.log('enum values:', enumVals.map((v) => v.enumlabel).join(', '));

    const cols = await prisma.$queryRaw<
      Array<{
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>
    >`
      SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'ProcessingJob' ORDER BY ordinal_position`;
    for (const c of cols)
      console.log(
        ' col',
        c.column_name,
        c.data_type,
        c.is_nullable,
        c.column_default ?? '',
      );

    const idx = await prisma.$queryRaw<
      Array<{ indexname: string; indexdef: string }>
    >`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'ProcessingJob' ORDER BY indexname`;
    for (const i of idx) console.log(' idx', i.indexdef);

    const con = await prisma.$queryRaw<Array<{ conname: string; def: string }>>`
      SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'public."ProcessingJob"'::regclass ORDER BY conname`;
    for (const c of con) console.log(' con', c.conname, c.def);

    const n = await prisma.$queryRaw<
      Array<{ n: bigint }>
    >`SELECT COUNT(*) AS n FROM "ProcessingJob"`;
    console.log('row count:', Number(n[0].n));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(
    'VERIFY FAILED:',
    e instanceof Error ? e.message.split('\n').slice(-3).join(' | ') : e,
  );
  process.exit(1);
});
