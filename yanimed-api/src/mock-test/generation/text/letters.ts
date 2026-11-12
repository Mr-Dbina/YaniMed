import {
  CHOICES_PER_QUESTION,
  LETTER_MAX,
  LETTER_MIN,
  QUESTIONS_PER_TEST,
} from '../generation.constants.js';
import { shuffle } from './rng.js';

export type AnswerLetter = 'A' | 'B' | 'C' | 'D';

const LETTERS: readonly AnswerLetter[] = ['A', 'B', 'C', 'D'];

/**
 * One answer letter per question. The base count is 25 / 4 = 6, the extra
 * question goes to one seeded letter, so the result is always 6/6/6/7 and
 * every letter stays inside the approved 5 to 8 range.
 */
export function allocateLetters(rng: () => number): AnswerLetter[] {
  const base = Math.floor(QUESTIONS_PER_TEST / CHOICES_PER_QUESTION);
  const extra = QUESTIONS_PER_TEST % CHOICES_PER_QUESTION;
  const extraLetter = Math.floor(rng() * CHOICES_PER_QUESTION);

  const letters: AnswerLetter[] = [];
  for (let index = 0; index < CHOICES_PER_QUESTION; index += 1) {
    const count = base + (index === extraLetter ? extra : 0);
    if (count < LETTER_MIN || count > LETTER_MAX) {
      throw new Error(
        `Letter allocation ${count} is outside ${LETTER_MIN}..${LETTER_MAX}.`,
      );
    }
    for (let occurrence = 0; occurrence < count; occurrence += 1) {
      letters.push(LETTERS[index]);
    }
  }

  if (letters.length !== QUESTIONS_PER_TEST) {
    throw new Error(
      `Letter allocation produced ${letters.length}, expected ${QUESTIONS_PER_TEST}.`,
    );
  }

  return shuffle(letters, rng);
}
