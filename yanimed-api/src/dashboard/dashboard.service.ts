import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  DashboardFocusTopicDto,
  DashboardRecentTestDto,
  DashboardResponse,
  DashboardSubjectDto,
  DashboardUnfinishedDto,
} from './dashboard.dto.js';
import {
  DASHBOARD_TIMEZONE,
  ageDays,
  currentStreak,
  labelForPercent,
  manilaToday,
  percentFromScore,
  rangeDays,
  selectFocusTopics,
  type DashboardRange,
  type FocusTopicRow,
} from './dashboard.logic.js';

interface TotalsRow {
  testsTaken: number;
  questionsAnswered: number;
}

interface SubjectRow {
  subjectId: string;
  name: string;
  averagePercent: number | null;
}

interface RecentRow {
  attemptId: string;
  subjectId: string;
  subjectName: string;
  score: number;
  total: number;
  createdAt: Date;
}

interface HeatmapRow {
  date: string;
  count: number;
}

interface DayRow {
  day: string;
}

interface UnfinishedRow {
  attemptId: string;
  subjectId: string;
  subjectName: string;
  status: string;
  lastActivityAt: Date;
  createdAt: Date;
  answered: number;
  total: number;
}

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async getDashboard(range: DashboardRange = 'all'): Promise<DashboardResponse> {
    const days = rangeDays(range);
    const now = new Date();
    const today = manilaToday(now);

    const [totals, subjectRows, focusRows, recentRows, heatmapRows, dayRows, unfinishedRows] =
      await Promise.all([
        this.loadTotals(days),
        this.loadSubjects(days),
        this.loadFocusTopics(days),
        this.loadRecentTests(days),
        this.loadHeatmap(),
        this.loadStudyDays(),
        this.loadUnfinished(),
      ]);

    const subjects: DashboardSubjectDto[] = subjectRows.map((row) => {
      const label = row.averagePercent === null ? 'NO_DATA' : labelForPercent(row.averagePercent);
      return {
        subjectId: row.subjectId,
        name: row.name,
        averagePercent: row.averagePercent,
        label,
      };
    });

    const recentTests: DashboardRecentTestDto[] = recentRows.map((row) => {
      const percent = percentFromScore(row.score, row.total);
      return {
        attemptId: row.attemptId,
        subjectId: row.subjectId,
        subjectName: row.subjectName,
        percent,
        label: labelForPercent(percent),
        completedAt: row.createdAt.toISOString(),
      };
    });

    const unfinished: DashboardUnfinishedDto[] = unfinishedRows.map((row) => {
      const age = ageDays(row.createdAt, now);
      return {
        attemptId: row.attemptId,
        subjectId: row.subjectId,
        subjectName: row.subjectName,
        status: row.status,
        answered: row.answered,
        total: row.total > 0 ? row.total : 25,
        lastActivityAt: row.lastActivityAt.toISOString(),
        ageDays: age,
        overFourteenDays: age > 14,
      };
    });

    return {
      generatedAt: now.toISOString(),
      timezone: DASHBOARD_TIMEZONE,
      range,
      totals: {
        testsTaken: totals.testsTaken,
        questionsAnswered: totals.questionsAnswered,
      },
      study: {
        currentStreak: currentStreak(dayRows.map((row) => row.day), today),
        heatmap: heatmapRows,
      },
      subjects,
      focusTopics: focusRows,
      recentTests,
      unfinished,
    };
  }

  private async loadTotals(days: number | null): Promise<TotalsRow> {
    const rows = await this.prisma.$queryRaw<TotalsRow[]>(Prisma.sql`
      SELECT count(*)::int AS "testsTaken",
             COALESCE(sum(
               CASE WHEN jsonb_typeof(ar."snapshot"->'perQuestion') = 'array'
                 THEN (SELECT count(*)
                       FROM jsonb_array_elements(ar."snapshot"->'perQuestion') AS q
                       WHERE q->>'selectedChoiceId' IS NOT NULL)
                 ELSE 0 END
             ), 0)::int AS "questionsAnswered"
      FROM "AttemptResult" ar
      JOIN "MockAttempt" a ON a."id" = ar."attemptId"
      JOIN "Subject" s ON s."id" = a."subjectId"
      WHERE a."status" = 'COMPLETED'
        AND s."status" != 'DELETING'
        ${this.rangeFilter(days)}
    `);
    return rows[0] ?? { testsTaken: 0, questionsAnswered: 0 };
  }

  private async loadSubjects(days: number | null): Promise<SubjectRow[]> {
    return this.prisma.$queryRaw<SubjectRow[]>(Prisma.sql`
      SELECT s."id" AS "subjectId",
             s."name" AS "name",
             CASE WHEN avg(ar."score"::numeric / NULLIF(ar."total", 0) * 100) IS NULL
               THEN NULL
               ELSE round(avg(ar."score"::numeric / NULLIF(ar."total", 0) * 100))::int
             END AS "averagePercent"
      FROM "Subject" s
      LEFT JOIN "MockAttempt" a
        ON a."subjectId" = s."id" AND a."status" = 'COMPLETED'
      LEFT JOIN "AttemptResult" ar
        ON ar."attemptId" = a."id" ${this.rangeFilter(days)}
      WHERE s."status" != 'DELETING'
      GROUP BY s."id", s."name"
      ORDER BY s."name" ASC, s."id" ASC
    `);
  }

  private async loadFocusTopics(days: number | null): Promise<DashboardFocusTopicDto[]> {
    const rows = await this.prisma.$queryRaw<FocusTopicRow[]>(Prisma.sql`
      SELECT a."subjectId" AS "subjectId",
             s."name" AS "subjectName",
             t."topicKey" AS "topicKey",
             st."name" AS "topicName",
             sum(t."correct")::int AS "correct",
             sum(t."total")::int AS "total"
      FROM "AttemptResult" ar
      JOIN "MockAttempt" a ON a."id" = ar."attemptId"
      JOIN "Subject" s ON s."id" = a."subjectId"
      CROSS JOIN LATERAL jsonb_to_recordset(
        CASE WHEN jsonb_typeof(ar."snapshot"->'perTopic') = 'array'
          THEN ar."snapshot"->'perTopic'
          ELSE '[]'::jsonb END
      ) AS t("topicKey" text, "correct" int, "total" int)
      JOIN "SubjectTopic" st
        ON st."subjectId" = a."subjectId" AND st."key" = t."topicKey"
      WHERE a."status" = 'COMPLETED'
        AND s."status" != 'DELETING'
        ${this.rangeFilter(days)}
      GROUP BY a."subjectId", s."name", t."topicKey", st."name"
    `);

    return selectFocusTopics(rows).map((row) => ({
      topicKey: row.topicKey,
      topicName: row.topicName,
      subjectId: row.subjectId,
      subjectName: row.subjectName,
    }));
  }

  private async loadRecentTests(days: number | null): Promise<RecentRow[]> {
    return this.prisma.$queryRaw<RecentRow[]>(Prisma.sql`
      SELECT ar."attemptId" AS "attemptId",
             a."subjectId" AS "subjectId",
             s."name" AS "subjectName",
             ar."score" AS "score",
             ar."total" AS "total",
             ar."createdAt" AS "createdAt"
      FROM "AttemptResult" ar
      JOIN "MockAttempt" a ON a."id" = ar."attemptId"
      JOIN "Subject" s ON s."id" = a."subjectId"
      WHERE a."status" = 'COMPLETED'
        AND s."status" != 'DELETING'
        ${this.rangeFilter(days)}
      ORDER BY ar."createdAt" DESC, ar."attemptId" DESC
      LIMIT 3
    `);
  }

  private async loadHeatmap(): Promise<HeatmapRow[]> {
    return this.prisma.$queryRaw<HeatmapRow[]>(Prisma.sql`
      WITH study_days AS (
        SELECT ((ar."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Manila')::date AS day
        FROM "AttemptResult" ar
        JOIN "MockAttempt" a ON a."id" = ar."attemptId"
        JOIN "Subject" s ON s."id" = a."subjectId"
        WHERE a."status" = 'COMPLETED'
          AND s."status" != 'DELETING'
          AND ((ar."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Manila')::date
              >= ((now() AT TIME ZONE 'Asia/Manila'))::date - 364
        UNION ALL
        SELECT ((m."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Manila')::date AS day
        FROM "Message" m
        JOIN "Chat" c ON c."id" = m."chatId"
        JOIN "Subject" s ON s."id" = c."subjectId"
        WHERE m."role" = 'USER'
          AND s."status" != 'DELETING'
          AND ((m."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Manila')::date
              >= ((now() AT TIME ZONE 'Asia/Manila'))::date - 364
      )
      SELECT to_char(day, 'YYYY-MM-DD') AS "date",
             count(*)::int AS "count"
      FROM study_days
      GROUP BY day
      ORDER BY day ASC
    `);
  }

  private async loadStudyDays(): Promise<DayRow[]> {
    return this.prisma.$queryRaw<DayRow[]>(Prisma.sql`
      SELECT to_char(day, 'YYYY-MM-DD') AS "day"
      FROM (
        SELECT DISTINCT ((ar."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Manila')::date AS day
        FROM "AttemptResult" ar
        JOIN "MockAttempt" a ON a."id" = ar."attemptId"
        JOIN "Subject" s ON s."id" = a."subjectId"
        WHERE a."status" = 'COMPLETED'
          AND s."status" != 'DELETING'
        UNION
        SELECT DISTINCT ((m."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Manila')::date AS day
        FROM "Message" m
        JOIN "Chat" c ON c."id" = m."chatId"
        JOIN "Subject" s ON s."id" = c."subjectId"
        WHERE m."role" = 'USER'
          AND s."status" != 'DELETING'
      ) AS days
      ORDER BY day ASC
    `);
  }

  private async loadUnfinished(): Promise<UnfinishedRow[]> {
    return this.prisma.$queryRaw<UnfinishedRow[]>(Prisma.sql`
      SELECT a."id" AS "attemptId",
             a."subjectId" AS "subjectId",
             s."name" AS "subjectName",
             a."status"::text AS "status",
             a."lastActivityAt" AS "lastActivityAt",
             a."createdAt" AS "createdAt",
             (SELECT count(*)::int FROM "AttemptQuestion" q
              WHERE q."attemptId" = a."id") AS "total",
             (SELECT count(*)::int
              FROM "AttemptAnswer" ans
              JOIN "AttemptQuestion" q ON q."id" = ans."attemptQuestionId"
              WHERE q."attemptId" = a."id") AS "answered"
      FROM "MockAttempt" a
      JOIN "Subject" s ON s."id" = a."subjectId"
      WHERE a."status" IN ('GENERATING', 'READY', 'IN_PROGRESS', 'AWAITING_SUBMISSION')
        AND s."status" != 'DELETING'
      ORDER BY a."lastActivityAt" DESC, a."id" DESC
    `);
  }

  private rangeFilter(days: number | null): Prisma.Sql {
    return days === null
      ? Prisma.empty
      : Prisma.sql`AND ar."createdAt" >= (now() AT TIME ZONE 'UTC') - (${days}::int * interval '1 day')`;
  }
}
