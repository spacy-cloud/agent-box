import { useSyncExternalStore } from 'react';
import { call, errorMessage } from './api';
import { appendLine, finishLog, startLog } from '../shared/build-log';
import type { BuildLog } from '../shared/build-log';

/**
 * The last build log of every template, for the time the window is open (not persisted: a build log is not
 * worth keeping, and it may contain what the build printed). Starting a new build replaces the old log.
 */
const logs = new Map<string, BuildLog>();
const listeners = new Set<() => void>();

function set(name: string, log: BuildLog): void {
  logs.set(name, log);
  for (const l of listeners) l();
}

export const buildLogs = {
  get: (name: string): BuildLog | undefined => logs.get(name),
  start(name: string, update: boolean): void {
    set(name, startLog(Date.now(), update));
  },
  append(name: string, line: string): void {
    const cur = logs.get(name);
    if (cur?.status === 'running') set(name, appendLine(cur, line));
  },
  finish(name: string, end: Parameters<typeof finishLog>[1]): void {
    const cur = logs.get(name);
    if (cur) set(name, finishLog(cur, end));
  },
  /** Tests only. */
  clear(): void {
    logs.clear();
    for (const l of listeners) l();
  },
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

export function useBuildLog(name: string): BuildLog | undefined {
  return useSyncExternalStore(buildLogs.subscribe, () => buildLogs.get(name));
}

/**
 * Runs the build of a saved template and keeps its log in the store, whether or not a dialog is still on
 * screen to show it. The lines come from the manager already masked (credentials in the output); the store
 * only bounds and neutralises them. Resolves with the manager's result, rejects with its error.
 */
export async function runBuild(name: string, update: boolean) {
  if (logs.get(name)?.status === 'running') {
    throw new Error('a build of this template is already running');
  }
  const key = `build-${Math.random().toString(36).slice(2)}`;
  buildLogs.start(name, update);
  const off = window.abox.on('evt:progress', (ev) => {
    if (ev.key === key) buildLogs.append(name, ev.line);
  });
  try {
    const r = await call('templates:build', {
      name,
      progressKey: key,
      ...(update ? { update: true } : {}),
    });
    buildLogs.finish(name, {
      ok: true,
      now: Date.now(),
      image: r.image.ref,
      cached: r.cached,
      durationMs: r.durationMs,
    });
    return r;
  } catch (e) {
    buildLogs.finish(name, { ok: false, now: Date.now(), error: errorMessage(e) });
    throw e;
  } finally {
    off();
  }
}
