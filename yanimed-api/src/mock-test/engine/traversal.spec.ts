import { describe, expect, it } from 'vitest';
import {
  applyAnswer,
  applySkip,
  nextPosition,
} from './traversal.js';
import {
  QUESTIONS_PER_TEST,
  type EngineQuestion,
  type QuestionStatus,
} from './types.js';

function build(
  overrides: Record<number, QuestionStatus> = {},
  fallback: QuestionStatus = 'UNSEEN',
): EngineQuestion[] {
  return Array.from({ length: QUESTIONS_PER_TEST }, (_, index) => ({
    position: index + 1,
    status: overrides[index + 1] ?? fallback,
  }));
}

describe('nextPosition', () => {
  it('walks the first pass in position order', () => {
    let questions = build();
    let current = 1;
    const visited = [1];

    for (;;) {
      const result = applyAnswer(questions, current);
      questions = result.questions;

      if (result.nextPosition === null) {
        expect(result.attemptStatus).toBe('AWAITING_SUBMISSION');
        break;
      }

      expect(result.attemptStatus).toBe('IN_PROGRESS');
      current = result.nextPosition;
      visited.push(current);
    }

    expect(visited).toEqual(
      Array.from({ length: QUESTIONS_PER_TEST }, (_, index) => index + 1),
    );
    expect(questions.every((question) => question.status === 'ANSWERED')).toBe(
      true,
    );
  });

  it('visits a SKIPPED question before a later UNSEEN one', () => {
    const questions = build({ 1: 'ANSWERED', 2: 'SKIPPED' });

    // Position order wins: 2 is closer than the first UNSEEN at 3.
    expect(nextPosition(questions, 1)).toBe(2);
  });

  it('wraps to the smallest skipped position after position 25', () => {
    const questions = build({ 3: 'SKIPPED' }, 'ANSWERED');

    expect(nextPosition(questions, 25)).toBe(3);
  });

  it('returns null when every question is answered', () => {
    const questions = build({}, 'ANSWERED');

    expect(nextPosition(questions, 5)).toBeNull();
  });
});

describe('skip and revisit pass', () => {
  it('skips position 1, answers 2..25, then revisits position 1', () => {
    const skipped = applySkip(build(), 1);
    expect(skipped.questions[0].status).toBe('SKIPPED');
    expect(skipped.nextPosition).toBe(2);
    expect(skipped.attemptStatus).toBe('IN_PROGRESS');

    let questions = skipped.questions;
    for (let position = 2; position <= QUESTIONS_PER_TEST; position += 1) {
      const result = applyAnswer(questions, position);
      questions = result.questions;
      expect(result.nextPosition).toBe(
        position === QUESTIONS_PER_TEST ? 1 : position + 1,
      );
    }

    expect(nextPosition(questions, QUESTIONS_PER_TEST)).toBe(1);

    const final = applyAnswer(questions, 1);
    expect(final.questions[0].status).toBe('ANSWERED');
    expect(final.nextPosition).toBeNull();
    expect(final.attemptStatus).toBe('AWAITING_SUBMISSION');
  });

  it('skips in the revisit pass to the next open question', () => {
    const questions = build({ 1: 'SKIPPED', 2: 'SKIPPED' }, 'ANSWERED');

    const result = applySkip(questions, 1);

    expect(result.questions[0].status).toBe('SKIPPED');
    expect(result.nextPosition).toBe(2);
    expect(result.attemptStatus).toBe('IN_PROGRESS');
  });

  it('skips the last remaining question and returns it again', () => {
    const questions = build({ 1: 'UNSEEN' }, 'ANSWERED');

    const result = applySkip(questions, 1);

    expect(result.questions[0].status).toBe('SKIPPED');
    expect(result.nextPosition).toBe(1);
    expect(result.attemptStatus).toBe('IN_PROGRESS');
  });

  it('keeps an already skipped question skipped', () => {
    const questions = build({ 1: 'SKIPPED' }, 'ANSWERED');

    const result = applySkip(questions, 1);

    expect(result.questions[0].status).toBe('SKIPPED');
    expect(result.nextPosition).toBe(1);
    expect(result.attemptStatus).toBe('IN_PROGRESS');
  });

  it('throws when an answered question is skipped', () => {
    const questions = build({ 1: 'ANSWERED' });

    expect(() => applySkip(questions, 1)).toThrow(
      'Answered questions cannot be skipped.',
    );
  });
});

describe('resume and immutability', () => {
  it('computes the same next position on refresh from the same state', () => {
    const questions = build({ 1: 'ANSWERED', 2: 'SKIPPED', 9: 'ANSWERED' });

    expect(nextPosition(questions, 2)).toBe(3);
    expect(nextPosition(questions, 2)).toBe(3);
  });

  it('does not mutate the input array or its objects', () => {
    const questions = build({ 2: 'SKIPPED' });
    const snapshot = questions.map((question) => ({ ...question }));

    applyAnswer(questions, 1);
    expect(questions).toEqual(snapshot);

    applySkip(questions, 1);
    expect(questions).toEqual(snapshot);
  });
});

describe('invalid question sets', () => {
  it('throws on duplicate positions', () => {
    const questions = build();
    questions[1].position = 1;

    expect(() => nextPosition(questions, 1)).toThrow('Invalid question set.');
  });

  it('throws on a missing position', () => {
    const questions = build();
    questions[24].position = 26;

    expect(() => nextPosition(questions, 1)).toThrow('Invalid question set.');
  });

  it('throws on the wrong number of questions', () => {
    expect(() => nextPosition(build().slice(0, 24), 1)).toThrow(
      'Invalid question set.',
    );
  });

  it('throws on a current position outside 1..25', () => {
    expect(() => nextPosition(build(), 0)).toThrow('Invalid current position.');
    expect(() => nextPosition(build(), 26)).toThrow(
      'Invalid current position.',
    );
  });
});
