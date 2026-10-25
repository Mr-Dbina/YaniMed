import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
type MulterFile = { originalname: string; mimetype: string; size: number; buffer: Buffer };
import { ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service.js';
import { ChatGuard } from '../chat/chat.guard.js';
import { StorageService, validatePdfUpload } from '../storage/storage.service.js';
import { Optional } from '@nestjs/common';
import { PdfObjectService } from '../pdf-objects/pdf-object.service.js';
import { ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DocumentProcessingService } from '../document-processing/document-processing.service.js';

const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;

@ApiTags('Documents (local development)')
@UseGuards(ChatGuard)
@Controller('documents')
export class DocumentController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(StorageService) private readonly storage: StorageService,
    @Optional() private readonly processing?: DocumentProcessingService,
    @Optional() private readonly pdfObjects?: PdfObjectService,
  ) {}

  @Post('upload')
  @HttpCode(201)
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', {
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 3, parts: 5 },
    fileFilter: (_req, file, cb) => cb(null, file.mimetype === 'application/pdf'),
  }))
  async upload(
    @Body('subjectId') subjectId: string,
    @Body('duplicateAction') duplicateAction: string | undefined,
    @UploadedFile() file: MulterFile | undefined,
  ) {
    const subject = await this.prisma.subject.findUnique({ where: { id: subjectId } });
    if (!subject || subject.status !== 'ACTIVE') throw new BadRequestException('Subject does not exist.');
    const { buffer, originalname } = validatePdfUpload(file as never);
    const sha256 = createHash('sha256').update(buffer).digest('hex');

    const duplicate = this.pdfObjects ? await this.pdfObjects.findDuplicate(sha256, subject.id) : null;
    if (duplicate && !duplicateAction) {
      throw new ConflictException({
        code: 'DUPLICATE_PDF', scope: duplicate.scope,
        existingDocumentId: duplicate.existingDocumentId,
        existingSubjectId: duplicate.existingSubjectId,
        existingFilename: duplicate.existingFilename,
        allowedActions: duplicate.scope === 'same_subject' ? ['upload_anyway'] : ['keep_existing', 'replace_existing'],
      });
    }
    if (duplicate && duplicateAction) {
      const allowed = duplicate.scope === 'same_subject' ? ['upload_anyway'] : ['keep_existing', 'replace_existing'];
      if (!allowed.includes(duplicateAction)) throw new BadRequestException('duplicateAction is not valid for this upload.');
    }

    const pdfObject = this.pdfObjects
      ? await this.pdfObjects.ensureFromBuffer(buffer, sha256, buffer.length)
      : undefined;

    const title = duplicate && duplicateAction === 'keep_existing'
      ? duplicate.existingFilename
      : originalname;

    const document = await this.prisma.document.create({
      data: {
        subjectId: subject.id,
        title,
        fileUrl: pdfObject ? pdfObject.r2Key : '',
        fileSize: buffer.length,
        status: 'QUEUED',
        processedPages: 0,
        embeddedChunks: 0,
        ocrPages: 0,
        pdfObjectId: pdfObject?.id ?? null,
      },
    });

    // If PdfObjectService is unavailable, fall back to the legacy R2 upload path.
    if (!pdfObject) {
      const result = await this.storage.uploadPdf(subject.id, buffer, originalname);
      await this.prisma.document.update({ where: { id: document.id }, data: { fileUrl: result.key, fileSize: result.bytes } });
    }

    this.processing?.schedule(document.id);
    const finalDocument = await this.prisma.document.findUniqueOrThrow({ where: { id: document.id } });
    return {
      documentId: finalDocument.id,
      filename: finalDocument.title,
      subjectId: subject.id,
      status: finalDocument.status,
      storageKey: finalDocument.fileUrl,
    };
  }
}
