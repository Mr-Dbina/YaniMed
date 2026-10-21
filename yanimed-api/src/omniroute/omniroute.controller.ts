import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Post,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { OmniRouteService } from './omniroute.service.js';
import { TestAnswerDto } from './dto/test-answer.dto.js';

/**
 * Development-only integration routes for the OmniRoute gateway.
 *
 * These exist to prove the transport and credential path end to end. They are
 * NOT the medical answer endpoint: there is no retrieval grounding and no
 * citation validation here yet. In production they return 404 so they do not
 * even advertise their existence on a public deployment.
 */
@ApiTags('AI (dev only)')
@Controller('ai')
export class OmniRouteController {
  constructor(private readonly omniroute: OmniRouteService) {}

  private assertLocalDevelopment(): void {
    if (process.env.NODE_ENV === 'production') {
      throw new NotFoundException();
    }
  }

  @Get('health')
  @ApiOperation({ summary: 'Check OmniRoute reachability (no secrets returned)' })
  @ApiOkResponse({ description: 'Gateway reachability report' })
  async health() {
    this.assertLocalDevelopment();
    return this.omniroute.checkHealth();
  }

  @Post('test-answer')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Send a test prompt through the configured OmniRoute Combo',
    description:
      'Temporary integration route. No retrieval grounding, no citations. ' +
      'Disabled in production.',
  })
  @ApiOkResponse({ description: 'Completion returned by the gateway' })
  async testAnswer(@Body() dto: TestAnswerDto) {
    this.assertLocalDevelopment();

    const started = Date.now();
    const result = await this.omniroute.complete(dto.prompt, dto.systemPrompt);

    return {
      prompt: dto.prompt,
      answer: result.content,
      // Which model the gateway actually served. Inside the configured Combo
      // this is the resolved upstream model, not the combo name.
      servedModel: result.model,
      durationMs: Date.now() - started,
    };
  }
}
