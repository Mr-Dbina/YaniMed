// Force the .env.test database into this process and its children before
// running a Prisma CLI command.
import '../src/config/load-test-env.js';

import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);

if (args.length === 0) {
  console.error('Usage: tsx scripts/with-test-env.ts <command> [args...]');
  process.exit(1);
}

const lowered = args.map(value => value.toLowerCase());
const joined = lowered.join(' ');
if (lowered.some(value => value.includes('reset')) || joined.includes('db push')) {
  console.error(
    'Refusing to run: reset, --force-reset and db push are not allowed against the test database wrapper.',
  );
  process.exit(1);
}

const [command, ...commandArgs] = args;
const result = spawnSync(command, commandArgs, {
  env: process.env,
  stdio: 'inherit',
  shell: true,
});

if (result.error) {
  console.error(`Failed to start command: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
