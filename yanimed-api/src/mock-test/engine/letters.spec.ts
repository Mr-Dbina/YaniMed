import { describe, expect, it } from 'vitest';
import {
  assignAnswerLetters,
  buildAttemptChoiceOrders,
  buildChoiceOrder,
  createRng,
} from './letters.js';
import {
  LETTER_MAX,
  LETTER_MIN,
  QUESTIONS_PER_TEST,
} from './types.js';

function counts(letters: readonly number[]): number[] {
  const result = [0, 0, 0, 0];
  for (const letter of letters) result[letter] += 1;
  return result;
}

describe('createRng', () => {
  it('repeats the same sequence for the same seed', () => {
    const first = createRng(7);
    const second = createRng(7);

    for (let index = 0; index < 10; index += 1) {
      expect(first()).toBe(second());
    }
  });
});

describe('assignAnswerLetters', () => {
  it('balances 6/6/6/7 across 200 seeds and keeps every letter in range', () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const letters = assignAnswerLetters(createRng(seed));
      expect(letters).toHaveLength(QUESTIONS_PER_TEST);

      const letterCounts = counts(letters);
      expect([...letterCounts].sort((a, b) => a - b)).toEqual([6, 6, 6, 7]);
      expect(letterCounts.reduce((sum, value) => sum + value, 0)).toBe(25);

      for (const count of letterCounts) {
        expect(count).toBeGreaterThanOrEqual(LETTER_MIN);
        expect(count).toBeLessThanOrEqual(LETTER_MAX);
      }
      for (const letter of letters) {
        expect([0, 1, 2, 3]).toContain(letter);
      }
    }
  });

  it('produces identical output for the same seed', () => {
    expect(assignAnswerLetters(createRng(42))).toEqual(
      assignAnswerLetters(createRng(42)),
    );
  });

  it('produces different output for different seeds', () => {
    const outputs = new Set(
      Array.from({ length: 20 }, (_, index) =>
        JSON.stringify(assignAnswerLetters(createRng(index + 1))),
      ),
    );

    expect(outputs.size).toBeGreaterThan(1);
  });
});

describe('buildChoiceOrder', () => {
  it('is a permutation with the correct stored position at the target display index', () => {
    for (let correct = 1; correct <= 4; correct += 1) {
      for (let target = 0; target < 4; target += 1) {
        for (let seed = 1; seed <= 50; seed += 1) {
          const order = buildChoiceOrder(
            correct as 1 | 2 | 3 | 4,
            target as 0 | 1 | 2 | 3,
            createRng(seed),
          );

          expect([...order].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
          expect(order[target]).toBe(correct);
        }
      }
    }
  });

  it('is deterministic for the same seed', () => {
    expect(buildChoiceOrder(3, 2, createRng(99))).toEqual(
      buildChoiceOrder(3, 2, createRng(99)),
    );
  });
});

describe('buildAttemptChoiceOrders', () => {
  const correctPositions = Array.from(
    { length: QUESTIONS_PER_TEST },
    (_, index) => (index % 4) + 1,
  );

  it('builds balanced letters and one permutation per question', () => {
    const result = buildAttemptChoiceOrders(
      correctPositions,
      createRng(123),
    );

    expect(result.letters).toHaveLength(25);
    expect([...counts(result.letters)].sort((a, b) => a - b)).toEqual([
      6, 6, 6, 7,
    ]);
    expect(result.choiceOrders).toHaveLength(25);

    result.choiceOrders.forEach((order, index) => {
      expect([...order].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
      expect(order[result.letters[index]]).toBe(correctPositions[index]);
    });
  });

  it('is deterministic for the same seed', () => {
    expect(
      buildAttemptChoiceOrders(correctPositions, createRng(123)),
    ).toEqual(buildAttemptChoiceOrders(correctPositions, createRng(123)));
  });

  it('throws on the wrong list length or a bad stored position', () => {
    expect(() =>
      buildAttemptChoiceOrders(correctPositions.slice(0, 24), createRng(1)),
    ).toThrow('Invalid correct position list.');

    const bad = [...correctPositions];
    bad[0] = 0;
    expect(() => buildAttemptChoiceOrders(bad, createRng(1))).toThrow(
      'Invalid stored choice position.',
    );
  });
});
