/** Explicit opt-in integration check. All test inserts are rolled back.
 * Run after deployment: npx tsx scripts/verify-subject-name-constraints.ts
 * Does not run as part of the ordinary mocked backend test suite.
 */
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { ConflictException } from '@nestjs/common';
import type { PrismaService } from '../src/prisma/prisma.service.js';

function check(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

async function main() {
  const env = parseEnv(readFileSync('.env', 'utf8'));
  check(env.DIRECT_URL, 'DIRECT_URL is missing');
  const url = new URL(env.DIRECT_URL);
  check(env.DIRECT_URL === env.DATABASE_URL &&
    url.hostname === 'aws-0-ap-northeast-1.pooler.supabase.com' &&
    decodeURIComponent(url.username) === 'postgres.fzpiddbndhuiimhgcbmu' &&
    url.port === '5432' && url.pathname === '/postgres' &&
    url.searchParams.get('sslmode') === 'require', 'Target verification failed');
  const prisma = new PrismaClient({ datasources: { db: { url: env.DIRECT_URL } } });
  const fixture = `Pediatrics ${randomUUID()}`;
  const rollback = new Error('Intentional test rollback');
  try {
    const index = await prisma.$queryRaw<{ valid: boolean; unique: boolean; expression: string }[]>`
      SELECT i.indisvalid AS valid, i.indisunique AS unique,
             pg_get_expr(i.indexprs, i.indrelid) AS expression
      FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = 'Subject_name_lower_key' AND i.indrelid = 'public."Subject"'::regclass
    `;
    check(index.length === 1 && index[0].valid && index[0].unique && index[0].expression === 'lower(name)',
      'Unique expression index verification failed');
    const constraints = await prisma.$queryRaw<{ conname: string; convalidated: boolean }[]>`
      SELECT conname, convalidated FROM pg_constraint
      WHERE conrelid = 'public."Subject"'::regclass
        AND conname IN ('Subject_name_nonempty_check', 'Subject_name_trimmed_check')
    `;
    check(constraints.length === 2 && constraints.every(row => row.convalidated), 'CHECK verification failed');
    const history = await prisma.$queryRaw<{ checksum: string; finished_at: Date | null; rolled_back_at: Date | null }[]>`
      SELECT checksum, finished_at, rolled_back_at FROM public._prisma_migrations
      WHERE migration_name = '20261023160000_subject_name_uniqueness'
    `;
    const checksum = createHash('sha256').update(readFileSync(
      'prisma/migrations/20261023160000_subject_name_uniqueness/migration.sql',
    )).digest('hex');
    check(history.length === 1 && history[0].finished_at && !history[0].rolled_back_at &&
      history[0].checksum === checksum, 'Migration history verification failed');

    try {
      await prisma.$transaction(async tx => {
        await tx.subject.create({ data: { name: fixture } });
        // Savepoints recover from expected database errors without committing fixtures.
        async function rejectedByDatabase(name: string, sqlstate: string) {
          await tx.$executeRaw`SAVEPOINT subject_name_test`;
          let code: unknown;
          try {
            await tx.$executeRaw`
              INSERT INTO public."Subject" (id, name, "updatedAt") VALUES (${randomUUID()}, ${name}, CURRENT_TIMESTAMP)
            `;
          } catch (error) {
            if (error instanceof Prisma.PrismaClientKnownRequestError) code = error.meta?.code;
            else throw error;
          } finally {
            await tx.$executeRaw`ROLLBACK TO SAVEPOINT subject_name_test`;
            await tx.$executeRaw`RELEASE SAVEPOINT subject_name_test`;
          }
          check(code === sqlstate, 'Direct database rejection did not match expected SQLSTATE');
        }
        await rejectedByDatabase(fixture.toLowerCase(), '23505');
        for (const name of ['', ' ', '\t\n', ` ${fixture}`, `${fixture} `,
          `\t${fixture}`, `${fixture}\n`, `\u00a0${fixture}`, `${fixture}\ufeff`]) {
          await rejectedByDatabase(name, '23514');
        }
        // PostgreSQL treats %, _ literally with equality, not as LIKE wildcards.
        await tx.subject.create({ data: { name: `${fixture} %_` } });
        await rejectedByDatabase(`${fixture.toUpperCase()} %_`, '23505');

        await tx.$executeRaw`SAVEPOINT subject_name_test`;
        let conflict = false;
        try {
          await tx.subject.create({ data: { name: fixture.toUpperCase() } });
        } catch (error) {
          conflict = error instanceof ConflictException && error.getStatus() === 409;
        } finally {
          await tx.$executeRaw`ROLLBACK TO SAVEPOINT subject_name_test`;
          await tx.$executeRaw`RELEASE SAVEPOINT subject_name_test`;
        }
        check(conflict, 'Real Prisma uniqueness violation was not mapped to HTTP 409');
        throw rollback;
      }, { timeout: 30000 });
    } catch (error) {
      if (error !== rollback) throw error;
    }
    check(await prisma.subject.count({ where: { name: { startsWith: fixture } } }) === 0,
      'Test rollback verification failed');
    console.log('Migration history: PASS; database uniqueness: PASS; database name validation: PASS; real P2002 -> HTTP 409: PASS; fixture rollback: PASS');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(error => {
  // Never print Prisma error messages/meta: they can contain record/connection data.
  console.error('Subject name integration verification: FAIL; category=' +
    (error instanceof Prisma.PrismaClientKnownRequestError ? error.code : 'VerificationError'));
  process.exitCode = 1;
});
