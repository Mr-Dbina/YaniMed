import { Transform } from 'class-transformer';
import {
  IsIn,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const ROGER_VOICE_ID = 'CwhRBWXzGAHq8TQ4Fs17';

export class SynthesizeDto {
  @ApiProperty({ maxLength: 2000 })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  text!: string;

  @ApiPropertyOptional({ enum: [ROGER_VOICE_ID], default: ROGER_VOICE_ID })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @IsIn([ROGER_VOICE_ID])
  voiceId?: string;
}
