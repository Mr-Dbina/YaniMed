import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { getResolvedPDFJS, renderPageAsImage } from 'unpdf';
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
    const pageSevenCall = vi.mocked(prisma.documentPage.upsert).mock.calls.find(call => call[0]?.where?.documentId_pageNumber?.pageNumber === 7);
    expect(pageSevenCall?.[0]?.create?.ocrError).toBe('OCR failed on page 7');
    expect(pageSevenCall?.[0]?.create?.ocrUsed).toBe(false);
    const upsertedPages = vi.mocked(prisma.documentPage.upsert).mock.calls.map(call => call[0]?.where?.documentId_pageNumber?.pageNumber);
    expect(upsertedPages).toContain(8);
    expect(upsertedPages).toContain(9);
    expect(upsertedPages).toContain(10);
    const statuses = vi.mocked(prisma.document.update).mock.calls.map(call => call[0]?.data?.status);
    expect(statuses).toContain('FAILED');

    // Rerun: only page 7 should be OCRed again.
    ocrPage.mockClear();
    vi.mocked(prisma.documentPage.upsert).mockClear();
    (prisma.documentPage.findMany as any)
      .mockResolvedValueOnce(Array.from({ length: 10 }, (_, index) => ({
        pageNumber: index + 1,
        needsOcr: true,
        ocrUsed: index !== 6,
        ocrError: index === 6 ? 'OCR failed on page 7' : null,
      })))
      .mockResolvedValue(Array.from({ length: 10 }, (_, index) => ({
        pageNumber: index + 1,
        needsOcr: true,
        ocrUsed: true,
        ocrError: null,
      })));
    const workingOcr = vi.fn().mockResolvedValue('OCR text');
    const rerunSpy = vi.spyOn(svc, 'extractWithOcr');
    rerunSpy.mockImplementation(async (bufferArg, options, skipPages, persistPage) =>
      (PdfExtractionService.prototype.extractWithOcr as any).call(svc, bufferArg, options, skipPages, persistPage, workingOcr),
    );
    await svc.processDocument('doc-ocr');
    expect(workingOcr).toHaveBeenCalledTimes(1);
    expect(workingOcr).toHaveBeenCalledWith(7, expect.any(Uint8Array));
    expect(vi.mocked(prisma.documentPage.upsert)).toHaveBeenCalledTimes(1);
    const rerunUpserted = vi.mocked(prisma.documentPage.upsert).mock.calls.map(call => call[0]?.where?.documentId_pageNumber?.pageNumber);
    expect(rerunUpserted).toEqual([7]);
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
        findMany: vi.fn().mockResolvedValueOnce([
          { pageNumber: 1, needsOcr: false, ocrUsed: false, ocrError: null },
          { pageNumber: 2, needsOcr: true, ocrUsed: true, ocrError: null },
        ]).mockResolvedValue([
          { pageNumber: 1, needsOcr: false, ocrUsed: false, ocrError: null },
          { pageNumber: 2, needsOcr: true, ocrUsed: true, ocrError: null },
        ]),
        upsert: vi.fn().mockResolvedValue({}),
      },
    } as unknown as PrismaService;
    const storage = { getObject: vi.fn().mockResolvedValue(buffer) } as unknown as StorageService;
    const svc = new PdfExtractionService(prisma, storage);
    vi.spyOn(svc, 'extractWithOcr').mockImplementation(async (_buffer, _options, skipPages, persistPage) => {
      expect(skipPages).toEqual(new Set([1, 2]));
      const pages = [
        { pageNumber: 1, text: 'Text', isEmpty: false, needsOcr: false, ocrUsed: false, extractionMethod: 'TEXT' as const },
        { pageNumber: 2, text: '', isEmpty: true, needsOcr: true, ocrUsed: false, extractionMethod: 'TEXT' as const },
      ];
      for (const page of pages) {
        if (skipPages?.has(page.pageNumber)) continue;
        if (persistPage) await persistPage(page as never);
      }
      return { pageCount: 2, pages: pages as never, ocrPageNumbers: [2], textPageNumbers: [1] };
    });
    await svc.processDocument('doc-ocr-count');
    const update = vi.mocked(prisma.document.update).mock.calls.find(call => call[0]?.data?.ocrPages !== undefined);
    expect(update?.[0]?.data?.ocrPages).toBe(1);
    const resultPageOcrCount = 0;
    expect(update?.[0]?.data?.ocrPages).not.toBe(resultPageOcrCount);
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
        { pageNumber: 2, text: '', isEmpty: true, needsOcr: true, ocrUsed: false, extractionMethod: 'TEXT' as const },
      ];
      for (const page of pages) {
        if (persistPage) await persistPage(page as never);
      }
      return { pageCount: 2, pages: pages as never, ocrPageNumbers: [2], textPageNumbers: [1] };
    });
    await svc.processDocument('doc-count');
    const update = vi.mocked(prisma.document.update).mock.calls.find(call => call[0]?.data?.processedPages !== undefined);
    expect(update?.[0]?.data?.processedPages).toBe(2);
  });
});

describe('PdfExtractionService scanned-page detection', () => {
  let service: PdfExtractionService;
  let getOperatorListSpy: any;
  let pageProto: any;
  let originalGetOperatorList: any;

  async function makeImagePdf(text: string, width: number, height: number): Promise<Buffer> {
    const { createCanvas } = await import('@napi-rs/canvas');
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'red';
    ctx.fillRect(0, 0, width, height);
    const png = canvas.toBuffer('image/png');
    const pdf = await PDFDocument.create();
    const image = await pdf.embedPng(png);
    const pageWidth = Math.max(width, 100);
    const pageHeight = Math.max(height, 100);
    const page = pdf.addPage([pageWidth, pageHeight]);
    if (text) {
      const font = await pdf.embedFont(StandardFonts.Helvetica);
      page.drawText(text, { x: 5, y: pageHeight - 12, size: 12, font });
    }
    page.drawImage(image, { x: 0, y: 0, width, height });
    return Buffer.from(await pdf.save());
  }

  beforeAll(async () => {
    const { getDocumentProxy } = await import('unpdf');
    const buf = await makeImagePdf('', 10, 10);
    const doc = await getDocumentProxy(new Uint8Array(buf));
    const page = await doc.getPage(1);
    originalGetOperatorList = Object.getPrototypeOf(page).getOperatorList;
    await doc.loadingTask.destroy();
  });

  beforeEach(async () => {
    service = new PdfExtractionService();
    const { getDocumentProxy } = await import('unpdf');
    const buf = await makeImagePdf('', 10, 10);
    const doc = await getDocumentProxy(new Uint8Array(buf));
    const page = await doc.getPage(1);
    pageProto = Object.getPrototypeOf(page);
    await doc.loadingTask.destroy();
    getOperatorListSpy = vi.spyOn(pageProto, 'getOperatorList');
    getOperatorListSpy.mockImplementation(async function (this: any) {
      return originalGetOperatorList.call(this);
    });
    getOperatorListSpy.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('T1: large image + short text "12" -> needsOcr true', async () => {
    const buffer = await makeImagePdf('12', 200, 100);
    const result = await service.extractFromBuffer(buffer);
    expect(result.pages[0].needsOcr).toBe(true);
  });

  it('T2: large image + caption under 50 chars -> needsOcr true', async () => {
    const buffer = await makeImagePdf('Fig 1', 200, 100);
    const result = await service.extractFromBuffer(buffer);
    expect(result.pages[0].needsOcr).toBe(true);
  });

  it('T3: large image + >=50 chars text -> needsOcr false, getOperatorList not called', async () => {
    const longText = 'This sentence is definitely longer than fifty characters in total.';
    const buffer = await makeImagePdf(longText, 400, 200);
    const result = await service.extractFromBuffer(buffer);
    expect(result.pages[0].needsOcr).toBe(false);
    expect(getOperatorListSpy).not.toHaveBeenCalled();
  });

  it('T4: tiny image + text "12" falls back to text rule (needsOcr false)', async () => {
    const buffer = await makeImagePdf('12', 10, 10);
    const result = await service.extractFromBuffer(buffer);
    expect(result.pages[0].needsOcr).toBe(false);
  });

  it('T5: text-only page with enough text -> getOperatorList not called', async () => {
    const buffer = await makePdf(['This page has plenty of text content for extraction.']);
    const result = await service.extractFromBuffer(buffer);
    expect(result.pages[0].needsOcr).toBe(false);
    expect(getOperatorListSpy).not.toHaveBeenCalled();
  });

  it('T6: enableImageDetection=false makes T1/T2 behave like old code', async () => {
    const b1 = await makeImagePdf('12', 200, 100);
    const r1 = await service.extractFromBuffer(b1, { enableImageDetection: false });
    expect(r1.pages[0].needsOcr).toBe(false);
    const b2 = await makeImagePdf('Fig 1', 200, 100);
    const r2 = await service.extractFromBuffer(b2, { enableImageDetection: false });
    expect(r2.pages[0].needsOcr).toBe(false);
  });

  it('T8: getOperatorList throws -> resolves, text rule result, cleanup + destroy called', async () => {
    const originalCleanup = pageProto.cleanup;
    const cleanupSpy = vi.spyOn(pageProto, 'cleanup');
    cleanupSpy.mockImplementation(function (this: any) {
      return originalCleanup.call(this);
    });
    const originalDestroy = (service as any).destroyDocumentProxy.bind(service);
    const destroySpy = vi.spyOn(service as any, 'destroyDocumentProxy');
    destroySpy.mockImplementation(async function (this: any, pdf: any) {
      return originalDestroy(pdf);
    });
    getOperatorListSpy.mockImplementationOnce(async () => {
      throw new Error('detection boom');
    });
    const buffer = await makeImagePdf('12', 200, 100);
    const result = await service.extractFromBuffer(buffer);
    expect(result.pages[0].needsOcr).toBe(false);
    expect(cleanupSpy).toHaveBeenCalled();
    expect(destroySpy).toHaveBeenCalled();
    cleanupSpy.mockRestore();
    destroySpy.mockRestore();
  });

  it('T8b: getPage throws -> rejects and destroyDocumentProxy runs', async () => {
    const originalDestroy = (service as any).destroyDocumentProxy.bind(service);
    const destroySpy = vi.spyOn(service as any, 'destroyDocumentProxy');
    destroySpy.mockImplementation(async function (this: any, pdf: any) {
      return originalDestroy(pdf);
    });
    const { getDocumentProxy } = await import('unpdf');
    const buf = await makeImagePdf('12', 200, 100);
    const doc = await getDocumentProxy(new Uint8Array(buf));
    vi.spyOn(doc, 'getPage').mockRejectedValueOnce(new Error('page boom'));
    const proxySpy = vi.spyOn(service as any, 'getDocumentProxy').mockResolvedValueOnce(doc as any);
    const buffer = await makeImagePdf('12', 200, 100);
    await expect(service.extractFromBuffer(buffer)).rejects.toThrow('page boom');
    expect(destroySpy).toHaveBeenCalled();
    proxySpy.mockRestore();
    destroySpy.mockRestore();
    await doc.loadingTask.destroy();
  });

  it('logging: catch path calls logger.warn with page number', async () => {
    const loggerSpy = vi.spyOn((service as any).logger, 'warn');
    getOperatorListSpy.mockImplementationOnce(async () => {
      throw new Error('boom');
    });
    const buffer = await makeImagePdf('12', 200, 100);
    await service.extractFromBuffer(buffer);
    expect(loggerSpy).toHaveBeenCalledWith(expect.stringContaining('page 1'));
    loggerSpy.mockRestore();
  });

  it('buffer reuse: Uint8Array input unchanged and renderPageAsImage works', async () => {
    const pdfBuffer = await makeImagePdf('12', 200, 100);
    const bytes = new Uint8Array(pdfBuffer);
    const originalLength = bytes.byteLength;
    const svc = new PdfExtractionService();
    await svc.extractFromBuffer(bytes);
    expect(bytes.byteLength).toBe(originalLength);
    const image = await renderPageAsImage(bytes, 1, { canvasImport: () => import('@napi-rs/canvas') });
    expect(image).toBeTruthy();
  });

  it('T9: hasQualifyingImage/readImagePixels handle operator shapes', async () => {
    const resolved = await getResolvedPDFJS();
    const OPS = resolved.OPS as any;
    const svc = new PdfExtractionService();
    const minImagePixels = 10000;

    // a. paintImageXObject above/below
    let ops: any = { fnArray: [OPS.paintImageXObject], argsArray: [['id', 200, 100]] };
    expect((svc as any).hasQualifyingImage(ops, minImagePixels, new Set([OPS.paintImageXObject]), OPS)).toBe(true);
    ops = { fnArray: [OPS.paintImageXObject], argsArray: [['id', 10, 10]] };
    expect((svc as any).hasQualifyingImage(ops, minImagePixels, new Set([OPS.paintImageXObject]), OPS)).toBe(false);

    // b. paintImageMaskXObject above/below
    ops = { fnArray: [OPS.paintImageMaskXObject], argsArray: [[{ width: 200, height: 100 }]] };
    expect((svc as any).hasQualifyingImage(ops, minImagePixels, new Set([OPS.paintImageMaskXObject]), OPS)).toBe(true);
    ops = { fnArray: [OPS.paintImageMaskXObject], argsArray: [[{ width: 10, height: 10 }]] };
    expect((svc as any).hasQualifyingImage(ops, minImagePixels, new Set([OPS.paintImageMaskXObject]), OPS)).toBe(false);

    // c. paintInlineImageXObject above/below
    ops = { fnArray: [OPS.paintInlineImageXObject], argsArray: [[{ width: 200, height: 100 }]] };
    expect((svc as any).hasQualifyingImage(ops, minImagePixels, new Set([OPS.paintInlineImageXObject]), OPS)).toBe(true);
    ops = { fnArray: [OPS.paintInlineImageXObject], argsArray: [[{ width: 10, height: 10 }]] };
    expect((svc as any).hasQualifyingImage(ops, minImagePixels, new Set([OPS.paintInlineImageXObject]), OPS)).toBe(false);

    // d. paintImageXObjectRepeat above/below
    ops = { fnArray: [OPS.paintImageXObjectRepeat], argsArray: [['name', 200, 100, new Float32Array([0, 0])]] };
    expect((svc as any).hasQualifyingImage(ops, minImagePixels, new Set([OPS.paintImageXObjectRepeat]), OPS)).toBe(true);
    ops = { fnArray: [OPS.paintImageXObjectRepeat], argsArray: [['name', 10, 10, new Float32Array([0, 0])]] };
    expect((svc as any).hasQualifyingImage(ops, minImagePixels, new Set([OPS.paintImageXObjectRepeat]), OPS)).toBe(false);

    // e. unreadable size -> qualifying
    ops = { fnArray: [OPS.paintImageXObject], argsArray: [undefined] };
    expect((svc as any).hasQualifyingImage(ops, minImagePixels, new Set([OPS.paintImageXObject]), OPS)).toBe(true);

    // f. non-image ops only -> false
    ops = { fnArray: [OPS.showText], argsArray: [['hello']] };
    expect((svc as any).hasQualifyingImage(ops, minImagePixels, new Set([OPS.paintImageXObject]), OPS)).toBe(false);
  });

  it('integration: extractWithOcr runs OCR for image page', async () => {
    const buffer = await makeImagePdf('12', 200, 100);
    const prisma = {
      document: { findUnique: vi.fn().mockResolvedValue({ id: 'doc-x', status: 'QUEUED' }), update: vi.fn().mockResolvedValue({}), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      documentPage: { findMany: vi.fn().mockResolvedValue([]), upsert: vi.fn().mockResolvedValue({}) },
    } as any;
    const svc = new PdfExtractionService(prisma);
    const ocrPage = vi.fn().mockResolvedValue('OCR RESULT');
    const result = await (svc as any).extractWithOcr(buffer, {}, new Set(), async (page: any) => {
      await prisma.documentPage.upsert({ where: { documentId_pageNumber: { documentId: 'doc-x', pageNumber: page.pageNumber } }, create: page, update: page });
    }, ocrPage);
    expect(ocrPage).toHaveBeenCalled();
    expect(result.pages[0].needsOcr).toBe(true);
    expect(result.pages[0].ocrUsed).toBe(true);
    expect(result.pages[0].extractionMethod).toBe('HYBRID');
  });

  it('integration: enableImageDetection=false skips OCR for image page', async () => {
    const buffer = await makeImagePdf('12', 200, 100);
    const ocrPage = vi.fn().mockResolvedValue('OCR RESULT');
    const svc = new PdfExtractionService();
    await (svc as any).extractWithOcr(buffer, { enableImageDetection: false }, new Set(), undefined, ocrPage);
    expect(ocrPage).not.toHaveBeenCalled();
  });

  it('resolveOcrConfig uses ConfigService camelCase values', async () => {
    const cfg = { get: (key: string) => (key === 'pdfOcrMinImagePixels' ? 0 : undefined) };
    const svc = new PdfExtractionService(undefined, undefined, undefined, cfg as any);
    const buffer = await makeImagePdf('12', 10, 10);
    const result = await svc.extractFromBuffer(buffer);
    // minImagePixels=0 makes the tiny image qualify
    expect(result.pages[0].needsOcr).toBe(true);
  });
});

describe('OCR time budget and page limit', () => {
  let service: PdfExtractionService;

  async function makePdf(texts: string[]): Promise<Buffer> {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    for (const text of texts) {
      const page = pdf.addPage();
      if (text) page.drawText(text, { x: 50, y: 700, size: 12, font });
    }
    return Buffer.from(await pdf.save());
  }

  beforeEach(() => {
    service = new PdfExtractionService();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('T1 maxPages: 3 flagged pages, maxPages=2 -> rejects OCR_PAGE_LIMIT_EXCEEDED', async () => {
    const buffer = await makePdf(Array(3).fill(''));
    const ocrPage = vi.fn().mockResolvedValue('OCR');
    const persistPage = vi.fn().mockResolvedValue(undefined);
    const createSpy = vi.spyOn(service as any, 'createTesseractWorker');
    await expect(service.extractWithOcr(buffer, { maxPages: 2 }, new Set(), persistPage, ocrPage)).rejects.toMatchObject({ code: 'OCR_PAGE_LIMIT_EXCEEDED' });
    expect(ocrPage).not.toHaveBeenCalled();
    expect(persistPage).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('T2 exactly maxPages flagged pages -> succeeds', async () => {
    const buffer = await makePdf(Array(2).fill(''));
    const ocrPage = vi.fn().mockResolvedValue('OCR');
    const result = await service.extractWithOcr(buffer, { maxPages: 2 }, new Set(), undefined, ocrPage);
    expect(result.pages.filter(p => p.needsOcr).length).toBe(2);
    expect(ocrPage).toHaveBeenCalledTimes(2);
  });

  it('T3 skipPages count toward cap', async () => {
    const buffer = await makePdf(Array(3).fill(''));
    const ocrPage = vi.fn().mockResolvedValue('OCR');
    await expect(service.extractWithOcr(buffer, { maxPages: 2 }, new Set([1]), undefined, ocrPage)).rejects.toMatchObject({ code: 'OCR_PAGE_LIMIT_EXCEEDED' });
  });

  it('T4 timeout (fake timers): page1 never resolves, page2 OCRs', async () => {
    const buffer = await makePdf(Array(2).fill(''));
    const ocrPage = vi.fn()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValue('OCR2');
    const persistPage = vi.fn().mockResolvedValue(undefined);
    const promise = service.extractWithOcr(buffer, { pageTimeoutMs: 10 }, new Set(), persistPage, ocrPage);
    await vi.advanceTimersByTimeAsync(20);
    const result = await promise;
    expect(result.pages[0].ocrError).toContain('OCR_PAGE_TIMEOUT');
    expect(result.pages[0].ocrError).toContain('10');
    expect(result.pages[1].ocrUsed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(persistPage).toHaveBeenCalledWith(expect.objectContaining({ pageNumber: 1, ocrError: expect.stringContaining('OCR_PAGE_TIMEOUT') }));
  });

  it('T5 timeout clears timer when page succeeds', async () => {
    const buffer = await makePdf(Array(1).fill(''));
    const ocrPage = vi.fn().mockResolvedValue('OCR');
    await service.extractWithOcr(buffer, { pageTimeoutMs: 1000 }, new Set(), undefined, ocrPage);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('T6 worker reset on timeout', async () => {
    vi.useRealTimers();
    const worker1 = { recognize: vi.fn(() => new Promise(() => {})), terminate: vi.fn().mockResolvedValue(undefined) };
    const worker2 = { recognize: vi.fn().mockResolvedValue({ data: { text: 'OCR2' } }), terminate: vi.fn().mockResolvedValue(undefined) };
    const createSpy = vi.spyOn(service as any, 'createTesseractWorker');
    createSpy.mockResolvedValueOnce(worker1).mockResolvedValueOnce(worker2);
    const buffer = await makePdf(Array(2).fill(''));
    const promise = service.extractWithOcr(buffer, { pageTimeoutMs: 500 });
    await new Promise(res => setTimeout(res, 1000));
    const result = await promise;
    const terminated = worker1.terminate.mock.calls.length + worker2.terminate.mock.calls.length;
    expect(terminated).toBe(createSpy.mock.calls.length);
    expect(worker1.terminate).toHaveBeenCalled();
    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(result.pages[0].ocrError).toContain('OCR_PAGE_TIMEOUT');
    expect(worker2.recognize).toHaveBeenCalled();
    expect(worker2.terminate).toHaveBeenCalled();
    expect(result.pages[1].ocrUsed).toBe(true);
    vi.useFakeTimers();
  });

  it('T7 budget exceeded before page3', async () => {
    const buffer = await makePdf(Array(4).fill(''));
    const ocrPage = vi.fn().mockResolvedValue('OCR');
    const persistPage = vi.fn().mockResolvedValue(undefined);
    const nowSpy = vi.spyOn(service as any, 'now');
    nowSpy.mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValueOnce(200);
    const promise = service.extractWithOcr(buffer, { docBudgetMs: 100, pageTimeoutMs: 1000 }, new Set(), persistPage, ocrPage);
    await expect(promise).rejects.toMatchObject({ code: 'OCR_TIME_BUDGET_EXCEEDED' });
    expect(persistPage).toHaveBeenCalledTimes(2);
    expect(ocrPage).toHaveBeenCalledTimes(2);
    nowSpy.mockRestore();
  });

  it('T8 budget not exceeded -> all pages OCRd', async () => {
    const buffer = await makePdf(Array(3).fill(''));
    const ocrPage = vi.fn().mockResolvedValue('OCR');
    const nowSpy = vi.spyOn(service as any, 'now');
    nowSpy.mockReturnValue(0);
    const result = await service.extractWithOcr(buffer, { docBudgetMs: 1000 }, new Set(), undefined, ocrPage);
    expect(result.pages.filter(p => p.ocrUsed).length).toBe(3);
    expect(ocrPage).toHaveBeenCalledTimes(3);
    nowSpy.mockRestore();
  });

  it('T9 worker terminated in finally on limit failure and on throw', async () => {
    const buffer = await makePdf(Array(3).fill(''));
    const createSpy = vi.spyOn(service as any, 'createTesseractWorker');
    await expect(service.extractWithOcr(buffer, { maxPages: 2 })).rejects.toMatchObject({ code: 'OCR_PAGE_LIMIT_EXCEEDED' });
    expect(createSpy).not.toHaveBeenCalled();

    const bufferA = await makePdf(Array(2).fill(''));
    const workerA = { recognize: vi.fn().mockResolvedValue({ data: { text: 'OCR' } }), terminate: vi.fn().mockResolvedValue(undefined) };
    const createSpyA = vi.spyOn(service as any, 'createTesseractWorker');
    createSpyA.mockResolvedValue(workerA);
    const nowSpy = vi.spyOn(service as any, 'now');
    nowSpy.mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValueOnce(1000);
    await expect(service.extractWithOcr(bufferA, { docBudgetMs: 100 })).rejects.toMatchObject({ code: 'OCR_TIME_BUDGET_EXCEEDED' });
    expect(workerA.terminate).toHaveBeenCalled();
    createSpyA.mockRestore();
    nowSpy.mockRestore();

    const bufferB = await makePdf(Array(2).fill(''));
    const workerB = { recognize: vi.fn().mockResolvedValue({ data: { text: 'OCR' } }), terminate: vi.fn().mockResolvedValue(undefined) };
    const createSpyB = vi.spyOn(service as any, 'createTesseractWorker');
    createSpyB.mockResolvedValue(workerB);
    const persistPage = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('persist boom'));
    await expect(service.extractWithOcr(bufferB, {}, new Set(), persistPage)).rejects.toThrow('persist boom');
    expect(workerB.terminate).toHaveBeenCalled();
    createSpyB.mockRestore();
  });

  it('item1a: late-created worker terminated on timeout', async () => {
    vi.useRealTimers();
    let release!: (v: any) => void;
    const latePromise = new Promise<any>(res => { release = res; });
    const worker1 = { recognize: vi.fn(() => new Promise(() => {})), terminate: vi.fn().mockResolvedValue(undefined) };
    const worker2 = { recognize: vi.fn().mockResolvedValue({ data: { text: 'OCR2' } }), terminate: vi.fn().mockResolvedValue(undefined) };
    const createSpy = vi.spyOn(service as any, 'createTesseractWorker');
    createSpy.mockImplementationOnce(() => latePromise.then(() => worker1));
    createSpy.mockResolvedValueOnce(worker2);
    const buffer = await makePdf(Array(2).fill(''));
    const promise = service.extractWithOcr(buffer, { pageTimeoutMs: 2000 });
    await new Promise(res => setTimeout(res, 2100));
    release(worker1);
    await new Promise(res => setTimeout(res, 2200));
    const result = await promise;

    const terminated = worker1.terminate.mock.calls.length + worker2.terminate.mock.calls.length;
    expect(terminated).toBe(createSpy.mock.calls.length);
    expect(worker1.terminate).toHaveBeenCalled();
    expect(worker2.terminate).toHaveBeenCalled();
    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(result.pages[0].ocrError).toContain('OCR_PAGE_TIMEOUT');
    expect(result.pages[1].ocrUsed).toBe(true);
    vi.useFakeTimers();
  }, 15000);

  it('item1b: created count equals terminated count', async () => {
    vi.useRealTimers();
    const worker = { recognize: vi.fn().mockResolvedValue({ data: { text: 'OCR' } }), terminate: vi.fn().mockResolvedValue(undefined) };
    const createSpy = vi.spyOn(service as any, 'createTesseractWorker');
    createSpy.mockResolvedValue(worker);
    const buffer = await makePdf(Array(2).fill(''));
    await service.extractWithOcr(buffer);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    vi.useFakeTimers();
  });

  it('sync throw becomes page ocrError', async () => {
    const buffer = await makePdf(Array(1).fill(''));
    const ocrPage = () => { throw new Error('sync boom'); };
    const persistPage = vi.fn().mockResolvedValue(undefined);
    const result = await service.extractWithOcr(buffer, {}, new Set(), persistPage, ocrPage as any);
    expect(result.pages[0].ocrError).toBe('sync boom');
    expect(result.pages[0].ocrUsed).toBe(false);
    expect(persistPage).toHaveBeenCalledWith(expect.objectContaining({ pageNumber: 1, ocrError: 'sync boom' }));
  });

  it('two consecutive timeouts then success: created count equals terminated count', async () => {
    vi.useRealTimers();
    const worker1 = { recognize: vi.fn(() => new Promise(() => {})), terminate: vi.fn().mockResolvedValue(undefined) };
    const worker2 = { recognize: vi.fn(() => new Promise(() => {})), terminate: vi.fn().mockResolvedValue(undefined) };
    const worker3 = { recognize: vi.fn().mockResolvedValue({ data: { text: 'OCR3' } }), terminate: vi.fn().mockResolvedValue(undefined) };
    const createSpy = vi.spyOn(service as any, 'createTesseractWorker');
    createSpy.mockResolvedValueOnce(worker1).mockResolvedValueOnce(worker2).mockResolvedValueOnce(worker3);
    const buffer = await makePdf(Array(3).fill(''));
    const result = await service.extractWithOcr(buffer, { pageTimeoutMs: 1000 });
    expect(createSpy).toHaveBeenCalledTimes(3);
    const terminated =
      worker1.terminate.mock.calls.length +
      worker2.terminate.mock.calls.length +
      worker3.terminate.mock.calls.length;
    expect(terminated).toBe(createSpy.mock.calls.length);
    expect(result.pages[0].ocrError).toContain('OCR_PAGE_TIMEOUT');
    expect(result.pages[1].ocrError).toContain('OCR_PAGE_TIMEOUT');
    expect(result.pages[2].ocrUsed).toBe(true);
    vi.useFakeTimers();
  }, 15000);

  it('T11 failure surface (mocked prisma): limit failure FAILED with reason starting with code', async () => {
    const buffer = await makePdf(Array(3).fill(''));
    const prisma = {
      document: { findUnique: vi.fn().mockResolvedValue({ id: 'doc-lim', subjectId: 's', title: 't', fileUrl: 'k', subject: { id: 's' } }), update: vi.fn().mockResolvedValue({}) },
      documentPage: { findMany: vi.fn().mockResolvedValue([]), upsert: vi.fn().mockResolvedValue({}) },
    } as any;
    const storage = { getObject: vi.fn().mockResolvedValue(buffer) } as any;
    const svc = new (await import('./pdf-extraction.service.js')).PdfExtractionService(prisma, storage);
    await expect(svc.processDocument('doc-lim', { maxPages: 2 })).rejects.toThrow(/OCR_PAGE_LIMIT_EXCEEDED/);
    const updateCalls = (prisma.document.update as any).mock.calls;
    const failedCall = updateCalls.find((c: any) => c[0]?.data?.status === 'FAILED');
    expect(failedCall[0].data.errorMessage.startsWith('OCR_PAGE_LIMIT_EXCEEDED')).toBe(true);
    expect((prisma.documentPage.upsert as any)).not.toHaveBeenCalled();
  });

  it('T12 resolveOcrConfig uses ConfigService keys for budget settings', async () => {
    const cfg = { get: (key: string) => (key === 'pdfOcrMaxPages' ? 1 : undefined) };
    const svc = new PdfExtractionService(undefined, undefined, undefined, cfg as any);
    const buffer = await makePdf(Array(2).fill(''));
    await expect(svc.extractWithOcr(buffer)).rejects.toMatchObject({ code: 'OCR_PAGE_LIMIT_EXCEEDED' });
  });
});
