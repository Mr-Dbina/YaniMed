import './test-db.js';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { draftQuestion } from '../../../src/mock-test/generation/draft/draft.service.js';
import { validateDraft } from '../../../src/mock-test/generation/validate/check-a.js';
import { verifyDraft } from '../../../src/mock-test/generation/validate/check-b.js';
import { checkDuplicates } from '../../../src/mock-test/generation/validate/check-c.js';
import { prisma } from '../helpers.js';
import { createE2eFixture, deleteE2eFixtures } from './fixture.js';
import { createFakeAi } from './fake-ai.js';

afterEach(async () => {
  await deleteE2eFixtures();
});

/**
 * Smoke test before the HTTP suite: one draft from the fake AI must pass the
 * real Check A, Check B and Check C. This isolates a fake-AI/validator mismatch
 * from the app boot and the worker.
 */
it(
  'the fake AI produces one fully accepted question',
  async () => {
    const fixture = await createE2eFixture();
    const jobId = randomUUID();
    const topic = { topicKey: 'zz-e2e-topic', name: 'Topic 0 Review' };

    const page = await prisma.documentPage.findFirstOrThrow({
      where: { documentId: fixture.documentId, pageNumber: 1 },
    });
    const chunk = await prisma.chunk.findFirstOrThrow({
      where: { documentId: fixture.documentId, page: 1 },
    });

    const fake = createFakeAi();
    const drafted = await draftQuestion(
      {
        jobId,
        subjectId: fixture.subjectId,
        subjectName: fixture.subjectName,
        topic,
        seedChunks: [
          {
            chunkId: chunk.id,
            documentId: fixture.documentId,
            documentTitle: fixture.documentTitle,
            pageStart: 1,
            pageEnd: 1,
            text: chunk.content,
          },
        ],
        acceptedObjectives: [],
        styleHint: 'CLINICAL_STEM',
      },
      fake,
    );

    expect(drafted.ok).toBe(true);
    if (!drafted.ok) return;

    const draft = drafted.draft;
    const checkA = validateDraft(draft, {
      topicKeys: new Set([topic.topicKey]),
      documents: new Map([
        [
          fixture.documentId,
          { title: fixture.documentTitle, pageCount: fixture.pageCount },
        ],
      ]),
      getPage: (documentId, pageNumber) =>
        documentId === fixture.documentId && pageNumber === 1
          ? { text: page.text, needsOcr: false }
          : null,
    });
    expect(checkA.ok).toBe(true);
    if (!checkA.ok) return;

    const checkB = await verifyDraft(draft, page.text, fake, {
      jobId,
      subjectId: fixture.subjectId,
    });
    expect(checkB.ok).toBe(true);

    const checkC = await checkDuplicates(draft, {
      jobId,
      subjectId: fixture.subjectId,
      accepted: [],
      bank: { loadRefs: async () => [] },
      embed: (input) => fake.embed(input),
    });
    expect(checkC.ok).toBe(true);
    if (checkC.ok) {
      expect(checkC.embedding).toHaveLength(768);
      expect(checkC.embedding.some((value) => value !== 0)).toBe(true);
    }
  },
  120_000,
);
