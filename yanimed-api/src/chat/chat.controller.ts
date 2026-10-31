import {
  Body, Controller, HttpCode, Inject, Post, ServiceUnavailableException,
  UseGuards, ValidationPipe,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Optional } from '@nestjs/common';
import { OmniRouteService } from '../omniroute/omniroute.service.js';
import { ChatGuard } from './chat.guard.js';
import { ChatAnswerDto, ChatAnswerResponseDto } from './dto/chat-answer.dto.js';
import { SubjectChatDto } from './dto/subject-chat.dto.js';
import { SubjectChatService } from './subject-chat.service.js';

const SYSTEM_PROMPT = 'You are answering without reference material. ' +
  'This is an ungrounded development demonstration, not study material. ' +
  'Do not invent citations, sources, or page numbers. State uncertainty plainly.';

@ApiTags('Chat (local development)')
@UseGuards(ChatGuard)
@Controller('chat')
export class ChatController {
  constructor(
    @Inject(OmniRouteService) private readonly omniroute: OmniRouteService,
    @Optional() @Inject(SubjectChatService) private readonly subjectChat?: SubjectChatService,
  ) {}

  @Post('answer')
  @HttpCode(200)
  @ApiOperation({ summary: 'Single-turn, ungrounded development answer' })
  @ApiOkResponse({ type: ChatAnswerResponseDto })
  async answer(
    @Body(new ValidationPipe({
      transform: true, whitelist: true, forbidNonWhitelisted: true,
      expectedType: ChatAnswerDto,
    })) dto: ChatAnswerDto,
  ): Promise<ChatAnswerResponseDto> {
    const started = Date.now();
    try {
      const result = await this.omniroute.complete(dto.prompt, SYSTEM_PROMPT);
      if (!result.content?.trim()) throw new Error('Empty completion');
      return {
        answer: result.content,
        citations: [],
        grounding: 'ungrounded',
        metadata: {
          gateway: 'omniroute',
          requestedModel: this.omniroute.getRequestedModel(),
          servedModel: result.model,
          provider: null,
          durationMs: Date.now() - started,
        },
      };
    } catch {
      throw new ServiceUnavailableException('AI answer unavailable. Please try again shortly.');
    }
  }

  @Post('subject-answer')
  @HttpCode(200)
  async subjectAnswer(
    @Body(new ValidationPipe({
      transform: true, whitelist: true, forbidNonWhitelisted: true,
      expectedType: SubjectChatDto,
    })) dto: SubjectChatDto,
  ) {
    if (!this.subjectChat) throw new ServiceUnavailableException('Subject chat is not configured.');
    return this.subjectChat.answer({
      subjectId: dto.subjectId,
      prompt: dto.prompt,
      chatId: dto.chatId,
      topK: dto.topK,
    });
  }
}
