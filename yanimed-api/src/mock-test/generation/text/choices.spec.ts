import { describe, expect, it } from 'vitest';
import { distinctChoices, isBannedChoice } from './choices.js';

describe('distinctChoices', () => {
  it('accepts four different choices', () => {
    expect(
      distinctChoices(['Alpha', 'Beta', 'Gamma', 'Delta']),
    ).toBe(true);
  });

  it('rejects identical choices', () => {
    expect(distinctChoices(['Same', 'Same', 'Same', 'Same'])).toBe(false);
  });

  it('rejects choices that differ only by case or whitespace', () => {
    expect(distinctChoices(['Alpha', ' alpha ', 'Beta', 'Gamma'])).toBe(
      false,
    );
  });

  it('handles an empty list', () => {
    expect(distinctChoices([])).toBe(true);
  });
});

describe('isBannedChoice', () => {
  it('bans all/none of the above in any case', () => {
    expect(isBannedChoice('All of the above')).toBe(true);
    expect(isBannedChoice('NONE OF THE ABOVE')).toBe(true);
  });

  it('allows a normal clinical option', () => {
    expect(isBannedChoice('Oral rehydration solution')).toBe(false);
  });
});
