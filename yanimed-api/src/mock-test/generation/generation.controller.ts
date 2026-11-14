import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  UseFilters,
  UseGuards,
  ValidationPipe,
  type Type,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { MockTestErrorFilter } from '../mock-test-error.filter.js';
import { MockTestGuard } from '../mock-test.guard.js';
import {
  CreateGenerationJobBody,
  type ActiveGenerationJobResponse,
  type CancelGenerationJobResponse,
  type CreateGenerationJobResponse,
  type GenerationProgressDto,
} from './generation.dto.js';
import { GenerationService } from './generation.service.js';

function validated(expectedType: Type<unknown>): ValidationPipe {
  return new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    expectedType,
  });
}

/** Generation routes. All are local-only and behind the Mock Test flag. */
@ApiTags('Mock Test (local development)')
@UseGuards(MockTestGuard)
@UseFilters(MockTestErrorFilter)
@Controller('mock-test')
export class GenerationController {
  constructor(
    @Inject(GenerationService)
    private readonly generation: GenerationService,
  ) {}

  /** 409 NO_READY_DOCUMENTS or GENERATION_IN_PROGRESS. */
  @Post('subjects/:subjectId/generation-jobs')
  @HttpCode(201)
  @ApiOperation({ summary: 'Start a generation job for READY documents' })
  create(
    @Param('subjectId', new ParseUUIDPipe()) subjectId: string,
    @Body(validated(CreateGenerationJobBody)) body: CreateGenerationJobBody,
  ): Promise<CreateGenerationJobResponse> {
    return this.generation.createJob(subjectId, body.idempotencyKey);
  }

  @Get('subjects/:subjectId/generation-jobs/active')
  @ApiOperation({ summary: 'The unfinished generation job of a subject' })
  active(
    @Param('subjectId', new ParseUUIDPipe()) subjectId: string,
  ): Promise<ActiveGenerationJobResponse> {
    return this.generation.getActiveJob(subjectId);
  }

  @Get('generation-jobs/:jobId')
  @ApiOperation({ summary: 'Progress without question text' })
  progress(
    @Param('jobId', new ParseUUIDPipe()) jobId: string,
  ): Promise<GenerationProgressDto> {
    return this.generation.getProgress(jobId);
  }

  @Post('generation-jobs/:jobId/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Request cancellation of an unfinished job' })
  cancel(
    @Param('jobId', new ParseUUIDPipe()) jobId: string,
  ): Promise<CancelGenerationJobResponse> {
    return this.generation.cancelJob(jobId);
  }
}
