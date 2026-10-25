import { IsString, Length, Matches } from 'class-validator';
import { CreateSubjectDto } from './create-subject.dto.js';

export class UploadKeyDto {
  @IsString()
  @Length(8, 128)
  @Matches(/^[A-Za-z0-9._:-]+$/)
  idempotencyKey!: string;
}

export class InitialUploadDto extends CreateSubjectDto {
  @IsString()
  @Length(8, 128)
  @Matches(/^[A-Za-z0-9._:-]+$/)
  idempotencyKey!: string;
}
