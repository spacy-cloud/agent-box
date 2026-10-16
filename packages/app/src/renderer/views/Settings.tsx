import { useState } from 'react';
import { call } from '../api';
import { useApp } from '../context';
import { useQuery } from '../hooks';
import {
  Badge,
  Banner,
  ConfirmDialog,
  CopyButton,
  Dialog,
  ErrorBox,
  Field,
  Loading,
} from '../components/ui';
import { LOCALES } from '../../shared/constants';
import type { Locale } from '../../shared/ipc';
import type { DoctorReport, ReconcileReport } from '../../shared/types';
import { formatTimestamp } from '../../shared/format';

export function SettingsView() {
  const { t, locale, setLocale, info } = useApp();
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
      <DiagnosticsSection />
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
          <Banner tone={data.ok ? 'ok' : 'warn'}>
            {data.ok ? t('settings.doctor.ok') : t('settings.doctor.issues')}
          </Banner>
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
                  <tr key={`${b.host}/${b.backend}`}>
                    <td className="plain">{b.host}</td>
                    <td className="plain">{b.backend}</td>
                    <td>
                      <Badge tone={b.available && b.status?.ok !== false ? 'ok' : 'danger'}>
                        {b.available && b.status?.ok !== false
                          ? t('settings.backend.ok')
                          : t('settings.backend.unavailable')}
                      </Badge>
                    </td>
                    <td className="plain small">
                      {b.status?.version ? `${b.status.version}` : ''}
                      {b.status?.rootless ? ` · rootless` : ''}
                      {b.error ? ` ${b.error}` : ''}
                      {b.status?.warnings.map((w, i) => (
                        <div key={i} className="warn-text">
                          {w}
                        </div>
                      ))}
                      {b.capabilities ? (
                        <div className="muted">
                          {t('settings.backend.isolation', { level: b.capabilities.isolation })}
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3>{t('settings.checks')}</h3>
          <ul className="checks">
            {data.checks.map((c) => (
              <li key={c.id}>
                <Badge tone={c.level === 'ok' ? 'ok' : c.level === 'warn' ? 'warn' : 'danger'}>
                  {t(`settings.level.${c.level}`)}
                </Badge>{' '}
                <strong className="plain">{c.title}</strong>
                {c.detail ? <div className="plain muted small">{c.detail}</div> : null}
                {c.hint && c.level !== 'ok' ? <div className="plain small">{c.hint}</div> : null}
              </li>
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
                  <code>{e.id}</code> ({e.backend}): {e.detail}
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
                  <th scope="row" className="plain">
                    {k.label}
                  </th>
                  <td className="plain">{k.contextId}</td>
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
                        aria-label={t('settings.tokens.revokeNamed', { label: k.label })}
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
