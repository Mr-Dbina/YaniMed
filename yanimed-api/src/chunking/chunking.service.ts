import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { LeaseLostError, type JobContext } from '../document-processing/processing-job.types.js';

export interface ChunkingOptions {
  maxChars?: number;
  overlapChars?: number;
}

export interface ChunkingResult {
  documentId: string;
  chunkCount: number;
  chunkIndexes: number[];
}

@Injectable()
export class ChunkingService {
  private readonly logger = new Logger(ChunkingService.name);

  constructor(@Optional() private readonly prisma?: PrismaService) {}

  async chunkDocument(documentId: string, options: ChunkingOptions = {}, ctx?: JobContext): Promise<ChunkingResult> {
    if (!this.prisma) throw new Error('PrismaService is not available.');
    const document = await this.prisma.document.findUnique({
      where: { id: documentId },
      include: { pages: { orderBy: { pageNumber: 'asc' } } },
    });
    if (!document) throw new NotFoundException(`Document ${documentId} not found.`);

    const maxChars = options.maxChars ?? 1200;
    const overlapChars = options.overlapChars ?? 200;
    const records: Array<{
      documentId: string;
      content: string;
      page: number;
      chapterGuess: string | null;
      chunkIndex: number;
      extractionMethod: (typeof document.pages)[number]['extractionMethod'];
      needsReview: boolean;
    }> = [];

    let chunkIndex = 0;
    for (const page of document.pages) {
      const normalized = normalizeWhitespace(page.text);
      if (!normalized) continue;
      const pageChunks = splitIntoChunks(normalized, maxChars, overlapChars);
      for (const content of pageChunks) {
        records.push({
          documentId: document.id,
          content,
          page: page.pageNumber,
          chapterGuess: null,
          chunkIndex: chunkIndex++,
          extractionMethod: page.extractionMethod,
          needsReview: page.needsOcr,
        });
      }
    }

    const existingChunks = await this.prisma.chunk.findMany({
      where: { documentId: document.id },
      orderBy: { chunkIndex: 'asc' },
    });
    const existingByIndex = new Map(existingChunks.map(chunk => [chunk.chunkIndex, chunk]));
    const desiredIndexes = new Set(records.map(record => record.chunkIndex));
    const staleIds = existingChunks
      .filter(chunk => !desiredIndexes.has(chunk.chunkIndex))
      .map(chunk => chunk.id);
    const newRecords = records.filter(record => !existingByIndex.has(record.chunkIndex));

    await this.prisma.$transaction(async tx => {
      if (ctx?.lost) throw new LeaseLostError();
      if (ctx) {
        await ctx.updateDocument({ status: 'PROCESSING' }, tx);
      }
      if (newRecords.length > 0) {
        await tx.chunk.createMany({ data: newRecords });
      }
      for (const record of records) {
        const existing = existingByIndex.get(record.chunkIndex);
        if (!existing) continue;
        if (existing.content !== record.content) {
          await tx.chunk.update({
            where: { id: existing.id },
            data: {
              content: record.content,
              page: record.page,
              chapterGuess: record.chapterGuess,
              extractionMethod: record.extractionMethod,
              needsReview: record.needsReview,
              embeddingModel: null,
            },
          });
          await tx.$executeRaw`UPDATE "Chunk" SET "embedding" = NULL WHERE "id" = ${existing.id}`;
        } else {
          const metadataChanged =
            existing.page !== record.page ||
            existing.extractionMethod !== record.extractionMethod ||
            existing.needsReview !== record.needsReview ||
            existing.chapterGuess !== record.chapterGuess;
          if (metadataChanged) {
            await tx.chunk.update({
              where: { id: existing.id },
              data: {
                page: record.page,
                chapterGuess: record.chapterGuess,
                extractionMethod: record.extractionMethod,
                needsReview: record.needsReview,
              },
            });
          }
        }
      }
      if (staleIds.length > 0) {
        await tx.chunk.deleteMany({ where: { id: { in: staleIds } } });
      }
      if (!ctx) {
        await tx.document.update({
          where: { id: document.id },
          data: { status: 'PROCESSING' },
        });
      }
    }, { timeout: 30000 });

    return {
      documentId: document.id,
      chunkCount: records.length,
      chunkIndexes: records.map(record => record.chunkIndex),
    };
  }
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function splitLongSentence(sentence: string, maxChars: number): string[] {
  const words = sentence.split(' ');
  const parts: string[] = [];
  let current = '';
  for (const word of words) {
    if (current && current.length + word.length + 1 > maxChars) {
      parts.push(current.trim());
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts.filter(Boolean);
}

function splitIntoChunks(text: string, maxChars: number, overlapChars: number): string[] {
  const rawSentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [text];
  const sentences: string[] = [];
  for (const sentence of rawSentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;
    if (trimmed.length > maxChars) sentences.push(...splitLongSentence(trimmed, maxChars));
    else sentences.push(trimmed);
  }

  const chunks: string[] = [];
  let current: string[] = [];
  let currentLength = 0;

  const flush = () => {
    if (current.length === 0) return;
    chunks.push(current.join(' '));
    const overlap: string[] = [];
    let overlapLength = 0;
    for (let i = current.length - 1; i >= 0; i--) {
      if (overlapLength + current[i].length > overlapChars) break;
      overlap.unshift(current[i]);
      overlapLength += current[i].length + 1;
    }
    current = overlap;
    currentLength = overlap.join(' ').length;
  };

  for (const sentence of sentences) {
    if (currentLength + sentence.length > maxChars && current.length > 0) {
      flush();
    }
    current.push(sentence);
    currentLength += sentence.length + 1;
  }
  if (current.length > 0) chunks.push(current.join(' '));
  return chunks.filter(chunk => chunk.trim().length > 0);
}
