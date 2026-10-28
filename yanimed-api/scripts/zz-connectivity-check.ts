import '../src/config/load-local-env.js';
import { PrismaClient } from '@prisma/client';

function describe(name: string) {
  const raw = process.env[name];
  if (!raw) return `${name}: NOT SET`;
  try {
    const u = new URL(raw);
    return `${name}: host=${u.hostname} port=${u.port || '(default)'}`;
  } catch {
    return `${name}: set but not a valid URL`;
  }
}

async function main() {
  console.log(describe('DATABASE_URL'));
  console.log(describe('DIRECT_URL'));
  const prisma = new PrismaClient();
  const started = Date.now();
  try {
    const rows = await prisma.$queryRaw<Array<{ ok: number }>>`SELECT 1 AS ok`;
    console.log(`SELECT 1 ok=${rows[0]?.ok} in ${Date.now() - started}ms`);
  } catch (error) {
    console.log(
      `CONNECT FAILED after ${Date.now() - started}ms: ${error instanceof Error ? error.message.split('\n').slice(-3).join(' | ') : String(error)}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main();
