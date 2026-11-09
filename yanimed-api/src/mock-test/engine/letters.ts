import {
  CHOICES_PER_QUESTION,
  QUESTIONS_PER_TEST,
} from './types.js';

/**
 * Mulberry32. Tiny deterministic PRNG; the caller supplies the seed, so the
 * engine never reads an ambient random source or the clock. Returns a float
 * in [0, 1).
 */
export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(values: readonly T[], rng: () => number): T[] {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapWith = Math.floor(rng() * (index + 1));
    const temporary = copy[index];
    copy[index] = copy[swapWith];
    copy[swapWith] = temporary;
  }
  return copy;
}

/**
 * Display letter (0 = A) for each of the 25 questions. Counts are 6/6/6/7:
 * one random letter gets the extra question, then positions are shuffled.
 */
export function assignAnswerLetters(rng: () => number): number[] {
  const extraLetter = Math.floor(rng() * CHOICES_PER_QUESTION);
  const letters: number[] = [];

  for (let letter = 0; letter < CHOICES_PER_QUESTION; letter += 1) {
    const count = letter === extraLetter ? 7 : 6;
    for (let index = 0; index < count; index += 1) letters.push(letter);
  }

  return shuffle(letters, rng);
}

function assertStoredPosition(
  value: number,
): asserts value is 1 | 2 | 3 | 4 {
  if (![1, 2, 3, 4].includes(value)) {
    throw new Error('Invalid stored choice position.');
  }
}

function assertDisplayIndex(
  value: number,
): asserts value is 0 | 1 | 2 | 3 {
  if (![0, 1, 2, 3].includes(value)) {
    throw new Error('Invalid display index.');
  }
}

/**
 * Stored MockChoice positions in display order. The correct stored position
 * lands on targetDisplayIndex; the three distractors are shuffled.
 */
export function buildChoiceOrder(
  correctStoredPosition: 1 | 2 | 3 | 4,
  targetDisplayIndex: 0 | 1 | 2 | 3,
  rng: () => number,
): number[] {
  assertStoredPosition(correctStoredPosition);
  assertDisplayIndex(targetDisplayIndex);

  const distractors = [1, 2, 3, 4].filter(
    (position) => position !== correctStoredPosition,
  );
  const order = shuffle(distractors, rng);
  order.splice(targetDisplayIndex, 0, correctStoredPosition);
  return order;
}

export interface AttemptChoiceOrders {
  letters: number[];
  choiceOrders: number[][];
}

/**
 * One letter draw for the attempt, then one stored-position order per
 * question. A fresh rng sequence makes the whole attempt reproducible.
 */
export function buildAttemptChoiceOrders(
  correctPositions: readonly number[],
  rng: () => number,
): AttemptChoiceOrders {
  if (correctPositions.length !== QUESTIONS_PER_TEST) {
    throw new Error('Invalid correct position list.');
  }
  for (const position of correctPositions) assertStoredPosition(position);

  const letters = assignAnswerLetters(rng);
  const choiceOrders = correctPositions.map((correct, index) =>
    buildChoiceOrder(
      correct as 1 | 2 | 3 | 4,
      letters[index] as 0 | 1 | 2 | 3,
      rng,
    ),
  );

  return { letters, choiceOrders };
}
