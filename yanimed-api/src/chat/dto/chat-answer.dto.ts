import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class ChatAnswerDto {
  @ApiProperty({ minLength: 1, maxLength: 2000 })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  prompt!: string;
}

export class ChatCitationDto {
  @ApiProperty()
  sourceId!: string;

  @ApiProperty({ type: String, nullable: true })
  chapter!: string | null;

  @ApiProperty({ minimum: 1, description: 'Physical, 1-based PDF page index' })
  page!: number;

  @ApiPropertyOptional()
  snippet?: string;
}

export class ChatMetadataDto {
  @ApiProperty({ enum: ['omniroute'] })
  gateway!: 'omniroute';

  @ApiProperty()
  requestedModel!: string;

  @ApiProperty({ type: String, nullable: true })
  servedModel!: string | null;

  @ApiProperty({ type: String, nullable: true })
  provider!: string | null;

  @ApiProperty({ minimum: 0 })
  durationMs!: number;
}

export class ChatAnswerResponseDto {
  @ApiProperty()
  answer!: string;

  @ApiProperty({ type: [ChatCitationDto] })
  citations!: ChatCitationDto[];

  @ApiProperty({ enum: ['ungrounded', 'grounded', 'insufficient_evidence'] })
  grounding!: 'ungrounded' | 'grounded' | 'insufficient_evidence';

  @ApiProperty({ type: ChatMetadataDto })
  metadata!: ChatMetadataDto;
}
