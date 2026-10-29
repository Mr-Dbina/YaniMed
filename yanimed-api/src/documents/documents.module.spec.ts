import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { PrismaService } from '../prisma/prisma.service.js';
import { DocumentProcessingService } from '../document-processing/document-processing.service.js';
import { ProcessingJobRepository } from '../document-processing/processing-job.repository.js';
import { DocumentsModule } from './documents.module.js';
import { DocumentStatusController } from './document-status.controller.js';

describe('DocumentsModule real wiring', () => {
  it('resolves DocumentStatusController and its processing dependencies', async () => {
    const module = await Test.createTestingModule({ imports: [DocumentsModule] })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();

    try {
      expect(module.get(DocumentStatusController)).toBeInstanceOf(DocumentStatusController);
      expect(module.get(ProcessingJobRepository)).toBeInstanceOf(ProcessingJobRepository);
      expect(module.get(DocumentProcessingService)).toBeInstanceOf(DocumentProcessingService);
    } finally {
      await module.close();
    }
  });
});
