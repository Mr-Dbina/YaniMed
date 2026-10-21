import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class TestAnswerDto {
  @ApiProperty({
    example: 'What is the definition of Type II hypersensitivity?',
    maxLength: 2000,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  prompt!: string;

  @ApiPropertyOptional({
    description:
      'Development-only system prompt override. Left unset in normal use.',
    maxLength: 2000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  systemPrompt?: string;
}