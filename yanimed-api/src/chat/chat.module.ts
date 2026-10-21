import { Module } from '@nestjs/common';
import { OmniRouteModule } from '../omniroute/omniroute.module.js';
import { ChatController } from './chat.controller.js';
import { ChatGuard } from './chat.guard.js';

@Module({
  imports: [OmniRouteModule],
  controllers: [ChatController],
  providers: [ChatGuard],
})
export class ChatModule {}
