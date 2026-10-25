import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { S3Client, PutObjectCommand, HeadObjectCommand, DeleteObjectCommand, GetObjectCommand, CopyObjectCommand } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { r2Env, requireEnv } from '../config/env.validation.js';

export const R2_PDF_MAX_BYTES = 256 * 1024 * 1024;
export const PDF_SIGNATURE = Buffer.from('%PDF-');
export const R2_UPLOAD_TIMEOUT_MS = 60_000;
export const R2_METADATA_TIMEOUT_MS = 15_000;
export const R2_DOWNLOAD_TIMEOUT_MS = 60_000;

export interface ReservedPdf {
  id: string;
  subjectId: string;
  objectKey: string;
  fileSha256: string;
}

export interface StoredPdf {
  bytes: number;
  etag: string;
  attemptId: string;
  sha256: string;
}

export interface UploadResult {
  key: string;
  etag: string | null;
  bytes: number;
}

export interface R2Config {
  accountId: string | undefined;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  bucketName: string;
  jurisdiction: string | undefined;
}

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private client: S3Client | null = null;
  private bucket: string | null = null;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    try {
      requireEnv(r2Env, 'Cloudflare R2');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'R2 is not configured.';
      this.logger.warn(message);
      return;
    }
    const cfg = this.configValue();
    this.client = new S3Client({
      maxAttempts: 1,
      region: cfg.jurisdiction || 'auto',
      endpoint: cfg.endpoint,
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      },
    });
    this.bucket = cfg.bucketName;
  }

  private configValue(): R2Config {
    return {
      accountId: this.config.get<string>('r2AccountId'),
      accessKeyId: this.config.get<string>('r2AccessKeyId')!,
      secretAccessKey: this.config.get<string>('r2SecretAccessKey')!,
      endpoint: this.config.get<string>('r2Endpoint')!,
      bucketName: this.config.get<string>('r2BucketName')!,
      jurisdiction: this.config.get<string>('r2Jurisdiction'),
    };
  }

  isAvailable(): boolean {
    return this.client !== null && this.bucket !== null;
  }

  private configured() {
    if (!this.client || !this.bucket) throw new ServiceUnavailableException('R2 storage is not configured.');
    return { client: this.client, bucket: this.bucket };
  }

  async putReservedPdf(attempt: ReservedPdf, file: Buffer): Promise<void> {
    const { client, bucket } = this.configured();
    try {
      await client.send(new PutObjectCommand({
        Bucket: bucket, Key: attempt.objectKey, Body: file,
        ContentType: 'application/pdf', ContentLength: file.length,
        ContentMD5: createHash('md5').update(file).digest('base64'),
        CacheControl: 'private, no-store', IfNoneMatch: '*',
        Metadata: { attemptid: attempt.id, sha256: attempt.fileSha256, subjectid: attempt.subjectId },
      }), { abortSignal: AbortSignal.timeout(R2_UPLOAD_TIMEOUT_MS) });
    } catch (error) {
      // A previous request may have stored the object before losing its response.
      if ((error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode !== 412) throw error;
    }
  }

  async inspectReservedPdf(key: string): Promise<StoredPdf | null> {
    const { client, bucket } = this.configured();
    try {
      const result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }),
        { abortSignal: AbortSignal.timeout(R2_METADATA_TIMEOUT_MS) });
      return {
        bytes: result.ContentLength ?? -1, etag: result.ETag ?? '',
        attemptId: result.Metadata?.attemptid ?? '', sha256: result.Metadata?.sha256 ?? '',
      };
    } catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 404) return null;
      throw error;
    }
  }

  async deleteReservedPdf(key: string, etag: string): Promise<void> {
    const { client, bucket } = this.configured();
    if (!etag) throw new Error('Object version is required for cleanup.');
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key, IfMatch: etag }),
      { abortSignal: AbortSignal.timeout(R2_METADATA_TIMEOUT_MS) });
  }

  async getObject(key: string): Promise<Buffer> {
    const { client, bucket } = this.configured();
    const started = Date.now();
    try {
      const result = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
        { abortSignal: AbortSignal.timeout(R2_DOWNLOAD_TIMEOUT_MS) },
      );
      const body = result.Body as { transformToByteArray?: () => Promise<Uint8Array> } | null;
      if (!body) throw new InternalServerErrorException('R2 download failed. Empty response body.');
      if (typeof body.transformToByteArray === 'function') {
        return Buffer.from(await body.transformToByteArray());
      }
      const chunks: Buffer[] = [];
      for await (const chunk of body as AsyncIterable<Uint8Array | Buffer>) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    } catch (error) {
      this.logger.warn(`R2 download failed after ${Date.now() - started}ms`);
      if (error instanceof Error && error.name === 'AbortError')
        throw new BadRequestException('Download timed out.');
      throw error;
    }
  }

  async downloadPdf(key: string): Promise<Buffer> { return this.getObject(key); }
  async getPdf(key: string): Promise<Buffer> { return this.getObject(key); }
  async getPdfBuffer(key: string): Promise<Buffer> { return this.getObject(key); }
  async retrievePdf(key: string): Promise<Buffer> { return this.getObject(key); }

  async putCanonicalPdf(key: string, file: Buffer): Promise<void> {
    const { client, bucket } = this.configured();
    try {
      await client.send(new PutObjectCommand({
        Bucket: bucket, Key: key, Body: file,
        ContentType: 'application/pdf', ContentLength: file.length,
        CacheControl: 'private, no-store', IfNoneMatch: '*',
      }), { abortSignal: AbortSignal.timeout(R2_UPLOAD_TIMEOUT_MS) });
    } catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode !== 412) throw error;
    }
  }

  async copyObject(sourceKey: string, destinationKey: string): Promise<void> {
    const { client, bucket } = this.configured();
    await client.send(new CopyObjectCommand({
      Bucket: bucket, Key: destinationKey,
      CopySource: `${bucket}/${sourceKey}`,
      ContentType: 'application/pdf',
      CacheControl: 'private, no-store',
    }), { abortSignal: AbortSignal.timeout(R2_UPLOAD_TIMEOUT_MS) });
  }

  async deleteObject(key: string, etag?: string): Promise<void> {
    if (!etag) {
      await this.deleteReservedPdf(key, await this.requiredEtag(key));
      return;
    }
    await this.deleteReservedPdf(key, etag);
  }

  private async requiredEtag(key: string): Promise<string> {
    const stored = await this.inspectReservedPdf(key);
    if (!stored?.etag) throw new Error('Object version is required for cleanup.');
    return stored.etag;
  }

  async uploadPdf(subjectId: string, file: Buffer, filename: string): Promise<UploadResult> {
    if (!this.client || !this.bucket)
      throw new ServiceUnavailableException('R2 storage is not configured.');
    if (!file.length || file.length > R2_PDF_MAX_BYTES)
      throw new BadRequestException(
        `PDF must be between 1 byte and ${R2_PDF_MAX_BYTES} bytes.`,
      );
    if (!file.subarray(0, PDF_SIGNATURE.length).equals(PDF_SIGNATURE))
      throw new BadRequestException('File signature does not match a PDF.');
    const key = `${subjectId}/${Date.now()}-${crypto.randomUUID()}.pdf`;
    const started = Date.now();
    try {
      const result = await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: file,
          ContentType: 'application/pdf',
          ContentLength: file.length,
          CacheControl: 'private, no-store',
          Metadata: {
            originalFilename: sanitizeFilename(filename).slice(0, 256),
            subjectId,
          },
        }),
        { abortSignal: AbortSignal.timeout(R2_UPLOAD_TIMEOUT_MS) },
      );
      return { key, etag: result.ETag ?? null, bytes: file.length };
    } catch (error) {
      this.logger.warn(`R2 upload failed after ${Date.now() - started}ms`);
      if (error instanceof Error && error.name === 'AbortError')
        throw new BadRequestException('Upload timed out.');
      throw new InternalServerErrorException('R2 upload failed. No document record was created.');
    }
  }
}

export function sanitizeFilename(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? '';
  const cleaned = base.replace(/[^A-Za-z0-9._ -]/g, '_').replace(/\.{2,}/g, '.');
  return cleaned.length > 0 ? cleaned : 'document.pdf';
}

export function validatePdfUpload(
  file: { originalname?: string; mimetype?: string; size?: number; buffer?: Buffer } | undefined,
): { buffer: Buffer; originalname: string } {
  if (!file?.buffer || !file.originalname)
    throw new BadRequestException('A PDF file is required.');
  if (file.mimetype !== 'application/pdf')
    throw new BadRequestException('Only application/pdf is accepted.');
  if (file.size !== file.buffer.length || file.size <= 0 || file.size > R2_PDF_MAX_BYTES)
    throw new BadRequestException('PDF size is invalid or exceeds the limit.');
  if (!file.buffer.subarray(0, PDF_SIGNATURE.length).equals(PDF_SIGNATURE))
    throw new BadRequestException('File signature does not match a PDF.');
  const name = sanitizeFilename(file.originalname);
  if (!name.toLowerCase().endsWith('.pdf'))
    throw new BadRequestException('Filename must end with .pdf.');
  return { buffer: file.buffer, originalname: name };
}
