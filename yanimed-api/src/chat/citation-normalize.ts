const FULLWIDTH_CITATION = /(?:【\s*(S\d+)\s*】|［\s*(S\d+)\s*］)/g;

export function normalizeCitationBrackets(content: string): string {
  return content.replace(
    FULLWIDTH_CITATION,
    (_match, lenticular: string | undefined, square: string | undefined) => `[${lenticular ?? square}]`,
  );
}
