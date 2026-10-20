import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  ValidationPipe,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiProduces, ApiTags } from '@nestjs/swagger';
import { VoiceService } from './voice.service.js';
import { VoiceGuard } from './voice.guard.js';
import { SynthesizeDto } from './synthesize.dto.js';
import { AUDIO_TYPES, MAX_AUDIO_BYTES } from './audio.validation.js';
import type { AudioUpload } from './audio.validation.js';

@ApiTags('Voice (local beta)')
@UseGuards(VoiceGuard)
@Controller('voice')
export class VoiceController {
  constructor(@Inject(VoiceService) private readonly voice: VoiceService) {}

  @Post('synthesize')
  @HttpCode(200)
  @ApiProduces('audio/mpeg')
  async synthesize(
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
        expectedType: SynthesizeDto,
      }),
    )
    dto: SynthesizeDto,
  ) {
    const audio = await this.voice.synthesize(dto.text, dto.voiceId);
    return new StreamableFile(audio, {
      type: 'audio/mpeg',
      disposition: 'inline',
      length: audio.length,
    });
  }

  @Post('transcribe')
  @HttpCode(200)
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_AUDIO_BYTES, files: 1, fields: 0, parts: 2 },
      fileFilter: (_req, file, cb) =>
        cb(
          AUDIO_TYPES.includes(file.mimetype)
            ? null
            : new BadRequestException('Unsupported audio type.'),
          AUDIO_TYPES.includes(file.mimetype),
        ),
    }),
  )
  transcribe(@UploadedFile() file: AudioUpload) {
    return this.voice.transcribe(file);
  }
}
