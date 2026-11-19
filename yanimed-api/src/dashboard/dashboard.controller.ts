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
import { DashboardQueryDto, type DashboardResponse } from './dashboard.dto.js';
import { DashboardService } from './dashboard.service.js';

function validated(expectedType: Type<unknown>): ValidationPipe {
  return new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    expectedType,
  });
}

@ApiTags('Dashboard (local development)')
@UseGuards(MockTestGuard)
@UseFilters(MockTestErrorFilter)
@Controller('dashboard')
export class DashboardController {
  constructor(@Inject(DashboardService) private readonly dashboard: DashboardService) {}

  @Get()
  @ApiOperation({ summary: 'Read-only study dashboard' })
  get(
    @Query(validated(DashboardQueryDto)) query: DashboardQueryDto,
  ): Promise<DashboardResponse> {
    return this.dashboard.getDashboard(query.range ?? 'all');
  }
}
