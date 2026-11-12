import { describe, expect, it } from 'vitest';
import { normalizeObjective } from './normalize.js';

describe('normalizeObjective', () => {
  it('lowercases and collapses punctuation and whitespace', () => {
    expect(normalizeObjective('  Recognise  HYPOglycaemia! ')).toBe(
      'recognise hypoglycaemia',
    );
  });

  it('keeps unicode letters and digits', () => {
    expect(normalizeObjective('Niño con fiebre 38.5°C')).toBe(
      'niño con fiebre 38 5 c',
    );
  });

  it('returns an empty string for punctuation only', () => {
    expect(normalizeObjective('---')).toBe('');
  });
});
