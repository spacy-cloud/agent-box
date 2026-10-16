import { AboxError, parseDuration } from '@abox/core';
import type { Abox, Caller } from '@abox/core';
import { invalidInput } from './results.js';

export interface McpLimits {
  /** Hard deadline for one tool call in ms (approval waits, image builds and execs included). Default 15 min. */
  callTimeoutMs?: number;
  /** Cap per output stream / file read / log read in bytes. Default: the manager's `limits.execMaxOutputBytes` (64 KiB). */
  maxOutputBytes?: number;
  /** How long a call waits for a human decision, ms. Default: the manager's `limits.approvalWaitMs`. */
  approvalWaitMs?: number;
}

export interface ResolvedLimits {
  callTimeoutMs: number;
  maxOutputBytes: number;
  approvalWaitMs: number | undefined;
}

export const DEFAULT_CALL_TIMEOUT_MS = 15 * 60_000;

export function resolveLimits(abox: Abox, limits: McpLimits = {}): ResolvedLimits {
  return {
    callTimeoutMs: limits.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
    maxOutputBytes: limits.maxOutputBytes ?? abox.config.limits.execMaxOutputBytes,
    approvalWaitMs: limits.approvalWaitMs,
  };
}

/** Everything a tool handler needs; `caller` is fixed per connection and never comes from tool arguments. */
export interface Runtime {
  abox: Abox;
  caller: Caller;
  signal: AbortSignal;
  limits: ResolvedLimits;
  /** Best effort MCP progress notification (only when the client asked for progress). */
  progress: (message: string) => void;
}

/**
 * Await `p`, but give up when `signal` aborts. The underlying operation keeps its own cancellation
 * through the same signal (passed to the manager); this only guarantees the tool call returns.
 */
export function raceSignal<T>(p: Promise<T>, signal: AbortSignal, deadlineMs: number): Promise<T> {
  const fail = (): AboxError =>
    new AboxError(
      'timeout',
      signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError'
        ? `the call exceeded the server-side time limit of ${Math.round(deadlineMs / 1000)}s`
        : 'the call was cancelled',
      {
        hint: 'The operation may still be running inside the sandbox. Check with sandbox_inspect or sandbox_process_logs; for long work use sandbox_process_start.',
      },
    );
  if (signal.aborted) {
    p.catch(() => undefined);
    return Promise.reject(fail());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(fail());
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/**
 * Duration from an agent: a number is SECONDS, a string is `30s`/`15m`/`2h`/`1h30m` (a bare numeric string
 * is seconds too). Returns milliseconds.
 */
export function durationMs(value: string | number, field: string): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0)
      throw invalidInput(`${field} must be greater than zero`);
    return Math.max(1, Math.round(value * 1000));
  }
  const s = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(s)) return durationMs(Number(s), field);
  try {
    return parseDuration(s);
  } catch (e) {
    throw invalidInput(
      `${field}: ${e instanceof Error ? e.message : String(e)}`,
      'Use seconds (e.g. 90) or a duration string such as 30s, 15m, 2h.',
    );
  }
}
