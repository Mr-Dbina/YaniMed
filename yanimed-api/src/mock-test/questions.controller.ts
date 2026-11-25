import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseFilters,
  UseGuards,
  ValidationPipe,
  type Type,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { QuestionsService, type QuarantinedQuestionResponse } from './questions.service.js';
import { MockTestErrorFilter } from './mock-test-error.filter.js';
import { MockTestGuard } from './mock-test.guard.js';
import {
  QuestionReportDto,
  QuarantinedQuestionDto,
  ReportQuestionBody,
  ResolveReportBody,
  ResolveReportBodyDto,
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
@Controller('mock-test/questions')
export class QuestionsController {
  constructor(@Inject(QuestionsService) private readonly questions: QuestionsService) {}

  @Post(':id/report')
  @HttpCode(201)
  @ApiOperation({ summary: 'Report a question during or after a mock test' })
  async report(
    @Param('id', new ParseUUIDPipe()) questionId: string,
    @Body(validated(ReportQuestionBody)) body: ReportQuestionBody,
  ): Promise<QuestionReportDto> {
    return this.questions.reportQuestion(questionId, body.reason, body.details);
  }

  @Get('quarantined')
  @ApiOperation({ summary: 'List quarantined questions with their open reports' })
  async quarantined(): Promise<QuarantinedQuestionDto[]> {
    return this.questions.getQuarantinedQuestions();
  }

  @Patch(':id/resolve-report')
  @HttpCode(200)
  @ApiOperation({ summary: 'Resolve a quarantined question by restoring or retiring it' })
  async resolveReport(
    @Param('id', new ParseUUIDPipe()) questionId: string,
    @Body(validated(ResolveReportBodyDto)) body: ResolveReportBody,
  ): Promise<{ questionId: string; status: 'ACTIVE' | 'RETIRED' }> {
    return this.questions.resolveReport(questionId, body);
  }
}