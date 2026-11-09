import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { MockTestController } from './mock-test.controller.js';
import { MockTestGuard } from './mock-test.guard.js';
import { ExamService } from './exam.service.js';

@Module({
  imports: [PrismaModule],
  controllers: [MockTestController],
  providers: [MockTestGuard, ExamService],
})
export class MockTestModule {}
