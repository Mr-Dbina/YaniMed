import type {
  CompleteInput,
  CompleteResult,
  EmbedInput,
} from '../../../src/mock-test/generation/ai/generation-ai.service.js';
import { GenerationError } from '../../../src/mock-test/generation/generation.errors.js';

/**
 * Deterministic stand-in for GenerationAiService. It answers the three real
 * prompts (PLAN, DRAFT, VERIFY) in valid JSON and never uses the network.
 *
 * The DRAFT answer keys choice 0 and quotes the first sentence of the first
 * seed chunk. The VERIFY answer repeats a sentence copied verbatim from the
 * page in <PAGE_TEXT>, so the real Check B quote check passes at 1.0. Check B
 * applies polarity in CODE, so the other three choices are NOT_ADDRESSED.
 */

export interface FakeAiOptions {
  /** Await release() during this DRAFT call, after the job is already RUNNING. */
  blockDraftAtCall?: number;
  /** Await release() during this VERIFY call, after earlier slots were written. */
  blockVerifyAtCall?: number;
  /** Throw GENERATION_PROVIDER_UNAVAILABLE from this DRAFT call onward. */
  failDraftFromCall?: number;
}

export interface FakeAi {
  complete(input: CompleteInput): Promise<CompleteResult>;
  embed(input: EmbedInput): Promise<number[]>;
  assertReady(): void;
  /** Resolves once the configured gate has been reached. */
  waitUntilBlocked(timeoutMs?: number): Promise<void>;
  /** Opens the gate; later calls never block. */
  release(): void;
  counts: { plan: number; draft: number; verify: number };
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function createDeferred(): Deferred {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error('Fake AI call aborted.');
  error.name = 'AbortError';
  return error;
}

function waitWithAbort(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));

  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      reject(abortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    });
  });
}

function userContent(input: CompleteInput): string {
  const message = input.messages.find((entry) => entry.role === 'user');
  return message?.content ?? '';
}

function completeResult(text: string): CompleteResult {
  return {
    text,
    model: 'zz-e2e-fake',
    tokensIn: null,
    tokensOut: null,
    latencyMs: 0,
  };
}

/** Descending clusterId -> one unique, plain 3-word topic name per cluster. */
function topicNamesJson(input: CompleteInput): string {
  let payload: unknown;
  try {
    payload = JSON.parse(userContent(input));
  } catch {
    throw new Error('Fake AI could not parse the topic-naming payload.');
  }

  const clusters =
    typeof payload === 'object' && payload !== null
      ? (payload as { clusters?: unknown }).clusters
      : undefined;
  if (!Array.isArray(clusters)) {
    throw new Error('Fake AI found no clusters in the naming payload.');
  }

  const topics = clusters.map((entry) => {
    const clusterId =
      typeof entry === 'object' && entry !== null
        ? (entry as { clusterId?: unknown }).clusterId
        : undefined;
    if (typeof clusterId !== 'number' || !Number.isInteger(clusterId)) {
      throw new Error('Fake AI found an invalid cluster id.');
    }
    return { clusterId, name: `Topic ${clusterId} Review` };
  });

  return JSON.stringify({ topics });
}

/** First sentence of 20+ characters, copied verbatim. */
function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const match = /[A-Z][^.!?]{20,300}[.!?]/.exec(flat);
  if (match) return match[0].trim();
  return flat.slice(0, 120);
}

const SEED_CHUNK =
  /<SOURCE_CHUNK id="[^"]*" document="([^"]*)" pages="([^"]*)">([\s\S]*?)<\/SOURCE_CHUNK>/;

function draftJson(input: CompleteInput): string {
  const match = SEED_CHUNK.exec(userContent(input));
  if (!match) throw new Error('Fake AI could not read a SOURCE_CHUNK.');

  const documentId = match[1] ?? '';
  const pages = match[2] ?? '';
  const body = match[3] ?? '';
  const page = Number.parseInt(pages, 10);
  if (!Number.isInteger(page) || page < 1) {
    throw new Error('Fake AI could not read the seed page number.');
  }

  const quote = firstSentence(body);
  const choiceExplanation = 'The cited page states this finding directly.';

  return JSON.stringify({
    stem: `Which statement about the finding recorded on page ${page} is supported by the source?`,
    leadIn: null,
    choices: [
      {
        text: 'The source confirms the recorded finding for this page.',
        explanation: choiceExplanation,
      },
      {
        text: 'The source omits the recorded finding for this page.',
        explanation: 'The cited page does not make this claim.',
      },
      {
        text: 'The source reverses the recorded finding for this page.',
        explanation: 'The cited page does not make this claim.',
      },
      {
        text: 'The source defers the recorded finding for this page.',
        explanation: 'The cited page does not make this claim.',
      },
    ],
    keyIndex: 0,
    objective: `Identify the finding recorded on page ${page}.`,
    keyExplanation: 'The cited page states this finding directly.',
    citation: {
      documentId,
      page,
      printedPage: null,
      quote,
    },
  });
}

const PAGE_TEXT = /<PAGE_TEXT>\n([\s\S]*?)\n<\/PAGE_TEXT>/;

function verifierJson(input: CompleteInput): string {
  const match = PAGE_TEXT.exec(userContent(input));
  if (!match) throw new Error('Fake AI could not read PAGE_TEXT.');

  const quote = firstSentence(match[1] ?? '');
  return JSON.stringify({
    verdicts: [
      { index: 0, verdict: 'SUPPORTED', quote },
      { index: 1, verdict: 'NOT_ADDRESSED', quote: '' },
      { index: 2, verdict: 'NOT_ADDRESSED', quote: '' },
      { index: 3, verdict: 'NOT_ADDRESSED', quote: '' },
    ],
    needsOutsideKnowledge: false,
    ambiguous: false,
  });
}

export function createFakeAi(options: FakeAiOptions = {}): FakeAi {
  const counts = { plan: 0, draft: 0, verify: 0 };
  const gate = createDeferred();
  const entered = createDeferred();
  const dimensions = new Map<string, number>();
  let nextDimension = 0;

  const providerUnavailable = (jobId: string): GenerationError =>
    new GenerationError('GENERATION_PROVIDER_UNAVAILABLE', { jobId });

  const waitAtGate = async (signal?: AbortSignal): Promise<void> => {
    entered.resolve();
    await waitWithAbort(gate.promise, signal);
    if (signal?.aborted) throw abortError(signal);
  };

  return {
    counts,

    async complete(input: CompleteInput): Promise<CompleteResult> {
      if (input.signal?.aborted) throw abortError(input.signal);

      if (input.purpose === 'PLAN') {
        counts.plan += 1;
        return completeResult(topicNamesJson(input));
      }

      if (input.purpose === 'DRAFT') {
        counts.draft += 1;
        if (
          options.failDraftFromCall !== undefined &&
          counts.draft >= options.failDraftFromCall
        ) {
          throw providerUnavailable(input.jobId);
        }
        if (options.blockDraftAtCall === counts.draft) {
          await waitAtGate(input.signal);
        }
        return completeResult(draftJson(input));
      }

      counts.verify += 1;
      if (options.blockVerifyAtCall === counts.verify) {
        await waitAtGate(input.signal);
      }
      return completeResult(verifierJson(input));
    },

    async embed(input: EmbedInput): Promise<number[]> {
      let dimension = dimensions.get(input.text);
      if (dimension === undefined) {
        dimension = nextDimension % 768;
        nextDimension += 1;
        dimensions.set(input.text, dimension);
      }
      const vector = Array.from({ length: 768 }, () => 0);
      vector[dimension] = 1;
      return vector;
    },

    assertReady(): void {
      // The fake is always configured.
    },

    async waitUntilBlocked(timeoutMs = 60_000): Promise<void> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('The fake AI was never blocked.'));
        }, timeoutMs);
      });
      try {
        await Promise.race([entered.promise, timeout]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },

    release(): void {
      gate.resolve();
    },
  };
}
