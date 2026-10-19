import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Locale, ViewName } from '../shared/ipc';
import type { AppInfo } from '../shared/types';
import { safeInline } from '../shared/format';
import { translate } from './i18n';
import type { Params, TFn } from './i18n';

export interface Route {
  view: ViewName;
  sandboxId?: string;
  tab?: string;
  approvalId?: string;
  /** Detail view, activity tab: start with these kinds selected (`exec`, `file`, ...). */
  activityKinds?: string[];
  /** Audit view: start with this actor filter (e.g. coming from the MCP status). */
  actor?: string;
}

export interface Toast {
  id: number;
  kind: 'ok' | 'error' | 'info';
  text: string;
}

export interface AppContextValue {
  info: AppInfo;
  locale: Locale;
  setLocale(l: Locale): void;
  t: TFn;
  route: Route;
  navigate(r: Route): void;
  /** Increments whenever the main process reports a change (live updates). */
  tick: number;
  pendingApprovals: number;
  toasts: Toast[];
  notify(kind: Toast['kind'], text: string): void;
  dismissToast(id: number): void;
}

const Ctx = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside AppProvider');
  return v;
}

export function useT(): TFn {
  return useApp().t;
}

export function AppProvider(props: {
  info: AppInfo;
  locale: Locale;
  setLocale(l: Locale): void;
  route: Route;
  navigate(r: Route): void;
  tick: number;
  pendingApprovals: number;
  children: ReactNode;
}) {
  const { info, locale, setLocale, route, navigate, tick, pendingApprovals } = props;
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const dismissToast = useCallback(
    (id: number) => setToasts((l) => l.filter((x) => x.id !== id)),
    [],
  );
  const notify = useCallback(
    (kind: Toast['kind'], text: string) => {
      const id = nextId.current++;
      // Toasts often carry names or messages an agent chose: neutralised and shortened here, once for every caller.
      setToasts((l) => [...l.slice(-3), { id, kind, text: safeInline(text, 300) }]);
      if (kind !== 'error') setTimeout(() => dismissToast(id), 6000);
    },
    [dismissToast],
  );
  const t = useCallback((key: string, params?: Params) => translate(locale, key, params), [locale]);
  const value = useMemo<AppContextValue>(
    () => ({
      info,
      locale,
      setLocale,
      t,
      route,
      navigate,
      tick,
      pendingApprovals,
      toasts,
      notify,
      dismissToast,
    }),
    [
      info,
      locale,
      setLocale,
      t,
      route,
      navigate,
      tick,
      pendingApprovals,
      toasts,
      notify,
      dismissToast,
    ],
  );
  return <Ctx.Provider value={value}>{props.children}</Ctx.Provider>;
}
