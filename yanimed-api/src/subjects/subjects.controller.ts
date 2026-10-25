import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Patch, UseGuards, ValidationPipe } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ChatGuard } from '../chat/chat.guard.js';
import { UpdateSubjectDto } from './dto/update-subject.dto.js';
import { SubjectsService } from './subjects.service.js';

@ApiTags('Subjects (local development)')
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

  @Patch(':subjectId')
  @UseGuards(ChatGuard)
  @ApiOperation({ summary: 'Rename an active Subject' })
  rename(@Param('subjectId', new ParseUUIDPipe()) id: string,
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true, expectedType: UpdateSubjectDto })) dto: UpdateSubjectDto) {
    return this.subjects.rename(id, dto.name);
  }


}
