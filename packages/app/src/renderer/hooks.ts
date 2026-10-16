import { useCallback, useEffect, useRef, useState } from 'react';
import { call } from './api';
import { useApp } from './context';
import type { IpcChannel, IpcError, IpcInput } from '../shared/ipc';
import type { IpcOutput } from '../shared/types';

export interface QueryState<T> {
  data: T | undefined;
  error: IpcError | undefined;
  loading: boolean;
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

  return { data, error, loading, reload };
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
