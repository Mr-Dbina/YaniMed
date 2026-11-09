import { describe, expect, it } from 'vitest';
import {
  CHOICES_PER_QUESTION,
  LETTER_MAX,
  LETTER_MIN,
  QUESTIONS_PER_TEST,
} from './types.js';

describe('engine constants', () => {
  it('matches the v2.2 exam shape', () => {
    expect(QUESTIONS_PER_TEST).toBe(25);
    expect(CHOICES_PER_QUESTION).toBe(4);
    expect(LETTER_MIN).toBe(5);
    expect(LETTER_MAX).toBe(8);
  });
});
