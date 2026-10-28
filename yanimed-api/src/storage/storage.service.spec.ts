import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeleteObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import { StorageService, R2_UPLOAD_TIMEOUT_MS, R2_METADATA_TIMEOUT_MS } from './storage.service.js';
import { r2Env } from '../config/env.validation.js';

describe('Reserved R2 storage (mocked SDK)', () => {
  let service: StorageService;
  const attempt = { id: 'attempt', subjectId: 'subject', objectKey: 'subject/initial/attempt.pdf', fileSha256: 'hash' };
  beforeEach(() => {
    for (const key of r2Env) vi.stubEnv(key, 'fixture');
    const config: Record<string, string> = {
      r2Endpoint: 'https://example.invalid', r2BucketName: 'fixture', r2Jurisdiction: 'auto',
      r2AccessKeyId: 'fixture', r2SecretAccessKey: 'fixture',
    };
    service = new StorageService({ get: (key: string) => config[key] } as never);
    service.onModuleInit();
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it('uses the reserved key, conditional creation, payload integrity and explicit abort deadline', async () => {
    const send = vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({} as never);
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    await service.putReservedPdf(attempt, Buffer.from('%PDF-fixture'));
    const [command, options] = send.mock.calls[0];
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect((command as PutObjectCommand).input).toMatchObject({ Key: attempt.objectKey, IfNoneMatch: '*',
      ContentMD5: expect.any(String), Metadata: { attemptid: attempt.id, sha256: attempt.fileSha256 } });
    expect(timeout).toHaveBeenCalledWith(R2_UPLOAD_TIMEOUT_MS);
    expect(options).toMatchObject({ abortSignal: expect.any(AbortSignal) });
  });
  it('treats conditional-create conflicts as requiring HEAD verification, not overwrites', async () => {
    vi.spyOn(S3Client.prototype, 'send').mockRejectedValue({ $metadata: { httpStatusCode: 412 } });
    await expect(service.putReservedPdf(attempt, Buffer.from('fixture'))).resolves.toBeUndefined();
  });
  it('propagates timeout and permission failures for durable retry handling', async () => {
    const send = vi.spyOn(S3Client.prototype, 'send').mockRejectedValue(new DOMException('Timed out', 'TimeoutError'));
    await expect(service.putReservedPdf(attempt, Buffer.from('fixture'))).rejects.toMatchObject({ name: 'TimeoutError' });
    send.mockRejectedValue({ $metadata: { httpStatusCode: 403 } });
    await expect(service.inspectReservedPdf(attempt.objectKey)).rejects.toMatchObject({ $metadata: { httpStatusCode: 403 } });
  });
  it('tags getObject abort failures as STORAGE_TRANSIENT', async () => {
    vi.spyOn(S3Client.prototype, 'send').mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await expect(service.getObject('pdfs/key.pdf')).rejects.toMatchObject({
      code: 'STORAGE_TRANSIENT',
      message: 'Download timed out.',
    });
  });

  it('tags getObject timeout failures as STORAGE_TRANSIENT', async () => {
    vi.spyOn(S3Client.prototype, 'send').mockRejectedValue(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
    await expect(service.getObject('pdfs/key.pdf')).rejects.toMatchObject({
      code: 'STORAGE_TRANSIENT',
      message: 'timed out',
    });
  });

  it('tags getObject 503 failures as STORAGE_TRANSIENT', async () => {
    vi.spyOn(S3Client.prototype, 'send').mockRejectedValue(
      Object.assign(new Error('service unavailable'), { $metadata: { httpStatusCode: 503 } }),
    );
    await expect(service.getObject('pdfs/key.pdf')).rejects.toMatchObject({
      code: 'STORAGE_TRANSIENT',
      message: 'service unavailable',
    });
  });

  it('tags getObject NoSuchKey failures as STORAGE_PERMANENT', async () => {
    vi.spyOn(S3Client.prototype, 'send').mockRejectedValue(Object.assign(new Error('missing'), { name: 'NoSuchKey' }));
    await expect(service.getObject('pdfs/key.pdf')).rejects.toMatchObject({
      code: 'STORAGE_PERMANENT',
      message: 'missing',
    });
  });

  it('tags getObject AccessDenied failures as STORAGE_PERMANENT', async () => {
    vi.spyOn(S3Client.prototype, 'send').mockRejectedValue(Object.assign(new Error('denied'), { name: 'AccessDenied' }));
    await expect(service.getObject('pdfs/key.pdf')).rejects.toMatchObject({
      code: 'STORAGE_PERMANENT',
      message: 'denied',
    });
  });

  it('HEAD returns receipts and distinguishes a missing object from infrastructure errors', async () => {
    const send = vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({
      ContentLength: 100, ETag: 'version', Metadata: { attemptid: 'attempt', sha256: 'hash' },
    } as never);
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    expect(await service.inspectReservedPdf(attempt.objectKey)).toEqual({ bytes: 100, etag: 'version', attemptId: 'attempt', sha256: 'hash' });
    expect(send.mock.calls[0][0]).toBeInstanceOf(HeadObjectCommand);
    expect(timeout).toHaveBeenCalledWith(R2_METADATA_TIMEOUT_MS);
    send.mockRejectedValue({ $metadata: { httpStatusCode: 404 } });
    expect(await service.inspectReservedPdf(attempt.objectKey)).toBeNull();
  });
  it('cleanup requires an ETag and performs a conditional deletion of only the specified key', async () => {
    const send = vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({} as never);
    await expect(service.deleteReservedPdf(attempt.objectKey, '')).rejects.toThrow('Object version');
    expect(send).not.toHaveBeenCalled();
    await service.deleteReservedPdf(attempt.objectKey, 'version');
    expect(send.mock.calls[0][0]).toBeInstanceOf(DeleteObjectCommand);
    expect((send.mock.calls[0][0] as DeleteObjectCommand).input).toMatchObject({ Key: attempt.objectKey, IfMatch: 'version' });
  });
  it('uses WHEN_REQUIRED checksum calculation and only Content-MD5 for reserved and canonical puts', async () => {
    const captured: any[] = [];
    const handler = { handle: async (request: any) => { captured.push(request); return { response: { statusCode: 200, headers: {}, body: Readable.from([]) } }; } };
    const client = new S3Client({
      maxAttempts: 1,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      region: 'auto',
      endpoint: 'https://example.invalid',
      credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' },
      requestHandler: handler as never,
    });
    (service as any).client = client;
    (service as any).bucket = 'fixture';
    await service.putReservedPdf(attempt, Buffer.from('%PDF-fixture'));
    await service.putCanonicalPdf('pdfs/hash.pdf', Buffer.from('%PDF-fixture'));
    expect(await (client.config as any).requestChecksumCalculation()).toBe('WHEN_REQUIRED');
    expect(await (client.config as any).responseChecksumValidation()).toBe('WHEN_REQUIRED');
    for (const request of captured) {
      expect(request.headers['content-md5']).toBeTruthy();
      expect(Object.keys(request.headers).some(key => key.toLowerCase().startsWith('x-amz-checksum-'))).toBe(false);
      expect(request.headers['x-amz-sdk-checksum-algorithm']).toBeUndefined();
    }
  });
  it('copyObject sends REPLACE and no custom metadata headers', async () => {
    const captured: any[] = [];
    const handler = { handle: async (request: any) => { captured.push(request); return { response: { statusCode: 200, headers: { 'content-type': 'application/xml' }, body: Readable.from([Buffer.from('<CopyObjectResult><ETag>"etag"</ETag><LastModified>2026-01-01T00:00:00.000Z</LastModified></CopyObjectResult>')]) } }; } };
    const client = new S3Client({
      maxAttempts: 1,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      region: 'auto',
      endpoint: 'https://example.invalid',
      credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' },
      requestHandler: handler as never,
    });
    (service as any).client = client;
    (service as any).bucket = 'fixture';
    await service.copyObject('subject/staging.pdf', 'pdfs/hash.pdf');
    expect(captured).toHaveLength(1);
    expect(captured[0].headers['x-amz-metadata-directive']).toBe('REPLACE');
    expect(Object.keys(captured[0].headers).some(key => key.toLowerCase().startsWith('x-amz-meta-'))).toBe(false);
  });
});
