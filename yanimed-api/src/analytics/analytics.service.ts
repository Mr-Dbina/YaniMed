import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  AnalyticsQueryDto,
  AnalyticsSummaryResponse,
  AnalyticsSubjectMetricDto,
  AnalyticsTopicMetricDto,
  type AnalyticsRange,
} from './analytics.dto.js';
import { rangeDays, accuracyPercent, sortByWeakestTopic } from './analytics.logic.js';

interface OverallRow {
  totalAnswered: number;
  correctCount: number;
  completedTestsCount: number;
}

interface SubjectMetricRow {
  subjectId: string;
  subject: string;
  totalAnswered: number;
  correctCount: number;
  accuracyPercent: number | null;
}

interface TopicMetricRow {
  subjectId: string;
  subject: string;
  topicKey: string;
  topic: string;
  totalAnswered: number;
  correctCount: number;
  accuracyPercent: number | null;
}

interface AvailableTopicRow {
  topicKey: string;
  topic: string;
}

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async getSummary(query: AnalyticsQueryDto): Promise<AnalyticsSummaryResponse> {
    const range = query.range ?? 'all';
    const days = rangeDays(range);
    const subjectId = query.subjectId ?? null;
    const topicKey = query.topic ?? null;

    const [overall, bySubject, byTopic, availableTopics] = await Promise.all([
      this.loadOverall(days, subjectId, topicKey),
      this.loadBySubject(days, subjectId, topicKey),
      this.loadByTopic(days, subjectId, topicKey),
      this.loadAvailableTopics(subjectId),
    ]);

    const overallAccuracy = accuracyPercent(overall.correctCount, overall.totalAnswered);

    return {
      generatedAt: new Date().toISOString(),
      range,
      subjectId,
      topic: topicKey,
      overall: {
        totalAnswered: overall.totalAnswered,
        correctCount: overall.correctCount,
        accuracyPercent: overallAccuracy,
        completedTestsCount: overall.completedTestsCount,
      },
      bySubject: bySubject.map((row) => ({
        subjectId: row.subjectId,
        subject: row.subject,
        totalAnswered: row.totalAnswered,
        correctCount: row.correctCount,
        accuracyPercent: row.accuracyPercent,
      })),
      byTopic: sortByWeakestTopic(
        byTopic
          .filter((row) => row.totalAnswered > 0)
          .map((row) => ({
            subjectId: row.subjectId,
            subject: row.subject,
            topicKey: row.topicKey,
            topic: row.topic,
            totalAnswered: row.totalAnswered,
            correctCount: row.correctCount,
            accuracyPercent: row.accuracyPercent,
          })),
      ),
      availableTopics: availableTopics.map((row) => ({
        topicKey: row.topicKey,
        topic: row.topic,
      })),
    };
  }

  private buildBaseFilter(
    days: number | null,
    subjectId: string | null,
    topicKey: string | null,
    hasSubjectTopicJoin = false,
  ): Prisma.Sql {
    const clauses: Prisma.Sql[] = [
      Prisma.sql`a."status" = 'COMPLETED'`,
      Prisma.sql`s."status" != 'DELETING'`,
    ];

    if (days !== null) {
      clauses.push(Prisma.sql`ar."createdAt" >= (now() AT TIME ZONE 'UTC') - (${days}::int * interval '1 day')`);
    }

    if (subjectId) {
      clauses.push(Prisma.sql`a."subjectId" = ${subjectId}`);
    }

    // Only add topicKey filter if the query actually has the SubjectTopic join
    if (topicKey && hasSubjectTopicJoin) {
      clauses.push(Prisma.sql`st."key" = ${topicKey}`);
    }

    if (clauses.length === 0) return Prisma.empty;

    return Prisma.sql`WHERE ${Prisma.join(clauses, ' AND ')}`;
  }

  private async loadOverall(
    days: number | null,
    subjectId: string | null,
    topicKey: string | null,
  ): Promise<OverallRow> {
    if (topicKey) {
      const filter = this.buildBaseFilter(days, subjectId, topicKey, true);
      const rows = await this.prisma.$queryRaw<OverallRow[]>(Prisma.sql`
        SELECT
          COALESCE(SUM(t."total"), 0)::int AS "totalAnswered",
          COALESCE(SUM(t."correct"), 0)::int AS "correctCount",
          COUNT(DISTINCT ar."attemptId")::int AS "completedTestsCount"
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
        ${filter}
      `);

      return rows[0] ?? { totalAnswered: 0, correctCount: 0, completedTestsCount: 0 };
    }

    const filter = this.buildBaseFilter(days, subjectId, null, false);

    const rows = await this.prisma.$queryRaw<OverallRow[]>(Prisma.sql`
      SELECT
        COALESCE(SUM(
          CASE WHEN jsonb_typeof(ar."snapshot"->'perQuestion') = 'array'
            THEN (
              SELECT COUNT(*)
              FROM jsonb_array_elements(ar."snapshot"->'perQuestion') AS q
              WHERE q->>'selectedChoiceId' IS NOT NULL
            )
            ELSE 0
          END
        ), 0)::int AS "totalAnswered",
        COALESCE(SUM(
          CASE WHEN jsonb_typeof(ar."snapshot"->'perQuestion') = 'array'
            THEN (
              SELECT COUNT(*)
              FROM jsonb_array_elements(ar."snapshot"->'perQuestion') AS q
              WHERE q->>'selectedChoiceId' IS NOT NULL
                AND (q->>'isCorrect')::boolean = true
            )
            ELSE 0
          END
        ), 0)::int AS "correctCount",
        COUNT(DISTINCT ar."attemptId")::int AS "completedTestsCount"
      FROM "AttemptResult" ar
      JOIN "MockAttempt" a ON a."id" = ar."attemptId"
      JOIN "Subject" s ON s."id" = a."subjectId"
      ${filter}
    `);

    return rows[0] ?? { totalAnswered: 0, correctCount: 0, completedTestsCount: 0 };
  }

  private async loadBySubject(
    days: number | null,
    subjectId: string | null,
    topicKey: string | null,
  ): Promise<SubjectMetricRow[]> {
    if (topicKey) {
      const filter = this.buildBaseFilter(days, subjectId, topicKey, true);
      return this.prisma.$queryRaw<SubjectMetricRow[]>(Prisma.sql`
        SELECT
          s."id" AS "subjectId",
          s."name" AS "subject",
          COALESCE(SUM(t."total"), 0)::int AS "totalAnswered",
          COALESCE(SUM(t."correct"), 0)::int AS "correctCount",
          CASE
            WHEN COALESCE(SUM(t."total"), 0) > 0
            THEN ROUND(COALESCE(SUM(t."correct"), 0)::numeric / NULLIF(COALESCE(SUM(t."total"), 0), 0) * 100)::int
            ELSE NULL
          END AS "accuracyPercent"
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
        ${filter}
        GROUP BY s."id", s."name"
        ORDER BY s."name" ASC
      `);
    }

    const filter = this.buildBaseFilter(days, subjectId, null, false);

    return this.prisma.$queryRaw<SubjectMetricRow[]>(Prisma.sql`
      SELECT
        s."id" AS "subjectId",
        s."name" AS "subject",
        COALESCE(SUM(
          CASE WHEN jsonb_typeof(ar."snapshot"->'perQuestion') = 'array'
            THEN (
              SELECT COUNT(*)
              FROM jsonb_array_elements(ar."snapshot"->'perQuestion') AS q
              WHERE q->>'selectedChoiceId' IS NOT NULL
            )
            ELSE 0
          END
        ), 0)::int AS "totalAnswered",
        COALESCE(SUM(
          CASE WHEN jsonb_typeof(ar."snapshot"->'perQuestion') = 'array'
            THEN (
              SELECT COUNT(*)
              FROM jsonb_array_elements(ar."snapshot"->'perQuestion') AS q
              WHERE q->>'selectedChoiceId' IS NOT NULL
                AND (q->>'isCorrect')::boolean = true
            )
            ELSE 0
          END
        ), 0)::int AS "correctCount",
        CASE
          WHEN SUM(
            CASE WHEN jsonb_typeof(ar."snapshot"->'perQuestion') = 'array'
              THEN (
                SELECT COUNT(*)
                FROM jsonb_array_elements(ar."snapshot"->'perQuestion') AS q
                WHERE q->>'selectedChoiceId' IS NOT NULL
              )
              ELSE 0
            END
          ) > 0
          THEN ROUND(
            SUM(
              CASE WHEN jsonb_typeof(ar."snapshot"->'perQuestion') = 'array'
                THEN (
                  SELECT COUNT(*)
                  FROM jsonb_array_elements(ar."snapshot"->'perQuestion') AS q
                  WHERE q->>'selectedChoiceId' IS NOT NULL
                    AND (q->>'isCorrect')::boolean = true
                )
                ELSE 0
              END
            )::numeric /
            NULLIF(
              SUM(
                CASE WHEN jsonb_typeof(ar."snapshot"->'perQuestion') = 'array'
                  THEN (
                    SELECT COUNT(*)
                    FROM jsonb_array_elements(ar."snapshot"->'perQuestion') AS q
                    WHERE q->>'selectedChoiceId' IS NOT NULL
                  )
                  ELSE 0
                END
              ), 0
            ) * 100
          )::int
          ELSE NULL
        END AS "accuracyPercent"
      FROM "AttemptResult" ar
      JOIN "MockAttempt" a ON a."id" = ar."attemptId"
      JOIN "Subject" s ON s."id" = a."subjectId"
      ${filter}
      GROUP BY s."id", s."name"
      ORDER BY s."name" ASC
    `);
  }

  private async loadByTopic(
    days: number | null,
    subjectId: string | null,
    topicKey: string | null,
  ): Promise<TopicMetricRow[]> {
    const filter = this.buildBaseFilter(days, subjectId, topicKey, true);

    return this.prisma.$queryRaw<TopicMetricRow[]>(Prisma.sql`
      SELECT
        s."id" AS "subjectId",
        s."name" AS "subject",
        st."key" AS "topicKey",
        st."name" AS "topic",
        COALESCE(SUM(t."total"), 0)::int AS "totalAnswered",
        COALESCE(SUM(t."correct"), 0)::int AS "correctCount",
        CASE
          WHEN COALESCE(SUM(t."total"), 0) > 0
          THEN ROUND(COALESCE(SUM(t."correct"), 0)::numeric / NULLIF(COALESCE(SUM(t."total"), 0), 0) * 100)::int
          ELSE NULL
        END AS "accuracyPercent"
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
      ${filter}
      GROUP BY s."id", s."name", st."key", st."name"
      ORDER BY s."name" ASC, st."name" ASC
    `);
  }

  private async loadAvailableTopics(subjectId: string | null): Promise<AvailableTopicRow[]> {
    if (!subjectId) {
      return [];
    }

    return this.prisma.$queryRaw<AvailableTopicRow[]>(Prisma.sql`
      SELECT st."key" AS "topicKey", st."name" AS "topic"
      FROM "SubjectTopic" st
      WHERE st."subjectId" = ${subjectId}
      ORDER BY st."name" ASC
    `);
  }
}