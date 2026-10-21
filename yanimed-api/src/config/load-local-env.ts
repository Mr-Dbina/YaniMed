import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';

// Must run before importing Prisma: its generated client eagerly loads .env.
// Existing shell/deployment variables still win; Nest loads the remaining .env
// defaults as usual. This prevents Prisma's defaults masking .env.local.
const localEnv = resolve(process.cwd(), '.env.local');
if (existsSync(localEnv)) loadEnvFile(localEnv);
