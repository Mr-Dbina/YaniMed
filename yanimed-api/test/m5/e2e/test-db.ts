/**
 * Import this module before anything that constructs a PrismaClient.
 *
 * Prisma sizes its pool from the CPU count, so one client can open ~30
 * connections. The e2e suite runs a shared client plus up to two booted apps,
 * and the remote TEST pooler refuses that many. Cap the pool through the
 * connection string; the database identity is unchanged.
 */
const url = process.env.DATABASE_URL;
if (url !== undefined && !/[?&]connection_limit=/.test(url)) {
  const parsed = new URL(url);
  parsed.searchParams.set('connection_limit', '4');
  process.env.DATABASE_URL = parsed.toString();
}
