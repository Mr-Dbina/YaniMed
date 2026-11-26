import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { DocumentProcessingModule } from '../document-processing/document-processing.module.js';
import { PdfObjectModule } from '../pdf-objects/pdf-object.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { DocumentController } from './documents.controller.js';
import { DocumentStatusController } from './document-status.controller.js';

@Module({
  imports: [PrismaModule, DocumentProcessingModule, PdfObjectModule, StorageModule],
  controllers: [DocumentController, DocumentStatusController],
})
export class DocumentsModule {}
