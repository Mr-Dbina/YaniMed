import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { PdfExtractionService, isPageComplete } from './pdf-extraction.service.js';
import { StorageService } from '../storage/storage.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

async function makePdf(texts: string[]): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const text of texts) {
    const page = pdf.addPage();
    if (text) page.drawText(text, { x: 50, y: 700, size: 12, font });
  }
  return Buffer.from(await pdf.save());
}

describe('PdfExtractionService', () => {
  let service: PdfExtractionService;

  beforeEach(() => {
    service = new PdfExtractionService();
  });

  it('extracts text with exact 1-based physical page numbers', async () => {
    const buffer = await makePdf(['Alpha', 'Beta', 'Gamma']);
    const result = await service.extractFromBuffer(buffer);
    expect(result.pageCount).toBe(3);
    expect(result.pages.map(p => p.pageNumber)).toEqual([1, 2, 3]);
    expect(result.pages[0].text).toContain('Alpha');
    expect(result.pages[1].text).toContain('Beta');
    expect(result.pages[2].text).toContain('Gamma');
    expect(result.ocrPageNumbers).toEqual([]);
    expect(result.textPageNumbers).toEqual([1, 2, 3]);
  });

  it('marks blank pages as requiring OCR', async () => {
    const buffer = await makePdf(['Text', '', 'More text']);
    const result = await service.extractFromBuffer(buffer);
    expect(result.ocrPageNumbers).toEqual([2]);
    expect(result.pages[1].needsOcr).toBe(true);
    expect(result.pages[1].isEmpty).toBe(true);
  });

  it('throws on corrupted PDFs', async () => {
    const buffer = Buffer.from('%PDF-1.4\ngarbage');
    await expect(service.extractFromBuffer(buffer)).rejects.toThrow();
  });

  it('extracts from R2 via storage service', async () => {
    const buffer = await makePdf(['Stored page']);
    const storage = { getObject: vi.fn().mockResolvedValue(buffer) } as unknown as StorageService;
    const svc = new PdfExtractionService(undefined, storage);
    const result = await svc.extractFromStorageKey('subject/doc.pdf', { subjectId: 's1', documentId: 'd1' });
    expect(vi.mocked(storage.getObject)).toHaveBeenCalledWith('subject/doc.pdf');
    expect(result.subjectId).toBe('s1');
    expect(result.documentId).toBe('d1');
    expect(result.storageKey).toBe('subject/doc.pdf');
    expect(result.pages[0].text).toContain('Stored page');
  });

  it('loads a document and preserves subject/document associations', async () => {
    const buffer = await makePdf(['Doc page']);
    const prisma = {
      document: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'doc-1',
          subjectId: 'subject-1',
          title: 'test.pdf',
          fileUrl: 'subject-1/doc-1.pdf',
          subject: { id: 'subject-1' },
        }),
      },
    } as unknown as PrismaService;
    const storage = { getObject: vi.fn().mockResolvedValue(buffer) } as unknown as StorageService;
    const svc = new PdfExtractionService(prisma, storage);
    const result = await svc.extractDocument('doc-1');
    expect(vi.mocked(prisma.document.findUnique)).toHaveBeenCalled();
    expect(vi.mocked(storage.getObject)).toHaveBeenCalledWith('subject-1/doc-1.pdf');
    expect(result.subjectId).toBe('subject-1');
    expect(result.documentId).toBe('doc-1');
    expect(result.filename).toBe('test.pdf');
  });

  it('OCR recognizes text on a scanned page image', async () => {
    const { createCanvas } = await import('@napi-rs/canvas');
    const canvas = createCanvas(400, 200);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 400, 200);
    ctx.fillStyle = 'black'; ctx.font = '32px sans-serif'; ctx.fillText('SCAN OCR 42', 40, 100);
    const png = canvas.toBuffer('image/png');
    const pdf = await PDFDocument.create();
    const image = await pdf.embedPng(png);
    const page = pdf.addPage([400, 200]);
    page.drawImage(image, { x: 0, y: 0, width: 400, height: 200 });
    const buffer = Buffer.from(await pdf.save());

    const result = await service.extractWithOcr(buffer);
    expect(result.pageCount).toBe(1);
    expect(result.pages[0].needsOcr).toBe(true);
    expect(result.pages[0].ocrUsed).toBe(true);
    expect(result.pages[0].text.toUpperCase()).toContain('SCAN');
  }, 120000);

  it('supports mixed text and scanned pages with 1-based numbering', async () => {
    const { createCanvas } = await import('@napi-rs/canvas');
    const canvas = createCanvas(400, 200);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 400, 200);
    ctx.fillStyle = 'black'; ctx.font = '32px sans-serif'; ctx.fillText('PAGE TWO SCAN', 40, 100);
    const png = canvas.toBuffer('image/png');
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const p1 = pdf.addPage(); p1.drawText('Text page one', { x: 50, y: 700, size: 12, font });
    const image = await pdf.embedPng(png);
    const p2 = pdf.addPage([400, 200]); p2.drawImage(image, { x: 0, y: 0, width: 400, height: 200 });
    const buffer = Buffer.from(await pdf.save());

    const result = await service.extractWithOcr(buffer);
    expect(result.pages.map(p => p.pageNumber)).toEqual([1, 2]);
    expect(result.pages[0].needsOcr).toBe(false);
    expect(result.pages[1].needsOcr).toBe(true);
    expect(result.ocrPageNumbers).toEqual([2]);
  }, 120000);

  it('keeps blank pages marked for OCR', async () => {
    const buffer = await makePdf(['', '']);
    const result = await service.extractWithOcr(buffer);
    expect(result.ocrPageNumbers).toEqual([1, 2]);
  });

  it('throws on corrupted PDFs during OCR extraction', async () => {
    const buffer = Buffer.from('%PDF-1.4\ngarbage');
    await expect(service.extractWithOcr(buffer)).rejects.toThrow();
  });

  it('persists extracted pages without marking READY', async () => {
    const buffer = await makePdf(['Persisted page']);
    const prisma = {
      document: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'doc-2',
          subjectId: 'subject-2',
          title: 'persist.pdf',
          fileUrl: 'subject-2/doc-2.pdf',
          subject: { id: 'subject-2' },
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      documentPage: {
        findMany: vi.fn().mockResolvedValueOnce([]).mockResolvedValue([{ pageNumber: 1, needsOcr: false, ocrUsed: false, ocrError: null }]),
        upsert: vi.fn().mockResolvedValue({}),
      },
    } as unknown as PrismaService;
    const storage = { getObject: vi.fn().mockResolvedValue(buffer) } as unknown as StorageService;
    const svc = new PdfExtractionService(prisma, storage);
    const result = await svc.processDocument('doc-2');
    expect(vi.mocked(storage.getObject)).toHaveBeenCalledWith('subject-2/doc-2.pdf');
    expect(vi.mocked(prisma.documentPage.upsert)).toHaveBeenCalled();
    expect(result.persistedPages).toBe(1);
    expect(result.pages[0].pageNumber).toBe(1);
    const updateCalls = vi.mocked(prisma.document.update).mock.calls.map(c => c[0]?.data?.status);
    expect(updateCalls).not.toContain('READY');
  });

  it('sets FAILED and does not persist on corrupted input', async () => {
    const prisma = {
      document: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'doc-3',
          subjectId: 'subject-3',
          title: 'bad.pdf',
          fileUrl: 'subject-3/doc-3.pdf',
          subject: { id: 'subject-3' },
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      documentPage: {
        findMany: vi.fn().mockResolvedValue([]),
        upsert: vi.fn().mockResolvedValue({}),
      },
    } as unknown as PrismaService;
    const storage = { getObject: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4\ngarbage')) } as unknown as StorageService;
    const svc = new PdfExtractionService(prisma, storage);
    await expect(svc.processDocument('doc-3')).rejects.toThrow();
    expect(vi.mocked(prisma.documentPage.upsert)).not.toHaveBeenCalled();
    const statuses = vi.mocked(prisma.document.update).mock.calls.map(c => c[0]?.data?.status);
    expect(statuses).toContain('FAILED');
  });

  it('prevents duplicate page records through upsert', async () => {
    const buffer = await makePdf(['Page']);
    const prisma = {
      document: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'doc-4',
          subjectId: 'subject-4',
          title: 'dup.pdf',
          fileUrl: 'subject-4/doc-4.pdf',
          subject: { id: 'subject-4' },
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      documentPage: {
        findMany: vi.fn().mockResolvedValue([]),
        upsert: vi.fn().mockResolvedValue({}),
      },
    } as unknown as PrismaService;
    const storage = { getObject: vi.fn().mockResolvedValue(buffer) } as unknown as StorageService;
    const svc = new PdfExtractionService(prisma, storage);
    await svc.processDocument('doc-4');
    await svc.processDocument('doc-4');
    expect(vi.mocked(prisma.documentPage.upsert)).toHaveBeenCalledTimes(2);
  });

  it('OCR failure persists the failed page and does not mark READY', async () => {
    const buffer = await makePdf(Array(10).fill(''));
    const prisma = {
      document: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'doc-ocr',
          subjectId: 'subject-ocr',
          title: 'ocr.pdf',
          fileUrl: 'subject-ocr/doc-ocr.pdf',
          subject: { id: 'subject-ocr' },
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      documentPage: {
        findMany: vi.fn().mockResolvedValueOnce([]).mockResolvedValue(Array.from({ length: 10 }, (_, index) => ({ pageNumber: index + 1, needsOcr: true, ocrUsed: index !== 6, ocrError: index === 6 ? 'OCR failed on page 7' : null }))),
        upsert: vi.fn().mockResolvedValue({}),
      },
    } as unknown as PrismaService;
    const storage = { getObject: vi.fn().mockResolvedValue(buffer) } as unknown as StorageService;
    const svc = new PdfExtractionService(prisma, storage);
    const ocrPage = vi.fn().mockImplementation(async (pageNumber: number) => {
      if (pageNumber === 7) throw new Error('OCR failed on page 7');
      return 'OCR text';
    });
    const original = PdfExtractionService.prototype.extractWithOcr.bind(svc);
    vi.spyOn(svc, 'extractWithOcr').mockImplementation(async (bufferArg, options, skipPages, persistPage) =>
      original(bufferArg, options, skipPages, persistPage, ocrPage),
    );
    await expect(svc.processDocument('doc-ocr')).rejects.toThrow('OCR failed on page 7');
    expect(vi.mocked(prisma.documentPage.upsert)).toHaveBeenCalledTimes(10);
    const statuses = vi.mocked(prisma.document.update).mock.calls.map(call => call[0]?.data?.status);
    expect(statuses).toContain('FAILED');
  });

  it('crash after page 6 leaves pages 1-6 persisted and rerun skips them', async () => {
    const buffer = await makePdf(Array(10).fill('Text'));
    const upserts: number[] = [];
    const prisma = {
      document: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'doc-crash',
          subjectId: 'subject-crash',
          title: 'crash.pdf',
          fileUrl: 'subject-crash/doc-crash.pdf',
          subject: { id: 'subject-crash' },
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      documentPage: {
        findMany: vi.fn()
          .mockResolvedValueOnce([])
          .mockResolvedValue(Array.from({ length: 6 }, (_, index) => ({ pageNumber: index + 1, needsOcr: false, ocrUsed: false, ocrError: null }))),
        upsert: vi.fn().mockImplementation(async ({ where }: any) => {
          upserts.push(where.documentId_pageNumber.pageNumber);
          if (where.documentId_pageNumber.pageNumber === 7) throw new Error('crash on page 7');
          return {};
        }),
      },
    } as unknown as PrismaService;
    const storage = { getObject: vi.fn().mockResolvedValue(buffer) } as unknown as StorageService;
    const svc = new PdfExtractionService(prisma, storage);
    const original = PdfExtractionService.prototype.extractWithOcr.bind(svc);
    vi.spyOn(svc, 'extractWithOcr').mockImplementation(async (bufferArg, options, skipPages, persistPage) =>
      original(bufferArg, options, skipPages, persistPage),
    );
    await expect(svc.processDocument('doc-crash')).rejects.toThrow('crash on page 7');
    expect(upserts).toEqual([1, 2, 3, 4, 5, 6, 7]);

    const secondUpserts: number[] = [];
    (prisma.documentPage.upsert as any).mockImplementation(async ({ where }: any) => {
      secondUpserts.push(where.documentId_pageNumber.pageNumber);
      return {};
    });
    (prisma.documentPage.findMany as any).mockResolvedValue(Array.from({ length: 6 }, (_, index) => ({ pageNumber: index + 1, needsOcr: false, ocrUsed: false, ocrError: null })));
    await svc.processDocument('doc-crash');
    expect(secondUpserts).toEqual([7, 8, 9, 10]);
  });

  it('treats a scanned page with only a printed page number as incomplete', () => {
    expect(isPageComplete({ needsOcr: true, ocrUsed: false, ocrError: null })).toBe(false);
  });

  it('treats OCR that returned empty text as complete', () => {
    expect(isPageComplete({ needsOcr: true, ocrUsed: true, ocrError: null })).toBe(true);
  });

  it('ocrPages equals persisted rows with ocrUsed true after resume', async () => {
    const buffer = await makePdf(['Text', '']);
    const prisma = {
      document: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'doc-ocr-count',
          subjectId: 'subject-ocr-count',
          title: 'ocr-count.pdf',
          fileUrl: 'subject-ocr-count/doc-ocr-count.pdf',
          subject: { id: 'subject-ocr-count' },
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      documentPage: {
        findMany: vi.fn().mockResolvedValueOnce([]).mockResolvedValue([
          { pageNumber: 1, needsOcr: false, ocrUsed: false, ocrError: null },
          { pageNumber: 2, needsOcr: true, ocrUsed: true, ocrError: null },
        ]),
        upsert: vi.fn().mockResolvedValue({}),
      },
    } as unknown as PrismaService;
    const storage = { getObject: vi.fn().mockResolvedValue(buffer) } as unknown as StorageService;
    const svc = new PdfExtractionService(prisma, storage);
    vi.spyOn(svc, 'extractWithOcr').mockImplementation(async (_buffer, _options, _skipPages, persistPage) => {
      const pages = [
        { pageNumber: 1, text: 'Text', isEmpty: false, needsOcr: false, ocrUsed: false, extractionMethod: 'TEXT' as const },
        { pageNumber: 2, text: 'OCR text', isEmpty: false, needsOcr: true, ocrUsed: true, extractionMethod: 'OCR' as const },
      ];
      for (const page of pages) {
        if (persistPage) await persistPage(page as never);
      }
      return { pageCount: 2, pages: pages as never, ocrPageNumbers: [2], textPageNumbers: [1] };
    });
    await svc.processDocument('doc-ocr-count');
    const update = vi.mocked(prisma.document.update).mock.calls.find(call => call[0]?.data?.ocrPages !== undefined);
    expect(update?.[0]?.data?.ocrPages).toBe(1);
  });

  it('counts only complete pages in processedPages', async () => {
    const buffer = await makePdf(['Text', '']);
    const prisma = {
      document: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'doc-count',
          subjectId: 'subject-count',
          title: 'count.pdf',
          fileUrl: 'subject-count/doc-count.pdf',
          subject: { id: 'subject-count' },
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      documentPage: {
        findMany: vi.fn().mockResolvedValueOnce([]).mockResolvedValue([
          { pageNumber: 1, needsOcr: false, ocrUsed: false, ocrError: null },
          { pageNumber: 2, needsOcr: true, ocrUsed: false, ocrError: null },
        ]),
        upsert: vi.fn().mockResolvedValue({}),
      },
    } as unknown as PrismaService;
    const storage = { getObject: vi.fn().mockResolvedValue(buffer) } as unknown as StorageService;
    const svc = new PdfExtractionService(prisma, storage);
    vi.spyOn(svc, 'extractWithOcr').mockImplementation(async (_buffer, _options, _skipPages, persistPage) => {
      const pages = [
        { pageNumber: 1, text: 'Text', isEmpty: false, needsOcr: false, ocrUsed: false, extractionMethod: 'TEXT' as const },
        { pageNumber: 2, text: '', isEmpty: true, needsOcr: true, ocrUsed: false, extractionMethod: 'TEXT' as const },
      ];
      for (const page of pages) {
        if (persistPage) await persistPage(page as never);
      }
      return { pageCount: 2, pages: pages as never, ocrPageNumbers: [2], textPageNumbers: [1] };
    });
    await svc.processDocument('doc-count');
    const update = vi.mocked(prisma.document.update).mock.calls.find(call => call[0]?.data?.processedPages !== undefined);
    expect(update?.[0]?.data?.processedPages).toBe(1);
  });
});
