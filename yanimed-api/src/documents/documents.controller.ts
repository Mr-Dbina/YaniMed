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
  ) {}

  @Post('upload')
  @HttpCode(201)
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', {
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 2, parts: 4 },
    fileFilter: (_req, file, cb) => cb(null, file.mimetype === 'application/pdf'),
  }))
  async upload(
    @Body('subjectId') subjectId: string,
    @UploadedFile() file: MulterFile | undefined,
  ) {
    const subject = await this.prisma.subject.findUnique({ where: { id: subjectId } });
    if (!subject) throw new BadRequestException('Subject does not exist.');
    const { buffer, originalname } = validatePdfUpload(file as never);
    const result = await this.storage.uploadPdf(subject.id, buffer, originalname);
    const document = await this.prisma.document.create({
      data: {
        subjectId: subject.id,
        title: originalname,
        fileUrl: result.key,
        fileSize: result.bytes,
        status: 'QUEUED',
        processedPages: 0,
        embeddedChunks: 0,
        ocrPages: 0,
      },
    });
    this.processing?.schedule(document.id);
    return {
      documentId: document.id,
      filename: originalname,
      subjectId: subject.id,
      status: document.status,
      storageKey: document.fileUrl,
    };
  }
}
