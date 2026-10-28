import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentProcessingService } from './document-processing.service.js';
import { LeaseLostError } from './processing-job.types.js';
import type { ClaimedJob } from './processing-job.repository.js';

function makeJob(overrides: Partial<ClaimedJob> = {}): ClaimedJob {
  return {
    id: 'job-1',
    documentId: 'doc-1',
    attempt: 1,
    maxAttempts: 4,
    fencingToken: 1,
    leaseOwner: 'owner-1',
    ...overrides,
  };
}

function makeJobs(claimQueue: Array<ClaimedJob | null>) {
  const queue = [...claimQueue];
  const makeContext = (job: ClaimedJob) => ({
    jobId: job.id,
    documentId: job.documentId,
    owner: job.leaseOwner,
    token: job.fencingToken,
    lost: false,
    updateDocument: vi.fn().mockResolvedValue(undefined),
  });
  const contexts: Array<ReturnType<typeof makeContext>> = [];
  return {
    enqueue: vi.fn().mockResolvedValue('job-1'),
    claimNext: vi.fn().mockImplementation(async () => queue.shift() ?? null),
    heartbeat: vi.fn().mockResolvedValue(true),
    complete: vi.fn().mockResolvedValue(undefined),
    findOrphanDocumentIds: vi.fn().mockResolvedValue([]),
    createContext: vi.fn((job: ClaimedJob) => {
      const ctx = makeContext(job);
      contexts.push(ctx);
      return ctx;
    }),
    contexts,
  };
}

function makeExtraction() {
  return { processDocument: vi.fn().mockResolvedValue(undefined) };
}

function makeEmbeddings() {
  return {
    embedDocument: vi.fn().mockResolvedValue(undefined),
    verifyDocumentEmbeddings: vi.fn().mockResolvedValue({ totalChunks: 2, isComplete: true }),
  };
}

describe('DocumentProcessingService', () => {
  const saved: Record<string, string | undefined> = {};
  const keys = ['PROCESSING_LEASE_MS', 'PROCESSING_HEARTBEAT_MS', 'PROCESSING_JOB_MAX_MS', 'PROCESSING_MAX_ATTEMPTS'];

  beforeEach(() => {
    for (const key of keys) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('marks the job and document READY only after extraction, embeddings, and integrity verification', async () => {
    const job = makeJob();
    const jobs = makeJobs([job]);
    const extraction = makeExtraction();
    const embeddings = makeEmbeddings();
    const service = new DocumentProcessingService(jobs as never, extraction as never, embeddings as never);

    await service.drain(1);

    const ctx = jobs.contexts[0];
    expect(extraction.processDocument).toHaveBeenCalledWith('doc-1', {}, ctx);
    expect(embeddings.embedDocument).toHaveBeenCalledWith('doc-1', ctx);
    expect(embeddings.verifyDocumentEmbeddings).toHaveBeenCalledWith('doc-1');
    expect(jobs.complete).toHaveBeenCalledWith({ job, success: true });
  });

  it('marks the job FAILED with the error code when processing fails', async () => {
    const job = makeJob();
    const jobs = makeJobs([job]);
    const extraction = makeExtraction();
    extraction.processDocument.mockRejectedValue(Object.assign(new Error('ocr failed'), { code: 'OCR_FAILED' }));
    const embeddings = makeEmbeddings();
    const service = new DocumentProcessingService(jobs as never, extraction as never, embeddings as never);

    await service.drain(1);

    expect(embeddings.embedDocument).not.toHaveBeenCalled();
    expect(jobs.complete).toHaveBeenCalledWith({
      job,
      success: false,
      errorCode: 'OCR_FAILED',
      errorMessage: 'ocr failed',
    });
  });

  it('marks the job FAILED when the document has no extractable text', async () => {
    const job = makeJob();
    const jobs = makeJobs([job]);
    const embeddings = makeEmbeddings();
    embeddings.verifyDocumentEmbeddings.mockResolvedValue({ totalChunks: 0, isComplete: false });
    const service = new DocumentProcessingService(jobs as never, makeExtraction() as never, embeddings as never);

    await service.drain(1);

    expect(jobs.complete).toHaveBeenCalledWith({
      job,
      success: false,
      errorCode: 'PROCESSING_FAILED',
      errorMessage: 'Document contains no extractable text.',
    });
  });

  it('marks the job FAILED when embedding integrity is incomplete', async () => {
    const job = makeJob();
    const jobs = makeJobs([job]);
    const embeddings = makeEmbeddings();
    embeddings.verifyDocumentEmbeddings.mockResolvedValue({ totalChunks: 2, isComplete: false });
    const service = new DocumentProcessingService(jobs as never, makeExtraction() as never, embeddings as never);

    await service.drain(1);

    expect(jobs.complete).toHaveBeenCalledWith({
      job,
      success: false,
      errorCode: 'PROCESSING_FAILED',
      errorMessage: 'Embedding integrity verification failed.',
    });
  });

  it('does not write a FAILED result when the lease is lost', async () => {
    const jobs = makeJobs([makeJob()]);
    const extraction = makeExtraction();
    extraction.processDocument.mockRejectedValue(new LeaseLostError());
    const embeddings = makeEmbeddings();
    const service = new DocumentProcessingService(jobs as never, extraction as never, embeddings as never);

    await service.drain(1);

    expect(jobs.complete).not.toHaveBeenCalled();
  });

  it('renews its heartbeat on the configured interval with fake timers', async () => {
    vi.useFakeTimers();
    const job = makeJob();
    const jobs = makeJobs([job]);
    jobs.heartbeat.mockResolvedValue(true);

    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const extraction = makeExtraction();
    extraction.processDocument.mockImplementation(async () => { await gate; });
    const embeddings = makeEmbeddings();
    const service = new DocumentProcessingService(jobs as never, extraction as never, embeddings as never);

    const drain = service.drain(1);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(jobs.heartbeat).toHaveBeenCalledWith(job, 180_000);

    release();
    await drain;

    expect(jobs.complete).toHaveBeenCalledWith({ job, success: true });
  });

  it('sets lost and stops a job when heartbeat renews zero rows', async () => {
    vi.useFakeTimers();
    const job = makeJob();
    const jobs = makeJobs([job]);
    jobs.heartbeat.mockResolvedValue(false);

    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const extraction = makeExtraction();
    extraction.processDocument.mockImplementation(async (_id: string, _options: unknown, ctx: { lost: boolean }) => {
      await gate;
      if (ctx.lost) throw new LeaseLostError();
    });
    const embeddings = makeEmbeddings();
    const service = new DocumentProcessingService(jobs as never, extraction as never, embeddings as never);

    const drain = service.drain(1);
    await vi.advanceTimersByTimeAsync(30_000);
    release();
    await drain;

    expect(jobs.heartbeat).toHaveBeenCalled();
    expect(jobs.complete).not.toHaveBeenCalled();
  });

  it('stops a hung stage when heartbeat reports lost and drains the next job', async () => {
    vi.useFakeTimers();
    process.env.PROCESSING_HEARTBEAT_MS = '500';
    const first = makeJob({ id: 'job-1', documentId: 'doc-1' });
    const second = makeJob({ id: 'job-2', documentId: 'doc-2', fencingToken: 2 });
    const jobs = makeJobs([first, second, null]);
    jobs.heartbeat.mockImplementation(async (claimed: ClaimedJob) => claimed.id !== first.id);
    const extraction = makeExtraction();
    extraction.processDocument.mockImplementation(async (documentId: string) => {
      if (documentId === 'doc-1') return new Promise<void>(() => undefined);
    });
    const embeddings = makeEmbeddings();
    const service = new DocumentProcessingService(jobs as never, extraction as never, embeddings as never);

    const drain = service.drain(2);
    await vi.advanceTimersByTimeAsync(500);
    await drain;

    expect(jobs.contexts[0].lost).toBe(true);
    expect(jobs.heartbeat).toHaveBeenCalledTimes(1);
    expect(jobs.complete).toHaveBeenCalledTimes(1);
    expect(jobs.complete).toHaveBeenCalledWith({ job: second, success: true });
    expect(jobs.complete).not.toHaveBeenCalledWith(expect.objectContaining({ job: first }));
  });

  it('fails a hung job at the deadline, continues draining, and stops heartbeat renewal', async () => {
    vi.useFakeTimers();
    process.env.PROCESSING_JOB_MAX_MS = '1000';
    process.env.PROCESSING_HEARTBEAT_MS = '500';
    const first = makeJob({ id: 'job-1', documentId: 'doc-1' });
    const second = makeJob({ id: 'job-2', documentId: 'doc-2', fencingToken: 2 });
    const jobs = makeJobs([first, second]);
    const extraction = makeExtraction();
    extraction.processDocument.mockImplementation(async (documentId: string) => {
      if (documentId === 'doc-1') return new Promise<void>(() => undefined);
    });
    const embeddings = makeEmbeddings();
    const service = new DocumentProcessingService(jobs as never, extraction as never, embeddings as never);

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);

    try {
      const drain = service.drain(2);
      await vi.advanceTimersByTimeAsync(1001);
      await drain;

      const heartbeatCallsAtDeadline = jobs.heartbeat.mock.calls.length;
      expect(jobs.complete).toHaveBeenNthCalledWith(1, {
        job: first,
        success: false,
        errorCode: 'PROCESSING_TIME_BUDGET_EXCEEDED',
        errorMessage: 'PROCESSING_TIME_BUDGET_EXCEEDED: job exceeded 1000ms.',
      });
      expect(jobs.complete).toHaveBeenNthCalledWith(2, { job: second, success: true });
      expect(jobs.claimNext).toHaveBeenCalledTimes(2);
      expect(embeddings.embedDocument).toHaveBeenCalledTimes(1);
      expect(embeddings.embedDocument).toHaveBeenCalledWith('doc-2', jobs.contexts[1]);

      await vi.advanceTimersByTimeAsync(5000);
      expect(jobs.heartbeat).toHaveBeenCalledTimes(heartbeatCallsAtDeadline);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('keeps the lease alive when one heartbeat rejects and the next succeeds', async () => {
    vi.useFakeTimers();
    const job = makeJob();
    const jobs = makeJobs([job]);
    jobs.heartbeat.mockRejectedValueOnce(new Error('db unavailable')).mockResolvedValue(true);

    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const extraction = makeExtraction();
    extraction.processDocument.mockImplementation(async (_id: string, _options: unknown, ctx: { lost: boolean }) => {
      await gate;
      if (ctx.lost) throw new LeaseLostError();
    });
    const embeddings = makeEmbeddings();
    const service = new DocumentProcessingService(jobs as never, extraction as never, embeddings as never);

    const drain = service.drain(1);
    await vi.advanceTimersByTimeAsync(60_000);
    release();
    await drain;

    expect(jobs.heartbeat).toHaveBeenCalledTimes(2);
    expect(jobs.contexts[0].lost).toBe(false);
    expect(jobs.complete).toHaveBeenCalledWith({ job, success: true });
  });

  it('sets lost only after heartbeat errors outlast the local lease estimate', async () => {
    vi.useFakeTimers();
    process.env.PROCESSING_LEASE_MS = '2000';
    process.env.PROCESSING_HEARTBEAT_MS = '500';
    const job = makeJob();
    const jobs = makeJobs([job]);
    jobs.heartbeat.mockRejectedValue(new Error('db unavailable'));

    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const extraction = makeExtraction();
    extraction.processDocument.mockImplementation(async (_id: string, _options: unknown, ctx: { lost: boolean }) => {
      await gate;
      if (ctx.lost) throw new LeaseLostError();
    });
    const embeddings = makeEmbeddings();
    const service = new DocumentProcessingService(jobs as never, extraction as never, embeddings as never);

    const drain = service.drain(1);
    await vi.advanceTimersByTimeAsync(2500);
    release();
    await drain;

    expect(jobs.contexts[0].lost).toBe(true);
    expect(jobs.complete).not.toHaveBeenCalled();
  });

  it('skips a heartbeat tick while the previous heartbeat is in flight', async () => {
    vi.useFakeTimers();
    const job = makeJob();
    const jobs = makeJobs([job]);
    let resolveHeartbeat!: (value: boolean) => void;
    jobs.heartbeat
      .mockImplementationOnce(() => new Promise<boolean>(resolve => { resolveHeartbeat = resolve; }))
      .mockResolvedValue(true);

    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const extraction = makeExtraction();
    extraction.processDocument.mockImplementation(async () => { await gate; });
    const service = new DocumentProcessingService(jobs as never, extraction as never, makeEmbeddings() as never);

    const drain = service.drain(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(jobs.heartbeat).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(jobs.heartbeat).toHaveBeenCalledTimes(1);

    resolveHeartbeat(true);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(jobs.heartbeat).toHaveBeenCalledTimes(2);

    release();
    await drain;

    expect(jobs.complete).toHaveBeenCalledWith({ job, success: true });
  });

  it('clears its heartbeat timer after a job succeeds', async () => {
    vi.useFakeTimers();
    const jobs = makeJobs([makeJob()]);
    const service = new DocumentProcessingService(jobs as never, makeExtraction() as never, makeEmbeddings() as never);

    await service.drain(1);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(jobs.heartbeat).not.toHaveBeenCalled();
  });

  it('clears its heartbeat timer when a job fails', async () => {
    vi.useFakeTimers();
    const jobs = makeJobs([makeJob()]);
    const extraction = makeExtraction();
    extraction.processDocument.mockRejectedValue(new Error('boom'));
    const service = new DocumentProcessingService(jobs as never, extraction as never, makeEmbeddings() as never);

    await service.drain(1);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(jobs.complete).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
    expect(jobs.heartbeat).not.toHaveBeenCalled();
  });

  it('clears its heartbeat timer when the lease is lost', async () => {
    vi.useFakeTimers();
    const jobs = makeJobs([makeJob()]);
    const extraction = makeExtraction();
    extraction.processDocument.mockRejectedValue(new LeaseLostError());
    const service = new DocumentProcessingService(jobs as never, extraction as never, makeEmbeddings() as never);

    await service.drain(1);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(jobs.complete).not.toHaveBeenCalled();
    expect(jobs.heartbeat).not.toHaveBeenCalled();
  });

  it('drains at most the requested number of jobs and stops when the queue is empty', async () => {
    const first = makeJob({ id: 'job-1', documentId: 'doc-1' });
    const second = makeJob({ id: 'job-2', documentId: 'doc-2', fencingToken: 2 });
    const jobs = makeJobs([first, second, null]);
    const extraction = makeExtraction();
    const embeddings = makeEmbeddings();
    const service = new DocumentProcessingService(jobs as never, extraction as never, embeddings as never);

    await service.drain(2);

    expect(jobs.claimNext).toHaveBeenCalledTimes(2);
    expect(extraction.processDocument).toHaveBeenCalledTimes(2);
    expect(jobs.complete).toHaveBeenCalledTimes(2);
  });

  it('serializes overlapping drains so the same queued work is not claimed twice', async () => {
    const job = makeJob();
    const jobs = makeJobs([job, null]);
    const extraction = makeExtraction();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    extraction.processDocument.mockImplementation(async () => { await gate; });
    const embeddings = makeEmbeddings();
    const service = new DocumentProcessingService(jobs as never, extraction as never, embeddings as never);

    const first = service.drain(1);
    const second = service.drain(1);
    release();
    await Promise.all([first, second]);

    expect(jobs.claimNext).toHaveBeenCalledTimes(2);
    expect(jobs.complete).toHaveBeenCalledTimes(1);
  });

  it('schedule enqueues the document and kicks a drain', async () => {
    const jobs = makeJobs([makeJob()]);
    const extraction = makeExtraction();
    const embeddings = makeEmbeddings();
    const service = new DocumentProcessingService(jobs as never, extraction as never, embeddings as never);

    service.schedule('doc-1');
    await vi.waitFor(() => expect(jobs.complete).toHaveBeenCalledTimes(1));

    expect(jobs.enqueue).toHaveBeenCalledWith('doc-1', 4);
    expect(extraction.processDocument).toHaveBeenCalled();
  });

  it('enqueues orphaned documents before draining', async () => {
    const jobs = makeJobs([null]);
    jobs.findOrphanDocumentIds.mockResolvedValue(['doc-1', 'doc-2']);
    const service = new DocumentProcessingService(jobs as never, makeExtraction() as never, makeEmbeddings() as never);

    await service.enqueueOrphans(20);

    expect(jobs.findOrphanDocumentIds).toHaveBeenCalledWith(20);
    expect(jobs.enqueue).toHaveBeenNthCalledWith(1, 'doc-1', 4);
    expect(jobs.enqueue).toHaveBeenNthCalledWith(2, 'doc-2', 4);
  });
});
