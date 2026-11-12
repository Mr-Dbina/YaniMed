import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AiCallError,
  AiClient,
  StallWatchdogError,
  type FetchLike,
  type FetchLikeResponse,
} from './ai.js';
import { checkpointFor, readCheckpoint, resumeSelection, writeJson } from './checkpoint.js';
import { assertSelectOnly } from './db.js';
import { attemptSlot, emptyRejections } from './pipeline.js';
import { balancedLetters, cosine, countSentences, fuzzyQuoteSimilarity, redactSecret } from './text.js';
import type { Checkpoint, Slot } from './types.js';

interface TestCase {
  name: string;
  run: () => string | null | Promise<string | null>;
}

const TEST_ENV: NodeJS.ProcessEnv = {
  OMNIROUTE_BASE_URL: 'http://localhost:20128',
  OMNIROUTE_API_KEY: 'test-key',
  OMNIROUTE_PRIMARY_MODEL: 'test-model',
  GEMINI_API_KEY: 'test-gemini-key',
};

const NO_DELAY = async (): Promise<void> => {};

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fakeResponse(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): FetchLikeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => headers[name.toLowerCase()] ?? null },
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

function testClient(fetchImpl: FetchLike): AiClient {
  return new AiClient(TEST_ENV, { fetchImpl, delayImpl: NO_DELAY });
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'yanimed-m2-selftest-'));
}

function baseCheckpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    version: 2,
    subject: { id: 's1', name: 'Test' },
    topics: [],
    slots: [],
    accepted: [],
    completedSlotIndexes: [],
    perTopicCap: 3,
    minDistinctTopics: 1,
    startedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

const tests: TestCase[] = [
  {
    name: 'sentence counter handles abbreviations and decimals',
    run: () => {
      const text =
        'Dr. Smith gave 1.5 mg/dL of the drug. The patient improved. ' +
        'She was discharged. Follow-up was scheduled. The result was normal.';
      const count = countSentences(text);
      return count === 5 ? null : `expected 5 sentences, got ${count}`;
    },
  },
  {
    name: 'sentence counter handles initials and two sentences',
    run: () => {
      const count = countSentences('Mr. J. Reyes has diabetes. He takes metformin.');
      return count === 2 ? null : `expected 2 sentences, got ${count}`;
    },
  },
  {
    name: 'fuzzy quote match accepts exact substring',
    run: () => {
      const page = 'The patient has a fever and a cough. Give fluids.';
      const similarity = fuzzyQuoteSimilarity(page, 'has a fever and a cough');
      return similarity === 1 ? null : `expected 1, got ${similarity}`;
    },
  },
  {
    name: 'fuzzy quote match tolerates light OCR noise',
    run: () => {
      const page = 'The patient has a fever and a productive cough with green sputum.';
      const quote = 'The patient has a feyer and a productive cough with green sputum.';
      const similarity = fuzzyQuoteSimilarity(page, quote);
      return similarity >= 0.9 ? null : `expected >= 0.90, got ${similarity}`;
    },
  },
  {
    name: 'fuzzy quote match rejects an absent quote',
    run: () => {
      const page = 'The patient has a fever and a cough. Give fluids and rest.';
      const similarity = fuzzyQuoteSimilarity(page, 'Radiography shows a displaced fracture');
      return similarity < 0.5 ? null : `expected < 0.50, got ${similarity}`;
    },
  },
  {
    name: 'answer letters stay balanced for 50 slots',
    run: () => {
      const rng = () => 0.5;
      const letters = balancedLetters(50, rng);
      const counts: Record<string, number> = { A: 0, B: 0, C: 0, D: 0 };
      for (const letter of letters) counts[letter] += 1;
      const ok =
        letters.length === 50 &&
        Object.values(counts).every(count => count >= 10 && count <= 15);
      return ok ? null : `counts ${JSON.stringify(counts)}`;
    },
  },
  {
    name: 'cosine returns 1 for identical and 0 for orthogonal vectors',
    run: () => {
      if (Math.abs(cosine([1, 2, 3], [1, 2, 3]) - 1) > 1e-9) return 'identical vectors failed';
      if (Math.abs(cosine([1, 0], [0, 1])) > 1e-9) return 'orthogonal vectors failed';
      return null;
    },
  },
  {
    name: 'SELECT-only guard allows SELECT and rejects writes',
    run: () => {
      if (assertSelectOnly('  SELECT 1') !== 'SELECT 1') return 'SELECT was not accepted';
      for (const statement of ['DELETE FROM "Chunk"', 'UPDATE "Chunk" SET x = 1', 'WITH x AS (SELECT 1) SELECT * FROM x']) {
        let rejected = false;
        try {
          assertSelectOnly(statement);
        } catch {
          rejected = true;
        }
        if (!rejected) return `statement was not rejected: ${statement}`;
      }
      return null;
    },
  },
  {
    name: 'stall watchdog triggers on an activity gap',
    run: () => {
      const client = testClient(async () => fakeResponse(200, '{}'));
      let triggered = false;
      try {
        client.checkWatchdog(-1);
      } catch (err) {
        if (err instanceof StallWatchdogError) triggered = true;
      }
      return triggered ? null : 'watchdog did not throw StallWatchdogError';
    },
  },
  {
    name: 'stall watchdog fires while a fetch hangs',
    run: async () => {
      const client = testClient(() => new Promise<FetchLikeResponse>(() => {}));
      let stalled = false;
      client.startWatchdog(() => {
        stalled = true;
      }, { timeoutMs: 25, intervalMs: 5 });
      void client
        .chat([{ role: 'user', content: 'ping' }], 'draft', {
          temperature: 0,
          verifier: false,
          slotNumber: 1,
        })
        .catch(() => {});
      await delay(100);
      client.stopWatchdog();
      return stalled ? null : 'watchdog did not fire for a hung fetch';
    },
  },
  {
    name: 'key redaction removes Bearer tokens and sensitive API keys',
    run: () => {
      const raw = 'Error: Bearer secret-token-xyz123 with api_key: AIzaSyD9876543210 and sk-abcdef1234567890';
      const clean = redactSecret(raw);
      if (clean.includes('secret-token-xyz123')) return 'Bearer token was not redacted';
      if (clean.includes('AIzaSyD9876543210')) return 'Google AIza key was not redacted';
      if (clean.includes('sk-abcdef1234567890')) return 'OpenAI sk- key was not redacted';
      if (!clean.includes('[REDACTED]')) return 'Redaction placeholder not found';
      return null;
    },
  },
  {
    name: 'failed call records redacted detail and failure counts',
    run: async () => {
      const bearer = 'sk-live-secret1234567890';
      const googleKey = 'AIzaSyD9876543210abcdefghij';
      const token = 'tok_abcdefghijk';
      const client = testClient(async () =>
        fakeResponse(500, `upstream failed Bearer ${bearer} key=${googleKey} token: ${token}`),
      );

      let caught: unknown = null;
      try {
        await client.chat([{ role: 'user', content: 'ping' }], 'draft', {
          temperature: 0,
          verifier: false,
          slotNumber: 7,
        });
      } catch (error) {
        caught = error;
      }
      if (!(caught instanceof AiCallError)) return 'expected an AiCallError';

      const serialized = JSON.stringify(client.getFailureDetails());
      for (const secret of [bearer, googleKey, token, 'Bearer sk-live']) {
        if (serialized.includes(secret)) return `secret leaked in failure detail: ${secret}`;
      }
      if (!serialized.includes('[REDACTED]')) return 'redaction marker missing';

      const counts = client.getFailureCounts();
      if (counts.byStatus['500'] !== 4) return `expected 4 status-500 failures, got ${counts.byStatus['500']}`;
      if (counts.byType['HTTP_500'] !== 4) return `expected 4 HTTP_500 failures, got ${counts.byType['HTTP_500']}`;
      return null;
    },
  },
  {
    name: 'rejected slot is saved, skipped by default and retried with --retry-rejected',
    run: async () => {
      const slot: Slot = {
        slotIndex: 1,
        topicId: 7,
        topicName: 'Topic',
        letter: 'B',
        seedChunks: [],
      };
      const client = testClient(async () =>
        fakeResponse(200, JSON.stringify({ choices: [{ message: { content: 'not json' } }] })),
      );
      const rejections = emptyRejections();
      const outcome = await attemptSlot(slot, {
        ai: client,
        pageMap: new Map(),
        accepted: [],
        rejections,
      });
      if (outcome.ok) return 'expected the slot to be rejected';

      const dir = tempDir();
      try {
        const file = join(dir, 'checkpoint.json');
        const checkpoint = checkpointFor({
          loaded: { subject: { id: 's1', name: 'Test' } },
          topics: [],
          slots: [slot],
          accepted: [],
          completed: new Set([slot.slotIndex]),
          slotStatuses: { [slot.slotIndex]: { status: 'rejected', reason: outcome.reason } },
          perTopicCap: 3,
          minDistinctTopics: 1,
          startedAt: new Date(0).toISOString(),
          aiCalls: client.getUsage(),
          rejections,
          failureCounts: client.getFailureCounts(),
          resumes: 0,
          incompleteReason: null,
        });
        writeJson(file, checkpoint);

        const loaded = readCheckpoint(file);
        if (!loaded) return 'checkpoint did not load';
        if (loaded.version !== 2) return `expected checkpoint version 2, got ${loaded.version}`;
        if (loaded.slotStatuses?.[slot.slotIndex]?.status !== 'rejected') {
          return 'rejected slot was not saved';
        }

        const defaultResume = resumeSelection(loaded, false);
        if (!defaultResume.completed.has(slot.slotIndex)) {
          return 'rejected slot was not skipped on default resume';
        }
        if (!defaultResume.skippedRejected.includes(slot.slotIndex)) {
          return 'default resume did not report the skipped rejected slot';
        }

        const retryResume = resumeSelection(loaded, true);
        if (retryResume.completed.has(slot.slotIndex)) {
          return '--retry-rejected did not schedule the rejected slot';
        }
        return null;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'cumulative AI counters restore from a checkpoint',
    run: async () => {
      const values = Array.from({ length: 768 }, () => 0.01);
      const client = testClient(async () =>
        fakeResponse(200, JSON.stringify({ embedding: { values } })),
      );
      client.restoreUsage({ total: 10, chat: 8, embedding: 2, byPurpose: { draft: 5, verify: 3, embed: 2 } });
      client.restoreFailureCounts({ byStatus: { '500': 2 }, byType: { HTTP_500: 2 } });
      await client.embed('text', 3);

      const dir = tempDir();
      try {
        const file = join(dir, 'checkpoint.json');
        writeJson(
          file,
          baseCheckpoint({
            aiCalls: client.getUsage(),
            failureCounts: client.getFailureCounts(),
            rejections: emptyRejections(),
            resumes: 2,
          }),
        );
        const loaded = readCheckpoint(file);
        if (!loaded) return 'checkpoint did not load';
        if (!loaded.aiCalls) return 'aiCalls were not saved in the checkpoint';

        const restored = testClient(async () => fakeResponse(200, '{}'));
        restored.restoreUsage(loaded.aiCalls);
        restored.restoreFailureCounts(loaded.failureCounts);
        const usage = restored.getUsage();
        if (usage.total !== 11) return `expected total 11 after restore, got ${usage.total}`;
        if (usage.chat !== 8) return `expected chat 8 after restore, got ${usage.chat}`;
        if (usage.embedding !== 3) return `expected embedding 3 after restore, got ${usage.embedding}`;
        if (usage.byPurpose.embed !== 3) return `expected embed purpose 3, got ${usage.byPurpose.embed}`;
        if (restored.getFailureCounts().byStatus['500'] !== 2) return 'failure counts were not restored';
        if (loaded.resumes !== 2) return `expected resumes 2, got ${loaded.resumes}`;
        return null;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'JSON output is UTF-8 without a BOM',
    run: () => {
      const dir = tempDir();
      try {
        const file = join(dir, 'utf8.json');
        const sample = 'em dash — eñe';
        writeJson(file, { text: sample });
        const bytes = readFileSync(file);
        if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'BOM found';
        if (!bytes.toString('utf8').includes(sample)) return 'non-ASCII text did not round-trip as UTF-8';
        return null;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'version-1 checkpoint loads without the new fields',
    run: () => {
      const dir = tempDir();
      try {
        const file = join(dir, 'checkpoint.json');
        const v1 = baseCheckpoint({
          version: 1,
          completedSlotIndexes: [0, 2],
          slotStatuses: undefined,
          aiCalls: undefined,
          rejections: undefined,
          failureCounts: undefined,
          resumes: undefined,
          incompleteReason: undefined,
        });
        writeJson(file, v1);

        const loaded = readCheckpoint(file);
        if (!loaded) return 'version-1 checkpoint did not load';
        if (loaded.version !== 1) return `expected version 1, got ${loaded.version}`;
        const selection = resumeSelection(loaded, false);
        if (selection.completed.size !== 2) return 'version-1 completed indexes were not restored';
        return null;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'success delay waits --delay-ms after a completed chat call',
    run: async () => {
      const waits: number[] = [];
      const client = new AiClient(TEST_ENV, {
        fetchImpl: async () =>
          fakeResponse(200, JSON.stringify({ choices: [{ message: { content: 'ok' } }] })),
        delayImpl: async ms => {
          waits.push(ms);
        },
        delayMs: 8000,
      });
      await client.chat([{ role: 'user', content: 'ping' }], 'draft', {
        temperature: 0,
        verifier: false,
        slotNumber: 1,
      });
      return waits.length === 1 && waits[0] === 8000
        ? null
        : `expected one 8000 ms wait, got ${JSON.stringify(waits)}`;
    },
  },
  {
    name: '429 with Retry-After waits the header value',
    run: async () => {
      const waits: number[] = [];
      let calls = 0;
      const client = new AiClient(TEST_ENV, {
        fetchImpl: async () => {
          calls += 1;
          return calls === 1
            ? fakeResponse(429, 'slow down', { 'retry-after': '12' })
            : fakeResponse(200, JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
        },
        delayImpl: async ms => {
          waits.push(ms);
        },
      });
      await client.chat([{ role: 'user', content: 'ping' }], 'draft', {
        temperature: 0,
        verifier: false,
        slotNumber: 1,
      });
      if (waits.length !== 1 || waits[0] !== 12000) {
        return `expected one 12000 ms wait, got ${JSON.stringify(waits)}`;
      }
      if (client.getFailureCounts().byType['rate-limited'] !== 1) {
        return 'rate-limited failure was not counted';
      }
      if (!client.getLastLogs(3).some(line => line.includes('rate-limited'))) {
        return 'call log did not record rate-limited';
      }
      return null;
    },
  },
  {
    name: '429 without Retry-After waits the 30 s default',
    run: async () => {
      const waits: number[] = [];
      let calls = 0;
      const client = new AiClient(TEST_ENV, {
        fetchImpl: async () => {
          calls += 1;
          return calls === 1
            ? fakeResponse(429, 'slow down')
            : fakeResponse(200, JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
        },
        delayImpl: async ms => {
          waits.push(ms);
        },
      });
      await client.chat([{ role: 'user', content: 'ping' }], 'draft', {
        temperature: 0,
        verifier: false,
        slotNumber: 1,
      });
      return waits.length === 1 && waits[0] === 30000
        ? null
        : `expected one 30000 ms wait, got ${JSON.stringify(waits)}`;
    },
  },
];

export async function runSelftest(): Promise<number> {
  let failures = 0;
  for (const test of tests) {
    const failure = await test.run();
    if (failure) {
      failures += 1;
      console.log(`FAIL ${test.name}: ${failure}`);
    } else {
      console.log(`PASS ${test.name}`);
    }
  }
  console.log(`\nSelftest: ${tests.length - failures}/${tests.length} passed.`);
  return failures === 0 ? 0 : 1;
}
