import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
import { useApp } from '../context';
import { TerminalPane, hostColor } from '../components/Terminal';
import type { HostProfile } from '../../shared/types';

export interface SshTab {
  key: string;
  host: string;
  /** `user@host`, shown next to the zone. */
  target: string;
  zone: string;
  /** 1 for the first session on a host, then 2, 3 … */
  n: number;
}

interface SshTabsValue {
  tabs: SshTab[];
  active: string | null;
  open(profile: HostProfile): void;
  close(key: string): void;
  select(key: string): void;
}

const Ctx = createContext<SshTabsValue | null>(null);

export function useSshTabs(): SshTabsValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSshTabs outside SshTabsProvider');
  return v;
}

function targetOf(p: HostProfile): string {
  const dest = p.sshConfigAlias ?? p.hostname ?? p.id;
  return `${p.user ? `${p.user}@` : ''}${dest}${p.port && p.port !== 22 ? `:${p.port}` : ''}`;
}

/** The ssh terminal tabs live above the views so a session survives switching to another view. */
export function SshTabsProvider(props: { children: ReactNode }) {
  const [tabs, setTabs] = useState<SshTab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const counter = useRef(0);

  const open = useCallback((p: HostProfile) => {
    const key = `ssh-${++counter.current}`;
    setTabs((list) => [
      ...list,
      {
        key,
        host: p.id,
        target: targetOf(p),
        zone: p.zone,
        n: list.filter((x) => x.host === p.id).length + 1,
      },
    ]);
    setActive(key);
  }, []);
  const close = useCallback((key: string) => {
    setTabs((list) => {
      const i = list.findIndex((x) => x.key === key);
      const next = list.filter((x) => x.key !== key);
      setActive((a) => (a === key ? (next[Math.min(i, next.length - 1)]?.key ?? null) : a));
      return next;
    });
  }, []);
  const value = useMemo<SshTabsValue>(
    () => ({ tabs, active, open, close, select: setActive }),
    [tabs, active, open, close],
  );
  return <Ctx.Provider value={value}>{props.children}</Ctx.Provider>;
}

/**
 * Terminal tabs for ssh sessions. Every session has its own colour (stable per host), the text "SSH", the
 * `user@host` and the zone in its header, so a server terminal cannot be mistaken for a local one.
 */
export function SshPanel(props: { visible: boolean }) {
  const { t } = useApp();
  const { tabs, active, close, select } = useSshTabs();
  if (tabs.length === 0) return null;
  const activeTab = tabs.find((x) => x.key === active);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const idx = tabs.findIndex((x) => x.key === active);
    let next: number;
    if (e.key === 'ArrowRight') next = (idx + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (idx - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    else if (e.key === 'Delete' && active) {
      e.preventDefault();
      close(active);
      return;
    } else return;
    e.preventDefault();
    const target = tabs[next];
    if (target) {
      select(target.key);
      requestAnimationFrame(() => document.getElementById(`ssh-tab-${target.key}`)?.focus());
    }
  };

  return (
    <section aria-labelledby="h-ssh" hidden={!props.visible} className="ssh-panel">
      <h2 id="h-ssh">{t('hosts.terminals')}</h2>
      <div className="ssh-bar">
        <div
          role="tablist"
          aria-label={t('hosts.terminals')}
          className="ssh-tabs"
          onKeyDown={onKey}
        >
          {tabs.map((tab) => (
            <button
              key={tab.key}
              id={`ssh-tab-${tab.key}`}
              type="button"
              role="tab"
              className="ssh-tab"
              data-active={tab.key === active}
              style={{ '--term-accent': hostColor(tab.host) } as CSSProperties}
              aria-selected={tab.key === active}
              aria-controls={`ssh-panel-${tab.key}`}
              tabIndex={tab.key === active ? 0 : -1}
              onClick={() => select(tab.key)}
            >
              <span className="ssh-dot" aria-hidden="true" />
              SSH {tab.host}
              {tab.n > 1 ? ` #${tab.n}` : ''}
            </button>
          ))}
        </div>
        {activeTab ? (
          <button type="button" onClick={() => close(activeTab.key)}>
            {t('hosts.closeTerminal', { host: activeTab.host })}
          </button>
        ) : null}
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.key}
          id={`ssh-panel-${tab.key}`}
          role="tabpanel"
          aria-labelledby={`ssh-tab-${tab.key}`}
          hidden={tab.key !== active}
        >
          <TerminalPane
            target={{ kind: 'ssh', host: tab.host }}
            visible={props.visible && tab.key === active}
            accent={hostColor(tab.host)}
            kindLabel={t('terminal.kind.ssh')}
            title={tab.host}
            subtitle={`${tab.target} · ${t(`hosts.zone.${tab.zone}`)}`}
          />
        </div>
      ))}
    </section>
  );
}
