import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { extractText, renderPageAsImage } from 'unpdf';
import { createWorker, type Worker } from 'tesseract.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { ExtractionMethod } from '@prisma/client';
import { ChunkingService } from '../chunking/chunking.service.js';

export interface ExtractedPdfPage {
  pageNumber: number;
  text: string;
  isEmpty: boolean;
  needsOcr: boolean;
  ocrUsed: boolean;
  ocrError?: string;
  extractionMethod: 'TEXT' | 'OCR' | 'HYBRID';
}

export interface PdfExtractionResult {
  subjectId?: string;
  documentId?: string;
  filename?: string;
  storageKey?: string;
  pageCount: number;
  pages: ExtractedPdfPage[];
  ocrPageNumbers: number[];
  textPageNumbers: number[];
}

export interface PdfExtractionOptions {
  minCharsPerPage?: number;
}

export function isPageComplete(page: { needsOcr: boolean; ocrUsed: boolean; ocrError?: string | null }): boolean {
  return !page.needsOcr || (page.ocrUsed && page.ocrError == null);
}

@Injectable()
export class PdfExtractionService {
  private readonly logger = new Logger(PdfExtractionService.name);

  constructor(
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly storage?: StorageService,
    @Optional() private readonly chunking?: ChunkingService,
  ) {}

  async extractFromBuffer(
    buffer: Buffer | Uint8Array | ArrayBuffer,
    options: PdfExtractionOptions = {},
  ): Promise<PdfExtractionResult> {
    const bytes = toUint8Array(buffer);
    const minChars = options.minCharsPerPage ?? 1;
    const { totalPages, text } = await extractText(bytes, { mergePages: false });
    const pages: ExtractedPdfPage[] = [];
    const ocrPageNumbers: number[] = [];
    const textPageNumbers: number[] = [];
    const count = Math.max(0, totalPages ?? 0);
    for (let i = 0; i < count; i++) {
      const pageText = (Array.isArray(text) ? text[i] : '') ?? '';
      const normalized = String(pageText);
      const needsOcr = normalized.trim().length < minChars;
      const page: ExtractedPdfPage = {
        pageNumber: i + 1,
        text: normalized,
        isEmpty: normalized.trim().length === 0,
        needsOcr,
        ocrUsed: false,
        extractionMethod: 'TEXT',
      };
      pages.push(page);
      if (needsOcr) ocrPageNumbers.push(page.pageNumber);
      else textPageNumbers.push(page.pageNumber);
    }
    return {
      pageCount: pages.length,
      pages,
      ocrPageNumbers,
      textPageNumbers,
    };
  }

  async extractFromPdf(
    buffer: Buffer | Uint8Array | ArrayBuffer,
    options?: PdfExtractionOptions,
  ): Promise<PdfExtractionResult> {
    return this.extractFromBuffer(buffer, options);
  }

  async extractPdf(
    buffer: Buffer | Uint8Array | ArrayBuffer,
    options?: PdfExtractionOptions,
  ): Promise<PdfExtractionResult> {
    return this.extractFromBuffer(buffer, options);
  }

  async extract(
    buffer: Buffer | Uint8Array | ArrayBuffer,
    options?: PdfExtractionOptions,
  ): Promise<PdfExtractionResult> {
    return this.extractFromBuffer(buffer, options);
  }

  async extractFromBytes(
    buffer: Buffer | Uint8Array | ArrayBuffer,
    options?: PdfExtractionOptions,
  ): Promise<PdfExtractionResult> {
    return this.extractFromBuffer(buffer, options);
  }

  async extractFromStorageKey(
    key: string,
    context: { subjectId?: string; documentId?: string; filename?: string } = {},
  ): Promise<PdfExtractionResult> {
    if (!this.storage) throw new Error('StorageService is not available.');
    const buffer = await this.storage.getObject(key);
    const result = await this.extractFromBuffer(buffer);
    return {
      ...result,
      subjectId: context.subjectId,
      documentId: context.documentId,
      filename: context.filename,
      storageKey: key,
    };
  }

  async extractFromR2(
    key: string,
    context?: { subjectId?: string; documentId?: string; filename?: string },
  ): Promise<PdfExtractionResult> {
    return this.extractFromStorageKey(key, context ?? {});
  }

  async retrieveAndExtract(
    key: string,
    context?: { subjectId?: string; documentId?: string; filename?: string },
  ): Promise<PdfExtractionResult> {
    return this.extractFromStorageKey(key, context ?? {});
  }

  async extractDocument(documentId: string): Promise<PdfExtractionResult> {
    if (!this.prisma) throw new Error('PrismaService is not available.');
    const document = await this.prisma.document.findUnique({
      where: { id: documentId },
      include: { subject: true },
    });
    if (!document) throw new NotFoundException(`Document ${documentId} not found.`);
    const storageKey = document.fileUrl;
    if (!this.storage) throw new Error('StorageService is not available.');
    const buffer = await this.storage.getObject(storageKey);
    const result = await this.extractFromBuffer(buffer);
    return {
      ...result,
      subjectId: document.subjectId,
      documentId: document.id,
      filename: document.title,
      storageKey,
    };
  }

  async extractWithOcr(
    buffer: Buffer | Uint8Array | ArrayBuffer,
    options: PdfExtractionOptions = {},
    skipPages: Set<number> = new Set(),
    persistPage?: (page: ExtractedPdfPage) => Promise<void>,
    ocrPage?: (pageNumber: number, bytes: Uint8Array) => Promise<string>,
  ): Promise<PdfExtractionResult> {
    const result = await this.extractFromBuffer(buffer, options);
    const bytes = toUint8Array(buffer);

    let worker: Worker | null = null;
    const defaultOcrPage = async (pageNumber: number, pageBytes: Uint8Array): Promise<string> => {
      if (!worker) worker = await createWorker('eng');
      const image = await renderPageAsImage(pageBytes, pageNumber, {
        scale: 2,
        canvasImport: () => import('@napi-rs/canvas'),
      });
      const { data } = await worker.recognize(Buffer.from(image));
      return (data.text ?? '').trim();
    };
    const runOcr = ocrPage ?? defaultOcrPage;

    try {
      for (const page of result.pages) {
        if (skipPages.has(page.pageNumber)) continue;
        if (page.needsOcr) {
          try {
            const ocrText = await runOcr(page.pageNumber, bytes);
            if (ocrText.length > 0) {
              page.text = page.text.trim() ? `${page.text.trim()}\n${ocrText}` : ocrText;
              page.ocrUsed = true;
              page.extractionMethod = page.isEmpty ? 'OCR' : 'HYBRID';
              page.isEmpty = page.text.trim().length === 0;
            } else {
              page.ocrUsed = true;
              page.extractionMethod = 'OCR';
            }
          } catch (error) {
            page.ocrUsed = false;
            page.ocrError = error instanceof Error ? error.message : String(error);
          }
        }
        if (persistPage) {
          await persistPage(page);
        }
      }
    } finally {
      if (worker) await (worker as Worker).terminate();
    }
    return result;
  }

  async processDocument(
    documentId: string,
    options: PdfExtractionOptions = {},
  ): Promise<PdfExtractionResult & { persistedPages: number }> {
    if (!this.prisma) throw new Error('PrismaService is not available.');
    if (!this.storage) throw new Error('StorageService is not available.');

    const document = await this.prisma.document.findUnique({
      where: { id: documentId },
      include: { subject: true },
    });
    if (!document) throw new NotFoundException(`Document ${documentId} not found.`);

    await this.prisma.document.update({
      where: { id: document.id },
      data: { status: 'PROCESSING', errorMessage: null },
    });

    try {
      const buffer = await this.storage.getObject(document.fileUrl);
      const existingPages = await this.prisma.documentPage.findMany({ where: { documentId: document.id } });
      const existingByPage = new Map(existingPages.map(page => [page.pageNumber, page]));
      const skipPages = new Set(
        existingPages.filter(page => isPageComplete(page)).map(page => page.pageNumber),
      );

      const persistPage = async (page: ExtractedPdfPage) => {
        const method =
          page.extractionMethod === 'OCR'
            ? ExtractionMethod.OCR
            : page.extractionMethod === 'HYBRID'
              ? ExtractionMethod.HYBRID
              : ExtractionMethod.TEXT;
        await this.prisma!.documentPage.upsert({
          where: {
            documentId_pageNumber: {
              documentId: document.id,
              pageNumber: page.pageNumber,
            },
          },
          create: {
            documentId: document.id,
            pageNumber: page.pageNumber,
            text: page.text,
            charCount: page.text.trim().length,
            extractionMethod: method,
            needsOcr: page.needsOcr,
            ocrUsed: page.ocrUsed,
            ocrError: page.ocrError,
          },
          update: {
            text: page.text,
            charCount: page.text.trim().length,
            extractionMethod: method,
            needsOcr: page.needsOcr,
            ocrUsed: page.ocrUsed,
            ocrError: page.ocrError,
          },
        });
      };

      const result = await this.extractWithOcr(buffer, options, skipPages, persistPage);
      const persistedPages = await this.prisma.documentPage.findMany({ where: { documentId: document.id } });

      if (this.chunking) {
        await this.chunking.chunkDocument(document.id, {});
      }

      const hasOcrFailure = persistedPages.some(page => page.ocrError != null);
      const ocrPages = persistedPages.filter(page => page.ocrUsed).length;
      const completePages = persistedPages.filter(page => isPageComplete(page)).length;
      await this.prisma.document.update({
        where: { id: document.id },
        data: {
          pageCount: result.pageCount,
          ocrPages,
          processedPages: completePages,
          status: hasOcrFailure ? 'FAILED' : 'PROCESSING',
          errorMessage: hasOcrFailure
            ? persistedPages.find(page => page.ocrError)?.ocrError ?? 'OCR failed.'
            : null,
        },
      });

      if (hasOcrFailure) {
        throw new Error(persistedPages.find(page => page.ocrError)?.ocrError ?? 'OCR failed.');
      }

      return {
        ...result,
        subjectId: document.subjectId,
        documentId: document.id,
        filename: document.title,
        storageKey: document.fileUrl,
        persistedPages: persistedPages.length,
      };
    } catch (error) {
      await this.prisma.document.update({
        where: { id: document.id },
        data: {
          status: 'FAILED',
          errorMessage: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }
  }

  async processSubjectDocuments(
    subjectId: string,
    options: PdfExtractionOptions = {},
  ): Promise<Array<PdfExtractionResult & { persistedPages: number }>> {
    if (!this.prisma) throw new Error('PrismaService is not available.');
    const subject = await this.prisma.subject.findUnique({
      where: { id: subjectId },
      include: { documents: true },
    });
    if (!subject) throw new NotFoundException(`Subject ${subjectId} not found.`);
    const results: Array<PdfExtractionResult & { persistedPages: number }> = [];
    for (const document of subject.documents) {
      results.push(await this.processDocument(document.id, options));
    }
    return results;
  }

  async extractForDocument(documentId: string): Promise<PdfExtractionResult> {
    return this.extractDocument(documentId);
  }

  async extractSubjectDocuments(subjectId: string): Promise<PdfExtractionResult[]> {
    if (!this.prisma) throw new Error('PrismaService is not available.');
    const subject = await this.prisma.subject.findUnique({
      where: { id: subjectId },
      include: { documents: true },
    });
    if (!subject) throw new NotFoundException(`Subject ${subjectId} not found.`);
    const results: PdfExtractionResult[] = [];
    for (const document of subject.documents) {
      results.push(await this.extractDocument(document.id));
    }
    return results;
  }

  async extractSubject(subjectId: string): Promise<PdfExtractionResult[]> {
    return this.extractSubjectDocuments(subjectId);
  }
}

function toUint8Array(buffer: Buffer | Uint8Array | ArrayBuffer): Uint8Array {
  if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer);
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}
