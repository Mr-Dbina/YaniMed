import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ExamController } from './exam.controller.js';
import { MockTestController } from './mock-test.controller.js';
import { MockTestErrorFilter } from './mock-test-error.filter.js';
import { MockTestGuard } from './mock-test.guard.js';
import { ExamService } from './exam.service.js';

@Module({
  imports: [PrismaModule],
  controllers: [MockTestController, ExamController],
  providers: [MockTestGuard, ExamService, MockTestErrorFilter],
})
export class MockTestModule {}
