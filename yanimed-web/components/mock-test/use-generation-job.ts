"use client";

import { useCallback, useEffect, useState } from "react";
import {
  MockTestApiError,
  getGenerationJob,
  type GenerationJob,
} from "@/lib/mock-test-api";
import {
  GENERATION_POLL_MS,
  isTerminalGenerationState,
} from "@/lib/mock-test-generation";

export interface GenerationJobPolling {
  /** Latest full job, or null before the first successful read. */
  job: GenerationJob | null;
  /** Set only when polling had to stop because the job is gone. */
  error: MockTestApiError | null;
  /** True while retrying after a network failure. Last state is kept. */
  reconnecting: boolean;
  /** Restarts polling immediately, e.g. after a refused cancel. */
  refresh: () => void;
}

function toApiError(error: unknown): MockTestApiError {
  return error instanceof MockTestApiError
    ? error
    : new MockTestApiError("Something went wrong. Please try again.");
}

/**
 * Polls one generation job until it reaches a terminal state.
 * One request in flight at a time, and the timer is always cleared on unmount.
 */
export function useGenerationJob(jobId: string): GenerationJobPolling {
  const [job, setJob] = useState<GenerationJob | null>(null);
  const [error, setError] = useState<MockTestApiError | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);

  const refresh = useCallback(() => {
    setError(null);
    setRefreshToken((token) => token + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let stopped = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      if (cancelled || stopped || inFlight) return;
      inFlight = true;
      try {
        const next = await getGenerationJob(jobId);
        if (cancelled) return;
        setJob(next);
        setError(null);
        setReconnecting(false);
        if (isTerminalGenerationState(next.state)) stopped = true;
      } catch (caught) {
        if (cancelled) return;
        const api = toApiError(caught);
        if (api.status === 404) {
          // GENERATION_NOT_FOUND, or the flag was turned off.
          stopped = true;
          setError(api);
        } else {
          // Keep the last known state and try again on the next tick.
          setReconnecting(true);
        }
      } finally {
        inFlight = false;
        if (!cancelled && !stopped) {
          timer = setTimeout(() => void poll(), GENERATION_POLL_MS);
        }
      }
    };

    void poll();

    return () => {
      cancelled = true;
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [jobId, refreshToken]);

  return { job, error, reconnecting, refresh };
}
