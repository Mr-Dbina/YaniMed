import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { StorageService, validatePdfUpload } from './storage.service.js';

describe('storage validation', () => {
  it('accepts a PDF signature', () => {
    const buffer = Buffer.from('%PDF-1.4\n');
    const result = validatePdfUpload({
      originalname: 'reviewer.pdf',
      mimetype: 'application/pdf',
      size: buffer.length,
      buffer,
    });
    expect(result.originalname).toBe('reviewer.pdf');
  });

  it('rejects a non-PDF signature', () => {
    const buffer = Buffer.from('not a pdf');
    expect(() => validatePdfUpload({
      originalname: 'reviewer.pdf',
      mimetype: 'application/pdf',
      size: buffer.length,
      buffer,
    })).toThrow('File signature does not match a PDF.');
  });

  it('rejects an oversized file before upload', () => {
    const buffer = Buffer.alloc(1, 0);
    buffer.write('%PDF-', 0);
    const large = Buffer.concat([buffer, Buffer.alloc(256 * 1024 * 1024)]);
    expect(() => validatePdfUpload({
      originalname: 'reviewer.pdf',
      mimetype: 'application/pdf',
      size: large.length,
      buffer: large,
    })).toThrow('PDF size is invalid or exceeds the limit.');
  });

  it('reports unavailable when R2 is not configured', () => {
    const service = new StorageService({ get: () => undefined } as never);
    expect(service.isAvailable()).toBe(false);
  });
});
