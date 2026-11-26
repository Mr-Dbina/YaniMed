import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  UseFilters,
  UseGuards,
  ValidationPipe,
  type Type,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { QuestionsService } from './questions.service.js';
import { MockTestErrorFilter } from './mock-test-error.filter.js';
import { MockTestGuard } from './mock-test.guard.js';
import {
  QUESTIONS_PER_TEST,
  QuestionReportDto,
  QuarantinedQuestionDto,
  ReportQuestionBody,
  ResolveReportBodyDto,
  type ResolveReportBody,
} from './exam.dto.js';

function validated(expectedType: Type<unknown>): ValidationPipe {
  return new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    expectedType,
  });
}

@ApiTags('Mock Test Questions (local development)')
@UseGuards(MockTestGuard)
@UseFilters(MockTestErrorFilter)
@Controller('mock-test')
export class QuestionsController {
  constructor(@Inject(QuestionsService) private readonly questions: QuestionsService) {}

  @Post('questions/:id/report')
  @HttpCode(201)
  @ApiOperation({ summary: 'Report a question during or after a mock test' })
  async report(
    @Param('id', new ParseUUIDPipe()) questionId: string,
    @Body(validated(ReportQuestionBody)) body: ReportQuestionBody,
  ): Promise<QuestionReportDto> {
    return this.questions.reportQuestion(questionId, body.reason, body.details);
  }

  @Post('attempts/:attemptId/questions/:position/report')
  @HttpCode(201)
  @ApiOperation({ summary: 'Report a question by attempt ID and 1-based position' })
  async reportByAttemptPosition(
    @Param('attemptId', new ParseUUIDPipe()) attemptId: string,
    @Param('position', ParseIntPipe) position: number,
    @Body(validated(ReportQuestionBody)) body: ReportQuestionBody,
  ): Promise<QuestionReportDto> {
    if (position < 1 || position > QUESTIONS_PER_TEST) {
      throw new BadRequestException(`position must be between 1 and ${QUESTIONS_PER_TEST}`);
    }
    return this.questions.reportAttemptQuestion(attemptId, position, body.reason, body.details);
  }

  @Get('questions/quarantined')
  @ApiOperation({ summary: 'List quarantined questions with their open reports' })
  async quarantined(): Promise<QuarantinedQuestionDto[]> {
    return this.questions.getQuarantinedQuestions();
  }

  @Patch('questions/:id/resolve-report')
  @HttpCode(200)
  @ApiOperation({ summary: 'Resolve a quarantined question by restoring or retiring it' })
  async resolveReport(
    @Param('id', new ParseUUIDPipe()) questionId: string,
    @Body(validated(ResolveReportBodyDto)) body: ResolveReportBody,
  ): Promise<{ questionId: string; status: 'ACTIVE' | 'RETIRED' }> {
    return this.questions.resolveReport(questionId, body);
  }
}