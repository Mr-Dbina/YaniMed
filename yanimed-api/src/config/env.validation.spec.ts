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

describe('validateEnv PDF OCR settings', () => {
  const keys = ['PDF_OCR_MIN_CHARS', 'PDF_OCR_MIN_TEXT_CHARS_WITH_IMAGE', 'PDF_OCR_MIN_IMAGE_PIXELS', 'PDF_OCR_IMAGE_DETECTION'] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of keys) saved[key] = process.env[key];
    process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://example';
  });

  afterEach(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('applies defaults', () => {
    for (const key of keys) delete process.env[key];
    const cfg = validateEnv();
    expect(cfg.pdfOcrMinChars).toBe(1);
    expect(cfg.pdfOcrMinTextCharsWithImage).toBe(50);
    expect(cfg.pdfOcrMinImagePixels).toBe(10000);
    expect(cfg.pdfOcrImageDetection).toBe(true);
  });

  it('applies overrides', () => {
    process.env.PDF_OCR_MIN_CHARS = '5';
    process.env.PDF_OCR_MIN_TEXT_CHARS_WITH_IMAGE = '75';
    process.env.PDF_OCR_MIN_IMAGE_PIXELS = '20000';
    process.env.PDF_OCR_IMAGE_DETECTION = 'false';
    const cfg = validateEnv();
    expect(cfg.pdfOcrMinChars).toBe(5);
    expect(cfg.pdfOcrMinTextCharsWithImage).toBe(75);
    expect(cfg.pdfOcrMinImagePixels).toBe(20000);
    expect(cfg.pdfOcrImageDetection).toBe(false);
  });

  it('rejects invalid values', () => {
    for (const [key, value] of [
      ['PDF_OCR_MIN_CHARS', 'abc'],
      ['PDF_OCR_MIN_TEXT_CHARS_WITH_IMAGE', '-1'],
      ['PDF_OCR_MIN_IMAGE_PIXELS', '1.5'],
      ['PDF_OCR_IMAGE_DETECTION', 'maybe'],
    ] as const) {
      for (const k of keys) delete process.env[k];
      process.env[key] = value;
      expect(() => validateEnv()).toThrow();
    }
  });
});
