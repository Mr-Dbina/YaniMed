function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fenced ? fenced[1].trim() : trimmed;
}

/** Index of the brace that closes the object opened at `start`, or -1. */
function balancedEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/**
 * Extracts the first balanced JSON object from a model response. Markdown
 * fences and surrounding prose are tolerated; a reply without a balanced
 * object falls back to the outermost braces, so the caller can count it as a
 * rejected draft.
 */
export function extractJsonObject(text: string): string {
  const stripped = stripJsonFence(text);
  for (
    let start = stripped.indexOf('{');
    start !== -1;
    start = stripped.indexOf('{', start + 1)
  ) {
    const end = balancedEnd(stripped, start);
    if (end !== -1) return stripped.slice(start, end + 1);
  }

  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('No JSON object found in model response.');
  }
  return stripped.slice(start, end + 1);
}
