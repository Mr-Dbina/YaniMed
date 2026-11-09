import { describe, expect, it } from 'vitest';
import { gradeAttempt, type GradeItem } from './grading.js';
import { QUESTIONS_PER_TEST } from './types.js';

function buildItems(
  select: (position: number) => string | null,
  topicFor: (position: number) => string = () => 'topic',
): GradeItem[] {
  return Array.from({ length: QUESTIONS_PER_TEST }, (_, index) => {
    const position = index + 1;
    return {
      position,
      topicKey: topicFor(position),
      selectedChoiceId: select(position),
      correctChoiceId: `correct-${position}`,
    };
  });
}

describe('gradeAttempt', () => {
  it('scores 25 of 25', () => {
    const result = gradeAttempt(
      buildItems((position) => `correct-${position}`),
    );

    expect(result).toMatchObject({
      score: 25,
      total: 25,
      percentage: 100,
      correctCount: 25,
      incorrectCount: 0,
      unansweredCount: 0,
    });
  });

  it('scores 0 of 25 when every answer is wrong', () => {
    const result = gradeAttempt(buildItems(() => 'wrong'));

    expect(result).toMatchObject({
      score: 0,
      total: 25,
      percentage: 0,
      correctCount: 0,
      incorrectCount: 25,
      unansweredCount: 0,
    });
  });

  it('counts unanswered as incorrect but not as a wrong answer', () => {
    const result = gradeAttempt(buildItems(() => null));

    expect(result).toMatchObject({
      score: 0,
      correctCount: 0,
      incorrectCount: 0,
      unansweredCount: 25,
    });
  });

  it('scores a mixed attempt', () => {
    const result = gradeAttempt(
      buildItems((position) => {
        if (position <= 10) return `correct-${position}`;
        if (position <= 15) return `wrong-${position}`;
        return null;
      }),
    );

    expect(result).toMatchObject({
      score: 10,
      total: 25,
      percentage: 40,
      correctCount: 10,
      incorrectCount: 5,
      unansweredCount: 10,
    });
    expect(
      result.correctCount + result.incorrectCount + result.unansweredCount,
    ).toBe(25);
  });

  it('sorts per-topic totals by topicKey', () => {
    const result = gradeAttempt(
      buildItems(
        (position) => `correct-${position}`,
        (position) => (position <= 5 ? 'zulu' : position <= 10 ? 'mike' : 'alpha'),
      ),
    );

    expect(result.perTopic).toEqual([
      { topicKey: 'alpha', correct: 15, total: 15 },
      { topicKey: 'mike', correct: 5, total: 5 },
      { topicKey: 'zulu', correct: 5, total: 5 },
    ]);
  });

  it('sorts per-question results by position even when input is reversed', () => {
    const items = buildItems((position) => `correct-${position}`).reverse();
    const result = gradeAttempt(items);

    expect(result.perQuestion.map((item) => item.position)).toEqual(
      Array.from({ length: QUESTIONS_PER_TEST }, (_, index) => index + 1),
    );
  });

  it('rounds the percentage to one decimal place', () => {
    const result = gradeAttempt(
      buildItems((position) => (position <= 7 ? `correct-${position}` : null)),
    );

    expect(result.percentage).toBe(28);
  });

  it('throws when there are not exactly 25 items', () => {
    const items = buildItems((position) => `correct-${position}`);

    expect(() => gradeAttempt(items.slice(0, 24))).toThrow(
      'Invalid grading items.',
    );
    expect(() => gradeAttempt([...items, items[0]])).toThrow(
      'Invalid grading items.',
    );
  });

  it('throws on duplicate or missing positions', () => {
    const duplicate = buildItems((position) => `correct-${position}`);
    duplicate[24].position = 1;
    expect(() => gradeAttempt(duplicate)).toThrow('Invalid grading items.');

    const missing = buildItems((position) => `correct-${position}`);
    missing[24].position = 26;
    expect(() => gradeAttempt(missing)).toThrow('Invalid grading items.');
  });
});
