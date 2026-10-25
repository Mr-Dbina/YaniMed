import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { OmniRouteModule } from '../omniroute/omniroute.module.js';
import { RetrievalModule } from '../retrieval/retrieval.module.js';
import { ChatController } from './chat.controller.js';
import { ChatGuard } from './chat.guard.js';
import { SubjectChatService } from './subject-chat.service.js';

@Module({
  imports: [PrismaModule, OmniRouteModule, RetrievalModule],
  controllers: [ChatController],
  providers: [ChatGuard, SubjectChatService],
  exports: [SubjectChatService],
})
export class ChatModule {}
