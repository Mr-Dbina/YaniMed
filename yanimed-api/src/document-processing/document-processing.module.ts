import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PdfExtractionModule } from '../pdf-extraction/pdf-extraction.module.js';
import { EmbeddingModule } from '../embeddings/embedding.module.js';
import { DocumentProcessingService } from './document-processing.service.js';
import { DocumentProcessingReconciler } from './document-processing.reconciler.js';
import { ProcessingJobRepository } from './processing-job.repository.js';

@Module({
  imports: [PrismaModule, PdfExtractionModule, EmbeddingModule],
  providers: [ProcessingJobRepository, DocumentProcessingService, DocumentProcessingReconciler],
  exports: [DocumentProcessingService],
})
export class DocumentProcessingModule {}
