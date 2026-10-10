import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const prisma = new PrismaClient();

async function main() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
      id VARCHAR(36) PRIMARY KEY,
      checksum VARCHAR(64) NOT NULL,
      finished_at TIMESTAMP,
      migration_name VARCHAR(255) NOT NULL,
      logs TEXT,
      rolled_back_at TIMESTAMP,
      started_at TIMESTAMP NOT NULL DEFAULT now(),
      applied_steps_count INTEGER NOT NULL DEFAULT 0
    )`);

  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "_prisma_migrations_finished_at_idx" ON "_prisma_migrations"("finished_at")`,
  );

  const dir = join(process.cwd(), 'prisma', 'migrations');
  const migrations = readdirSync(dir)
    .filter((d) => {
      try {
        readFileSync(join(dir, d, 'migration.sql'));
        return true;
      } catch {
        return false;
      }
    })
    .sort();

  for (const name of migrations) {
    const buf = readFileSync(join(dir, name, 'migration.sql'));
    const checksum = createHash('sha256').update(buf).digest('hex');

    const existing = await prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM "_prisma_migrations" WHERE migration_name = $1`,
      name,
    );
    if (existing.length) {
      await prisma.$executeRawUnsafe(
        `UPDATE "_prisma_migrations" SET checksum = $1 WHERE migration_name = $2`,
        checksum,
        name,
      );
      console.log(`refreshed  ${name}`);
      continue;
    }

    await prisma.$executeRawUnsafe(
      `INSERT INTO "_prisma_migrations"
        (id, checksum, migration_name, started_at, finished_at, applied_steps_count, logs)
       VALUES ($1, $2, $3, now(), now(), 1, NULL)`,
      randomUUID(),
      checksum,
      name,
    );
    console.log(`inserted  ${name}`);
  }
}

main()
  .catch((e) => {
    console.error('FAILED:', e.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());