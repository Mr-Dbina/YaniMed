/**
 * Stem polarity. The verifier is polarity-blind: it judges every choice as a
 * plain claim and never applies NOT/EXCEPT itself. Code applies the inversion,
 * so this detector must be deterministic and conservative.
 *
 * Detection rules, applied to the lead-in and the stem:
 *
 * 1. Strong markers anywhere: whole-word EXCEPT (any case), whole-word
 *    uppercase NOT, whole-word uppercase FALSE, uppercase LEAST with "likely",
 *    whole-word "incorrect" (any case), the phrase "false statement" (any
 *    case). Any one of these makes the stem NEGATED.
 *    Lowercase bare "not" and "false" are ignored: they are far more often
 *    ordinary prose than a negated question.
 * 2. Weak markers ("does not", "is not", any case) count only inside an
 *    interrogative sentence, that is a sentence ending in "?". A declarative
 *    "Metformin is not first-line." in a vignette is context, not a question.
 *
 * The detector never looks at the choices or the key.
 */
export type StemPolarity = 'NORMAL' | 'NEGATED';

/** Lowercase "except" is included on purpose: it is almost always a negator. */
const EXCEPT = /\bexcept\b/i;
const UPPERCASE_MARKER = /\b(?:NOT|FALSE)\b/;
const INCORRECT = /\bincorrect\b/i;
const FALSE_STATEMENT = /\bfalse statement\b/i;
const WEAK_MARKER = /\b(?:does not|is not)\b/i;

/** Splits on sentence enders, keeping the ender with its sentence. */
const SENTENCE_SPLIT = /(?<=[.!?])\s+/;

function hasLeastLikely(text: string): boolean {
  // Uppercase LEAST only; "likely" follows somewhere in the text.
  return /\bLEAST\b/.test(text) && /\blikely\b/i.test(text);
}

function hasWeakMarkerInQuestion(text: string): boolean {
  return text
    .split(SENTENCE_SPLIT)
    .some((sentence) => sentence.trim().endsWith('?') && WEAK_MARKER.test(sentence));
}

export function detectPolarity(
  stem: string,
  leadIn: string | null,
): StemPolarity {
  const text = [leadIn ?? '', stem].filter((part) => part.trim() !== '').join('\n');

  if (
    EXCEPT.test(text) ||
    UPPERCASE_MARKER.test(text) ||
    INCORRECT.test(text) ||
    FALSE_STATEMENT.test(text) ||
    hasLeastLikely(text)
  ) {
    return 'NEGATED';
  }

  return hasWeakMarkerInQuestion(text) ? 'NEGATED' : 'NORMAL';
}
