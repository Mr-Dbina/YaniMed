import { describe, expect, it } from 'vitest';
import { detectPolarity } from './stem-polarity.js';

describe('detectPolarity', () => {
  it('treats a plain question as NORMAL', () => {
    expect(
      detectPolarity('Which of the following is a cause of acidosis?', null),
    ).toBe('NORMAL');
    expect(
      detectPolarity(
        'A 60-year-old adult has sepsis. Which of the following is a cause?',
        'A 60-year-old adult has sepsis.',
      ),
    ).toBe('NORMAL');
  });

  it('detects whole-word EXCEPT in either case', () => {
    expect(
      detectPolarity('All of the following are true EXCEPT:', null),
    ).toBe('NEGATED');
    expect(
      detectPolarity('All of the following are true except one.', null),
    ).toBe('NEGATED');
  });

  it('detects uppercase NOT', () => {
    expect(
      detectPolarity('Which of the following is NOT a feature of X?', null),
    ).toBe('NEGATED');
  });

  it('detects uppercase LEAST likely', () => {
    expect(
      detectPolarity('Which of the following is LEAST likely to occur?', null),
    ).toBe('NEGATED');
  });

  it('detects uppercase FALSE and the phrase false statement', () => {
    expect(
      detectPolarity('Which of the following statements is FALSE?', null),
    ).toBe('NEGATED');
    expect(
      detectPolarity('Which of these is a false statement about X?', null),
    ).toBe('NEGATED');
  });

  it('detects incorrect in either case', () => {
    expect(
      detectPolarity('Which of the following statements is incorrect?', null),
    ).toBe('NEGATED');
  });

  it('ignores a lowercase "not" inside a normal stem', () => {
    expect(
      detectPolarity(
        'Metformin is not recommended in renal failure. Which of the following is a cause of lactic acidosis?',
        null,
      ),
    ).toBe('NORMAL');
  });

  it('detects a weak marker in a lead-in question', () => {
    expect(
      detectPolarity('Select the best option.', 'Which of the following is not a feature of the drug?'),
    ).toBe('NEGATED');
  });

  it('detects a weak marker in a stem question', () => {
    expect(
      detectPolarity('Which of the following does not cause bradycardia?', null),
    ).toBe('NEGATED');
  });

  it('does not match markers inside longer words', () => {
    expect(
      detectPolarity('NOTEWORTHY findings are described below.', null),
    ).toBe('NORMAL');
  });

  it('returns NEGATED when both NOT and EXCEPT appear', () => {
    expect(
      detectPolarity('Which of the following is NOT true EXCEPT:', null),
    ).toBe('NEGATED');
  });

  it('handles an empty lead-in', () => {
    expect(
      detectPolarity('Which of the following is a cause?', ''),
    ).toBe('NORMAL');
  });
});
