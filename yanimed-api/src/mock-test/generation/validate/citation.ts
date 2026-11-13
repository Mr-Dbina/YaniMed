import {
  CITATION_QUOTE_MATCH,
  CITATION_QUOTE_MATCH_OCR,
} from '../generation.constants.js';
import { fuzzyQuoteSimilarity } from '../text/similarity.js';
import {
  REASON_CODES,
  type CheckAContext,
  type CitationCheckResult,
  type DraftCitation,
} from './types.js';

/**
 * Three checks, cheapest first: the document is in the job snapshot, the page
 * exists in that document, and the quote is on that page. The quote match is
 * the existing page-capped bigram-Dice window.
 */
export function verifyCitation(
  citation: DraftCitation,
  ctx: CheckAContext,
): CitationCheckResult {
  const document = ctx.documents.get(citation.documentId);
  if (!document) {
    return {
      ok: false,
      similarity: 0,
      thresholdUsed: CITATION_QUOTE_MATCH,
      reasons: [{ code: REASON_CODES.CITATION_DOCUMENT_NOT_IN_SNAPSHOT }],
    };
  }

  if (
    !Number.isInteger(citation.page) ||
    citation.page < 1 ||
    citation.page > document.pageCount
  ) {
    return {
      ok: false,
      similarity: 0,
      thresholdUsed: CITATION_QUOTE_MATCH,
      reasons: [
        {
          code: REASON_CODES.CITATION_PAGE_OUT_OF_RANGE,
          detail: `page ${citation.page} of ${document.pageCount}`,
        },
      ],
    };
  }

  const page = ctx.getPage(citation.documentId, citation.page);
  if (!page || page.text.trim().length === 0) {
    return {
      ok: false,
      similarity: 0,
      thresholdUsed: CITATION_QUOTE_MATCH,
      reasons: [{ code: REASON_CODES.CITATION_PAGE_MISSING }],
    };
  }

  const thresholdUsed = page.needsOcr
    ? CITATION_QUOTE_MATCH_OCR
    : CITATION_QUOTE_MATCH;
  const similarity = fuzzyQuoteSimilarity(page.text, citation.quote);
  if (similarity >= thresholdUsed) {
    return { ok: true, similarity, thresholdUsed, reasons: [] };
  }

  return {
    ok: false,
    similarity,
    thresholdUsed,
    reasons: [
      {
        code: REASON_CODES.CITATION_QUOTE_NOT_FOUND,
        detail: `similarity ${similarity.toFixed(2)} below ${thresholdUsed}`,
      },
    ],
  };
}
