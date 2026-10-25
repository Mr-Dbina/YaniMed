import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { EmbeddingModule } from '../embeddings/embedding.module.js';
import { RetrievalService } from './retrieval.service.js';

@Module({
  imports: [PrismaModule, EmbeddingModule],
  providers: [RetrievalService],
  exports: [RetrievalService],
})
export class RetrievalModule {}
