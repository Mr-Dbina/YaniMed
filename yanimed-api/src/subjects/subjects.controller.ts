import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, UseGuards, ValidationPipe } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ChatGuard } from '../chat/chat.guard.js';
import { CreateSubjectDto } from './dto/create-subject.dto.js';
import { SubjectsService } from './subjects.service.js';

@ApiTags('Subjects (local development)')
@UseGuards(ChatGuard)
@Controller('subjects')
export class SubjectsController {
  constructor(@Inject(SubjectsService) private readonly subjects: SubjectsService) {}

  @Get()
  @ApiOperation({ summary: 'List backend Subjects in creation order (ID breaks ties)' })
  list() { return this.subjects.list(); }

  @Get(':subjectId/documents')
  @ApiOperation({ summary: 'List safe document metadata for one Subject' })
  documents(@Param('subjectId', new ParseUUIDPipe()) id: string) { return this.subjects.documents(id); }

  @Get(':subjectId')
  @ApiOperation({ summary: 'Read safe Subject metadata' })
  get(@Param('subjectId', new ParseUUIDPipe()) id: string) { return this.subjects.get(id); }

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Create workspace metadata; an initial PDF is still required before use' })
  create(@Body(new ValidationPipe({
    transform: true, whitelist: true, forbidNonWhitelisted: true, expectedType: CreateSubjectDto,
  })) dto: CreateSubjectDto) {
    return this.subjects.create(dto.name);
  }
}
