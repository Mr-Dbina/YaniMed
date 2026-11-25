import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import type { AnalyticsRange } from './analytics.logic.js';

export { isAnalyticsRange, rangeDays } from './analytics.logic.js';
export type { AnalyticsRange } from './analytics.logic.js';

export class AnalyticsQueryDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Filter by subject ID' })
  @IsOptional()
  @IsUUID()
  subjectId?: string;

  @ApiPropertyOptional({ description: 'Filter by topic key (e.g., "cardiology-basics")' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  topic?: string;

  @ApiPropertyOptional({ enum: ['7', '30', '90', 'all'], default: 'all' })
  @IsOptional()
  @IsIn(['7', '30', '90', 'all'])
  range?: AnalyticsRange;
}

export interface AnalyticsSubjectMetricDto {
  subjectId: string;
  subject: string;
  totalAnswered: number;
  correctCount: number;
  accuracyPercent: number | null;
}

export interface AnalyticsTopicMetricDto {
  subjectId: string;
  subject: string;
  topicKey: string;
  topic: string;
  totalAnswered: number;
  correctCount: number;
  accuracyPercent: number | null;
}

export interface AnalyticsSummaryResponse {
  generatedAt: string;
  range: AnalyticsRange;
  subjectId: string | null;
  topic: string | null;
  overall: {
    totalAnswered: number;
    correctCount: number;
    accuracyPercent: number | null;
    completedTestsCount: number;
  };
  bySubject: AnalyticsSubjectMetricDto[];
  byTopic: AnalyticsTopicMetricDto[];
  availableTopics: { topicKey: string; topic: string }[];
}