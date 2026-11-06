import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import * as unpdf from 'unpdf';
import { PdfExtractionService } from './pdf-extraction.service.js';

vi.mock('unpdf', async importOriginal => {
  const actual = await importOriginal<typeof import('unpdf')>();
  return {
    ...actual,
    extractText: vi.fn(actual.extractText),
  };
});

async function makePdf(texts: string[]): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  for (const _ of texts) {
    pdf.addPage();
  }
  return Buffer.from(await pdf.save());
}

function fakePrisma() {
  const upserts: any[] = [];
  const prisma = {
    document: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'doc-nul',
        subjectId: 'subject-1',
        title: 'nul.pdf',
        fileUrl: 'subject-1/doc-nul.pdf',
        subject: { id: 'subject-1' },
      }),
      update: vi.fn().mockResolvedValue({}),
    },
    documentPage: {
      findMany: vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValue([{ pageNumber: 1, needsOcr: false, ocrUsed: false, ocrError: null }]),
      upsert: vi.fn().mockImplementation(async (args: any) => {
        upserts.push(args);
        return {};
      }),
    },
  };
  return { prisma, upserts };
}

describe('PdfExtractionService NUL handling', () => {
  let service: PdfExtractionService;

  beforeEach(() => {
    service = new PdfExtractionService();
    vi.mocked(unpdf.extractText).mockClear();
  });

  it('TEXT path persists abc\\u0000def as abcdef and keeps other characters intact', async () => {
    vi.mocked(unpdf.extractText).mockResolvedValueOnce({
      totalPages: 1,
      text: ['abc\u0000def'],
    } as any);

    const { prisma, upserts } = fakePrisma();
    const storage = { getObject: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4 fake')) };
    const svc = new PdfExtractionService(prisma as any, storage as any);

    await svc.processDocument('doc-nul', { enableImageDetection: false });

    expect(upserts).toHaveLength(1);
    expect(upserts[0].create.text).toBe('abcdef');
    expect(upserts[0].create.charCount).toBe(6);
    expect(upserts[0].update.text).toBe('abcdef');
  });

  it('OCR path persists abc\\u0000def as abcdef and keeps other characters intact', async () => {
    const buffer = await makePdf(['']);
    const { prisma, upserts } = fakePrisma();
    const storage = { getObject: vi.fn().mockResolvedValue(buffer) };
    const svc = new PdfExtractionService(prisma as any, storage as any);
    const ocrPage = vi.fn().mockResolvedValue('abc\u0000def');
    const original = PdfExtractionService.prototype.extractWithOcr.bind(svc);
    vi.spyOn(svc, 'extractWithOcr').mockImplementation(async (bufferArg, options, skipPages, persistPage) =>
      original(bufferArg, options, skipPages, persistPage, ocrPage),
    );

    await svc.processDocument('doc-nul', { enableImageDetection: false });

    expect(upserts).toHaveLength(1);
    expect(upserts[0].create.text).toBe('abcdef');
    expect(upserts[0].create.charCount).toBe(6);
    expect(upserts[0].update.text).toBe('abcdef');
    expect(ocrPage).toHaveBeenCalledTimes(1);
  });

  it('TEXT text that is only NUL characters becomes empty and does not crash', async () => {
    vi.mocked(unpdf.extractText).mockResolvedValueOnce({
      totalPages: 1,
      text: ['\u0000\u0000'],
    } as any);

    const result = await service.extractFromBuffer(Buffer.from('%PDF-1.4 fake'), { enableImageDetection: false });

    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].text).toBe('');
    expect(result.pages[0].isEmpty).toBe(true);
    expect(result.pages[0].needsOcr).toBe(true);
  });

  it('OCR text that is only NUL characters becomes empty and does not crash', async () => {
    const buffer = await makePdf(['']);
    const persistPage = vi.fn().mockResolvedValue(undefined);
    const ocrPage = vi.fn().mockResolvedValue('\u0000\u0000');

    const result = await service.extractWithOcr(
      buffer,
      { enableImageDetection: false },
      new Set(),
      persistPage,
      ocrPage,
    );

    expect(result.pages[0].text).toBe('');
    expect(result.pages[0].isEmpty).toBe(true);
    expect(result.pages[0].ocrUsed).toBe(true);
    expect(persistPage).toHaveBeenCalledWith(expect.objectContaining({ text: '', ocrUsed: true }));
  });
});
