import { describe, expect, it } from 'vitest';
import {
  assertNotProduction,
  assertTestDbIsolated,
  parseDbIdentity,
} from './test-env-guard.js';

// Dummy credentials only. These URLs never reach a database.
const POOLER_A =
  'postgresql://postgres.abcdefghij:p%40ss@aws-0-ap-south-1.pooler.supabase.com:5432/postgres';
const DIRECT_A = 'postgresql://postgres:p%40ss@db.abcdefghij.supabase.co:5432/postgres';
const POOLER_B =
  'postgresql://postgres.klmnopqrst:other@aws-0-ap-south-1.pooler.supabase.com:5432/postgres';

describe('parseDbIdentity', () => {
  it('lowercases the host and reads the pooler project reference', () => {
    const identity = parseDbIdentity(
      'postgresql://postgres.abcdefghij:p%40ss@AWS-0-AP-SOUTH-1.POOLER.SUPABASE.COM:5432/postgres?pgbouncer=true',
    );

    expect(identity.host).toBe('aws-0-ap-south-1.pooler.supabase.com');
    expect(identity.port).toBe('5432');
    expect(identity.username).toBe('postgres.abcdefghij');
    expect(identity.database).toBe('postgres');
    expect(identity.projectRef).toBe('abcdefghij');
  });

  it('reads the direct-host project reference', () => {
    const identity = parseDbIdentity(DIRECT_A);

    expect(identity.host).toBe('db.abcdefghij.supabase.co');
    expect(identity.projectRef).toBe('abcdefghij');
  });

  it('accepts IPv6 literals and encoded passwords', () => {
    const identity = parseDbIdentity('postgresql://postgres:p%40ss@[::1]:5432/postgres');

    expect(identity.host).toContain('::1');
    expect(identity.database).toBe('postgres');
    expect(identity.projectRef).toBeNull();
  });

  it('throws a generic error for an unparsable URL', () => {
    expect(() => parseDbIdentity('this is not a url with p%40ss')).toThrow(
      'Unparsable database URL: cannot derive an identity.',
    );
  });
});

describe('assertTestDbIsolated', () => {
  it('throws when pooler identities are identical', () => {
    expect(() =>
      assertTestDbIsolated(
        { DATABASE_URL: POOLER_A, DIRECT_URL: POOLER_A },
        { DATABASE_URL: POOLER_A },
      ),
    ).toThrow(/shares a Supabase project reference/);
  });

  it('throws when hosts differ but the project reference matches', () => {
    expect(() =>
      assertTestDbIsolated(
        { DATABASE_URL: POOLER_A, DIRECT_URL: POOLER_A },
        { DATABASE_URL: DIRECT_A },
      ),
    ).toThrow(/shares a Supabase project reference/);
  });

  it('throws when host, username and database all match without a project reference', () => {
    const plain = 'postgresql://postgres:p%40ss@localhost:5432/postgres';

    expect(() =>
      assertTestDbIsolated(
        { DATABASE_URL: plain, DIRECT_URL: plain },
        { DATABASE_URL: plain },
      ),
    ).toThrow(/identity \(host, username, database\) matches/);
  });

  it('passes when the project references differ', () => {
    expect(() =>
      assertTestDbIsolated(
        { DATABASE_URL: POOLER_A, DIRECT_URL: POOLER_A },
        { DATABASE_URL: POOLER_B },
      ),
    ).not.toThrow();
  });

  it('passes when main has only one URL and the references differ', () => {
    expect(() =>
      assertTestDbIsolated(
        { DATABASE_URL: DIRECT_A, DIRECT_URL: POOLER_A },
        { DATABASE_URL: POOLER_B },
      ),
    ).not.toThrow();
  });

  it('throws when a test URL is missing', () => {
    expect(() => assertTestDbIsolated({ DATABASE_URL: POOLER_A }, {})).toThrow(
      'Test database variable DIRECT_URL is missing.',
    );
    expect(() => assertTestDbIsolated({}, {})).toThrow(
      'Test database variable DATABASE_URL is missing.',
    );
  });

  it('throws for an unparsable test URL without echoing it', () => {
    let message = '';
    try {
      assertTestDbIsolated(
        { DATABASE_URL: 'not a url p%40ss', DIRECT_URL: POOLER_A },
        {},
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('Unparsable database URL');
    expect(message).not.toContain('p%40ss');
    expect(message).not.toContain('p@ss');
  });

  it('never puts the dummy password in an identity error', () => {
    let message = '';
    try {
      assertTestDbIsolated(
        { DATABASE_URL: POOLER_A, DIRECT_URL: POOLER_A },
        { DATABASE_URL: POOLER_A },
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).not.toContain('p%40ss');
    expect(message).not.toContain('p@ss');
    expect(message).not.toContain('abcdefghij');
  });
});

describe('assertNotProduction', () => {
  it('throws in production', () => {
    expect(() => assertNotProduction('production')).toThrow(
      'Refusing test database setup when NODE_ENV=production.',
    );
  });

  it('allows non-production and unset NODE_ENV', () => {
    expect(() => assertNotProduction('test')).not.toThrow();
    expect(() => assertNotProduction(undefined)).not.toThrow();
  });
});
