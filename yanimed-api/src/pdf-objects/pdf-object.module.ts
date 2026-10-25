import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { PdfObjectService } from './pdf-object.service.js';

@Module({
  imports: [PrismaModule, StorageModule],
  providers: [PdfObjectService],
  exports: [PdfObjectService],
})
export class PdfObjectModule {}
