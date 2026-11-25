/// <reference types="node" />
import '../src/config/load-local-env.js';
import { PrismaClient } from '@prisma/client';

/**
 * Quarantines the four approved Pediatrics questions that cite front-matter
 * pages. Dry run by default; writes only with --apply.
 *
 *   npx tsx scripts/quarantine-front-matter-questions.ts
 *   npx tsx scripts/quarantine-front-matter-questions.ts --apply
 */

const TARGET_QUESTION_IDS = [
  'ffc40e0c-2ad9-42a0-bc47-991707f381f0',
  '9c3cd11f-96a4-4293-b43c-05da2051989d',
  '06817b74-af11-4529-8698-a1cfd2d4cbeb',
  'd150fce8-ce48-4233-b0f8-a4dce13bca00',
] as const;

const SUBJECT_ID = '974c0df4-37df-4efd-8308-45fe03820d5b';

const APPLY = process.argv.includes('--apply');

const prisma = new PrismaClient();

async function main() {
  console.log(APPLY ? 'APPLY MODE' : 'DRY RUN, NO WRITES');

  const rows = await prisma.mockQuestion.findMany({
    where: { id: { in: [...TARGET_QUESTION_IDS] } },
    select: { id: true, status: true, subjectId: true },
  });

  const byId = new Map(rows.map((row) => [row.id, row]));

  for (const id of TARGET_QUESTION_IDS) {
    const row = byId.get(id);
    console.log(
      `id=${id} found=${row ? 'yes' : 'no'} status=${row ? row.status : 'none'} ` +
        `subjectMatch=${row && row.subjectId === SUBJECT_ID ? 'yes' : 'no'}`,
    );
  }

  const eligible = rows.filter(
    (row) => row.status === 'ACTIVE' && row.subjectId === SUBJECT_ID,
  );

  if (!APPLY) {
    console.log(`would change ${eligible.length}`);
    if (rows.length !== TARGET_QUESTION_IDS.length) {
      console.log('refusing to apply: expected exactly 4 rows');
      process.exitCode = 1;
    } else if (rows.some((row) => row.subjectId !== SUBJECT_ID)) {
      console.log('refusing to apply: at least one row is outside the Pediatrics subject');
      process.exitCode = 1;
    }
    return;
  }

  if (rows.length !== TARGET_QUESTION_IDS.length) {
    console.log(
      `refusing to apply: expected exactly ${TARGET_QUESTION_IDS.length} rows, found ${rows.length}`,
    );
    process.exitCode = 1;
    return;
  }

  const subjectMismatch = rows.filter((row) => row.subjectId !== SUBJECT_ID);
  if (subjectMismatch.length > 0) {
    console.log(`refusing to apply: ${subjectMismatch.length} row(s) outside subject ${SUBJECT_ID}`);
    process.exitCode = 1;
    return;
  }

  const changed = await prisma.mockQuestion.updateMany({
    where: {
      id: { in: [...TARGET_QUESTION_IDS] },
      subjectId: SUBJECT_ID,
      status: 'ACTIVE',
    },
    data: { status: 'QUARANTINED' },
  });
  console.log(`changed=${changed.count}`);

  const after = await prisma.mockQuestion.findMany({
    where: { id: { in: [...TARGET_QUESTION_IDS] } },
    select: { id: true, status: true },
  });
  const statusById = new Map(after.map((row) => [row.id, row.status]));
  for (const id of TARGET_QUESTION_IDS) {
    console.log(`id=${id} status=${statusById.get(id) ?? 'none'}`);
  }

  const activeTotal = await prisma.mockQuestion.count({
    where: { subjectId: SUBJECT_ID, status: 'ACTIVE' },
  });
  console.log(`activeTotal=${activeTotal}`);
}

main().catch((error: unknown) => {
  console.error('error:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}).finally(async () => {
  await prisma.$disconnect();
});
