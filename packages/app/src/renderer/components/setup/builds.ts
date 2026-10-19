import { useCallback, useEffect, useRef, useState } from 'react';
import { call } from '../../api';
import { useApp } from '../../context';
import { safeInline } from '../../../shared/format';

export interface SetupBuild {
  name: string;
  status: 'queued' | 'running' | 'built' | 'cached' | 'failed';
  /** The last line of build output. */
  line?: string;
  error?: string;
}

/**
 * Builds the chosen templates one after the other through the normal build action (`templates:build`: network access
 * for the build, recorded in the audit log). It lives in the wizard host, not in the dialog, so the builds go on when
 * the wizard is closed and report through toasts. A template that is queued or running is not queued twice.
 */
export function useSetupBuilds(): {
  builds: SetupBuild[];
  start(names: string[]): void;
  active: boolean;
} {
  const { t, notify } = useApp();
  const [builds, setBuilds] = useState<SetupBuild[]>([]);
  const queue = useRef<string[]>([]);
  const running = useRef(false);
  const keys = useRef(new Map<string, string>());
  const tRef = useRef(t);
  tRef.current = t;
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  const patch = useCallback((name: string, change: Partial<SetupBuild>) => {
    setBuilds((list) => list.map((b) => (b.name === name ? { ...b, ...change } : b)));
  }, []);

  useEffect(
    () =>
      window.abox.on('evt:progress', (ev) => {
        const name = keys.current.get(ev.key);
        if (name) patch(name, { line: safeInline(ev.line, 160) });
      }),
    [patch],
  );

  const pump = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      for (let name = queue.current.shift(); name !== undefined; name = queue.current.shift()) {
        const key = `setup-build-${Math.random().toString(36).slice(2)}`;
        keys.current.set(key, name);
        patch(name, { status: 'running' });
        try {
          const r = await call('templates:build', { name, progressKey: key });
          patch(name, { status: r.cached ? 'cached' : 'built' });
          notifyRef.current('ok', tRef.current('tpl.build.done', { name }));
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          patch(name, { status: 'failed', error: safeInline(message, 300) });
          notifyRef.current('error', `${name}: ${message}`);
        } finally {
          keys.current.delete(key);
        }
      }
    } finally {
      running.current = false;
    }
  }, [patch]);

  const start = useCallback(
    (names: string[]) => {
      const busy = new Set(
        builds.filter((b) => b.status === 'queued' || b.status === 'running').map((b) => b.name),
      );
      const fresh = names.filter((n) => !busy.has(n));
      if (fresh.length === 0) return;
      setBuilds((list) => [
        ...list.filter((b) => !fresh.includes(b.name)),
        ...fresh.map((name): SetupBuild => ({ name, status: 'queued' })),
      ]);
      queue.current.push(...fresh);
      void pump();
    },
    [builds, pump],
  );

  return {
    builds,
    start,
    active: builds.some((b) => b.status === 'queued' || b.status === 'running'),
  };
}
