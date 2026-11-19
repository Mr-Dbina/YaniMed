import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { MockTestErrorFilter } from '../mock-test/mock-test-error.filter.js';
import { MockTestGuard } from '../mock-test/mock-test.guard.js';
import { DashboardController } from './dashboard.controller.js';
import { DashboardService } from './dashboard.service.js';

@Module({
  imports: [PrismaModule],
  controllers: [DashboardController],
  providers: [DashboardService, MockTestGuard, MockTestErrorFilter],
})
export class DashboardModule {}
