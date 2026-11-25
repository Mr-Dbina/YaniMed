import {
  Controller,
  Get,
  Inject,
  Query,
  UseFilters,
  UseGuards,
  ValidationPipe,
  type Type,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { MockTestErrorFilter } from '../mock-test/mock-test-error.filter.js';
import { MockTestGuard } from '../mock-test/mock-test.guard.js';
import { AnalyticsQueryDto, type AnalyticsSummaryResponse } from './analytics.dto.js';
import { AnalyticsService } from './analytics.service.js';

function validated(expectedType: Type<unknown>): ValidationPipe {
  return new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    expectedType,
  });
}

@ApiTags('Analytics (local development)')
@UseGuards(MockTestGuard)
@UseFilters(MockTestErrorFilter)
@Controller('analytics')
export class AnalyticsController {
  constructor(@Inject(AnalyticsService) private readonly analytics: AnalyticsService) {}

  @Get('summary')
  @ApiOperation({
    summary: 'Get analytics summary with optional subject, topic, and date range filters',
  })
  async summary(
    @Query(validated(AnalyticsQueryDto)) query: AnalyticsQueryDto,
  ): Promise<AnalyticsSummaryResponse> {
    return this.analytics.getSummary(query);
  }
}