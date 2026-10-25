import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { validateEnv } from './env.validation.js';

const R2_KEYS = [
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_ENDPOINT',
  'R2_BUCKET_NAME',
  'R2_JURISDICTION',
] as const;

describe('validateEnv R2 mappings', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of [...R2_KEYS, 'DATABASE_URL']) {
      saved[key] = process.env[key];
    }
    process.env.DATABASE_URL = 'postgresql://example';
    process.env.R2_ACCOUNT_ID = 'test-account';
    process.env.R2_ACCESS_KEY_ID = 'test-access-key';
    process.env.R2_SECRET_ACCESS_KEY = 'test-secret-key';
    process.env.R2_ENDPOINT = 'https://example.r2.cloudflarestorage.com';
    process.env.R2_BUCKET_NAME = 'yanimed-pdfs';
    process.env.R2_JURISDICTION = 'auto';
  });

  afterEach(() => {
    for (const key of [...R2_KEYS, 'DATABASE_URL']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('maps every R2 environment variable to the config keys used by StorageService', () => {
    const cfg = validateEnv();

    expect(cfg.r2AccountId).toBe('test-account');
    expect(cfg.r2AccessKeyId).toBe('test-access-key');
    expect(cfg.r2SecretAccessKey).toBe('test-secret-key');
    expect(cfg.r2Endpoint).toBe('https://example.r2.cloudflarestorage.com');
    expect(cfg.r2BucketName).toBe('yanimed-pdfs');
    expect(cfg.r2Jurisdiction).toBe('auto');
  });

  it('defaults the bucket name to an empty string when R2_BUCKET_NAME is missing', () => {
    delete process.env.R2_BUCKET_NAME;

    const cfg = validateEnv();

    expect(cfg.r2BucketName).toBe('');
  });
});
