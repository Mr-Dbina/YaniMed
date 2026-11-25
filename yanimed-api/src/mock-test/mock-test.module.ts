import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ExamController } from './exam.controller.js';
import { MockTestController } from './mock-test.controller.js';
import { QuestionsController } from './questions.controller.js';
import { MockTestErrorFilter } from './mock-test-error.filter.js';
import { MockTestGuard } from './mock-test.guard.js';
import { ExamService } from './exam.service.js';
import { QuestionsService } from './questions.service.js';
import { GenerationModule } from './generation/generation.module.js';

@Module({
  imports: [PrismaModule, GenerationModule],
  controllers: [MockTestController, ExamController, QuestionsController],
  providers: [MockTestGuard, ExamService, QuestionsService, MockTestErrorFilter],
})
export class MockTestModule {}
