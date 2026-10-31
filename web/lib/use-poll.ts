"use client";

import { useCallback, useEffect, useRef, useState, type DependencyList } from "react";

export interface PollState<T> {
  data: T | undefined;
  error: Error | undefined;
  /** true until the first response (or error) arrives; stays false during background refreshes */
  loading: boolean;
  refresh: () => Promise<void>;
}

/**
 * Poll `fetcher` every `intervalMs`, on window focus / tab becoming visible, and whenever `deps` change.
 * Pauses while the document is hidden. Keeps the last good `data` when a refetch fails.
 */
export function usePoll<T>(fetcher: () => Promise<T>, intervalMs: number, deps: DependencyList = []): PollState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const fetcherRef = useRef(fetcher);
  const runId = useRef(0);

  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  const refresh = useCallback(async () => {
    const id = ++runId.current;
    try {
      const result = await fetcherRef.current();
      if (id !== runId.current) return;
      setData(result);
      setError(undefined);
    } catch (e) {
      if (id !== runId.current) return;
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      if (id === runId.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const counter = runId;
    let timer: ReturnType<typeof setInterval> | undefined;
    const visible = () => document.visibilityState !== "hidden";
    const start = () => {
      if (timer === undefined && intervalMs > 0) timer = setInterval(() => void refresh(), intervalMs);
    };
    const stop = () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    };
    const onVisibility = () => {
      if (visible()) {
        void refresh();
        start();
      } else {
        stop();
      }
    };
    const onFocus = () => void refresh();

    void refresh();
    if (visible()) start();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    return () => {
      counter.current++; // drop in-flight results
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, refresh, ...deps]);

  return { data, error, loading, refresh };
}
