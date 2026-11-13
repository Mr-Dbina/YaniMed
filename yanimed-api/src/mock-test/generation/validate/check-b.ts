import type { GenerationAiService } from '../ai/generation-ai.service.js';
import { fuzzyQuoteSimilarity } from '../text/similarity.js';
import { detectPolarity, type StemPolarity } from './stem-polarity.js';
import {
  buildVerifierMessages,
  parseVerifierResponse,
  type VerifierResponse,
  type VerifierVerdict,
  type VerifierVerdictEntry,
} from './verifier-prompt.js';
import {
  REASON_CODES,
  type CheckBReason,
  type DraftQuestion,
} from './types.js';

/** Verdict quotes are always checked at 0.90, even on OCR pages. */
export const VERIFIER_QUOTE_MATCH = 0.9;

/** One VERIFY call plus one retry when the output cannot be parsed. */
const MAX_VERIFIER_CALLS = 2;

export type CheckBResult =
  | {
      ok: true;
      polarity: StemPolarity;
      /** Effective verdicts, after unverified quotes were downgraded. */
      verdicts: VerifierVerdictEntry[];
    }
  | { ok: false; polarity: StemPolarity; reasons: CheckBReason[] };

export interface VerifyDraftOptions {
  jobId: string;
  subjectId?: string;
  signal?: AbortSignal;
}

/**
 * The one place the polarity inversion lives. Returns the indices whose
 * verdict breaks the product rule:
 * - NORMAL: keyed choice SUPPORTED, every other choice not SUPPORTED.
 * - NEGATED: keyed choice CONTRADICTED, every other choice SUPPORTED.
 */
export function mismatchedVerdicts(
  polarity: StemPolarity,
  keyIndex: number,
  verdicts: readonly VerifierVerdict[],
): number[] {
  const expectedKey: VerifierVerdict =
    polarity === 'NEGATED' ? 'CONTRADICTED' : 'SUPPORTED';

  const mismatched: number[] = [];
  for (let index = 0; index < verdicts.length; index += 1) {
    const verdict = verdicts[index];
    const ok =
      index === keyIndex
        ? verdict === expectedKey
        : polarity === 'NEGATED'
          ? verdict === 'SUPPORTED'
          : verdict !== 'SUPPORTED';
    if (!ok) mismatched.push(index);
  }
  return mismatched;
}

function choiceLabels(indices: readonly number[]): string {
  return indices.map((index) => `choices[${index}]`).join(', ');
}

/**
 * Check B: a second model re-derives the answer from the cited page only. The
 * key, the explanations, the objective and the topic never reach it. Budget,
 * breaker, timeout and configuration errors from complete() propagate: they
 * are job failures, not draft rejections.
 */
export async function verifyDraft(
  draft: DraftQuestion,
  pageText: string,
  ai: Pick<GenerationAiService, 'complete'>,
  opts: VerifyDraftOptions,
): Promise<CheckBResult> {
  const polarity = detectPolarity(draft.stem, draft.leadIn);
  const messages = buildVerifierMessages({
    stem: draft.stem,
    leadIn: draft.leadIn,
    choices: draft.choices.map((choice) => choice.text),
    pageText,
  });

  let parsed: VerifierResponse | null = null;
  for (let attempt = 0; attempt < MAX_VERIFIER_CALLS && parsed === null; attempt += 1) {
    const result = await ai.complete({
      purpose: 'VERIFY',
      jobId: opts.jobId,
      subjectId: opts.subjectId,
      messages,
      temperature: 0,
      jsonMode: true,
      signal: opts.signal,
    });
    try {
      parsed = parseVerifierResponse(result.text);
    } catch {
      parsed = null;
    }
  }

  if (parsed === null) {
    return {
      ok: false,
      polarity,
      reasons: [{ code: REASON_CODES.VERIFIER_INVALID_OUTPUT }],
    };
  }

  const reasons: CheckBReason[] = [];
  const unverified: number[] = [];
  const verdicts: VerifierVerdictEntry[] = parsed.verdicts.map((entry) => {
    const quote = entry.quote.trim();
    const needsQuote =
      entry.verdict === 'SUPPORTED' || entry.verdict === 'CONTRADICTED';
    const verified =
      !needsQuote ||
      (quote !== '' &&
        fuzzyQuoteSimilarity(pageText, quote) >= VERIFIER_QUOTE_MATCH);

    if (verified) return { index: entry.index, verdict: entry.verdict, quote };
    unverified.push(entry.index);
    return { index: entry.index, verdict: 'NOT_ADDRESSED', quote };
  });

  if (unverified.length > 0) {
    reasons.push({
      code: REASON_CODES.VERIFIER_QUOTE_UNVERIFIED,
      detail: choiceLabels(unverified),
    });
  }

  const mismatched = mismatchedVerdicts(
    polarity,
    draft.keyIndex,
    verdicts.map((entry) => entry.verdict),
  );
  if (mismatched.length > 0) {
    reasons.push({
      code: REASON_CODES.VERIFIER_KEY_MISMATCH,
      detail: choiceLabels(mismatched),
    });
  }

  if (parsed.needsOutsideKnowledge) {
    reasons.push({ code: REASON_CODES.VERIFIER_OUTSIDE_KNOWLEDGE });
  }
  if (parsed.ambiguous) {
    reasons.push({ code: REASON_CODES.VERIFIER_AMBIGUOUS });
  }

  if (reasons.length > 0) return { ok: false, polarity, reasons };
  return { ok: true, polarity, verdicts };
}
