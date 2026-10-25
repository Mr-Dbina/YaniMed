import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateSubjectDto } from './dto/create-subject.dto.js';
import { UpdateSubjectDto } from './dto/update-subject.dto.js';

async function errorsFor(Dto: new () => any, value: unknown) {
  const instance = plainToInstance(Dto, { name: value });
  return validate(instance);
}

describe('Subject name DTO validation', () => {
  it('trims CreateSubjectDto names', async () => {
    const instance = plainToInstance(CreateSubjectDto, { name: '  Pediatrics  ' });
    expect(instance.name).toBe('Pediatrics');
    expect(await validate(instance)).toHaveLength(0);
  });

  it('rejects empty CreateSubjectDto names', async () => {
    expect(await errorsFor(CreateSubjectDto, '')).not.toHaveLength(0);
  });

  it('rejects whitespace-only CreateSubjectDto names', async () => {
    expect(await errorsFor(CreateSubjectDto, '   ')).not.toHaveLength(0);
  });

  it('rejects non-string CreateSubjectDto names', async () => {
    expect(await errorsFor(CreateSubjectDto, 42)).not.toHaveLength(0);
  });

  it('trims UpdateSubjectDto names', async () => {
    const instance = plainToInstance(UpdateSubjectDto, { name: '  Pediatrics  ' });
    expect(instance.name).toBe('Pediatrics');
    expect(await validate(instance)).toHaveLength(0);
  });

  it('rejects empty UpdateSubjectDto names', async () => {
    expect(await errorsFor(UpdateSubjectDto, '')).not.toHaveLength(0);
  });

  it('rejects whitespace-only UpdateSubjectDto names', async () => {
    expect(await errorsFor(UpdateSubjectDto, '   ')).not.toHaveLength(0);
  });

  it('rejects non-string UpdateSubjectDto names', async () => {
    expect(await errorsFor(UpdateSubjectDto, null)).not.toHaveLength(0);
  });

  it('rejects too-long UpdateSubjectDto names', async () => {
    expect(await errorsFor(UpdateSubjectDto, 'a'.repeat(201))).not.toHaveLength(0);
  });
});
