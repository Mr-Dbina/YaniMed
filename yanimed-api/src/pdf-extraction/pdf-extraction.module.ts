import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { ChunkingModule } from '../chunking/chunking.module.js';
import { PdfExtractionService } from './pdf-extraction.service.js';

@Module({
  imports: [PrismaModule, StorageModule, ChunkingModule],
  providers: [PdfExtractionService],
  exports: [PdfExtractionService],
})
export class PdfExtractionModule {}
