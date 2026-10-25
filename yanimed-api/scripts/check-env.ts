import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateEnv } from '../src/config/env.validation.js';

/**
 * ConfigModule.forRoot() loads .env inside the running app, but this script
 * bypasses Nest, so .env has to be loaded here or every variable reads as
 * missing. dotenv is only a transitive dependency of @nestjs/config, so it is
 * not imported directly; the format below is the simple KEY="value" form this
 * project uses.
 */
function loadEnvFile(path: string): void {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    console.log(`BOOT BLOCKED:\n.env not found at ${path}`);
    process.exit(1);
  }

  for (const line of raw.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile(resolve(process.cwd(), '.env'));

try {
  const cfg = validateEnv();
  console.log('BOOT: ok');
  console.log(`  port             = ${cfg.port}`);
  console.log(`  omniroute model  = ${cfg.omniroutePrimaryModel ?? 'MISSING'}`);
  console.log(`  omniroute base   = ${cfg.omnirouteBaseUrl ?? 'MISSING'}`);
  console.log(`  omniroute key    = ${cfg.omnirouteApiKey ? 'set' : 'MISSING'}`);
  console.log(`  gemini key       = ${cfg.geminiApiKey ? 'set' : 'not set (embeddings, not built yet)'}`);
  console.log(`  r2 bucket        = ${cfg.r2BucketName ? 'set' : 'not set (storage, not built yet)'}`);
  console.log(
    `  fallback models  = ${cfg.omnirouteFallbackModels.length ? cfg.omnirouteFallbackModels.join(', ') : 'none (combo owns failover)'}`,
  );
} catch (e) {
  console.log('BOOT BLOCKED:');
  console.log((e as Error).message);
  process.exitCode = 1;
}