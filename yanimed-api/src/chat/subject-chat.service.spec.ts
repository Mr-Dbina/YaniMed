import { describe, expect, it, vi } from 'vitest';
import { SubjectChatService } from './subject-chat.service.js';

function makePrisma() {
  const tx = {
    message: { create: vi.fn().mockResolvedValue({ id: 'msg-1' }) },
    messageCitation: { create: vi.fn().mockResolvedValue({}) },
  };
  return {
    subject: { findUnique: vi.fn().mockResolvedValue({ id: 'subject-1' }) },
    chat: { findUnique: vi.fn(), create: vi.fn().mockResolvedValue({ id: 'chat-1', subjectId: 'subject-1' }) },
    message: { create: vi.fn(), createMany: vi.fn().mockResolvedValue({}) },
    messageCitation: { create: vi.fn() },
    $transaction: vi.fn(async (work: (tx: any) => Promise<unknown>) => work(tx)),
    $queryRaw: vi.fn().mockResolvedValue([{ exists: true }]),
    _tx: tx,
  };
}

describe('SubjectChatService', () => {
  it('returns grounded answer with verified citations', async () => {
    const prisma = makePrisma();
    const retrieval = {
      retrieve: vi.fn().mockResolvedValue({
        hasReadyDocuments: true,
        matches: [
          { chunkId: 'chunk-1', documentId: 'doc-1', documentTitle: 'doc.pdf', pageNumber: 3, content: 'passage', extractionMethod: 'TEXT' },
        ],
      }),
    };
    const omniroute = { complete: vi.fn().mockResolvedValue({ content: 'Answer [S1].', model: 'm' }), getRequestedModel: () => 'primary' };
    const service = new SubjectChatService(prisma as never, omniroute as never, retrieval as never);
    const result = await service.answer({ subjectId: 'subject-1', prompt: 'question' });
    expect(result.grounding).toBe('grounded');
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0].page).toBe(3);
    expect(prisma._tx.messageCitation.create).toHaveBeenCalled();
  });

  it('returns insufficient evidence when retrieval has no matches', async () => {
    const prisma = makePrisma();
    const retrieval = { retrieve: vi.fn().mockResolvedValue({ hasReadyDocuments: false, matches: [] }) };
    const omniroute = { complete: vi.fn(), getRequestedModel: () => 'primary' };
    const service = new SubjectChatService(prisma as never, omniroute as never, retrieval as never);
    const result = await service.answer({ subjectId: 'subject-1', prompt: 'question' });
    expect(result.grounding).toBe('insufficient_evidence');
    expect(result.citations).toEqual([]);
    expect(omniroute.complete).not.toHaveBeenCalled();
  });

  it('returns insufficient evidence when citations are invalid', async () => {
    const prisma = makePrisma();
    const retrieval = {
      retrieve: vi.fn().mockResolvedValue({
        hasReadyDocuments: true,
        matches: [{ chunkId: 'chunk-1', documentId: 'doc-1', documentTitle: 'doc.pdf', pageNumber: 3, content: 'passage', extractionMethod: 'TEXT' }],
      }),
    };
    const omniroute = { complete: vi.fn().mockResolvedValue({ content: 'Answer without citation.', model: 'm' }), getRequestedModel: () => 'primary' };
    const service = new SubjectChatService(prisma as never, omniroute as never, retrieval as never);
    const result = await service.answer({ subjectId: 'subject-1', prompt: 'question' });
    expect(result.grounding).toBe('insufficient_evidence');
    expect(result.citations).toEqual([]);
  });

  it('rejects invalid source identifiers and keeps only verified citations', async () => {
    const prisma = makePrisma();
    const retrieval = {
      retrieve: vi.fn().mockResolvedValue({
        hasReadyDocuments: true,
        matches: [{ chunkId: 'chunk-1', documentId: 'doc-1', documentTitle: 'doc.pdf', pageNumber: 3, content: 'passage', extractionMethod: 'TEXT' }],
      }),
    };
    const omniroute = { complete: vi.fn().mockResolvedValue({ content: 'Answer [S1] and [S999].', model: 'm' }), getRequestedModel: () => 'primary' };
    const service = new SubjectChatService(prisma as never, omniroute as never, retrieval as never);
    const result = await service.answer({ subjectId: 'subject-1', prompt: 'question' });
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0].chunkId).toBe('chunk-1');
  });

  it('throws when subject is missing', async () => {
    const prisma = makePrisma();
    prisma.subject.findUnique.mockResolvedValue(null);
    const retrieval = { retrieve: vi.fn() };
    const omniroute = { complete: vi.fn(), getRequestedModel: () => 'primary' };
    const service = new SubjectChatService(prisma as never, omniroute as never, retrieval as never);
    await expect(service.answer({ subjectId: 'missing', prompt: 'question' })).rejects.toThrow();
  });
});
