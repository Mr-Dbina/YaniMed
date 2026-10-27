import { describe, expect, it, vi } from 'vitest';
import { DocumentProcessingService } from './document-processing.service.js';

  function makePrisma(status: string = 'QUEUED') {
  return {
    document: {
      findUnique: vi.fn().mockResolvedValue({ id: 'doc-1', status }),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
}

describe('DocumentProcessingService', () => {
  it('marks READY only after extraction, embeddings, and integrity verification', async () => {
    const prisma = makePrisma();
    const extraction = { processDocument: vi.fn().mockResolvedValue(undefined) };
    const embeddings = {
      embedDocument: vi.fn().mockResolvedValue(undefined),
      verifyDocumentEmbeddings: vi.fn().mockResolvedValue({ totalChunks: 2, isComplete: true }),
    };
    const service = new DocumentProcessingService(prisma as never, extraction as never, embeddings as never);
    await service.processDocument('doc-1');
    const statuses = (prisma.document.update as ReturnType<typeof vi.fn>).mock.calls.map((c: any) => c[0]?.data?.status);
    expect(statuses).toContain('READY');
    expect(embeddings.verifyDocumentEmbeddings).toHaveBeenCalled();
  });

  it('marks FAILED when extraction fails', async () => {
    const prisma = makePrisma();
    const extraction = { processDocument: vi.fn().mockRejectedValue(new Error('ocr failed')) };
    const embeddings = { embedDocument: vi.fn(), verifyDocumentEmbeddings: vi.fn() };
    const service = new DocumentProcessingService(prisma as never, extraction as never, embeddings as never);
    await expect(service.processDocument('doc-1')).rejects.toThrow(/ocr failed/);
    const statuses = (prisma.document.update as ReturnType<typeof vi.fn>).mock.calls.map((c: any) => c[0]?.data?.status);
    expect(statuses).toContain('FAILED');
    expect(embeddings.embedDocument).not.toHaveBeenCalled();
  });

  it('marks FAILED for empty documents', async () => {
    const prisma = makePrisma();
    const extraction = { processDocument: vi.fn().mockResolvedValue(undefined) };
    const embeddings = {
      embedDocument: vi.fn().mockResolvedValue(undefined),
      verifyDocumentEmbeddings: vi.fn().mockResolvedValue({ totalChunks: 0, isComplete: false }),
    };
    const service = new DocumentProcessingService(prisma as never, extraction as never, embeddings as never);
    await expect(service.processDocument('doc-1')).rejects.toThrow(/no extractable text/i);
    const statuses = (prisma.document.update as ReturnType<typeof vi.fn>).mock.calls.map((c: any) => c[0]?.data?.status);
    expect(statuses).toContain('FAILED');
  });

  it('skips processing when the document is already READY', async () => {
    const prisma = makePrisma('READY');
    const extraction = { processDocument: vi.fn() };
    const embeddings = { embedDocument: vi.fn(), verifyDocumentEmbeddings: vi.fn() };
    const service = new DocumentProcessingService(prisma as never, extraction as never, embeddings as never);
    await service.processDocument('doc-1');
    expect(prisma.document.updateMany).not.toHaveBeenCalled();
    expect(extraction.processDocument).not.toHaveBeenCalled();
  });

  it('does not claim an already-claimed document', async () => {
    const prisma = makePrisma();
    prisma.document.updateMany.mockResolvedValue({ count: 0 });
    const extraction = { processDocument: vi.fn() };
    const embeddings = { embedDocument: vi.fn(), verifyDocumentEmbeddings: vi.fn() };
    const service = new DocumentProcessingService(prisma as never, extraction as never, embeddings as never);
    await service.processDocument('doc-1');
    expect(extraction.processDocument).not.toHaveBeenCalled();
  });

  it('processDocument releases its in-process lock after overlapping calls', async () => {
    const prisma = makePrisma();
    const extraction = { processDocument: vi.fn().mockResolvedValue(undefined) };
    const embeddings = { embedDocument: vi.fn().mockResolvedValue(undefined), verifyDocumentEmbeddings: vi.fn().mockResolvedValue({ totalChunks: 1, isComplete: true }) };
    const service = new DocumentProcessingService(prisma as never, extraction as never, embeddings as never);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const runSpy = vi.spyOn(service as any, 'run').mockImplementation(async () => { await firstGate; });
    const firstCall = service.processDocument('doc-1');
    await Promise.resolve();
    const secondCall = service.processDocument('doc-1');
    expect((service as any).locks.size).toBe(1);
    releaseFirst();
    await firstCall;
    await secondCall;
    expect((service as any).locks.size).toBe(0);
    await service.processDocument('doc-1');
    expect((service as any).locks.size).toBe(0);
  });

  it('processDocument releases its lock when work throws', async () => {
    const prisma = makePrisma();
    const extraction = { processDocument: vi.fn() };
    const embeddings = { embedDocument: vi.fn(), verifyDocumentEmbeddings: vi.fn() };
    const service = new DocumentProcessingService(prisma as never, extraction as never, embeddings as never);
    vi.spyOn(service as any, 'run').mockRejectedValueOnce(new Error('boom'));
    await expect(service.processDocument('doc-1')).rejects.toThrow('boom');
    expect((service as any).locks.size).toBe(0);
  });

  it('processDocument serializes queued third call and cleans up lock', async () => {
    const prisma = makePrisma();
    const extraction = { processDocument: vi.fn().mockResolvedValue(undefined) };
    const embeddings = { embedDocument: vi.fn().mockResolvedValue(undefined), verifyDocumentEmbeddings: vi.fn().mockResolvedValue({ totalChunks: 1, isComplete: true }) };
    const service = new DocumentProcessingService(prisma as never, extraction as never, embeddings as never);
    const order: string[] = [];
    const gates: Array<() => void> = [];
    vi.spyOn(service as any, 'run').mockImplementation(async () => {
      const index = gates.length + 1;
      order.push(`start-${index}`);
      await new Promise<void>(resolve => { gates.push(resolve); });
      order.push(`end-${index}`);
    });
    const firstCall = service.processDocument('doc-1');
    await new Promise(resolve => setTimeout(resolve, 0));
    const secondCall = service.processDocument('doc-1');
    const thirdCall = service.processDocument('doc-1');
    expect(gates.length).toBe(1);
    gates[0]();
    await firstCall;
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(gates.length).toBe(2);
    expect(order.indexOf('start-2')).toBeGreaterThan(order.indexOf('end-1'));
    gates[1]();
    await secondCall;
    expect((service as any).locks.has('doc-1')).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 0));
    if (gates.length < 3) await new Promise(resolve => setTimeout(resolve, 0));
    gates[2]();
    await thirdCall;
    expect(order).toEqual(['start-1', 'end-1', 'start-2', 'end-2', 'start-3', 'end-3']);
    expect((service as any).locks.size).toBe(0);
  });
});
