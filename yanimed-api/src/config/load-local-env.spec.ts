import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function probe(localContents?: string, inheritedModel?: string) {
  const cwd = mkdtempSync(join(tmpdir(), 'yanimed-env-'));
  directories.push(cwd);
  if (localContents !== undefined)
    writeFileSync(join(cwd, '.env.local'), localContents);
  const env = { ...process.env };
  delete env.OMNIROUTE_PRIMARY_MODEL;
  delete env.OMNIROUTE_API_KEY;
  if (inheritedModel) env.OMNIROUTE_PRIMARY_MODEL = inheritedModel;
  const code = `
    import ${JSON.stringify(new URL('./load-local-env.ts', import.meta.url).href)};
    import ${JSON.stringify(import.meta.resolve('@prisma/client'))};
    console.log(JSON.stringify({model: process.env.OMNIROUTE_PRIMARY_MODEL ?? null, localKeyPreserved: process.env.OMNIROUTE_API_KEY === 'fixture-local-placeholder'}));
  `;
  const result = spawnSync(
    process.execPath,
    ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', code],
    { cwd, env, encoding: 'utf8' },
  );
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout.trim()) as {
    model: string | null;
    localKeyPreserved: boolean;
  };
}

describe('local environment bootstrap before Prisma import', () => {
  it('preserves local model and credential overrides when Prisma eagerly loads .env', () => {
    expect(
      probe(
        'OMNIROUTE_PRIMARY_MODEL=yanimed\nOMNIROUTE_API_KEY=fixture-local-placeholder\n',
      ),
    ).toEqual({ model: 'yanimed', localKeyPreserved: true });
  });
  it('preserves explicit deployment environment variables', () => {
    expect(
      probe('OMNIROUTE_PRIMARY_MODEL=yanimed\n', 'deployment-model').model,
    ).toBe('deployment-model');
  });
  it('allows missing .env.local and retains Prisma defaults', () => {
    expect(probe().localKeyPreserved).toBe(false);
  });
});
