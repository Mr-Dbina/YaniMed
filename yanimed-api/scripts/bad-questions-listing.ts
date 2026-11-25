/// <reference types="node" />
import '../src/config/load-local-env.js';
import { PrismaClient } from '@prisma/client';

/**
 * READ-ONLY, NO WRITES.
 *
 * Lists MockQuestion rows for the Pediatrics subject that cite known
 * front-matter pages of the Harriet Lane source PDF, plus per-topic counts.
 * Prints ids, statuses, topic names, page numbers and timestamps only.
 *
 *   npx tsx scripts/bad-questions-listing.ts
 */

const SUBJECT_ID = '974c0df4-37df-4efd-8308-45fe03820d5b';
const FRONT_MATTER_PAGES = [2, 3, 13, 14, 15, 16, 17, 18] as const;
const FRONT_MATTER_PAGE_SET = new Set<number>(FRONT_MATTER_PAGES);

const prisma = new PrismaClient();

async function main() {
  const questions = await prisma.mockQuestion.findMany({
    where: { subjectId: SUBJECT_ID },
    select: {
      id: true,
      status: true,
      createdAt: true,
      topic: { select: { id: true, name: true } },
      citations: { select: { pageNumber: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  const topics = await prisma.subjectTopic.findMany({
    where: { subjectId: SUBJECT_ID },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });

  const activeQuestions = questions.filter((q) => q.status === 'ACTIVE');
  const withCitations = questions.filter((q) => q.citations.length > 0);
  const noCitation = questions.filter((q) => q.citations.length === 0);

  console.log('READ-ONLY, NO WRITES');
  console.log(`subject=${SUBJECT_ID}`);
  console.log(`frontMatterPages=${FRONT_MATTER_PAGES.join(',')}`);
  console.log('');

  const flagged: typeof questions = [];
  console.log('questions:');
  for (const question of questions) {
    const pages = question.citations.map((c) => c.pageNumber).sort((a, b) => a - b);
    const isFlagged = pages.some((p) => FRONT_MATTER_PAGE_SET.has(p));
    if (isFlagged) flagged.push(question);
    console.log(
      `question=${question.id} status=${question.status} topic=${question.topic.name} ` +
        `pages=${pages.length > 0 ? pages.join(',') : 'none'} createdAt=${question.createdAt.toISOString()}` +
        (isFlagged ? ' frontMatter=true' : ''),
    );
  }

  console.log('');
  console.log('flagged questions (cite pages 2, 3 or 13-18):');
  if (flagged.length === 0) {
    console.log('none');
  } else {
    for (const question of flagged) {
      const pages = question.citations
        .map((c) => c.pageNumber)
        .filter((p) => FRONT_MATTER_PAGE_SET.has(p))
        .sort((a, b) => a - b);
      console.log(
        `question=${question.id} status=${question.status} topic=${question.topic.name} pages=${pages.join(',')}`,
      );
    }
  }

  console.log('');
  console.log('questions with no citation:');
  if (noCitation.length === 0) {
    console.log('none');
  } else {
    for (const question of noCitation) {
      console.log(`question=${question.id} status=${question.status} topic=${question.topic.name} pages=none`);
    }
  }

  const flaggedActive = activeQuestions.filter((q) =>
    q.citations.some((c) => FRONT_MATTER_PAGE_SET.has(c.pageNumber)),
  );

  console.log('');
  console.log('summary:');
  console.log(`totalQuestions=${questions.length}`);
  console.log(`totalActiveQuestions=${activeQuestions.length}`);
  console.log(`activeQuestionsWithFrontMatterCitation=${flaggedActive.length}`);
  console.log(`questionsWithCitations=${withCitations.length}`);
  console.log(`questionsWithNoCitation=${noCitation.length}`);

  console.log('');
  console.log('countsPerTopic (active/total):');
  const topicCounts = new Map<string, { name: string; active: number; total: number }>();
  for (const topic of topics) {
    topicCounts.set(topic.id, { name: topic.name, active: 0, total: 0 });
  }
  for (const question of questions) {
    const entry = topicCounts.get(question.topic.id);
    if (!entry) continue;
    entry.total += 1;
    if (question.status === 'ACTIVE') entry.active += 1;
  }
  for (const entry of topicCounts.values()) {
    console.log(`topic=${entry.name} active=${entry.active} total=${entry.total}`);
  }

  console.log('');
  console.log('topicsWithFrontMatterQuestions:');
  const flaggedTopicNames = [...new Set(flagged.map((q) => q.topic.name))].sort();
  if (flaggedTopicNames.length === 0) {
    console.log('none');
  } else {
    for (const name of flaggedTopicNames) {
      console.log(`topic=${name}`);
    }
  }
}

main().catch((error: unknown) => {
  console.error('error:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}).finally(async () => {
  await prisma.$disconnect();
});
