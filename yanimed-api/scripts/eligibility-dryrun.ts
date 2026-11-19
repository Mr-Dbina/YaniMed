/// <reference types="node" />
import '../src/config/load-local-env.js';
import { PrismaClient } from '@prisma/client';
import {
  classifyChunks,
  type ChunkInput,
} from '../src/mock-test/generation/plan/eligibility.js';
import { FRONT_MATTER_SCAN_PAGES } from '../src/mock-test/generation/generation.constants.js';

/**
 * Read-only eligibility diagnostic for one document and pages 1-20. It prints
 * counts, rule labels and fixed-vocabulary keywords only. It never prints chunk
 * text, document text, titles, filenames, env values, or connection URLs.
 *
 *   npx tsx scripts/eligibility-dryrun.ts
 *
 * The rule checks below are copied from classifyFrontMatter because the
 * classifier does not export its private vocabulary. Keep them in sync.
 */

const TARGET_DOCUMENT_ID = '558f5a14-c860-4e5a-b2e0-2aabfca340f3';
const TARGET_PAGE_MIN = 1;
const TARGET_PAGE_MAX = 20;

const ADMIN_HEADINGS = [
  'table of contents',
  'acknowledgements',
  'acknowledgments',
  'contributing authors',
  'list of contributors',
  'editorial board',
  'acknowledgement',
  'acknowledgment',
  'title page',
  'contributors',
  'dedication',
  'copyright',
  'contents',
  'preface',
  'foreword',
  'editors',
] as const;

const SENTENCE_CONTINUATIONS = new Set([
  'of',
  'the',
  'a',
  'an',
  'in',
  'on',
  'at',
  'was',
  'were',
  'is',
  'are',
  'has',
  'have',
  'had',
  'contain',
  'contains',
  'include',
  'includes',
  'consist',
  'consists',
]);

const CREDENTIAL_TOKEN =
  /\b(?:MBBS|MSc|MSN|MHS|PhD|MPH|FAAP|MD|MS|DO|RN)\b/gi;
const AFFILIATION_MARKER =
  /\b(?:University|Hospital|Department of|School of Medicine|Professor|Editor|Chief)\b/gi;

type RuleName = 'a' | 'b' | 'c';

interface RuleMatch {
  rule: RuleName;
  keyword?: string;
  marker?: string;
}

interface DocumentRow {
  id: string;
}

interface ChunkRow {
  content: string;
  page: number | null;
  chunkIndex: number;
  needsReview: boolean;
}

const prisma = new PrismaClient();

function countTokens(text: string, pattern: RegExp): number {
  return (text.match(pattern) ?? []).length;
}

function stripFrontMatterLead(text: string): string {
  let rest = text.trimStart();
  for (;;) {
    const before = rest;
    rest = rest
      .replace(
        /^(?:chapter|section|part)\b[\s.:)]*(?:[0-9]+|[ivxlcdm]+)?[\s.:)]*/i,
        '',
      )
      .replace(/^[^A-Za-z]+/, '');
    if (rest === before) return rest;
  }
}

function matchAdminHeading(text: string): string | null {
  const stripped = stripFrontMatterLead(text);
  const lower = stripped.toLowerCase();

  for (const heading of ADMIN_HEADINGS) {
    if (!lower.startsWith(heading)) continue;

    const after = stripped.slice(heading.length);
    if (after !== '' && /\p{L}/u.test(after[0])) continue;

    const nextWord = /^[^\p{L}]*([\p{L}]+)/u.exec(after)?.[1];
    if (
      nextWord !== undefined &&
      nextWord[0] === nextWord[0].toLowerCase() &&
      SENTENCE_CONTINUATIONS.has(nextWord.toLowerCase())
    ) {
      continue;
    }
    return heading;
  }
  return null;
}

function matchPublisherMarker(text: string): string | null {
  if (/\bisbn\b/i.test(text)) return 'isbn';
  if (/all rights reserved/i.test(text)) return 'all rights reserved';
  if (/library of congress/i.test(text)) return 'library of congress';
  if (/printed in the united states/i.test(text)) {
    return 'printed in the united states';
  }
  if (/\u00a9\s*(?:19|20)\d{2}/u.test(text)) return 'copyright-symbol-year';
  return null;
}

function isCredentialDense(text: string): boolean {
  const credentials = countTokens(text, CREDENTIAL_TOKEN);
  if (credentials >= 6) return true;
  if (credentials < 3) return false;
  return countTokens(text, AFFILIATION_MARKER) >= 3;
}

function frontMatterRule(
  text: string,
  firstPage: number | null | undefined,
): RuleMatch | null {
  if (firstPage === null || firstPage === undefined) return null;
  if (
    !Number.isInteger(firstPage) ||
    firstPage < 1 ||
    firstPage > FRONT_MATTER_SCAN_PAGES
  ) {
    return null;
  }

  const flat = text.replace(/\s+/g, ' ').trim();
  const keyword = matchAdminHeading(flat);
  if (keyword !== null) return { rule: 'a', keyword };

  const marker = matchPublisherMarker(flat);
  if (marker !== null) return { rule: 'b', marker };

  if (isCredentialDense(flat)) return { rule: 'c' };
  return null;
}

function toChunkInput(documentId: string, row: ChunkRow): ChunkInput {
  return {
    documentId,
    content: row.content,
    page: row.page ?? 0,
    chunkIndex: row.chunkIndex,
    needsReview: row.needsReview,
  };
}

function formatRule(
  reason: string | undefined,
  rule: RuleMatch | null,
): string {
  if (reason !== 'front-matter' || rule === null) return 'rule=none';
  if (rule.rule === 'a') return `rule=a keyword=${rule.keyword ?? 'none'}`;
  if (rule.rule === 'b') return `rule=b marker=${rule.marker ?? 'none'}`;
  return 'rule=c';
}

async function loadDocument(): Promise<DocumentRow | null> {
  const documents = await prisma.document.findMany({
    where: { id: TARGET_DOCUMENT_ID },
    select: { id: true },
    take: 1,
  });
  return documents[0] ?? null;
}

async function loadChunks(documentId: string): Promise<ChunkRow[]> {
  return prisma.chunk.findMany({
    where: {
      documentId,
      page: { gte: TARGET_PAGE_MIN, lte: TARGET_PAGE_MAX },
    },
    select: {
      content: true,
      page: true,
      chunkIndex: true,
      needsReview: true,
    },
    orderBy: [{ page: 'asc' }, { chunkIndex: 'asc' }],
  });
}

function printDocument(document: DocumentRow, rows: readonly ChunkRow[]): void {
  const classified = classifyChunks(
    rows.map((row) => toChunkInput(document.id, row)),
  );

  console.log(`document ${document.id}`);
  for (const result of classified) {
    const page = result.chunk.page;
    if (page < TARGET_PAGE_MIN || page > TARGET_PAGE_MAX) continue;

    const rule = frontMatterRule(result.chunk.content, page);
    console.log(
      `page=${page} chunkIndex=${result.chunk.chunkIndex} ` +
        `eligible=${result.eligible ? 'yes' : 'no'} ` +
        `reason=${result.reason ?? 'none'} ` +
        formatRule(result.reason, rule),
    );
  }

  const flagged = classified.filter(
    (result) =>
      result.reason === 'front-matter' &&
      result.chunk.page >= TARGET_PAGE_MIN &&
      result.chunk.page <= TARGET_PAGE_MAX,
  );
  if (flagged.length === 0) return;

  console.log('summary');
  for (const flag of flagged) {
    const following = classified.filter(
      (result) =>
        result.chunk.page === flag.chunk.page &&
        result.chunk.chunkIndex > flag.chunk.chunkIndex,
    );
    const indexes =
      following.length === 0
        ? 'none'
        : following.map((result) => result.chunk.chunkIndex).join(',');
    const eligibility =
      following.length === 0
        ? 'none'
        : following
            .map((result) => (result.eligible ? 'yes' : 'no'))
            .join(',');
    console.log(
      `flag page=${flag.chunk.page} chunkIndex=${flag.chunk.chunkIndex} ` +
        `followingChunkIndexes=${indexes} ` +
        `followingEligible=${eligibility}`,
    );
  }
}

async function main(): Promise<void> {
  console.log('READ-ONLY DRY RUN, NO WRITES');

  const document = await loadDocument();
  if (document === null) return;

  const rows = await loadChunks(document.id);
  printDocument(document, rows);
}

main()
  .catch((error: unknown) => {
    const name = error instanceof Error ? error.name : 'UnknownError';
    console.error(`ERROR ${name}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
