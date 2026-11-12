import { describe, expect, it } from 'vitest';
import { countSentences } from './sentences.js';

describe('countSentences', () => {
  it('returns 0 for empty input', () => {
    expect(countSentences('')).toBe(0);
    expect(countSentences('   \n\t ')).toBe(0);
  });

  it('counts a single sentence', () => {
    expect(countSentences('The patient improved.')).toBe(1);
  });

  it('counts seven sentences', () => {
    const text = [
      'One.',
      'Two.',
      'Three.',
      'Four.',
      'Five.',
      'Six.',
      'Seven.',
    ].join(' ');
    expect(countSentences(text)).toBe(7);
  });

  it('tolerates abbreviations and initials', () => {
    expect(
      countSentences('Dr. Smith reviewed the chart. The patient improved.'),
    ).toBe(2);
    expect(countSentences('J. R. Smith wrote the note. It was clear.')).toBe(2);
  });

  it('tolerates decimals', () => {
    expect(countSentences('The dose was 2.5 mg. It worked.')).toBe(2);
  });

  it('counts unicode question and exclamation marks', () => {
    expect(countSentences('¿Fiebre? Sí. El niño mejora.')).toBe(3);
  });

  it('does not count a trailing separator as a sentence', () => {
    expect(countSentences('Only one sentence...')).toBe(1);
  });
});
