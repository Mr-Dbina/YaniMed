import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DocumentController } from '../../src/documents/documents.controller.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { StorageService } from '../../src/storage/storage.service.js';
import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import {
  assertTestDb,
  cleanupSubjects,
  createSubject,
  createDocument,
  prisma,
} from './helpers.js';

describe('M6 PDF Viewer Auth & Error Handling', () => {
  let documentController: DocumentController;
  let mockStorage: StorageService;
  let testSubjectId: string;
  let testDocumentId: string;

  beforeAll(async () => {
    assertTestDb();
    const prismaService = new PrismaService();

    // Mock StorageService
    mockStorage = {
      getObject: vi.fn(),
      putReservedPdf: vi.fn(),
      inspectReservedPdf: vi.fn(),
      deleteReservedPdf: vi.fn(),
      putCanonicalPdf: vi.fn(),
      copyObject: vi.fn(),
      deleteObject: vi.fn(),
      downloadPdf: vi.fn(),
      getPdf: vi.fn(),
      getPdfBuffer: vi.fn(),
      retrievePdf: vi.fn(),
      isAvailable: vi.fn().mockReturnValue(true),
      onModuleInit: vi.fn(),
      configValue: vi.fn(),
      configured: vi.fn(),
      logger: { warn: vi.fn(), log: vi.fn(), error: vi.fn(), debug: vi.fn(), verbose: vi.fn() },
      client: null,
      bucket: null,
      config: {} as any,
    } as unknown as StorageService;

    documentController = new DocumentController(
      prismaService,
      {} as any, // pdfObjects
      mockStorage,
      undefined, // processing
    );

    const subject = await createSubject();
    testSubjectId = subject.id;

    const document = await createDocument(subject.id);
    testDocumentId = document.id;
  });

  afterAll(async () => {
    vi.clearAllMocks();
    await cleanupSubjects();
  });

  describe('GET /documents/:documentId/file - ChatGuard enforcement', () => {
    it('returns PDF when document exists and storage returns file', async () => {
      const mockPdfBuffer = Buffer.from('%PDF-1.4 test content');
      mockStorage.getObject = vi.fn().mockResolvedValue(mockPdfBuffer);

      const mockRes = {
        setHeader: vi.fn(),
        send: vi.fn(),
        status: vi.fn().mockReturnThis(),
      } as any;

      await documentController.file(testDocumentId, mockRes);

      expect(mockStorage.getObject).toHaveBeenCalledWith(
        expect.stringContaining('ZZ-m6/file-')
      );
      expect(mockRes.setHeader).toHaveBeenCalledWith('Content-Type', 'application/pdf');
      expect(mockRes.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
      expect(mockRes.send).toHaveBeenCalledWith(mockPdfBuffer);
    });

    it('throws 404 NotFoundException when document does not exist', async () => {
      const nonExistentId = randomUUID();
      const mockRes = { setHeader: vi.fn(), send: vi.fn() } as any;

      await expect(
        documentController.file(nonExistentId, mockRes)
      ).rejects.toThrow(NotFoundException);

      await expect(
        documentController.file(nonExistentId, mockRes)
      ).rejects.toThrow('Document not found.');
    });

    it('throws 404 NotFoundException when document subject is DELETING', async () => {
      // Create a document and then mark subject as DELETING
      const subject = await createSubject();
      const document = await createDocument(subject.id);

      await prisma.subject.update({
        where: { id: subject.id },
        data: { status: 'DELETING' },
      });

      const mockRes = { setHeader: vi.fn(), send: vi.fn() } as any;

      await expect(
        documentController.file(document.id, mockRes)
      ).rejects.toThrow(NotFoundException);

      await expect(
        documentController.file(document.id, mockRes)
      ).rejects.toThrow('Document not found.');

      // Cleanup - restore subject status so it can be deleted
      await prisma.subject.update({
        where: { id: subject.id },
        data: { status: 'ACTIVE' },
      });
    });

    it('throws 404 NotFoundException when storage returns NoSuchKey', async () => {
      const notFoundError = new Error('Not Found');
      notFoundError.name = 'NoSuchKey';
      mockStorage.getObject = vi.fn().mockRejectedValue(notFoundError);

      const mockRes = { setHeader: vi.fn(), send: vi.fn() } as any;

      await expect(
        documentController.file(testDocumentId, mockRes)
      ).rejects.toThrow(NotFoundException);

      await expect(
        documentController.file(testDocumentId, mockRes)
      ).rejects.toThrow('Document file not found.');
    });

    it('throws 404 NotFoundException when storage returns 404 status', async () => {
      const errorWithStatus = new Error('Not Found');
      (errorWithStatus as any).$metadata = { httpStatusCode: 404 };
      mockStorage.getObject = vi.fn().mockRejectedValue(errorWithStatus);

      const mockRes = { setHeader: vi.fn(), send: vi.fn() } as any;

      await expect(
        documentController.file(testDocumentId, mockRes)
      ).rejects.toThrow(NotFoundException);

      await expect(
        documentController.file(testDocumentId, mockRes)
      ).rejects.toThrow('Document file not found.');
    });

    it('throws 503 ServiceUnavailableException for other storage errors', async () => {
      const networkError = new Error('Network failure');
      (networkError as any).$metadata = { httpStatusCode: 500 };
      mockStorage.getObject = vi.fn().mockRejectedValue(networkError);

      const mockRes = { setHeader: vi.fn(), send: vi.fn() } as any;

      await expect(
        documentController.file(testDocumentId, mockRes)
      ).rejects.toThrow(ServiceUnavailableException);

      await expect(
        documentController.file(testDocumentId, mockRes)
      ).rejects.toThrow('Document storage unavailable.');
    });

    it('throws 503 ServiceUnavailableException for timeout errors', async () => {
      const timeoutError = new Error('Timeout');
      timeoutError.name = 'TimeoutError';
      mockStorage.getObject = vi.fn().mockRejectedValue(timeoutError);

      const mockRes = { setHeader: vi.fn(), send: vi.fn() } as any;

      await expect(
        documentController.file(testDocumentId, mockRes)
      ).rejects.toThrow(ServiceUnavailableException);

      await expect(
        documentController.file(testDocumentId, mockRes)
      ).rejects.toThrow('Document storage unavailable.');
    });

    it('throws 503 ServiceUnavailableException for 429 rate limit', async () => {
      const rateLimitError = new Error('Rate Limited');
      (rateLimitError as any).$metadata = { httpStatusCode: 429 };
      mockStorage.getObject = vi.fn().mockRejectedValue(rateLimitError);

      const mockRes = { setHeader: vi.fn(), send: vi.fn() } as any;

      await expect(
        documentController.file(testDocumentId, mockRes)
      ).rejects.toThrow(ServiceUnavailableException);
    });
  });
});