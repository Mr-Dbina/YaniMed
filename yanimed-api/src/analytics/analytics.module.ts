import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { MockTestErrorFilter } from '../mock-test/mock-test-error.filter.js';
import { MockTestGuard } from '../mock-test/mock-test.guard.js';
import { AnalyticsController } from './analytics.controller.js';
import { AnalyticsService } from './analytics.service.js';

@Module({
  imports: [PrismaModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService, MockTestGuard, MockTestErrorFilter],
})
export class AnalyticsModule {}