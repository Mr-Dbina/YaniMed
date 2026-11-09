import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseFilters,
  UseGuards,
  ValidationPipe,
  type Type,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AnswerBody,
  SessionVersionQueryDto,
  SkipBody,
  SubmitBody,
  type ExamQuestionDto,
  type ReviewDto,
  type ResultDto,
} from './exam.dto.js';
import {
  ExamService,
  type CreateAttemptResponse,
  type DiscardAttemptResponse,
  type QuestionProgressResponse,
  type ReviewNavigatorResponse,
  type StartAttemptResponse,
  type SubjectOverviewResponse,
} from './exam.service.js';
import { MockTestErrorFilter } from './mock-test-error.filter.js';
import { MockTestGuard } from './mock-test.guard.js';

function validated(expectedType: Type<unknown>): ValidationPipe {
  return new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    expectedType,
  });
}

@ApiTags('Mock Test (local development)')
@UseGuards(MockTestGuard)
@UseFilters(MockTestErrorFilter)
@Controller('mock-test')
export class ExamController {
  constructor(@Inject(ExamService) private readonly exam: ExamService) {}

  /** Unknown subject is 404; the DB allows at most one unfinished attempt. */
  @Get('subjects/:subjectId/overview')
  @ApiOperation({ summary: 'Unfinished attempt and eligible question count' })
  overview(
    @Param('subjectId', new ParseUUIDPipe()) subjectId: string,
  ): Promise<SubjectOverviewResponse> {
    return this.exam.getSubjectOverview(subjectId);
  }

  /** Duplicate unfinished attempts are refused by a DB rule, not the client. */
  @Post('subjects/:subjectId/attempts')
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a READY attempt for one subject' })
  create(
    @Param('subjectId', new ParseUUIDPipe()) subjectId: string,
  ): Promise<CreateAttemptResponse> {
    return this.exam.createAttempt(subjectId);
  }

  /** Server increments sessionVersion, making older sessions stale. */
  @Post('attempts/:attemptId/start')
  @HttpCode(200)
  @ApiOperation({ summary: 'Start or resume an attempt' })
  start(
    @Param('attemptId', new ParseUUIDPipe()) attemptId: string,
  ): Promise<StartAttemptResponse> {
    return this.exam.startAttempt(attemptId);
  }

  /** Read-only. A stale session is 409, never a silently different question. */
  @Get('attempts/:attemptId/current')
  @ApiOperation({ summary: 'Current exam-safe question' })
  current(
    @Param('attemptId', new ParseUUIDPipe()) attemptId: string,
    @Query(validated(SessionVersionQueryDto)) query: SessionVersionQueryDto,
  ): Promise<ExamQuestionDto | null> {
    return this.exam.getCurrentQuestion(attemptId, query.sessionVersion);
  }

  /** The server computes the next position; the client never supplies it. */
  @Post('attempts/:attemptId/answer')
  @HttpCode(200)
  @ApiOperation({ summary: 'Answer the current question' })
  answer(
    @Param('attemptId', new ParseUUIDPipe()) attemptId: string,
    @Body(validated(AnswerBody)) body: AnswerBody,
  ): Promise<QuestionProgressResponse> {
    return this.exam.answerQuestion(attemptId, body);
  }

  /** The engine decides whether a skip is allowed. */
  @Post('attempts/:attemptId/skip')
  @HttpCode(200)
  @ApiOperation({ summary: 'Skip an unseen question' })
  skip(
    @Param('attemptId', new ParseUUIDPipe()) attemptId: string,
    @Body(validated(SkipBody)) body: SkipBody,
  ): Promise<QuestionProgressResponse> {
    return this.exam.skipQuestion(attemptId, body);
  }

  /** Neutral navigator: answered flag and selected id only, no correctness. */
  @Get('attempts/:attemptId/review-navigator')
  @ApiOperation({ summary: 'Answer state before submit' })
  navigator(
    @Param('attemptId', new ParseUUIDPipe()) attemptId: string,
    @Query(validated(SessionVersionQueryDto)) query: SessionVersionQueryDto,
  ): Promise<ReviewNavigatorResponse> {
    return this.exam.getReviewNavigator(attemptId, query.sessionVersion);
  }

  /** Idempotent: a replay on a COMPLETED attempt returns the stored result. */
  @Post('attempts/:attemptId/submit')
  @HttpCode(200)
  @ApiOperation({ summary: 'Submit once and read the result' })
  submit(
    @Param('attemptId', new ParseUUIDPipe()) attemptId: string,
    @Body(validated(SubmitBody)) body: SubmitBody,
  ): Promise<ResultDto> {
    return this.exam.submitAttempt(
      attemptId,
      body.sessionVersion,
      body.idempotencyKey,
    );
  }

  /** Result exists only after COMPLETED. */
  @Get('attempts/:attemptId/result')
  @ApiOperation({ summary: 'Stored result' })
  result(
    @Param('attemptId', new ParseUUIDPipe()) attemptId: string,
  ): Promise<ResultDto> {
    return this.exam.getResult(attemptId);
  }

  /** Review is available only after COMPLETED; the stored score never changes. */
  @Get('attempts/:attemptId/review')
  @ApiOperation({ summary: 'Full review with correctness and citations' })
  review(
    @Param('attemptId', new ParseUUIDPipe()) attemptId: string,
  ): Promise<ReviewDto> {
    return this.exam.getReview(attemptId);
  }

  /** ABANDONED frees the subject slot for a new attempt. */
  @Post('attempts/:attemptId/discard')
  @HttpCode(200)
  @ApiOperation({ summary: 'Discard an unfinished attempt' })
  discard(
    @Param('attemptId', new ParseUUIDPipe()) attemptId: string,
  ): Promise<DiscardAttemptResponse> {
    return this.exam.discardAttempt(attemptId);
  }
}
