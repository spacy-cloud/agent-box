import { useCallback, useEffect, useRef, useState } from 'react';
import { AppProvider, useApp } from './context';
import type { Route } from './context';
import { call } from './api';
import { Banner, ToastRegion } from './components/ui';
import type { AppInfo } from '../shared/types';
import type { Locale, ViewName } from '../shared/ipc';
import { OverviewView } from './views/Overview';
import { SandboxesView } from './views/Sandboxes';
import { ApprovalsView } from './views/Approvals';
import { DetailView } from './views/Detail';
import { AuditView } from './views/Audit';
import { PolicyView } from './views/Policy';
import { SettingsView } from './views/Settings';
import { TemplatesView } from './views/Templates';
import { SkillsView } from './views/Skills';
import { HostsView } from './views/Hosts';
import { SshPanel, SshTabsProvider, useSshTabs } from './views/ssh-tabs';
import { AskpassHost } from './components/AskpassDialog';
import { SetupWizardHost } from './components/setup/SetupWizard';
import { ShortcutsDialog } from './components/ShortcutsDialog';
import { useShortcuts } from './shortcuts';
import logoMark from './assets/logo-mark.png';

const NAV: Array<{ view: Exclude<ViewName, 'detail'>; key: string }> = [
  { view: 'overview', key: 'nav.overview' },
  { view: 'sandboxes', key: 'nav.sandboxes' },
  { view: 'templates', key: 'nav.templates' },
  { view: 'skills', key: 'nav.skills' },
  { view: 'hosts', key: 'nav.hosts' },
  { view: 'approvals', key: 'nav.approvals' },
  { view: 'audit', key: 'nav.audit' },
  { view: 'policy', key: 'nav.policy' },
  { view: 'settings', key: 'nav.settings' },
];

export function App(props: { info: AppInfo }) {
  const [locale, setLocaleState] = useState<Locale>(props.info.locale);
  const [route, setRoute] = useState<Route>({ view: 'overview' });
  const [tick, setTick] = useState(0);
  const [pending, setPending] = useState(0);
  // The first-run wizard opens by itself until it was finished or skipped; Settings opens it again.
  const [setupOpen, setSetupOpen] = useState(
    props.info.showSetupWizard && props.info.managerError === null,
  );

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    document.documentElement.lang = l;
    void call('app:setLocale', l).catch(() => undefined);
  }, []);

  useEffect(() => {
    const offChanged = window.abox.on('evt:changed', (ev) => {
      setTick(ev.tick);
      setPending(ev.pendingApprovals);
    });
    const offNav = window.abox.on('evt:navigate', (ev) => {
      setRoute({
        view: ev.view,
        ...(ev.approvalId ? { approvalId: ev.approvalId } : {}),
        ...(ev.sandboxId ? { sandboxId: ev.sandboxId } : {}),
      });
    });
    return () => {
      offChanged();
      offNav();
    };
  }, []);

  return (
    <AppProvider
      info={props.info}
      locale={locale}
      setLocale={setLocale}
      route={route}
      navigate={setRoute}
      tick={tick}
      pendingApprovals={pending}
      setupOpen={setupOpen}
      setSetupOpen={setSetupOpen}
    >
      <SshTabsProvider>
        <Shell />
      </SshTabsProvider>
    </AppProvider>
  );
}

function Shell() {
  const { t, route, navigate, pendingApprovals, info } = useApp();
  const ssh = useSshTabs();
  const mainRef = useRef<HTMLElement>(null);
  const [helpOpen, setHelpOpen] = useState(false);

  // Single-key shortcuts (`n`, `/`, `?`); they stay quiet while typing, in dialogs, menus and terminals.
  useShortcuts({
    onNew: () => navigate({ view: 'sandboxes', create: true }),
    onHelp: () => setHelpOpen(true),
  });

  // After a view change move focus to the view heading's container so keyboard/screen reader users
  // start at the new content (not at the nav). Skipped on first render.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    mainRef.current?.focus({ preventScroll: true });
  }, [route.view, route.sandboxId]);

  const active: ViewName = route.view;
  return (
    <div className="app">
      <nav className="sidebar" aria-label={t('nav.label')}>
        <div className="brand">
          <img src={logoMark} alt="" width={28} height={28} />
          <span>abox</span>
        </div>
        <ul>
          {NAV.map((n) => (
            <li key={n.view}>
              <button
                type="button"
                className="navbtn"
                aria-current={
                  active === n.view || (active === 'detail' && n.view === 'sandboxes')
                    ? 'page'
                    : undefined
                }
                onClick={() => navigate({ view: n.view })}
              >
                <span>{t(n.key)}</span>
                {n.view === 'hosts' && ssh.tabs.length > 0 ? (
                  <span
                    className="count"
                    aria-label={t('hosts.openTerminals', { count: ssh.tabs.length })}
                  >
                    {ssh.tabs.length}
                  </span>
                ) : null}
                {n.view === 'approvals' && pendingApprovals > 0 ? (
                  <span
                    className="count"
                    aria-label={t('approvals.pending', { count: pendingApprovals })}
                  >
                    {pendingApprovals}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
        <div className="sidebar-foot muted">
          <button
            type="button"
            className="linklike sidebar-help"
            title={t('shortcuts.openHint')}
            onClick={() => setHelpOpen(true)}
          >
            {t('shortcuts.open')}
          </button>
          <span>{t('app.actingAs', { context: info.contextId })}</span>
          <span>v{info.version}</span>
        </div>
      </nav>
      <main ref={mainRef} tabIndex={-1} className="content" aria-label={t('app.content')}>
        {info.managerError ? (
          <Banner tone="danger" role="alert">
            <strong>{t('app.managerError')}</strong>
            <div className="plain">{info.managerError}</div>
          </Banner>
        ) : null}
        {active === 'overview' ? <OverviewView /> : null}
        {active === 'sandboxes' ? <SandboxesView /> : null}
        {active === 'templates' ? <TemplatesView /> : null}
        {active === 'skills' ? <SkillsView /> : null}
        {active === 'hosts' ? <HostsView /> : null}
        <SshPanel visible={active === 'hosts'} />
        {active === 'approvals' ? <ApprovalsView /> : null}
        {active === 'detail' && route.sandboxId ? (
          <DetailView key={route.sandboxId} id={route.sandboxId} />
        ) : null}
        {active === 'audit' ? <AuditView /> : null}
        {active === 'policy' ? <PolicyView /> : null}
        {active === 'settings' ? <SettingsView /> : null}
      </main>
      <AskpassHost />
      <SetupWizardHost />
      {helpOpen ? <ShortcutsDialog onClose={() => setHelpOpen(false)} /> : null}
      <ToastRegion />
    </div>
  );
}
