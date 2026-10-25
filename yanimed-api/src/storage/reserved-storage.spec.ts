import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeleteObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
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
});
