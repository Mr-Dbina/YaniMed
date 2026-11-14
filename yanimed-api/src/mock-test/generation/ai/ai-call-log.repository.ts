import { Injectable } from '@nestjs/common';
import type { AiCallPurpose } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service.js';

const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface AiCallLogEntry {
  jobId: string;
  purpose: AiCallPurpose;
  model: string;
  promptTokens: number | null;
  completionTokens: number | null;
  latencyMs: number;
  outcome: string;
  errorCode: string | null;
}

/** Read/write port used by the AI wrapper. Unit tests pass a fake. */
@Injectable()
export class AiCallLogRepository {
  constructor(private readonly prisma: PrismaService) {}

  async insert(entry: AiCallLogEntry): Promise<void> {
    await this.prisma.aiCallLog.create({ data: entry });
  }

  countSince(since: Date): Promise<number> {
    return this.prisma.aiCallLog.count({
      where: { createdAt: { gte: since } },
    });
  }
}

/**
 * Asia/Manila is a fixed +08:00 offset with no DST, so the calendar day starts
 * at 16:00 UTC of the previous day.
 */
export function manilaDayStart(now: number | Date = Date.now()): Date {
  const ms = now instanceof Date ? now.getTime() : now;
  return new Date(
    Math.floor((ms + MANILA_OFFSET_MS) / DAY_MS) * DAY_MS - MANILA_OFFSET_MS,
  );
}
