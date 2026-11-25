import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { MockTestError } from './exam.errors.js';
import {
  QuestionReportDto,
  QuarantinedQuestionDto,
  type ResolveReportBody,
  type QuestionReportReason,
  type QuestionReportStatus,
} from './exam.dto.js';

interface QuestionWithDetails {
  id: string;
  stem: string;
  leadIn: string | null;
  educationalObjective: string;
  status: string;
  choices: {
    id: string;
    position: number;
    text: string;
    isCorrect: boolean;
    explanation: string;
  }[];
  citations: {
    documentTitleSnapshot: string;
    pageNumber: number;
    quote: string;
  }[];
  reports: {
    id: string;
    attemptId: string;
    reason: QuestionReportReason;
    details: string | null;
    status: QuestionReportStatus;
    resolutionNote: string | null;
    createdAt: Date;
  }[];
}

@Injectable()
export class QuestionsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * Creates a report for a question and immediately quarantines it so future
   * mock test draws exclude it. The report is linked to the most recent
   * attempt that included this question, or the most recent attempt for the
   * subject if no attempt question exists.
   */
  async reportQuestion(
    questionId: string,
    reason: QuestionReportReason,
    details: string | undefined,
  ): Promise<QuestionReportDto> {
    return this.prisma.$transaction(async (tx) => {
      const question = await tx.mockQuestion.findUnique({
        where: { id: questionId },
        select: { id: true, subjectId: true, status: true },
      });
      if (!question) throw new MockTestError('QUESTION_NOT_FOUND');

      const attemptQuestion = await tx.attemptQuestion.findFirst({
        where: { questionId },
        orderBy: { attempt: { createdAt: 'desc' } },
        select: { attemptId: true },
      });

      let attemptId = attemptQuestion?.attemptId;
      if (!attemptId) {
        const latestAttempt = await tx.mockAttempt.findFirst({
          where: { subjectId: question.subjectId },
          orderBy: { createdAt: 'desc' },
          select: { id: true },
        });
        if (!latestAttempt) throw new MockTestError('ATTEMPT_NOT_FOUND');
        attemptId = latestAttempt.id;
      }

      const existingReport = await tx.questionReport.findUnique({
        where: { attemptId_questionId: { attemptId, questionId } },
      });
      if (existingReport) {
        throw new MockTestError('QUESTION_NOT_FOUND', {
          details: { alreadyReported: 1 },
        });
      }

      const report = await tx.questionReport.create({
        data: {
          attemptId,
          questionId,
          reason,
          details: details ?? null,
          status: 'OPEN',
        },
      });

      await tx.mockQuestion.update({
        where: { id: questionId },
        data: { status: 'QUARANTINED' },
      });

      return this.toReportDto(report);
    });
  }

  /**
   * Returns all quarantined questions with their citations, choices, and open reports.
   */
  async getQuarantinedQuestions(): Promise<QuarantinedQuestionDto[]> {
    const questions = await this.prisma.mockQuestion.findMany({
      where: { status: 'QUARANTINED' },
      include: {
        choices: { orderBy: { position: 'asc' } },
        citations: {
          select: { documentTitleSnapshot: true, pageNumber: true, quote: true },
          orderBy: { createdAt: 'asc' },
        },
        reports: {
          where: { status: 'OPEN' },
          orderBy: { createdAt: 'desc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return questions.map((q) => ({
      questionId: q.id,
      stem: q.stem,
      leadIn: q.leadIn,
      choices: q.choices.map((c) => ({
        id: c.id,
        position: c.position,
        text: c.text,
        isCorrect: c.isCorrect,
        explanation: c.explanation,
      })),
      citations: q.citations,
      educationalObjective: q.educationalObjective,
      status: q.status as 'QUARANTINED' | 'RETIRED',
      reports: q.reports.map((r) => this.toReportDto(r)),
    }));
  }

  /**
   * Resolves a quarantined question by either restoring it to ACTIVE (optionally
   * updating its content) or retiring it. All open reports for the question are
   * marked as resolved (ACCEPTED if action is RETIRE, DISMISSED if RESTORE).
   */
  async resolveReport(
    questionId: string,
    body: ResolveReportBody,
  ): Promise<{ questionId: string; status: 'ACTIVE' | 'RETIRED' }> {
    return this.prisma.$transaction(async (tx) => {
      const question = await tx.mockQuestion.findUnique({
        where: { id: questionId },
        select: { id: true, status: true },
      });
      if (!question) throw new MockTestError('QUESTION_NOT_FOUND');
      if (question.status !== 'QUARANTINED') {
        throw new MockTestError('QUESTION_NOT_FOUND', {
          details: { notQuarantined: 1 },
        });
      }

      if (body.action === 'RESTORE') {
        await tx.mockQuestion.update({
          where: { id: questionId },
          data: {
            status: 'ACTIVE',
            ...(body.stem !== undefined && { stem: body.stem }),
            ...(body.leadIn !== undefined && { leadIn: body.leadIn }),
            ...(body.educationalObjective !== undefined && {
              educationalObjective: body.educationalObjective,
            }),
            ...(body.choices !== undefined && {
              choices: {
                deleteMany: {},
                create: body.choices.map((choice) => ({
                  position: choice.position,
                  text: choice.text,
                  isCorrect: choice.isCorrect,
                  explanation: choice.explanation,
                })),
              },
            }),
          },
        });
        await tx.questionReport.updateMany({
          where: { questionId, status: 'OPEN' },
          data: { status: 'DISMISSED', resolutionNote: body.resolutionNote ?? null },
        });
        return { questionId, status: 'ACTIVE' as const };
      }

      await tx.mockQuestion.update({
        where: { id: questionId },
        data: { status: 'RETIRED' },
      });
      await tx.questionReport.updateMany({
        where: { questionId, status: 'OPEN' },
        data: { status: 'ACCEPTED', resolutionNote: body.resolutionNote ?? null },
      });
      return { questionId, status: 'RETIRED' as const };
    });
  }

  private toReportDto(report: {
    id: string;
    attemptId: string;
    questionId: string;
    reason: QuestionReportReason;
    details: string | null;
    status: QuestionReportStatus;
    resolutionNote: string | null;
    createdAt: Date;
  }): QuestionReportDto {
    return {
      id: report.id,
      attemptId: report.attemptId,
      questionId: report.questionId,
      reason: report.reason,
      details: report.details,
      status: report.status,
      resolutionNote: report.resolutionNote,
      createdAt: report.createdAt,
    };
  }
}