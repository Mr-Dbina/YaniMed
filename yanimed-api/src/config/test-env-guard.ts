// Pure identity checks for the throwaway test database. No I/O and no
// process.env access: callers read the files and pass strings in.
export interface DbIdentity {
  host: string;
  port: string | null;
  username: string;
  database: string;
  projectRef: string | null;
}

export interface DbEnv {
  DATABASE_URL?: string;
  DIRECT_URL?: string;
}

// Refuse to load test settings in production. Kept here so it is pure and
// unit-testable; the loader only passes NODE_ENV in.
export function assertNotProduction(nodeEnv: string | undefined): void {
  if (nodeEnv === 'production') {
    throw new Error('Refusing test database setup when NODE_ENV=production.');
  }
}

function projectRefFor(host: string, username: string): string | null {
  const pooler = /^postgres\.([^.]+)$/i.exec(username);
  if (pooler) return pooler[1].toLowerCase();

  const direct = /^db\.([^.]+)\.supabase\.co$/i.exec(host);
  if (direct) return direct[1].toLowerCase();

  return null;
}

export function parseDbIdentity(raw: string): DbIdentity {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Never echo the input: it can contain a password.
    throw new Error('Unparsable database URL: cannot derive an identity.');
  }

  let username = url.username;
  let database = url.pathname.replace(/^\/+/, '');
  try {
    username = decodeURIComponent(username);
  } catch {
    // Keep the encoded form when decoding fails.
  }
  try {
    database = decodeURIComponent(database);
  } catch {
    // Keep the encoded form when decoding fails.
  }

  const host = url.hostname.toLowerCase();
  return {
    host,
    port: url.port || null,
    username,
    database,
    projectRef: projectRefFor(host, username),
  };
}

// Cross-compare every test URL against every main URL. Error messages name
// only variables and the rule, never a URL fragment.
export function assertTestDbIsolated(test: DbEnv, main: DbEnv): void {
  const testEntries: Array<[string, string | undefined]> = [
    ['DATABASE_URL', test.DATABASE_URL],
    ['DIRECT_URL', test.DIRECT_URL],
  ];

  for (const [name, value] of testEntries) {
    if (!value) throw new Error(`Test database variable ${name} is missing.`);
  }

  const mainEntries: Array<[string, string]> = [];
  for (const name of ['DATABASE_URL', 'DIRECT_URL'] as const) {
    const value = main[name];
    if (value) mainEntries.push([name, value]);
  }

  for (const [testName, testUrl] of testEntries) {
    const testId = parseDbIdentity(testUrl as string);

    for (const [mainName, mainUrl] of mainEntries) {
      const mainId = parseDbIdentity(mainUrl);

      if (testId.projectRef && mainId.projectRef && testId.projectRef === mainId.projectRef) {
        throw new Error(
          `${testName} shares a Supabase project reference with main ${mainName}.`,
        );
      }

      if (
        testId.host === mainId.host &&
        testId.username === mainId.username &&
        testId.database === mainId.database
      ) {
        throw new Error(
          `${testName} identity (host, username, database) matches main ${mainName}.`,
        );
      }
    }
  }
}
