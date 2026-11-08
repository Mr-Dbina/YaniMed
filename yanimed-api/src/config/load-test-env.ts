import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  assertNotProduction,
  assertTestDbIsolated,
  type DbEnv,
} from './test-env-guard.js';

// Import this module first: it forces the throwaway test database into
// process.env before Prisma reads its own .env defaults.
function parseEnvText(text: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const withoutExport = trimmed.startsWith('export ')
      ? trimmed.slice('export '.length).trim()
      : trimmed;
    const equals = withoutExport.indexOf('=');
    if (equals <= 0) continue;

    const key = withoutExport.slice(0, equals).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = withoutExport.slice(equals + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }

  return result;
}

function readFileEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  return parseEnvText(readFileSync(path, 'utf8'));
}

function readMainEnv(): DbEnv {
  // Read text only. Never inherit main values from process.env, because the
  // shell may already hold a stale or explicitly wrong value.
  const file = readFileEnv(resolve(process.cwd(), '.env'));
  const local = readFileEnv(resolve(process.cwd(), '.env.local'));
  return {
    DATABASE_URL: local.DATABASE_URL ?? file.DATABASE_URL,
    DIRECT_URL: local.DIRECT_URL ?? file.DIRECT_URL,
  };
}

const testPath = resolve(process.cwd(), '.env.test');
if (!existsSync(testPath)) {
  throw new Error('Missing .env.test in the current working directory.');
}

const testEnv = readFileEnv(testPath);
const test: DbEnv = {
  DATABASE_URL: testEnv.DATABASE_URL,
  DIRECT_URL: testEnv.DIRECT_URL,
};

assertNotProduction(process.env.NODE_ENV);
assertTestDbIsolated(test, readMainEnv());

const shellDatabaseUrl = process.env.DATABASE_URL;
const shellDirectUrl = process.env.DIRECT_URL;
const shellValuesDiffer =
  (shellDatabaseUrl !== undefined && shellDatabaseUrl !== test.DATABASE_URL) ||
  (shellDirectUrl !== undefined && shellDirectUrl !== test.DIRECT_URL);

// Prisma's dotenv load never overrides existing variables, so override them
// here after the isolation check passes.
process.env.DATABASE_URL = test.DATABASE_URL;
process.env.DIRECT_URL = test.DIRECT_URL;
process.env.YANIMED_TEST_DB = '1';

if (shellValuesDiffer) {
  console.warn('shell DATABASE_URL/DIRECT_URL ignored');
}
