import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../../prisma/prisma.service.js';
import {
  AiCallLogRepository,
  manilaDayStart,
  type AiCallLogEntry,
} from './ai-call-log.repository.js';

describe('manilaDayStart', () => {
  it('starts the Manila day at 16:00 UTC of the previous day', () => {
    expect(
      manilaDayStart(new Date('2026-11-13T00:30:00.000Z')).toISOString(),
    ).toBe('2026-11-12T16:00:00.000Z');
  });

  it('rolls over exactly at 16:00 UTC', () => {
    expect(
      manilaDayStart(new Date('2026-11-13T15:59:59.999Z')).toISOString(),
    ).toBe('2026-11-12T16:00:00.000Z');
    expect(
      manilaDayStart(new Date('2026-11-13T16:00:00.000Z')).toISOString(),
    ).toBe('2026-11-13T16:00:00.000Z');
  });

  it('accepts epoch milliseconds', () => {
    expect(
      manilaDayStart(Date.parse('2026-11-13T23:59:59.000Z')).toISOString(),
    ).toBe('2026-11-13T16:00:00.000Z');
  });
});

describe('AiCallLogRepository', () => {
  it('inserts exactly the logged columns, never prompt text', async () => {
    const create = vi.fn().mockResolvedValue({});
    const prisma = { aiCallLog: { create } } as unknown as PrismaService;
    const repository = new AiCallLogRepository(prisma);

    const entry: AiCallLogEntry = {
      jobId: 'job-1',
      purpose: 'PLAN',
      model: 'primary',
      promptTokens: 10,
      completionTokens: 20,
      latencyMs: 150,
      outcome: 'SUCCESS',
      errorCode: null,
    };
    await repository.insert(entry);

    expect(create).toHaveBeenCalledWith({ data: entry });
  });

  it('counts every row since the given boundary', async () => {
    const count = vi.fn().mockResolvedValue(7);
    const prisma = { aiCallLog: { count } } as unknown as PrismaService;
    const repository = new AiCallLogRepository(prisma);
    const since = new Date('2026-11-12T16:00:00.000Z');

    await expect(repository.countSince(since)).resolves.toBe(7);
    expect(count).toHaveBeenCalledWith({
      where: { createdAt: { gte: since } },
    });
  });
});
