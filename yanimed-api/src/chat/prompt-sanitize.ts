const CONTROL_EXCEPT_NEWLINE_TAB = /[\u0000-\u0008\u000B-\u001F\u007F]/g;
const QUOTE_RUN = /"{3,}/g;
const SOURCE_MARKER = /\[\s*[Ss]\s*\d[^\]]*\]/g;
const TITLE_REMOVED = /["\[\]`\u0000-\u0008\u000B-\u001F\u007F]/g;

function replaceQuoteRuns(value: string): string {
  return value.replace(QUOTE_RUN, (quotes) => "'".repeat(quotes.length));
}

export function sanitizePassageText(text: string): string {
  const value = typeof text === 'string' ? text : '';
  return replaceQuoteRuns(
    value
      .replace(CONTROL_EXCEPT_NEWLINE_TAB, '')
      .replace(SOURCE_MARKER, (marker) => `(${marker.slice(1, -1)})`),
  );
}

export function sanitizeTitle(title: string | null | undefined): string {
  const sanitized = (title ?? '')
    .replace(/\s+/g, ' ')
    .replace(TITLE_REMOVED, '')
    .trim()
    .slice(0, 120)
    .trim();
  return sanitized || 'Untitled document';
}

export function sanitizeQuestion(text: string): string {
  const value = typeof text === 'string' ? text : '';
  return replaceQuoteRuns(value.replace(CONTROL_EXCEPT_NEWLINE_TAB, ''));
}
