import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { AppProvider } from '../../src/renderer/context';
import type { Route } from '../../src/renderer/context';
import type { AppInfo } from '../../src/shared/types';
import type { Locale } from '../../src/shared/constants';

export const INFO: AppInfo = {
  version: '0.0.0-test',
  platform: 'linux',
  contextId: 'human',
  locale: 'de',
  paths: null,
  trayAvailable: false,
  notificationsAvailable: false,
  closeToTray: false,
  managerError: null,
};

export type InvokeFn = (
  channel: string,
  input?: unknown,
) => Promise<{ ok: true; data: unknown } | { ok: false; error: { code: string; message: string } }>;

/** Installs `window.abox` with a scripted `invoke` and returns the recorded calls. */
export function installBridge(
  handler: (channel: string, input: unknown) => unknown,
): Array<{ channel: string; input: unknown }> {
  const calls: Array<{ channel: string; input: unknown }> = [];
  const invoke: InvokeFn = (channel, input) => {
    calls.push({ channel, input });
    try {
      return Promise.resolve({ ok: true as const, data: handler(channel, input) });
    } catch (e) {
      return Promise.resolve({
        ok: false as const,
        error: { code: 'internal', message: (e as Error).message },
      });
    }
  };
  (window as unknown as { abox: unknown }).abox = { invoke, on: () => () => undefined };
  return calls;
}

export function renderApp(
  ui: ReactElement,
  opts: { locale?: Locale; route?: Route; navigate?: (r: Route) => void } = {},
) {
  return render(
    <AppProvider
      info={INFO}
      locale={opts.locale ?? 'de'}
      setLocale={() => undefined}
      route={opts.route ?? { view: 'sandboxes' }}
      navigate={opts.navigate ?? (() => undefined)}
      tick={0}
      pendingApprovals={0}
    >
      {ui}
    </AppProvider>,
  );
}
