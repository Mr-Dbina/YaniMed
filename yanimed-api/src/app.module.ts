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
import { MockTestModule } from './mock-test/mock-test.module.js';
import { StorageModule } from './storage/storage.module.js';
import { DocumentsModule } from './documents/documents.module.js';
import { PdfExtractionModule } from './pdf-extraction/pdf-extraction.module.js';
import { ChunkingModule } from './chunking/chunking.module.js';
import { EmbeddingModule } from './embeddings/embedding.module.js';
import { DocumentProcessingModule } from './document-processing/document-processing.module.js';
import { RetrievalModule } from './retrieval/retrieval.module.js';
import { SubjectsModule } from './subjects/subjects.module.js';

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
    MockTestModule,
    StorageModule,
    DocumentsModule,
    SubjectsModule,
    PdfExtractionModule,
    ChunkingModule,
    EmbeddingModule,
    DocumentProcessingModule,
    RetrievalModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
