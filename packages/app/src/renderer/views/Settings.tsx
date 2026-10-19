import { useState } from 'react';
import { call } from '../api';
import { useApp } from '../context';
import { useQuery } from '../hooks';
import {
  Badge,
  ConfirmDialog,
  CopyButton,
  Dialog,
  Disclosure,
  ErrorBox,
  Field,
  IsolationBadge,
  Loading,
  Safe,
} from '../components/ui';
import { CachesSection } from '../components/CachesSection';
import {
  CheckItem,
  DetailLines,
  DoctorBanner,
  NoteList,
  detailLinesOf,
  severityOf,
} from '../components/DoctorChecks';
import { SnapshotsSection } from '../components/SnapshotsSection';
import { LOCALES, NOTIFICATION_KINDS } from '../../shared/constants';
import type { Locale, NotificationKind, NotificationPrefs } from '../../shared/ipc';
import type {
  BackendReport,
  DoctorCheck,
  DoctorReport,
  DoctorSeverity,
  ReconcileReport,
} from '../../shared/types';
import { formatTimestamp, safeInline, safeText } from '../../shared/format';

export function SettingsView() {
  const { t, locale, setLocale, info, notify } = useApp();
  const [closeToTray, setCloseToTray] = useState(info.closeToTray);
  async function changeCloseToTray(on: boolean) {
    setCloseToTray(on);
    try {
      await call('app:settings', { closeToTray: on });
    } catch (e) {
      setCloseToTray(!on);
      notify('error', (e as Error).message);
    }
  }
  const [notifications, setNotifications] = useState<NotificationPrefs>(info.notifications);
  async function changeNotification(kind: NotificationKind, on: boolean) {
    setNotifications((n) => ({ ...n, [kind]: on }));
    try {
      const saved = await call('app:settings', { notifications: { [kind]: on } });
      setNotifications(saved.notifications);
    } catch (e) {
      setNotifications((n) => ({ ...n, [kind]: !on }));
      notify('error', (e as Error).message);
    }
  }
  return (
    <section aria-labelledby="h-settings">
      <header className="page-head">
        <h1 id="h-settings">{t('settings.title')}</h1>
      </header>
      <h2>{t('settings.general')}</h2>
      <div className="form-grid">
        <Field label={t('settings.language')}>
          {(id) => (
            <select id={id} value={locale} onChange={(e) => setLocale(e.target.value as Locale)}>
              {LOCALES.map((l) => (
                <option key={l} value={l}>
                  {t(`settings.lang.${l}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <div className="field">
          <label className="inline">
            <input
              type="checkbox"
              checked={closeToTray}
              disabled={!info.trayAvailable}
              aria-describedby="close-to-tray-hint"
              onChange={(e) => void changeCloseToTray(e.target.checked)}
            />
            {t('settings.closeToTray')}
          </label>
          <small id="close-to-tray-hint" className="muted">
            {info.trayAvailable ? t('settings.closeToTrayHint') : t('settings.closeToTrayNoTray')}
          </small>
        </div>
      </div>
      <dl className="kv-list">
        <dt>{t('settings.tray')}</dt>
        <dd>{info.trayAvailable ? t('common.yes') : t('settings.trayMissing')}</dd>
        <dt>{t('settings.notifications')}</dt>
        <dd>
          {info.notificationsAvailable ? t('common.yes') : t('settings.notificationsMissing')}
        </dd>
        {info.paths ? (
          <>
            <dt>{t('settings.paths')}</dt>
            <dd className="plain">
              <div>{info.paths.configDir}</div>
              <div>{info.paths.dataDir}</div>
            </dd>
          </>
        ) : null}
      </dl>
      <h2 id="h-notifications">{t('settings.notifications.title')}</h2>
      <p className="muted" id="notifications-hint">
        {info.notificationsAvailable
          ? t('settings.notifications.hint')
          : t('settings.notifications.unavailable')}
      </p>
      <div className="form-grid" role="group" aria-labelledby="h-notifications">
        {NOTIFICATION_KINDS.map((kind) => (
          <div key={kind} className="field">
            <label className="inline">
              <input
                type="checkbox"
                checked={notifications[kind]}
                aria-describedby={`notify-${kind}-hint`}
                onChange={(e) => void changeNotification(kind, e.target.checked)}
              />
              {t(`settings.notifications.${kind}`)}
            </label>
            <small id={`notify-${kind}-hint`} className="muted">
              {t(`settings.notifications.${kind}.hint`)}
            </small>
          </div>
        ))}
      </div>
      <DiagnosticsSection />
      <CachesSection />
      <SnapshotsSection />
      <McpStatusSection />
      <McpSection />
      <TokensSection />
    </section>
  );
}

// -- diagnostics ---------------------------------------------------------------------------------------------

function DiagnosticsSection() {
  const { t, notify } = useApp();
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [rec, setRec] = useState<ReconcileReport | null>(null);
  const [applyAsk, setApplyAsk] = useState(false);

  const doctor = useQuery('doctor:run', undefined, { live: false, pollMs: 30000 });
  const data = report ?? doctor.data;

  async function runDoctor() {
    setBusy(true);
    setError(undefined);
    try {
      setReport(await call('doctor:run'));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  async function reconcile(apply: boolean) {
    setBusy(true);
    setError(undefined);
    setApplyAsk(false);
    try {
      const r = await call('reconcile:run', apply ? { apply: true } : {});
      setRec(r);
      if (apply) notify('ok', t('settings.reconcile.applied'));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h2>{t('settings.diagnostics')}</h2>
      <div className="actions">
        <button type="button" onClick={() => void runDoctor()} disabled={busy}>
          {t('settings.doctor.run')}
        </button>
        <button type="button" onClick={() => void reconcile(false)} disabled={busy}>
          {t('settings.reconcile.check')}
        </button>
      </div>
      {error ? <ErrorBox error={error} /> : null}
      {doctor.loading && !data ? <Loading /> : null}
      {doctor.error && !data ? <ErrorBox error={doctor.error} /> : null}
      {data ? (
        <>
          <DoctorBanner report={data} />
          <h3>{t('settings.backends')}</h3>
          <div className="table-wrap">
            <table>
              <caption className="sr-only">{t('settings.backends')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('sandboxes.col.host')}</th>
                  <th scope="col">{t('sandboxes.col.backend')}</th>
                  <th scope="col">{t('sandboxes.col.state')}</th>
                  <th scope="col">{t('settings.backend.details')}</th>
                </tr>
              </thead>
              <tbody>
                {data.backends.map((b) => (
                  <BackendRow key={`${b.host}/${b.backend}`} backend={b} report={data} />
                ))}
              </tbody>
            </table>
          </div>
          <h3>{t('settings.checks')}</h3>
          <ul className="checks">
            {data.checks
              .filter((c) => !shownInBackends(c, data))
              .map((c) => (
                <CheckItem key={c.id} check={c} />
              ))}
          </ul>
        </>
      ) : null}

      {rec ? (
        <>
          <h3>{t('settings.reconcile.title')}</h3>
          <dl className="kv-list">
            <dt>{t('settings.reconcile.orphans')}</dt>
            <dd>{rec.orphans.length}</dd>
            <dt>{t('settings.reconcile.ghosts')}</dt>
            <dd>{rec.ghosts.length}</dd>
            <dt>{t('settings.reconcile.interrupted')}</dt>
            <dd>{rec.interrupted.length}</dd>
            <dt>{t('settings.reconcile.expired')}</dt>
            <dd>{rec.expired.length}</dd>
            <dt>{t('settings.reconcile.unreachable')}</dt>
            <dd>{rec.unreachable.length}</dd>
          </dl>
          {[...rec.orphans, ...rec.ghosts, ...rec.interrupted].length > 0 ? (
            <ul className="plain-list">
              {[...rec.orphans, ...rec.ghosts, ...rec.interrupted].map((e) => (
                <li key={`${e.id}`} className="plain">
                  <code>{safeInline(e.id, 80)}</code> ({safeInline(e.backend, 30)}):{' '}
                  {safeText(e.detail)}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">{t('settings.reconcile.clean')}</p>
          )}
          {rec.ghosts.length + rec.interrupted.length > 0 ? (
            <button type="button" className="danger" onClick={() => setApplyAsk(true)}>
              {t('settings.reconcile.apply')}
            </button>
          ) : null}
        </>
      ) : null}
      {applyAsk ? (
        <ConfirmDialog
          title={t('settings.reconcile.apply')}
          confirmLabel={t('settings.reconcile.apply')}
          danger
          onClose={() => setApplyAsk(false)}
          onConfirm={() => void reconcile(true)}
        >
          <p>{t('settings.reconcile.confirm')}</p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}

function backendCheckOf(report: DoctorReport, b: BackendReport): DoctorCheck | undefined {
  return (
    report.checks.find((c) => c.id === `backend.${b.host}.${b.backend}`) ??
    (b.error ? report.checks.find((c) => c.id === `host.${b.host}`) : undefined)
  );
}

/** Checks that the Backends table already shows (one row per backend). */
function shownInBackends(c: DoctorCheck, report: DoctorReport): boolean {
  return report.backends.some((b) => c.id === `backend.${b.host}.${b.backend}`);
}

function BackendRow(props: { backend: BackendReport; report: DoctorReport }) {
  const { t } = useApp();
  const b = props.backend;
  const check = backendCheckOf(props.report, b);
  const available = b.available && b.status?.ok !== false;
  const severity: DoctorSeverity = check ? severityOf(check) : available ? 'ok' : 'error';
  const state = available
    ? severity === 'warning'
      ? { tone: 'warn' as const, label: t('settings.backend.degraded') }
      : { tone: 'ok' as const, label: t('settings.backend.ok') }
    : severity === 'info'
      ? { tone: 'neutral' as const, label: t('settings.backend.optionalMissing') }
      : { tone: 'danger' as const, label: t('settings.backend.unavailable') };
  const notes = available ? (check?.notes ?? []) : [];
  const lines = available ? [] : detailLinesOf(check);
  const reason = available ? undefined : (b.error ?? check?.hint);
  return (
    <tr>
      <td className="plain">{b.host}</td>
      <td className="plain">{b.backend}</td>
      <td>
        <Badge tone={state.tone}>{state.label}</Badge>
      </td>
      <td className="plain small">
        <div>
          {[b.status?.version, b.status?.rootless ? 'rootless' : undefined]
            .filter(Boolean)
            .join(' · ')}
          {reason ? safeInline(reason, 200) : null}
        </div>
        {b.capabilities ? (
          <div className="muted">
            {t('settings.backend.isolation', { level: t(`isolation.${b.capabilities.isolation}`) })}{' '}
            {b.capabilities.isolation === 'none' ? <IsolationBadge level="none" /> : null}
          </div>
        ) : null}
        {notes.length > 0 ? (
          <Disclosure label={t('settings.notes', { count: notes.length })}>
            <NoteList notes={notes} />
          </Disclosure>
        ) : null}
        {lines.length > 0 ? (
          <Disclosure label={t('settings.detailLines', { count: lines.length })}>
            <DetailLines lines={lines} />
          </Disclosure>
        ) : null}
      </td>
    </tr>
  );
}

// -- MCP status -------------------------------------------------------------------------------------------------

/**
 * Which agent contexts are configured, which HTTP tokens exist and when each agent last acted. The MCP server is
 * a separate process (stdio per agent or HTTP with tokens) that keeps no "running" flag in the shared state, so
 * the status shows what can be observed: the configuration, the tokens and the audit log.
 */
function McpStatusSection() {
  const { t, navigate } = useApp();
  const st = useQuery('mcp:status', undefined, { pollMs: 10000 });
  const s = st.data;
  return (
    <>
      <h2>{t('settings.mcpStatus')}</h2>
      <p className="muted">{t('settings.mcpStatus.hint')}</p>
      {st.error ? <ErrorBox error={st.error} /> : null}
      {!s && st.loading ? <Loading /> : null}
      {s ? (
        <>
          <dl className="kv-list" data-testid="mcp-summary">
            <dt>{t('settings.mcpStatus.contexts')}</dt>
            <dd>{s.contexts.length}</dd>
            <dt>{t('settings.mcpStatus.http')}</dt>
            <dd>
              {t('settings.mcpStatus.tokens', {
                active: s.tokens.active,
                revoked: s.tokens.revoked,
              })}
              {s.tokens.lastUsedAt
                ? ` · ${t('settings.mcpStatus.lastTokenUse', { time: formatTimestamp(s.tokens.lastUsedAt) })}`
                : ` · ${t('settings.mcpStatus.neverUsed')}`}
            </dd>
            <dt>{t('settings.mcpStatus.lastActivity')}</dt>
            <dd>
              {s.lastActivityAt ? formatTimestamp(s.lastActivityAt) : t('settings.mcpStatus.none')}
            </dd>
          </dl>
          {s.contexts.length === 0 ? (
            <p className="muted">{t('settings.mcpStatus.noContexts')}</p>
          ) : (
            <div className="table-wrap">
              <table>
                <caption className="sr-only">{t('settings.mcpStatus')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('policy.context')}</th>
                    <th scope="col">{t('policy.profile')}</th>
                    <th scope="col">{t('settings.mcpStatus.lastActivity')}</th>
                    <th scope="col">{t('settings.mcpStatus.activeTokens')}</th>
                    <th scope="col">{t('settings.tokens.lastUsed')}</th>
                    <th scope="col">{t('sandboxes.col.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {s.contexts.map((c) => (
                    <tr key={c.id}>
                      <th scope="row">
                        <Safe text={c.id} max={80} />
                      </th>
                      <td>
                        <Safe text={c.profile} max={80} />
                      </td>
                      <td>
                        {c.lastActivityAt ? (
                          <>
                            <span className="mono">{formatTimestamp(c.lastActivityAt)}</span>
                            <div className="muted small">
                              <code>{safeInline(c.lastAction ?? '', 80)}</code>
                            </div>
                          </>
                        ) : (
                          t('settings.mcpStatus.none')
                        )}
                      </td>
                      <td>{c.activeTokens}</td>
                      <td className="mono">
                        {c.lastTokenUseAt ? formatTimestamp(c.lastTokenUseAt) : '—'}
                      </td>
                      <td>
                        <button
                          type="button"
                          disabled={!c.lastActivityAt}
                          aria-label={t('settings.mcpStatus.showAuditNamed', {
                            name: safeInline(c.id, 60),
                          })}
                          onClick={() => navigate({ view: 'audit', actor: `agent:${c.id}` })}
                        >
                          {t('settings.mcpStatus.showAudit')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : null}
    </>
  );
}

// -- MCP ------------------------------------------------------------------------------------------------------

function McpSection() {
  const { t } = useApp();
  const [agent, setAgent] = useState<string | undefined>();
  const cfg = useQuery('mcp:config', agent ? { agent } : undefined, { live: false });
  return (
    <>
      <h2>{t('settings.mcp')}</h2>
      <p className="muted">{t('settings.mcp.hint')}</p>
      {cfg.error ? <ErrorBox error={cfg.error} /> : null}
      {cfg.data ? (
        <>
          <Field label={t('settings.mcp.agent')} hint={t('settings.mcp.agentHint')}>
            {(id) => (
              <select id={id} value={cfg.data!.agent} onChange={(e) => setAgent(e.target.value)}>
                {[...new Set([cfg.data!.agent, ...cfg.data!.contexts])].map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <h3 className="h-small">{t('settings.mcp.claude')}</h3>
          <pre className="code plain" tabIndex={0}>
            {cfg.data.claudeCommand}
          </pre>
          <CopyButton text={cfg.data.claudeCommand} label={t('settings.mcp.copyCommand')} />
          <h3 className="h-small">{t('settings.mcp.json')}</h3>
          <pre className="code plain" tabIndex={0}>
            {cfg.data.json}
          </pre>
          <CopyButton text={cfg.data.json} label={t('settings.mcp.copyJson')} />
        </>
      ) : null}
    </>
  );
}

// -- tokens -----------------------------------------------------------------------------------------------------

function TokensSection() {
  const { t, notify } = useApp();
  const tokens = useQuery('tokens:list', undefined, { live: false, pollMs: 10000 });
  const cfg = useQuery('mcp:config', undefined, { live: false });
  const [creating, setCreating] = useState(false);
  const [ctxId, setCtxId] = useState('');
  const [label, setLabel] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<unknown>();
  const [revoke, setRevoke] = useState<string | null>(null);
  const contexts = cfg.data?.contexts ?? [];

  async function create() {
    setError(undefined);
    try {
      const r = await call('tokens:create', { contextId: ctxId || contexts[0] || '', label });
      setCreated(r.token);
      setCreating(false);
      setLabel('');
      await tokens.reload();
    } catch (e) {
      setError(e);
    }
  }
  async function doRevoke(id: string) {
    setRevoke(null);
    try {
      await call('tokens:revoke', { id });
      notify('ok', t('settings.tokens.revoked'));
      await tokens.reload();
    } catch (e) {
      notify('error', (e as Error).message);
    }
  }

  return (
    <>
      <h2>{t('settings.tokens')}</h2>
      <p className="muted">{t('settings.tokens.hint')}</p>
      <div className="actions">
        <button type="button" onClick={() => setCreating(true)} disabled={contexts.length === 0}>
          {t('settings.tokens.create')}
        </button>
      </div>
      {contexts.length === 0 && cfg.data ? (
        <p className="muted">{t('settings.tokens.noContexts')}</p>
      ) : null}
      {tokens.error ? <ErrorBox error={tokens.error} /> : null}
      {tokens.data && tokens.data.length === 0 ? (
        <p className="muted">{t('settings.tokens.empty')}</p>
      ) : null}
      {tokens.data && tokens.data.length > 0 ? (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">{t('settings.tokens')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('settings.tokens.label')}</th>
                <th scope="col">{t('policy.context')}</th>
                <th scope="col">{t('settings.tokens.created')}</th>
                <th scope="col">{t('settings.tokens.lastUsed')}</th>
                <th scope="col">{t('sandboxes.col.state')}</th>
                <th scope="col">{t('sandboxes.col.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {tokens.data.map((k) => (
                <tr key={k.id}>
                  <th scope="row">
                    <Safe text={k.label} max={80} />
                  </th>
                  <td>
                    <Safe text={k.contextId} max={80} />
                  </td>
                  <td className="mono">{formatTimestamp(k.createdAt)}</td>
                  <td className="mono">{k.lastUsedAt ? formatTimestamp(k.lastUsedAt) : '—'}</td>
                  <td>
                    {k.revokedAt ? (
                      <Badge tone="neutral">{t('settings.tokens.revokedState')}</Badge>
                    ) : (
                      <Badge tone="ok">{t('settings.tokens.active')}</Badge>
                    )}
                  </td>
                  <td>
                    {!k.revokedAt ? (
                      <button
                        type="button"
                        className="danger"
                        aria-label={t('settings.tokens.revokeNamed', {
                          label: safeInline(k.label, 60),
                        })}
                        onClick={() => setRevoke(k.id)}
                      >
                        {t('settings.tokens.revoke')}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {creating ? (
        <Dialog
          title={t('settings.tokens.create')}
          onClose={() => setCreating(false)}
          footer={
            <>
              <button type="button" onClick={() => setCreating(false)}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="primary"
                disabled={label.trim() === ''}
                onClick={() => void create()}
              >
                {t('settings.tokens.create')}
              </button>
            </>
          }
        >
          <Field label={t('policy.context')}>
            {(id) => (
              <select
                id={id}
                value={ctxId || contexts[0] || ''}
                onChange={(e) => setCtxId(e.target.value)}
              >
                {contexts.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label={t('settings.tokens.label')}>
            {(id) => (
              <input
                id={id}
                type="text"
                maxLength={100}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            )}
          </Field>
          {error ? <ErrorBox error={error} /> : null}
        </Dialog>
      ) : null}
      {created ? (
        <Dialog
          title={t('settings.tokens.shownOnce')}
          onClose={() => setCreated(null)}
          footer={
            <button type="button" className="primary" onClick={() => setCreated(null)}>
              {t('common.close')}
            </button>
          }
        >
          <p>{t('settings.tokens.copyNow')}</p>
          <pre className="code plain" tabIndex={0}>
            {created}
          </pre>
          <CopyButton text={created} />
        </Dialog>
      ) : null}
      {revoke ? (
        <ConfirmDialog
          title={t('settings.tokens.revoke')}
          confirmLabel={t('settings.tokens.revoke')}
          danger
          onClose={() => setRevoke(null)}
          onConfirm={() => void doRevoke(revoke)}
        >
          <p>{t('settings.tokens.revokeConfirm')}</p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}
