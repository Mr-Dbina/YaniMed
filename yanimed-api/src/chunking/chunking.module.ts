import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ChunkingService } from './chunking.service.js';

@Module({
  imports: [PrismaModule],
  providers: [ChunkingService],
  exports: [ChunkingService],
})
export class ChunkingModule {}
