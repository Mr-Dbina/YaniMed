import type { PrismaService } from '../../../prisma/prisma.service.js';
import { getGenerationPrisma } from './question-writer.js';

export interface PlanTopicInput {
  topicKey: string;
  name: string;
}

/**
 * Creates missing SubjectTopic rows and returns key -> id. Existing rows are
 * never renamed: createMany(skipDuplicates) leaves them untouched.
 */
export async function ensureSubjectTopics(
  subjectId: string,
  planTopics: readonly PlanTopicInput[],
  client: PrismaService = getGenerationPrisma(),
): Promise<Map<string, string>> {
  const topics = new Map<string, string>();
  for (const topic of planTopics) {
    const key = topic.topicKey.trim();
    if (key === '' || topics.has(key)) continue;
    topics.set(key, topic.name);
  }
  if (topics.size === 0) return new Map();

  await client.subjectTopic.createMany({
    data: [...topics].map(([key, name]) => ({ subjectId, key, name })),
    skipDuplicates: true,
  });

  const rows = await client.subjectTopic.findMany({
    where: { subjectId, key: { in: [...topics.keys()] } },
    select: { key: true, id: true },
  });
  return new Map(rows.map((row) => [row.key, row.id]));
}
