import {
  CHOICES_PER_QUESTION,
  CHOICE_LENGTH_RATIO_MAX,
  STEM_MAX_SENTENCES,
  STEM_MIN_SENTENCES,
} from '../generation.constants.js';
import { distinctChoices, isBannedChoice } from '../text/choices.js';
import { normalizeObjective } from '../text/normalize.js';
import { countSentences } from '../text/sentences.js';
import { verifyCitation } from './citation.js';
import {
  REASON_CODES,
  type CheckAContext,
  type CheckAReason,
  type CheckAResult,
  type DraftChoice,
  type DraftCitation,
} from './types.js';

/** Catch-alls that cannot be grounded in one quote. */
const EXTRA_BANNED_CHOICES = [
  'both of the above',
  'neither of the above',
  'all of these',
  'none of these',
];

/** "A. ", "B) ", "C: " at the start of a choice. */
const LETTER_PREFIX = /^\s*[A-Da-d]\s*[.):]\s/;

const MARKUP_PATTERNS = [
  /<\s*\/?\s*[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>/i,
  /<\s*script\b/i,
  /javascript\s*:/i,
];

/** Ranges that state a span of acceptable values on one page. */
const STATED_RANGE_PATTERNS = [
  /\bbetween\s+(\d+(?:[.,]\d+)?)\s+and\s+(\d+(?:[.,]\d+)?)/gi,
  /(\d+(?:[.,]\d+)?)\s*(?:to|[-\u2013\u2014])\s*(\d+(?:[.,]\d+)?)/gi,
];

const NUMBER_TOKEN = /\d[\d,]*(?:\.\d+)?/g;

interface ParsedDraft {
  stem: string | null;
  leadIn: string | null;
  choices: DraftChoice[] | null;
  keyIndex: number | null;
  objective: string | null;
  keyExplanation: string | null;
  topicKey: string | null;
  citation: DraftCitation | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseChoices(value: unknown, invalid: string[]): DraftChoice[] | null {
  if (!Array.isArray(value)) {
    invalid.push('choices');
    return null;
  }

  const choices: DraftChoice[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!isRecord(item)) {
      invalid.push(`choices[${index}]`);
      continue;
    }
    if (typeof item.text !== 'string') {
      invalid.push(`choices[${index}].text`);
    }
    if (typeof item.explanation !== 'string') {
      invalid.push(`choices[${index}].explanation`);
    }
    if (typeof item.text === 'string' && typeof item.explanation === 'string') {
      choices.push({ text: item.text, explanation: item.explanation });
    }
  }

  return invalid.some((field) => field.startsWith('choices')) ? null : choices;
}

function parseCitation(
  value: unknown,
  invalid: string[],
): DraftCitation | null {
  if (!isRecord(value)) {
    invalid.push('citation');
    return null;
  }

  const documentId =
    typeof value.documentId === 'string' ? value.documentId : null;
  const page =
    typeof value.page === 'number' && Number.isFinite(value.page)
      ? value.page
      : null;
  const quote = typeof value.quote === 'string' ? value.quote : null;
  const printedPage =
    value.printedPage === undefined || value.printedPage === null
      ? null
      : typeof value.printedPage === 'number' &&
          Number.isFinite(value.printedPage)
        ? value.printedPage
        : undefined;

  if (documentId === null) invalid.push('citation.documentId');
  if (page === null) invalid.push('citation.page');
  if (quote === null) invalid.push('citation.quote');
  if (printedPage === undefined) invalid.push('citation.printedPage');

  if (
    documentId === null ||
    page === null ||
    quote === null ||
    printedPage === undefined
  ) {
    return null;
  }
  return { documentId, page, printedPage, quote };
}

function parseDraft(value: unknown): {
  fields: ParsedDraft;
  invalid: string[];
} {
  const invalid: string[] = [];
  const record = isRecord(value) ? value : null;
  if (!record) {
    return {
      fields: {
        stem: null,
        leadIn: null,
        choices: null,
        keyIndex: null,
        objective: null,
        keyExplanation: null,
        topicKey: null,
        citation: null,
      },
      invalid: ['draft'],
    };
  }

  const readString = (key: string): string | null => {
    const field = record[key];
    if (typeof field === 'string') return field;
    invalid.push(key);
    return null;
  };

  const stem = readString('stem');
  const objective = readString('objective');
  const keyExplanation = readString('keyExplanation');
  const topicKey = readString('topicKey');

  const leadInRaw = record.leadIn;
  const leadIn =
    leadInRaw === undefined || leadInRaw === null
      ? null
      : typeof leadInRaw === 'string'
        ? leadInRaw
        : null;
  if (
    leadInRaw !== undefined &&
    leadInRaw !== null &&
    typeof leadInRaw !== 'string'
  ) {
    invalid.push('leadIn');
  }

  const keyIndexRaw = record.keyIndex;
  const keyIndex =
    typeof keyIndexRaw === 'number' && Number.isFinite(keyIndexRaw)
      ? keyIndexRaw
      : null;
  if (keyIndex === null) invalid.push('keyIndex');

  return {
    fields: {
      stem,
      leadIn,
      choices: parseChoices(record.choices, invalid),
      keyIndex,
      objective,
      keyExplanation,
      topicKey,
      citation: parseCitation(record.citation, invalid),
    },
    invalid,
  };
}

function isBanned(text: string): boolean {
  if (isBannedChoice(text)) return true;
  const normalized = normalizeObjective(text);
  return EXTRA_BANNED_CHOICES.some((phrase) => normalized.includes(phrase));
}

function hasMarkup(text: string): boolean {
  return MARKUP_PATTERNS.some((pattern) => pattern.test(text));
}

function parseNumberToken(token: string): number | null {
  if (/^\d{1,3}(?:,\d{3})+$/.test(token)) {
    return Number(token.replace(/,/g, ''));
  }
  if (/^\d+,\d+$/.test(token)) return Number(token.replace(',', '.'));
  if (token.includes(',')) return null;
  const value = Number(token);
  return Number.isFinite(value) ? value : null;
}

function numbersIn(text: string): number[] {
  const numbers: number[] = [];
  for (const match of text.matchAll(NUMBER_TOKEN)) {
    const parsed = parseNumberToken(match[0]);
    if (parsed !== null) numbers.push(parsed);
  }
  return numbers;
}

function statedRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const pattern of STATED_RANGE_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const first = parseNumberToken(match[1]);
      const second = parseNumberToken(match[2]);
      if (first === null || second === null) continue;
      ranges.push([Math.min(first, second), Math.max(first, second)]);
    }
  }
  return ranges;
}

/**
 * M2 defect Q14: four choices that all sit inside one range on the cited page
 * give no defensible key. Conservative heuristic: every choice must carry a
 * number, and one stated range on the page must enclose all of them.
 */
function allChoicesInStatedRange(
  choices: readonly DraftChoice[],
  pageText: string,
): boolean {
  const perChoice = choices.map((choice) => numbersIn(choice.text));
  if (perChoice.some((numbers) => numbers.length === 0)) return false;

  const all = perChoice.flat();
  return statedRanges(pageText).some(
    ([low, high]) =>
      low !== high && all.every((value) => value >= low && value <= high),
  );
}

function choiceIndices(choices: readonly DraftChoice[]): number[] {
  return [...choices.keys()];
}

function choiceLabels(indices: readonly number[]): string[] {
  return indices.map((index) => `choices[${index}]`);
}

/**
 * Check A: deterministic validation of one drafted question. Pure; the page
 * reader is injected through CheckAContext. All reasons are collected.
 */
export function validateDraft(
  draft: unknown,
  ctx: CheckAContext,
): CheckAResult {
  const { fields, invalid } = parseDraft(draft);
  const reasons: CheckAReason[] = [];
  if (invalid.length > 0) {
    reasons.push({
      code: REASON_CODES.SCHEMA_INVALID,
      detail: invalid.join(', '),
    });
  }

  if (fields.stem !== null) {
    const sentenceCount = countSentences(fields.stem);
    if (
      sentenceCount < STEM_MIN_SENTENCES ||
      sentenceCount > STEM_MAX_SENTENCES
    ) {
      reasons.push({
        code: REASON_CODES.STEM_SENTENCE_COUNT,
        detail: `${sentenceCount} sentences`,
      });
    }
  }

  const choices = fields.choices;
  const texts = choices?.map((choice) => choice.text) ?? [];

  if (choices !== null && choices.length !== CHOICES_PER_QUESTION) {
    reasons.push({
      code: REASON_CODES.CHOICES_NOT_FOUR,
      detail: `${choices.length} choices`,
    });
  }

  if (choices !== null && choices.length === CHOICES_PER_QUESTION) {
    if (!distinctChoices(texts)) {
      reasons.push({ code: REASON_CODES.CHOICES_NOT_DISTINCT });
    }
  }

  if (choices !== null) {
    const indices = choiceIndices(choices);
    const prefixed = indices.filter((index) =>
      LETTER_PREFIX.test(choices[index].text),
    );
    if (prefixed.length > 0) {
      reasons.push({
        code: REASON_CODES.LETTER_PREFIX,
        detail: choiceLabels(prefixed).join(', '),
      });
    }

    const banned = indices.filter((index) => isBanned(choices[index].text));
    if (banned.length > 0) {
      reasons.push({
        code: REASON_CODES.CHOICE_BANNED,
        detail: choiceLabels(banned).join(', '),
      });
    }

    const lengths = choices
      .map((choice) => choice.text.trim().length)
      .filter((length) => length >= 4);
    if (lengths.length > 0) {
      const longest = Math.max(...lengths);
      const shortest = Math.min(...lengths);
      if (longest > shortest * CHOICE_LENGTH_RATIO_MAX) {
        reasons.push({
          code: REASON_CODES.CHOICE_LENGTH_UNEVEN,
          detail: `${longest} vs ${shortest} chars`,
        });
      }
    }

    const missing = choiceIndices(choices)
      .filter((index) => choices[index].explanation.trim() === '')
      .map((index) => `choices[${index}].explanation`);
    if (fields.keyExplanation !== null && fields.keyExplanation.trim() === '') {
      missing.push('keyExplanation');
    }
    if (missing.length > 0) {
      reasons.push({
        code: REASON_CODES.EXPLANATION_MISSING,
        detail: missing.join(', '),
      });
    }
  }

  if (
    fields.keyIndex !== null &&
    (!Number.isInteger(fields.keyIndex) ||
      fields.keyIndex < 0 ||
      fields.keyIndex >= CHOICES_PER_QUESTION)
  ) {
    reasons.push({
      code: REASON_CODES.KEY_INDEX_INVALID,
      detail: String(fields.keyIndex),
    });
  }

  if (fields.topicKey !== null && !ctx.topicKeys.has(fields.topicKey.trim())) {
    reasons.push({ code: REASON_CODES.TOPIC_UNKNOWN });
  }

  if (fields.objective !== null && fields.objective.trim() === '') {
    reasons.push({ code: REASON_CODES.OBJECTIVE_MISSING });
  }

  const markupFields: string[] = [];
  const markupTargets: Array<[string, string | null]> = [
    ['stem', fields.stem],
    ['leadIn', fields.leadIn],
    ['objective', fields.objective],
    ['keyExplanation', fields.keyExplanation],
  ];
  if (choices !== null) {
    for (const [index, choice] of choices.entries()) {
      markupTargets.push([`choices[${index}].text`, choice.text]);
      markupTargets.push([`choices[${index}].explanation`, choice.explanation]);
    }
  }
  for (const [label, text] of markupTargets) {
    if (text !== null && text !== '' && hasMarkup(text)) {
      markupFields.push(label);
    }
  }
  if (markupFields.length > 0) {
    reasons.push({
      code: REASON_CODES.MARKUP_DETECTED,
      detail: markupFields.join(', '),
    });
  }

  if (fields.citation !== null) {
    reasons.push(...verifyCitation(fields.citation, ctx).reasons);

    const document = ctx.documents.get(fields.citation.documentId);
    const page =
      document &&
      Number.isInteger(fields.citation.page) &&
      fields.citation.page >= 1 &&
      fields.citation.page <= document.pageCount
        ? ctx.getPage(fields.citation.documentId, fields.citation.page)
        : null;

    if (
      choices !== null &&
      choices.length === CHOICES_PER_QUESTION &&
      page &&
      page.text.trim() !== '' &&
      allChoicesInStatedRange(choices, page.text)
    ) {
      reasons.push({ code: REASON_CODES.CHOICES_ALL_IN_STATED_RANGE });
    }
  }

  if (reasons.length > 0) return { ok: false, reasons };

  return {
    ok: true,
    draft: {
      stem: (fields.stem ?? '').trim(),
      leadIn:
        fields.leadIn === null || fields.leadIn.trim() === ''
          ? null
          : fields.leadIn.trim(),
      choices: (fields.choices ?? []).map((choice) => ({
        text: choice.text.trim(),
        explanation: choice.explanation.trim(),
      })),
      keyIndex: fields.keyIndex ?? 0,
      objective: (fields.objective ?? '').trim(),
      keyExplanation: (fields.keyExplanation ?? '').trim(),
      topicKey: (fields.topicKey ?? '').trim(),
      citation: {
        documentId: (fields.citation?.documentId ?? '').trim(),
        page: fields.citation?.page ?? 0,
        printedPage: fields.citation?.printedPage ?? null,
        quote: (fields.citation?.quote ?? '').trim(),
      },
    },
  };
}
