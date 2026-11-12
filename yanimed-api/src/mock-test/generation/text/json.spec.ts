import { describe, expect, it } from 'vitest';
import { extractJsonObject } from './json.js';

describe('extractJsonObject', () => {
  it('returns a plain object unchanged', () => {
    expect(extractJsonObject('{"a":1}')).toBe('{"a":1}');
  });

  it('strips a markdown fence', () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('ignores prose around the object', () => {
    expect(extractJsonObject('Here it is: {"a":{"b":2}} done')).toBe(
      '{"a":{"b":2}}',
    );
  });

  it('keeps nested braces', () => {
    expect(extractJsonObject('{"a":{"b":{"c":3}}}')).toBe(
      '{"a":{"b":{"c":3}}}',
    );
  });

  it('throws when no object is present', () => {
    expect(() => extractJsonObject('')).toThrow();
    expect(() => extractJsonObject('no json here')).toThrow();
    expect(() => extractJsonObject('{unbalanced')).toThrow();
  });
});
