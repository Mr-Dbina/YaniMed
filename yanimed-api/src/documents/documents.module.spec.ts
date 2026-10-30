import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { PrismaService } from '../prisma/prisma.service.js';
import { DocumentProcessingService } from '../document-processing/document-processing.service.js';
import { ProcessingJobRepository } from '../document-processing/processing-job.repository.js';
import { PdfObjectService } from '../pdf-objects/pdf-object.service.js';
import { DocumentsModule } from './documents.module.js';
import { DocumentController } from './documents.controller.js';
import { DocumentStatusController } from './document-status.controller.js';

describe('DocumentsModule real wiring', () => {
  it('resolves controllers and their processing/PdfObject dependencies', async () => {
    const module = await Test.createTestingModule({ imports: [DocumentsModule] })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();

    try {
      expect(module.get(DocumentController)).toBeInstanceOf(DocumentController);
      expect(module.get(DocumentStatusController)).toBeInstanceOf(DocumentStatusController);
      expect(module.get(PdfObjectService)).toBeInstanceOf(PdfObjectService);
      expect(module.get(ProcessingJobRepository)).toBeInstanceOf(ProcessingJobRepository);
      expect(module.get(DocumentProcessingService)).toBeInstanceOf(DocumentProcessingService);
    } finally {
      await module.close();
    }
  });
});
