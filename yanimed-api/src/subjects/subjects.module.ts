import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { SubjectsController } from './subjects.controller.js';
import { SubjectsService } from './subjects.service.js';
import { StorageModule } from '../storage/storage.module.js';
import { DocumentProcessingModule } from '../document-processing/document-processing.module.js';
import { PdfObjectModule } from '../pdf-objects/pdf-object.module.js';
import { InitialUploadController } from './initial-upload.controller.js';
import { InitialUploadService } from './initial-upload.service.js';
import { UploadReconciler } from './upload-reconciler.service.js';

@Module({
  imports: [PrismaModule, StorageModule, DocumentProcessingModule, PdfObjectModule],
  controllers: [SubjectsController, InitialUploadController],
  providers: [SubjectsService, InitialUploadService, UploadReconciler],
})
export class SubjectsModule {}
