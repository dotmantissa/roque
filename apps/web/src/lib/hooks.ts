"use client";

/**
 * Two small hooks the dashboard leans on. `usePoll` runs an async read on an
 * interval and hands back the latest value with a loading flag, pausing when the
 * tab is hidden so we are not hammering the chain in a background tab. `useNow`
 * ticks once a second, for the live countdown on a capability window. Nothing
 * fancy, just the plumbing every live panel would otherwise rewrite.
 */

import { useCallback, useEffect, useRef, useState } from "react";

// A tiny shim so this file reads cleanly even though React exports useCallback
// directly; keeps the import list honest.
function useCallbackShim<T extends (...args: never[]) => unknown>(fn: T, deps: unknown[]): T {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useCallback(fn, deps);
}

export interface PollState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function usePoll<T>(
  fetcher: (() => Promise<T>) | null,
  intervalMs: number,
  deps: unknown[] = [],
): PollState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState<boolean>(Boolean(fetcher));
  const [error, setError] = useState<string | null>(null);
  const savedFetcher = useRef(fetcher);
  savedFetcher.current = fetcher;

  const run = useCallbackShim(async () => {
    const f = savedFetcher.current;
    if (!f) {
      setData(null);
      setLoading(false);
      return;
    }
    try {
      const next = await f();
      setData(next);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const tick = () => {
      if (document.visibilityState === "visible" && !stopped) void run();
    };

    setLoading(Boolean(savedFetcher.current));
    void run();
    timer = setInterval(tick, intervalMs);

    const onVisible = () => {
      if (document.visibilityState === "visible") void run();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, run]);

  return { data, loading, error, refresh: run };
}

/** A once-a-second clock, in unix seconds, for live countdowns. */
export function useNow(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}
