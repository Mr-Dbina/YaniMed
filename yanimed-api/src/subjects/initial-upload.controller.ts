import { Body, Controller, Get, HttpCode, Inject, Param, Post, UploadedFile, UseGuards, UseInterceptors, ValidationPipe } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ChatGuard } from '../chat/chat.guard.js';
import { R2_PDF_MAX_BYTES } from '../storage/storage.service.js';
import type { PdfUpload } from '../storage/pdf-validation.js';
import { InitialUploadDto, UploadKeyDto } from './dto/initial-upload.dto.js';
import { InitialUploadService } from './initial-upload.service.js';

@ApiTags('Subjects (local development)')
@UseGuards(ChatGuard)
@Controller('subjects')
export class InitialUploadController {
  constructor(@Inject(InitialUploadService) private readonly uploads: InitialUploadService) {}

  @Post('initial-upload')
  @HttpCode(202)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Reserve a workspace and upload its initial PDF; chat remains unavailable' })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: R2_PDF_MAX_BYTES, files: 1, fields: 2, parts: 3 } }))
  create(@Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true,
    expectedType: InitialUploadDto })) dto: InitialUploadDto, @UploadedFile() file: PdfUpload) {
    return this.uploads.create(dto, file);
  }

  @Get('initial-upload/:idempotencyKey')
  status(@Param(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true,
    expectedType: UploadKeyDto })) dto: UploadKeyDto) {
    return this.uploads.status(dto.idempotencyKey);
  }
}
