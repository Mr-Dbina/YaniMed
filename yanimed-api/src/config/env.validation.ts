/**
 * Boot-time environment validation.
 *
 * Only DATABASE_URL is required to start the process, because PrismaModule
 * connects at boot. Every other credential is owned by a single feature and is
 * validated by that feature when it initialises (see requireEnv), so a missing
 * R2 bucket cannot take down the whole API.
 */
const bootRequired = ['DATABASE_URL'] as const;

/**
 * Credentials checked by the features that consume them. Empty is tolerated at
 * boot; the owning module fails fast in onModuleInit instead.
 */
export const omnirouteEnv = [
  'OMNIROUTE_BASE_URL',
  'OMNIROUTE_API_KEY',
  'OMNIROUTE_PRIMARY_MODEL',
] as const;

export const r2Env = [
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_ENDPOINT',
  'R2_BUCKET_NAME',
] as const;

export const geminiEnv = ['GEMINI_API_KEY'] as const;

export function validateEnv() {
  const missing = bootRequired.filter((key) => !process.env[key]?.trim());

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}\n` +
        'Copy .env.example to .env and fill them in.',
    );
  }

  // Provider fallback is owned by the OmniRoute combo (strategy: priority),
  // so OMNIROUTE_FALLBACK_MODELS is intentionally optional. Listing models
  // here as well would run two competing failover mechanisms.
  const fallback = process.env.OMNIROUTE_FALLBACK_MODELS?.trim();

  return {
    port: Number(process.env.PORT ?? 3000),
    r2BucketName: process.env.R2_BUCKET_NAME,
    geminiApiKey: process.env.GEMINI_API_KEY,
    omnirouteBaseUrl: process.env.OMNIROUTE_BASE_URL,
    omnirouteApiKey: process.env.OMNIROUTE_API_KEY,
    omniroutePrimaryModel: process.env.OMNIROUTE_PRIMARY_MODEL,
    omnirouteFallbackModels: (fallback ?? '')
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean),
  };
}

/**
 * Assert that a feature's credentials are present. Called from the owning
 * module's onModuleInit so a misconfigured feature fails on startup with a
 * clear message instead of failing on first request.
 */
export function requireEnv(keys: readonly string[], feature: string): void {
  const missing = keys.filter((key) => !process.env[key]?.trim());

  if (missing.length > 0) {
    throw new Error(
      `[${feature}] Missing required environment variables: ${missing.join(', ')}\n` +
        'Add them to yanimed-api/.env and restart the API.',
    );
  }
}