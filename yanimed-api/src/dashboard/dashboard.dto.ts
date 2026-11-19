import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import type { DashboardRange, ScoreLabel } from './dashboard.logic.js';

export class DashboardQueryDto {
  @ApiPropertyOptional({ enum: ['7', '30', 'all'], default: 'all' })
  @IsOptional()
  @IsIn(['7', '30', 'all'])
  range?: DashboardRange;
}

export interface DashboardTotalsDto {
  testsTaken: number;
  questionsAnswered: number;
}

export interface DashboardHeatmapDayDto {
  date: string;
  count: number;
}

export interface DashboardStudyDto {
  currentStreak: number;
  heatmap: DashboardHeatmapDayDto[];
}

export interface DashboardSubjectDto {
  subjectId: string;
  name: string;
  averagePercent: number | null;
  label: ScoreLabel;
}

export interface DashboardFocusTopicDto {
  topicKey: string;
  topicName: string;
  subjectId: string;
  subjectName: string;
}

export interface DashboardRecentTestDto {
  attemptId: string;
  subjectId: string;
  subjectName: string;
  percent: number;
  label: ScoreLabel;
  completedAt: string;
}

export interface DashboardUnfinishedDto {
  attemptId: string;
  subjectId: string;
  subjectName: string;
  status: string;
  answered: number;
  total: number;
  lastActivityAt: string;
  ageDays: number;
  overFourteenDays: boolean;
}

export interface DashboardResponse {
  generatedAt: string;
  timezone: 'Asia/Manila';
  range: DashboardRange;
  totals: DashboardTotalsDto;
  study: DashboardStudyDto;
  subjects: DashboardSubjectDto[];
  focusTopics: DashboardFocusTopicDto[];
  recentTests: DashboardRecentTestDto[];
  unfinished: DashboardUnfinishedDto[];
}
