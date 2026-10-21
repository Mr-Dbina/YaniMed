import {
  Body, Controller, HttpCode, Inject, Post, ServiceUnavailableException,
  UseGuards, ValidationPipe,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { OmniRouteService } from '../omniroute/omniroute.service.js';
import { ChatGuard } from './chat.guard.js';
import { ChatAnswerDto, ChatAnswerResponseDto } from './dto/chat-answer.dto.js';

const SYSTEM_PROMPT = 'You are answering without reference material. ' +
  'This is an ungrounded development demonstration, not study material. ' +
  'Do not invent citations, sources, or page numbers. State uncertainty plainly.';

@ApiTags('Chat (local development)')
@UseGuards(ChatGuard)
@Controller('chat')
export class ChatController {
  constructor(@Inject(OmniRouteService) private readonly omniroute: OmniRouteService) {}

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
}
