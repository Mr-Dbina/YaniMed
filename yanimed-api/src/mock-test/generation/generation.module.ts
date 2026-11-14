import { Module } from '@nestjs/common';
import { EmbeddingModule } from '../../embeddings/embedding.module.js';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { MockTestErrorFilter } from '../mock-test-error.filter.js';
import { MockTestGuard } from '../mock-test.guard.js';
import { AiCallLogRepository } from './ai/ai-call-log.repository.js';
import { GenerationAiService } from './ai/generation-ai.service.js';
import { GenerationController } from './generation.controller.js';
import { GenerationJobRepository } from './generation-job.repository.js';
import { GenerationRuntime } from './generation-runtime.js';
import { GenerationService } from './generation.service.js';
import { GenerationPlanner } from './plan/planner.js';

@Module({
  imports: [PrismaModule, EmbeddingModule],
  controllers: [GenerationController],
  providers: [
    MockTestGuard,
    MockTestErrorFilter,
    GenerationJobRepository,
    AiCallLogRepository,
    GenerationAiService,
    GenerationPlanner,
    GenerationService,
    GenerationRuntime,
  ],
})
export class GenerationModule {}
