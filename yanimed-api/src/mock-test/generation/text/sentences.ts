/**
 * Sentence counter that tolerates common medical abbreviations, initials and
 * decimals. A stem must be 1 to 6 sentences, so this stays deliberately
 * conservative rather than clever.
 */
export function countSentences(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;

  const protectedText = trimmed
    .replace(
      /\b(?:Dr|Mr|Mrs|Ms|Prof|Sr|Jr|St|vs|etc|approx|No|Fig|Ph\.D|M\.D|U\.S|B\.S)\./gi,
      (match) => match.replace(/\./g, '\u0001'),
    )
    .replace(/\b(?:[A-Za-z]\.){2,}/g, (match) =>
      match.replace(/\./g, '\u0001'),
    )
    .replace(/\b[A-Z]\.(?=\s+[A-Z])/g, (match) =>
      match.replace(/\./g, '\u0001'),
    )
    .replace(/(\d)\.(\d)/g, '$1\u0001$2');

  return protectedText
    .split(/[.!?]+(?=\s|$)/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0).length;
}
