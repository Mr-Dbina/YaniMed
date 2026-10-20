import { Module } from '@nestjs/common';
import { VoiceController } from './voice.controller.js';
import { VoiceService } from './voice.service.js';
import { VoiceGuard } from './voice.guard.js';

@Module({
  controllers: [VoiceController],
  providers: [VoiceService, VoiceGuard],
})
export class VoiceModule {}
