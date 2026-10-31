/// <reference types="node" />
import '../src/config/load-local-env.js';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  EMBEDDING_DIMENSIONS,
  EmbeddingService,
} from '../src/embeddings/embedding.service.js';

const PREFIX = 'ZZ-ret3b-';
const CANDIDATE_LIMIT = 20;
const TARGET1 = '9bc688be-0c9b-4415-83e5-7bbb46447dd2';
const TARGET2 = '4c70afc5-9c57-4c18-afcc-112d6b2315ca';
const QUERY1 =
  'Consider advanced airway and capnography Rhythm shockable? No Yes Go to 5 Rhythm shockable?';
const QUERY2 =
  'by alt-text descriptions provided by Elsevier. For more information, see https://www. elsevier. com/about/ accessibility.';

interface SubjectRow {
  id: string;
  name: string;
  createdAt: Date;
}

interface VectorDiagRow {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  pageNumber: number;
  content: string;
  extractionMethod: string;
  score: number;
}

interface QueryCase {
  label: string;
  query: string;
  targetChunkId: string;
}

interface ClassStatRow {
  relname: string;
  reltuples: number;
  relpages: number;
}

interface TableStatRow {
  relname: string;
  last_analyze: Date | string | null;
  last_autoanalyze: Date | string | null;
  n_live_tup: bigint | number;
}

const prisma = new PrismaClient();
const embeddings = new EmbeddingService(undefined, {
  requestsPerMinute: 60,
  maxAttempts: 1,
});

let exitCode = 0;

function json(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    typeof item === 'bigint' ? item.toString() : item,
  );
}

function describeError(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

function sanitizeLiteral(value: string, literal: string): string {
  return value.split(literal).join('<vec>');
}

async function embeddingLiteral(question: string): Promise<string> {
  const vector = await embeddings.embedText(question, 'RETRIEVAL_QUERY');
  if (
    !Array.isArray(vector) ||
    vector.length !== EMBEDDING_DIMENSIONS ||
    !vector.every(
      (value) => typeof value === 'number' && Number.isFinite(value),
    )
  ) {
    throw new Error('Invalid query embedding.');
  }
  return `[${vector.join(',')}]`;
}

async function productionVectorRows(
  client: PrismaClient | Prisma.TransactionClient,
  subjectId: string,
  literal: string,
): Promise<VectorDiagRow[]> {
  return client.$queryRaw<VectorDiagRow[]>`
    SELECT c."id" AS "chunkId",
           c."documentId" AS "documentId",
           d."title" AS "documentTitle",
           c."page" AS "pageNumber",
           c."content" AS "content",
           c."extractionMethod"::text AS "extractionMethod",
           (1 - (c."embedding" <=> ${literal}::vector))::float8 AS "score"
    FROM "Chunk" c
    JOIN "Document" d ON d."id" = c."documentId"
    WHERE d."subjectId" = ${subjectId}
      AND d."status" = 'READY'
      AND c."embedding" IS NOT NULL
    ORDER BY c."embedding" <=> ${literal}::vector ASC, c."id" ASC
    LIMIT ${CANDIDATE_LIMIT}
  `;
}

function planLines(rows: Array<Record<string, unknown>>): string[] {
  return rows.map((row) =>
    Object.values(row)
      .map((value) => String(value))
      .join(' | '),
  );
}

function present(rows: VectorDiagRow[], targetChunkId: string): boolean {
  return rows.some((row) => row.chunkId === targetChunkId);
}

async function printStats(
  tx: Prisma.TransactionClient,
  literal: string,
): Promise<void> {
  try {
    const classStats = await tx.$queryRaw<ClassStatRow[]>`
      SELECT relname, reltuples, relpages
      FROM pg_class
      WHERE relname IN ('Chunk', 'Document', 'chunk_embedding_idx')
      ORDER BY relname
    `;
    console.log(`(h5) pg_class rows=${classStats.length}`);
    for (const row of classStats) {
      console.log(`  ${json(row)}`);
    }
  } catch (error) {
    console.log(
      `(h5) pg_class ERROR ${sanitizeLiteral(describeError(error), literal)}`,
    );
  }

  try {
    const tableStats = await tx.$queryRaw<TableStatRow[]>`
      SELECT relname, last_analyze, last_autoanalyze, n_live_tup
      FROM pg_stat_user_tables
      WHERE relname IN ('Chunk', 'Document')
      ORDER BY relname
    `;
    console.log(`(h5) pg_stat_user_tables rows=${tableStats.length}`);
    for (const row of tableStats) {
      console.log(`  ${json(row)}`);
    }
  } catch (error) {
    console.log(
      `(h5) pg_stat_user_tables ERROR ${sanitizeLiteral(describeError(error), literal)}`,
    );
  }
}

async function diagnoseQuery(
  subject: SubjectRow,
  queryCase: QueryCase,
): Promise<void> {
  console.log(`\n=== ${queryCase.label} ===`);
  console.log(`query=${queryCase.query}`);
  console.log(`targetChunkId=${queryCase.targetChunkId}`);

  let literal: string | null = null;
  try {
    literal = await embeddingLiteral(queryCase.query);
    console.log('(a) embedText succeeded');
  } catch (error) {
    console.log(`(a) embedText ERROR ${describeError(error)}`);
  }

  await prisma.$transaction(async (tx) => {
    if (literal === null) {
      console.log('(h1)-(h4) skipped because embedding failed');
      await printStats(tx, '<unavailable>');
      return;
    }

    const queryLiteral = literal;
    await tx.$executeRawUnsafe('SET LOCAL enable_sort = off');
    try {
      const plan = await tx.$queryRaw<Array<Record<string, unknown>>>`
        EXPLAIN
        SELECT c."id" AS "chunkId",
               c."documentId" AS "documentId",
               d."title" AS "documentTitle",
               c."page" AS "pageNumber",
               c."content" AS "content",
               c."extractionMethod"::text AS "extractionMethod",
               (1 - (c."embedding" <=> ${queryLiteral}::vector))::float8 AS "score"
        FROM "Chunk" c
        JOIN "Document" d ON d."id" = c."documentId"
        WHERE d."subjectId" = ${subject.id}
          AND d."status" = 'READY'
          AND c."embedding" IS NOT NULL
        ORDER BY c."embedding" <=> ${queryLiteral}::vector ASC, c."id" ASC
        LIMIT ${CANDIDATE_LIMIT}
      `;
      const lines = planLines(plan).map((line) =>
        sanitizeLiteral(line, queryLiteral),
      );
      console.log('(h1) EXPLAIN with SET LOCAL enable_sort = off');
      for (const line of lines) {
        console.log(`  ${line}`);
      }
      console.log(
        `(h1) usesChunkEmbeddingIdx=${lines.some((line) => line.includes('chunk_embedding_idx'))}`,
      );
    } catch (error) {
      console.log(
        `(h1) EXPLAIN ERROR ${sanitizeLiteral(describeError(error), queryLiteral)}`,
      );
    }

    for (const probes of [1, 10, 100] as const) {
      const label = probes === 1 ? 'h2' : probes === 10 ? 'h3' : 'h4';
      try {
        await tx.$executeRawUnsafe(
          `SET LOCAL ivfflat.probes = ${probes}`,
        );
        const rows = await productionVectorRows(
          tx,
          subject.id,
          queryLiteral,
        );
        console.log(
          `(${label}) probes=${probes} rows=${rows.length} targetPresent=${present(rows, queryCase.targetChunkId)}`,
        );
      } catch (error) {
        console.log(
          `(${label}) probes=${probes} ERROR ${sanitizeLiteral(describeError(error), queryLiteral)}`,
        );
      }
    }

    await printStats(tx, queryLiteral);
  });
}

async function printRetrievalTryCatchLines(): Promise<void> {
  const retrievalPath = fileURLToPath(
    new URL('../src/retrieval/retrieval.service.ts', import.meta.url),
  );
  const source = await readFile(retrievalPath, 'utf8');
  const lines = source.split(/\r?\n/);
  const matches = lines
    .map((line, index) => ({ line, number: index + 1 }))
    .filter((entry) => /catch|try/.test(entry.line));

  console.log(`\n=== retrieval.service.ts try/catch lines ===`);
  console.log(`path=${retrievalPath} matches=${matches.length}`);
  for (const entry of matches) {
    console.log(`${entry.number}: ${entry.line}`);
  }
}

async function main(): Promise<void> {
  console.log(`ZZ-diag-3b-ivf IVFFlat diagnostic (prefix ${PREFIX})`);

  const subject = await prisma.subject.findFirst({
    where: { name: { startsWith: PREFIX, endsWith: '-A' } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, name: true, createdAt: true },
  });
  if (!subject) {
    console.error(
      `NO MATCHING SUBJECT A: name startsWith "${PREFIX}" and endsWith "-A"`,
    );
    exitCode = 1;
    return;
  }
  console.log(
    `Subject A: id=${subject.id} name=${subject.name} createdAt=${subject.createdAt.toISOString()}`,
  );

  const cases: QueryCase[] = [
    { label: 'QUERY 1 airway/capnography', query: QUERY1, targetChunkId: TARGET1 },
    { label: 'QUERY 2 Elsevier alt-text', query: QUERY2, targetChunkId: TARGET2 },
  ];
  for (const queryCase of cases) {
    await diagnoseQuery(subject, queryCase);
  }

  try {
    await printRetrievalTryCatchLines();
  } catch (error) {
    exitCode = 1;
    console.log(`retrieval.service.ts read ERROR ${describeError(error)}`);
  }
}

main()
  .catch((error) => {
    exitCode = 1;
    console.error(`DIAGNOSTIC ERROR: ${describeError(error)}`);
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exitCode = exitCode;
  });
