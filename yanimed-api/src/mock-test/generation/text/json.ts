function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fenced ? fenced[1].trim() : trimmed;
}

/**
 * Extracts the outermost JSON object from a model response. Markdown fences
 * and surrounding prose are tolerated; anything without a balanced-looking
 * object throws, so the caller can count it as a rejected draft.
 */
export function extractJsonObject(text: string): string {
  const stripped = stripJsonFence(text);
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('No JSON object found in model response.');
  }
  return stripped.slice(start, end + 1);
}
