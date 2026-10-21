import './config/load-local-env.js';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { OmniRouteModule } from './omniroute/omniroute.module.js';
import { validateEnv } from './config/env.validation.js';
import { VoiceModule } from './voice/voice.module.js';
import { ChatModule } from './chat/chat.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // Earlier entries win, so machine-local overrides in .env.local take
      // precedence over the shared .env without editing the tracked file.
      envFilePath: ['.env.local', '.env'],
      load: [validateEnv],
    }),
    PrismaModule,
    OmniRouteModule,
    VoiceModule,
    ChatModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
