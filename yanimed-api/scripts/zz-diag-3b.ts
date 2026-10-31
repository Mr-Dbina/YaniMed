/// <reference types="node" />
import '../src/config/load-local-env.js';
import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  EMBEDDING_DIMENSIONS,
  EmbeddingService,
} from '../src/embeddings/embedding.service.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import {
  RetrievalService,
  type RetrievalResult,
} from '../src/retrieval/retrieval.service.js';

const PREFIX = 'ZZ-ret3b-';
const DIAGNOSTIC_ID = randomUUID();
const CANDIDATE_LIMIT = 20;
const TARGET1 = '9bc688be-0c9b-4415-83e5-7bbb46447dd2';
const TARGET2 = '4c70afc5-9c57-4c18-afcc-112d6b2315ca';
const QUERY1 =
  'Consider advanced airway and capnography Rhythm shockable? No Yes Go to 5 Rhythm shockable?';
const QUERY2 =
  'by alt-text descriptions provided by Elsevier. For more information, see https://www. elsevier. com/about/ accessibility.';

const VECTOR_SQL_EXACT = [
  'SELECT c."id" AS "chunkId",',
  '       c."documentId" AS "documentId",',
  '       d."title" AS "documentTitle",',
  '       c."page" AS "pageNumber",',
  '       c."content" AS "content",',
  '       c."extractionMethod"::text AS "extractionMethod",',
  '       (1 - (c."embedding" <=> ${literal}::vector))::float8 AS "score"',
  'FROM "Chunk" c',
  'JOIN "Document" d ON d."id" = c."documentId"',
  'WHERE d."subjectId" = ${subjectId}',
  '  AND d."status" = \'READY\'',
  '  AND c."embedding" IS NOT NULL',
  'ORDER BY c."embedding" <=> ${literal}::vector ASC, c."id" ASC',
  'LIMIT ${candidateLimit}',
].join('\n');

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

interface CosineRow {
  chunkId: string;
  pageNumber: number;
  score: number | null;
}

interface QueryCase {
  label: string;
  query: string;
  targetChunkId: string;
}

const prisma = new PrismaClient();
const embeddings = new EmbeddingService(undefined, {
  requestsPerMinute: 60,
  maxAttempts: 1,
});
const retrieval = new RetrievalService(
  prisma as unknown as PrismaService,
  embeddings,
);

let exitCode = 0;

function json(value: unknown): string {
  return JSON.stringify(value);
}

function describeError(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

function matchedByDistribution(matches: RetrievalResult['matches']): Record<string, number> {
  const distribution: Record<string, number> = {};
  for (const match of matches) {
    const key = match.matchedBy ?? 'undefined';
    distribution[key] = (distribution[key] ?? 0) + 1;
  }
  return distribution;
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

function printVectorRows(rows: VectorDiagRow[], targetChunkId: string): void {
  const target = rows.find((row) => row.chunkId === targetChunkId);
  console.log(`  rows=${rows.length} targetPresent=${target !== undefined}`);
  if (target) {
    console.log(
      `  target chunkId=${target.chunkId} page=${target.pageNumber} score=${target.score.toFixed(6)}`,
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
    const dimensions = literal.slice(1, -1).split(',').length;
    console.log(`(a) embedText succeeded dimensions=${dimensions}`);
  } catch (error) {
    console.log(`(a) embedText ERROR ${describeError(error)}`);
  }

  if (literal !== null) {
    try {
      const rows = await prisma.$queryRaw<CosineRow[]>`
        SELECT c."id" AS "chunkId",
               c."page" AS "pageNumber",
               (1 - (c."embedding" <=> ${literal}::vector))::float8 AS "score"
        FROM "Chunk" c
        JOIN "Document" d ON d."id" = c."documentId"
        WHERE d."subjectId" = ${subject.id}
          AND d."status" = 'READY'
      `;
      const sorted = [...rows].sort(
        (a, b) =>
          (b.score ?? Number.NEGATIVE_INFINITY) -
            (a.score ?? Number.NEGATIVE_INFINITY) ||
          a.chunkId.localeCompare(b.chunkId),
      );
      const targetRank =
        sorted.findIndex((row) => row.chunkId === queryCase.targetChunkId) + 1;
      console.log(`(b) allChunks=${sorted.length} targetRank=${targetRank}`);
      for (const [index, row] of sorted.entries()) {
        console.log(
          `  rank=${index + 1} chunkId=${row.chunkId} page=${row.pageNumber} score=${row.score === null ? 'null' : row.score.toFixed(6)}`,
        );
      }
    } catch (error) {
      console.log(`(b) cosine-all ERROR ${describeError(error)}`);
    }

    try {
      const rows = await productionVectorRows(prisma, subject.id, literal);
      console.log('(c) production vector query');
      printVectorRows(rows, queryCase.targetChunkId);
    } catch (error) {
      console.log(`(c) production vector query ERROR ${describeError(error)}`);
    }

    try {
      const rows = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ivfflat.probes = 100');
        return productionVectorRows(tx, subject.id, literal as string);
      });
      console.log('(d) production vector query with SET LOCAL ivfflat.probes = 100');
      printVectorRows(rows, queryCase.targetChunkId);
    } catch (error) {
      console.log(`(d) ivfflat.probes=100 ERROR ${describeError(error)}`);
    }

    try {
      const rows = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL enable_indexscan = off');
        return productionVectorRows(tx, subject.id, literal as string);
      });
      console.log('(e) production vector query with SET LOCAL enable_indexscan = off');
      printVectorRows(rows, queryCase.targetChunkId);
    } catch (error) {
      console.log(`(e) enable_indexscan=off ERROR ${describeError(error)}`);
    }

    try {
      const plan = await prisma.$queryRaw<Array<Record<string, unknown>>>`
        EXPLAIN
        SELECT c."id" AS "chunkId",
               c."documentId" AS "documentId",
               d."title" AS "documentTitle",
               c."page" AS "pageNumber",
               c."content" AS "content",
               c."extractionMethod"::text AS "extractionMethod",
               (1 - (c."embedding" <=> ${literal}::vector))::float8 AS "score"
        FROM "Chunk" c
        JOIN "Document" d ON d."id" = c."documentId"
        WHERE d."subjectId" = ${subject.id}
          AND d."status" = 'READY'
          AND c."embedding" IS NOT NULL
        ORDER BY c."embedding" <=> ${literal}::vector ASC, c."id" ASC
        LIMIT ${CANDIDATE_LIMIT}
      `;
      console.log('(f) EXPLAIN (no ANALYZE) of production vector query');
      for (const row of plan) {
        console.log(`  ${Object.values(row).join(' | ')}`);
      }
    } catch (error) {
      console.log(`(f) EXPLAIN ERROR ${describeError(error)}`);
    }
  } else {
    console.log('(b)-(f) skipped because embedding failed');
  }

  for (const topK of [5, 1000] as const) {
    try {
      const result = await retrieval.retrieve(subject.id, queryCase.query, {
        topK,
      });
      console.log(
        `(g) retrieve topK=${topK} matches=${result.matches.length} matchedBy=${json(matchedByDistribution(result.matches))}`,
      );
    } catch (error) {
      console.log(`(g) retrieve topK=${topK} ERROR ${describeError(error)}`);
    }
  }
}

async function main(): Promise<void> {
  console.log(
    `ZZ-diag-3b hybrid retrieval diagnostic (id ${DIAGNOSTIC_ID}, prefix ${PREFIX})`,
  );

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

  console.log('\n=== 1. RetrievalService source facts ===');
  console.log(
    'DEFAULT minScore: options.minScore ?? 0 (src/retrieval/retrieval.service.ts:65)',
  );
  console.log(
    'EMBEDDING CALL src/retrieval/retrieval.service.ts:78: const queryVector = await this.embeddings.embedText(trimmedQuestion, \'RETRIEVAL_QUERY\');',
  );
  console.log(
    'VECTOR QUERY src/retrieval/retrieval.service.ts:85-118: const [vectorRows, keywordRows] = await Promise.all([this.prisma.$queryRaw<VectorRow[]>`...`, this.prisma.$queryRaw<RetrievalRow[]>`...`]);',
  );
  console.log(
    'VECTOR SQL src/retrieval/retrieval.service.ts:86-101: this.prisma.$queryRaw<VectorRow[]> `SELECT ... FROM "Chunk" c JOIN "Document" d ... ORDER BY c."embedding" <=> ${literal}::vector ASC, c."id" ASC LIMIT ${candidateLimit}`.',
  );
  console.log(
    'ERROR HANDLING: no try/catch around the embedText call at line 78 or the vector $queryRaw at lines 86-101; errors propagate. There is no keyword-only fallback for embedding/vector failures.',
  );
  console.log('EXACT VECTOR SQL:');
  console.log(VECTOR_SQL_EXACT);

  console.log('\n=== 2. Per-query diagnostics ===');
  const cases: QueryCase[] = [
    { label: 'QUERY 1 airway/capnography', query: QUERY1, targetChunkId: TARGET1 },
    { label: 'QUERY 2 Elsevier alt-text', query: QUERY2, targetChunkId: TARGET2 },
  ];
  for (const queryCase of cases) {
    await diagnoseQuery(subject, queryCase);
  }

  console.log('\n=== 3. Vector index and probes setting ===');
  try {
    const indexes = await prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef
      FROM pg_indexes
      WHERE indexname = 'chunk_embedding_idx'
    `;
    console.log(`chunk_embedding_idx rows=${indexes.length}`);
    for (const row of indexes) console.log(`  indexdef=${row.indexdef}`);
  } catch (error) {
    console.log(`chunk_embedding_idx ERROR ${describeError(error)}`);
  }
  try {
    const probes = await prisma.$queryRaw<Array<{ probes: string }>>`
      SELECT current_setting('ivfflat.probes') AS "probes"
    `;
    console.log(`ivfflat.probes=${probes[0]?.probes ?? 'null'}`);
  } catch (error) {
    console.log(`ivfflat.probes ERROR ${describeError(error)}`);
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
