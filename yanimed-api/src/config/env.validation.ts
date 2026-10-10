const required = [
  'DATABASE_URL',
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_ENDPOINT',
  'R2_BUCKET_NAME',
  'GEMINI_API_KEY',
  'OMNIROUTE_BASE_URL',
  'OMNIROUTE_API_KEY',
  'OMNIROUTE_PRIMARY_MODEL',
] as const;

// Present in .env.example but genuinely optional: DIRECT_URL (only used when
// it resolves), R2_JURISDICTION (defaults to "auto"), OMNIROUTE_FALLBACK_MODELS
// (warned about below) and PORT (defaults to 3000).

export function validateEnv() {
  const missing = required.filter((key) => !process.env[key]?.trim());

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}\n` +
        'Copy .env.example to .env and fill them in.',
    );
  }

  const fallback = process.env.OMNIROUTE_FALLBACK_MODELS?.trim();
  if (!fallback) {
    console.warn(
      '[config] OMNIROUTE_FALLBACK_MODELS is empty - if the primary model runs out ' +
        'of quota, answer generation will fail instead of degrading to a fallback.',
    );
  }

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