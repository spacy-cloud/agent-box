import { useCallback, useEffect, useRef, useState } from 'react';
import { call } from './api';
import { useApp } from './context';
import type { IpcChannel, IpcError, IpcInput } from '../shared/ipc';
import type { IpcOutput } from '../shared/types';
import type { ResourceUsage } from '@abox/core';

export interface QueryState<T> {
  data: T | undefined;
  error: IpcError | undefined;
  loading: boolean;
  /** When `data` was last fetched successfully (epoch ms); undefined before the first answer. */
  updatedAt: number | undefined;
  reload(): Promise<void>;
}

export interface QueryOptions {
  /** Refetch every N ms (cross-process changes the main process cannot see). */
  pollMs?: number;
  enabled?: boolean;
  /** Refetch when the main process reports a change (default true). */
  live?: boolean;
}

/**
 * Fetches one channel; keeps the previous data while reloading (no flicker), refetches on live
 * `evt:changed` ticks and on an optional poll interval, ignores out-of-order responses.
 */
export function useQuery<C extends IpcChannel>(
  channel: C,
  input?: IpcInput<C>,
  opts: QueryOptions = {},
): QueryState<IpcOutput<C>> {
  const { tick } = useApp();
  const { pollMs, enabled = true, live = true } = opts;
  const [data, setData] = useState<IpcOutput<C>>();
  const [error, setError] = useState<IpcError>();
  const [loading, setLoading] = useState(enabled);
  const [updatedAt, setUpdatedAt] = useState<number>();
  const seq = useRef(0);
  const mounted = useRef(true);
  const key = JSON.stringify(input ?? null);
  const inputRef = useRef(input);
  inputRef.current = input;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const res = await call(channel, inputRef.current);
      if (mounted.current && mine === seq.current) {
        setData(res);
        setUpdatedAt(Date.now());
        setError(undefined);
      }
    } catch (e) {
      if (mounted.current && mine === seq.current) setError(e as IpcError);
    } finally {
      if (mounted.current && mine === seq.current) setLoading(false);
    }
  }, [channel, key]);

  useEffect(() => {
    if (enabled) void reload();
  }, [enabled, reload, live ? tick : 0]);

  useEffect(() => {
    if (!enabled || !pollMs) return;
    const id = setInterval(() => void reload(), pollMs);
    return () => clearInterval(id);
  }, [enabled, pollMs, reload]);

  return { data, error, loading, updatedAt, reload };
}

/** A clock that ticks every `ms` (default 1 s) so countdowns advance without refetching. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

export type UsageMap = Record<string, ResourceUsage>;

/**
 * Live cpu / memory of the given sandboxes (pass only the ones that are visible and running).
 * Polls `sandboxes:stats` every `intervalMs` while the window is visible; a hidden window stops the
 * poll and refreshes once when it comes back. No overlapping calls (a sample takes about a second).
 * Sandboxes the backend gives no data for are simply absent from the result.
 */
export function useSandboxUsage(ids: string[], intervalMs = 5000): UsageMap {
  const [usage, setUsage] = useState<UsageMap>({});
  const key = [...new Set(ids)].sort().join('\n');
  useEffect(() => {
    const wanted = key === '' ? [] : key.split('\n');
    if (wanted.length === 0) {
      setUsage((u) => (Object.keys(u).length === 0 ? u : {}));
      return;
    }
    let cancelled = false;
    let inFlight = false;
    const visible = (): boolean => document.visibilityState !== 'hidden';
    const sample = async (): Promise<void> => {
      if (inFlight || cancelled || !visible()) return;
      inFlight = true;
      try {
        const res = await call('sandboxes:stats', { ids: wanted });
        if (!cancelled) setUsage(res.usage ?? {});
      } catch {
        if (!cancelled) setUsage({}); // no data is better than stale numbers
      } finally {
        inFlight = false;
      }
    };
    void sample();
    const timer = setInterval(() => void sample(), intervalMs);
    const onVisibility = (): void => {
      if (visible()) void sample();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [key, intervalMs]);
  return usage;
}
