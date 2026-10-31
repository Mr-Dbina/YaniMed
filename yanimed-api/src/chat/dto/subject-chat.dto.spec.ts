import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { SubjectChatDto } from './subject-chat.dto.js';

async function validatePayload(payload: Record<string, unknown>) {
  const dto = plainToInstance(SubjectChatDto, {
    subjectId: 'subject-1',
    prompt: 'question',
    ...payload,
  });
  return validate(dto);
}

describe('SubjectChatDto', () => {
  it('T9 rejects decimal topK and accepts integer or omitted topK', async () => {
    const decimal = await validatePayload({ topK: 1.5 });
    expect(decimal.some((error) => error.property === 'topK')).toBe(true);
    expect(await validatePayload({ topK: 5 })).toHaveLength(0);
    expect(await validatePayload({})).toHaveLength(0);
  });

  it('T10 rejects empty chatId and accepts omitted or non-empty chatId', async () => {
    const empty = await validatePayload({ chatId: '' });
    expect(empty.some((error) => error.property === 'chatId')).toBe(true);
    expect(await validatePayload({})).toHaveLength(0);
    expect(await validatePayload({ chatId: 'abc' })).toHaveLength(0);
  });
});
