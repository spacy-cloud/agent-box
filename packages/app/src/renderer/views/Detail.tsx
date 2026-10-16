import { useEffect, useMemo, useState } from 'react';
import type { AuditEntry, DirEntry, ExportSandboxResult } from '@abox/core';
import { call } from '../api';
import { useApp } from '../context';
import { useNow, useQuery } from '../hooks';
import {
  Badge,
  Banner,
  ConfirmDialog,
  EmptyState,
  ErrorBox,
  Field,
  IsolationBadge,
  Loading,
  OwnerBadge,
  StateBadge,
  Tabs,
} from '../components/ui';
import { overviewRows } from '../../shared/overview';
import {
  formatBytes,
  formatDuration,
  formatTimestamp,
  remainingMs,
  shortId,
} from '../../shared/format';
import { ExtendDialog } from './Sandboxes';

const TABS = ['overview', 'terminal', 'activity', 'files', 'logs', 'snapshots'] as const;
type Tab = (typeof TABS)[number];

export function DetailView(props: { id: string }) {
  const { t, route, navigate, notify } = useApp();
  const q = useQuery('sandboxes:inspect', { id: props.id }, { pollMs: 4000 });
  const [tab, setTab] = useState<Tab>(
    (TABS as readonly string[]).includes(route.tab ?? '') ? (route.tab as Tab) : 'overview',
  );
  const [extend, setExtend] = useState(false);
  const [del, setDel] = useState(false);
  const [busy, setBusy] = useState(false);
  const now = useNow(1000);
  const s = q.data;

  async function run(fn: () => Promise<unknown>, okKey: string) {
    setBusy(true);
    try {
      await fn();
      notify('ok', t(okKey, { name: s?.name ?? '' }));
      await q.reload();
    } catch (e) {
      notify('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="h-detail">
      <p>
        <button type="button" className="linklike" onClick={() => navigate({ view: 'sandboxes' })}>
          &larr; {t('detail.back')}
        </button>
      </p>
      {q.error ? <ErrorBox error={q.error} /> : null}
      {q.loading && !s ? <Loading /> : null}
      {s ? (
        <>
          <header className="page-head">
            <div>
              <h1 id="h-detail" className="plain">
                {s.name}
              </h1>
              <div className="badges">
                <StateBadge state={s.state} stale={s.stale} />
                <OwnerBadge owner={s.owner} />
                <Badge tone="neutral">{s.backend}</Badge>
                <IsolationBadge level={s.isolation} />
                <span className="muted plain mono">{s.id}</span>
              </div>
            </div>
            <div className="actions">
              {s.state === 'running' ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(() => call('sandboxes:stop', { id: s.id }), 'sandboxes.stopped')
                  }
                >
                  {t('sandboxes.action.stop')}
                </button>
              ) : null}
              {s.state === 'stopped' || s.state === 'created' ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(() => call('sandboxes:start', { id: s.id }), 'sandboxes.started')
                  }
                >
                  {t('sandboxes.action.start')}
                </button>
              ) : null}
              <button type="button" onClick={() => setExtend(true)}>
                {t('sandboxes.action.extend')}
              </button>
              <button type="button" className="danger" onClick={() => setDel(true)}>
                {t('sandboxes.action.delete')}
              </button>
            </div>
          </header>
          {s.pendingApprovals > 0 ? (
            <Banner tone="warn">
              {t('detail.pendingApprovals', { count: s.pendingApprovals })}{' '}
              <button type="button" onClick={() => navigate({ view: 'approvals' })}>
                {t('nav.approvals')}
              </button>
            </Banner>
          ) : null}
          {s.error ? (
            <Banner tone="danger">
              <span className="plain">{s.error}</span>
            </Banner>
          ) : null}
          <Tabs
            label={t('detail.tabs')}
            active={tab}
            onChange={(x) => setTab(x as Tab)}
            tabs={TABS.map((id) => ({ id, label: t(`detail.tab.${id}`) }))}
          >
            {tab === 'overview' ? (
              <OverviewTab id={s.id} template={s.template} sandbox={s} now={now} />
            ) : null}
            {tab === 'terminal' ? <TerminalPlaceholder /> : null}
            {tab === 'activity' ? <ActivityTab id={s.id} /> : null}
            {tab === 'files' ? <FilesTab id={s.id} /> : null}
            {tab === 'logs' ? <LogsTab id={s.id} /> : null}
            {tab === 'snapshots' ? <SnapshotsTab id={s.id} /> : null}
          </Tabs>
          {extend ? (
            <ExtendDialog
              sandbox={s}
              onClose={() => setExtend(false)}
              onDone={() => {
                setExtend(false);
                void q.reload();
              }}
            />
          ) : null}
          {del ? (
            <ConfirmDialog
              title={t('sandboxes.delete.title')}
              confirmLabel={t('sandboxes.delete.confirm')}
              danger
              busy={busy}
              onClose={() => setDel(false)}
              onConfirm={() => {
                setBusy(true);
                void call('sandboxes:remove', { id: s.id }).then(
                  () => {
                    notify('ok', t('sandboxes.removed', { name: s.name }));
                    navigate({ view: 'sandboxes' });
                  },
                  (e: Error) => {
                    setBusy(false);
                    setDel(false);
                    notify('error', e.message);
                  },
                );
              }}
            >
              <p>{t('sandboxes.delete.text', { name: s.name })}</p>
              <p className="muted">{t('sandboxes.delete.hint')}</p>
            </ConfirmDialog>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

// -- overview -------------------------------------------------------------------------------------------

function OverviewTab(props: {
  id: string;
  template: string;
  sandbox: NonNullable<ReturnType<typeof useQuery<'sandboxes:inspect'>>['data']>;
  now: number;
}) {
  const { t } = useApp();
  const tpl = useQuery('templates:show', { name: props.template }, { live: false });
  const s = props.sandbox;
  const rows = useMemo(() => overviewRows(s, tpl.data?.template), [s, tpl.data]);
  const left = remainingMs(s.expiresAt, props.now);
  return (
    <>
      {rows.some((r) => r.deviates) ? <p className="muted">{t('detail.deviationsHint')}</p> : null}
      <table className="kv">
        <caption className="sr-only">{t('detail.tab.overview')}</caption>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={r.deviates ? (r.danger ? 'row-danger' : 'row-changed') : ''}>
              <th scope="row">{t(`detail.opt.${r.id}`)}</th>
              <td className="plain">
                {r.enumKey ? t(r.enumKey) : null}
                {r.values.length > 0 ? (
                  <ul className="plain-list">
                    {r.values.map((v) => (
                      <li key={v}>{v}</li>
                    ))}
                  </ul>
                ) : r.enumKey ? null : (
                  t('common.none')
                )}
                {r.deviates && r.noteKey ? (
                  <div className={r.danger ? 'danger-text small' : 'warn-text small'}>
                    <span aria-hidden="true">{'Δ '}</span>
                    {t(r.noteKey)}
                  </div>
                ) : null}
              </td>
            </tr>
          ))}
          <tr>
            <th scope="row">{t('detail.opt.remaining')}</th>
            <td className="mono">
              {s.state === 'expired' ? t('state.expired') : formatDuration(left)}
            </td>
          </tr>
          <tr>
            <th scope="row">{t('detail.opt.created')}</th>
            <td>{formatTimestamp(s.createdAt)}</td>
          </tr>
          <tr>
            <th scope="row">{t('detail.opt.template')}</th>
            <td className="plain">{s.template}</td>
          </tr>
          <tr>
            <th scope="row">{t('detail.opt.host')}</th>
            <td className="plain">{s.host}</td>
          </tr>
          <tr>
            <th scope="row">{t('detail.opt.processes')}</th>
            <td>{s.processes.length}</td>
          </tr>
        </tbody>
      </table>
    </>
  );
}

function TerminalPlaceholder() {
  const { t } = useApp();
  return <EmptyState title={t('detail.terminal.title')} text={t('detail.terminal.text')} />;
}

// -- activity -------------------------------------------------------------------------------------------

export function AuditTable(props: { entries: AuditEntry[]; onSandbox?: (id: string) => void }) {
  const { t } = useApp();
  return (
    <div className="table-wrap">
      <table>
        <caption className="sr-only">{t('audit.table')}</caption>
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">{t('audit.col.time')}</th>
            <th scope="col">{t('audit.col.actor')}</th>
            <th scope="col">{t('audit.col.action')}</th>
            <th scope="col">{t('audit.col.decision')}</th>
            {props.onSandbox ? <th scope="col">{t('audit.col.sandbox')}</th> : null}
            <th scope="col">{t('audit.col.details')}</th>
          </tr>
        </thead>
        <tbody>
          {props.entries.map((e) => (
            <tr key={e.seq}>
              <td className="mono">{e.seq}</td>
              <td className="mono nowrap">{formatTimestamp(e.ts)}</td>
              <td className="plain">{e.actor}</td>
              <td className="plain">
                <code>{e.action}</code>
              </td>
              <td>
                {e.decision ? (
                  <Badge
                    tone={
                      e.decision === 'deny' || e.decision === 'denied' || e.decision === 'error'
                        ? 'danger'
                        : e.decision === 'approval'
                          ? 'warn'
                          : 'neutral'
                    }
                  >
                    {t(`decision.${e.decision}`)}
                  </Badge>
                ) : (
                  '—'
                )}
              </td>
              {props.onSandbox ? (
                <td>
                  {e.sandboxId ? (
                    <button
                      type="button"
                      className="linklike plain"
                      onClick={() => props.onSandbox?.(e.sandboxId!)}
                    >
                      {e.sandboxId}
                    </button>
                  ) : (
                    '—'
                  )}
                </td>
              ) : null}
              <td>
                {e.details ? (
                  <details>
                    <summary>{summaryOf(e.details)}</summary>
                    <pre className="log plain">{JSON.stringify(e.details, null, 2)}</pre>
                  </details>
                ) : (
                  '—'
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function summaryOf(d: Record<string, unknown>): string {
  const keys = Object.keys(d).slice(0, 4);
  return keys.join(', ') || '{}';
}

function ActivityTab(props: { id: string }) {
  const { t } = useApp();
  const q = useQuery('audit:query', { sandboxId: props.id, limit: 200 }, { pollMs: 4000 });
  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data) return <Loading />;
  if (q.data.length === 0) return <p className="muted">{t('detail.activity.empty')}</p>;
  return <AuditTable entries={q.data} />;
}

// -- files ------------------------------------------------------------------------------------------------

function FilesTab(props: { id: string }) {
  const { t, notify } = useApp();
  const [path, setPath] = useState<string>('');
  const dir = useQuery('files:list', { id: props.id, ...(path ? { path } : {}) }, { live: false });
  const [exp, setExp] = useState<ExportSandboxResult | null>(null);
  const [expError, setExpError] = useState<unknown>();
  const [expBusy, setExpBusy] = useState(false);
  const [branch, setBranch] = useState(`abox/${shortId(props.id)}`);
  const [branchConfirm, setBranchConfirm] = useState(false);

  const entries = (dir.data ?? []) as DirEntry[];
  const parts = path.split('/').filter(Boolean);

  async function loadDiff() {
    setExpBusy(true);
    setExpError(undefined);
    try {
      setExp(await call('export:run', { id: props.id, format: 'diff' }));
    } catch (e) {
      setExpError(e);
    } finally {
      setExpBusy(false);
    }
  }

  async function save(format: 'diff' | 'patch') {
    try {
      const r = await call('export:save', { id: props.id, format });
      if (r.saved) notify('ok', t('detail.files.saved', { path: r.saved }));
    } catch (e) {
      notify('error', (e as Error).message);
    }
  }

  async function exportBranch() {
    setBranchConfirm(false);
    try {
      const r = await call('export:run', { id: props.id, format: 'branch', branchName: branch });
      notify('ok', t('detail.files.branchDone', { branch: r.branch ?? branch }));
    } catch (e) {
      notify('error', (e as Error).message);
    }
  }

  return (
    <>
      <h2 className="h-small">{t('detail.files.dir')}</h2>
      <nav aria-label={t('detail.files.breadcrumb')} className="crumbs">
        <button type="button" className="linklike" onClick={() => setPath('')}>
          {t('detail.files.root')}
        </button>
        {parts.map((p, i) => (
          <span key={i}>
            {' / '}
            <button
              type="button"
              className="linklike plain"
              onClick={() => setPath(parts.slice(0, i + 1).join('/'))}
            >
              {p}
            </button>
          </span>
        ))}
      </nav>
      {dir.error ? <ErrorBox error={dir.error} /> : null}
      {dir.loading && !dir.data ? <Loading /> : null}
      {dir.data ? (
        entries.length === 0 ? (
          <p className="muted">{t('detail.files.emptyDir')}</p>
        ) : (
          <div className="table-wrap">
            <table>
              <caption className="sr-only">{t('detail.files.dir')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('detail.files.name')}</th>
                  <th scope="col">{t('detail.files.size')}</th>
                  <th scope="col">{t('detail.files.modified')}</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.name}>
                    <th scope="row" className="plain">
                      {e.type === 'dir' ? (
                        <button
                          type="button"
                          className="linklike plain"
                          onClick={() => setPath(path ? `${path}/${e.name}` : e.name)}
                        >
                          {e.name}/
                        </button>
                      ) : (
                        e.name
                      )}
                      {e.type === 'symlink' ? (
                        <span className="muted"> ({t('detail.files.symlink')})</span>
                      ) : null}
                    </th>
                    <td>{e.type === 'file' ? formatBytes(e.size) : ''}</td>
                    <td className="mono">{formatTimestamp(e.mtimeMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : null}

      <h2 className="h-small">{t('detail.files.changes')}</h2>
      <p className="muted">{t('detail.files.changesHint')}</p>
      <div className="actions">
        <button
          type="button"
          className="primary"
          onClick={() => void loadDiff()}
          disabled={expBusy}
        >
          {exp ? t('common.refresh') : t('detail.files.loadDiff')}
        </button>
        <button type="button" onClick={() => void save('patch')}>
          {t('detail.files.savePatch')}
        </button>
        <button type="button" onClick={() => void save('diff')}>
          {t('detail.files.saveDiff')}
        </button>
      </div>
      {expError ? <ErrorBox error={expError} /> : null}
      {exp ? (
        <>
          <p>
            {t('detail.files.stats', {
              files: exp.stats.filesChanged,
              add: exp.stats.insertions,
              del: exp.stats.deletions,
            })}
          </p>
          {exp.flagged.length > 0 ? (
            <Banner tone="danger">
              <strong>{t('detail.files.flagged', { count: exp.flagged.length })}</strong>
              <p>{t('detail.files.flaggedHint')}</p>
              <ul>
                {exp.flagged.map((f) => (
                  <li key={f.path} className="plain">
                    <code>{f.path}</code> - {f.reason}
                  </li>
                ))}
              </ul>
            </Banner>
          ) : null}
          {exp.warnings.length > 0 ? (
            <Banner tone="warn">
              <ul>
                {exp.warnings.map((w, i) => (
                  <li key={i} className="plain">
                    {w}
                  </li>
                ))}
              </ul>
            </Banner>
          ) : null}
          {exp.files.length === 0 ? <p className="muted">{t('detail.files.noChanges')}</p> : null}
          {exp.files.length > 0 ? (
            <div className="table-wrap">
              <table>
                <caption className="sr-only">{t('detail.files.changes')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('detail.files.name')}</th>
                    <th scope="col">{t('detail.files.status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {exp.files.map((f) => {
                    const flagged = exp.flagged.some((x) => x.path === f.path);
                    return (
                      <tr key={f.path} className={flagged ? 'row-danger' : ''}>
                        <th scope="row" className="plain">
                          <code>{f.path}</code>
                        </th>
                        <td>
                          {t(`detail.files.status.${f.status}`)}
                          {flagged ? (
                            <>
                              {' '}
                              <Badge tone="danger">{t('detail.files.flaggedBadge')}</Badge>
                            </>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
          {exp.content ? <DiffText text={exp.content} /> : null}
          <h3 className="h-small">{t('detail.files.branchTitle')}</h3>
          <div className="with-button">
            <Field label={t('detail.files.branchName')}>
              {(id) => (
                <input
                  id={id}
                  type="text"
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                />
              )}
            </Field>
            <button
              type="button"
              disabled={!/^abox\/[A-Za-z0-9._/-]{1,100}$/.test(branch)}
              onClick={() => setBranchConfirm(true)}
            >
              {t('detail.files.branchExport')}
            </button>
          </div>
        </>
      ) : null}
      {branchConfirm ? (
        <ConfirmDialog
          title={t('detail.files.branchTitle')}
          confirmLabel={t('detail.files.branchExport')}
          onClose={() => setBranchConfirm(false)}
          onConfirm={() => void exportBranch()}
        >
          <p>{t('detail.files.branchConfirm', { branch })}</p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}

/** Diff text rendered line by line as plain text; +/- are shown as characters, colour is only a hint. */
function DiffText(props: { text: string }) {
  const { t } = useApp();
  const lines = useMemo(() => props.text.split('\n'), [props.text]);
  return (
    <pre className="diff plain" tabIndex={0} aria-label={t('detail.files.diffLabel')}>
      {lines.map((l, i) => (
        <span
          key={i}
          className={
            l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ')
              ? 'diff-head'
              : l.startsWith('+')
                ? 'diff-add'
                : l.startsWith('-')
                  ? 'diff-del'
                  : l.startsWith('@@')
                    ? 'diff-hunk'
                    : ''
          }
        >
          {l}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}

// -- logs ----------------------------------------------------------------------------------------------------

function LogsTab(props: { id: string }) {
  const { t } = useApp();
  const procs = useQuery('processes:list', { id: props.id }, { pollMs: 3000 });
  const [sel, setSel] = useState<string>();
  const list = procs.data ?? [];
  useEffect(() => {
    if (!sel && list[0]) setSel(list[0].id);
  }, [list.length, sel]);
  const logs = useQuery('processes:logs', sel ? { processId: sel, tail: 300 } : undefined, {
    enabled: Boolean(sel),
    pollMs: 2000,
    live: false,
  });
  if (procs.error) return <ErrorBox error={procs.error} />;
  if (!procs.data) return <Loading />;
  if (list.length === 0)
    return <EmptyState title={t('detail.logs.empty.title')} text={t('detail.logs.empty.text')} />;
  const cur = list.find((p) => p.id === sel);
  return (
    <>
      <Field label={t('detail.logs.process')}>
        {(id) => (
          <select id={id} value={sel ?? ''} onChange={(e) => setSel(e.target.value)}>
            {list.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id} - {p.command.slice(0, 60)} ({p.status})
              </option>
            ))}
          </select>
        )}
      </Field>
      {cur ? (
        <p className="muted small">
          {t(`detail.logs.status.${cur.status}`)} &middot; {formatTimestamp(cur.startedAt)}
          {cur.exitCode !== null ? ` · exit ${cur.exitCode}` : ''}
        </p>
      ) : null}
      {logs.error ? <ErrorBox error={logs.error} /> : null}
      <pre className="log plain" tabIndex={0} aria-label={t('detail.logs.output')} aria-live="off">
        {logs.data?.content ?? ''}
      </pre>
      {logs.data?.truncated ? <p className="muted small">{t('detail.logs.truncated')}</p> : null}
    </>
  );
}

// -- snapshots -----------------------------------------------------------------------------------------------------

function SnapshotsTab(props: { id: string }) {
  const { t, notify } = useApp();
  const audit = useQuery(
    'audit:query',
    { sandboxId: props.id, action: 'sandbox.snapshot', limit: 100 },
    { pollMs: 5000 },
  );
  const [name, setName] = useState('');
  const [restoreId, setRestoreId] = useState<string | null>(null);
  const [error, setError] = useState<unknown>();
  const snaps = (audit.data ?? []).filter((e) => typeof e.details?.['snapshotId'] === 'string');

  async function create() {
    setError(undefined);
    try {
      const r = await call('snapshots:create', { id: props.id, name });
      notify('ok', t('detail.snap.created', { id: r.snapshotId }));
      setName('');
      await audit.reload();
    } catch (e) {
      setError(e);
    }
  }
  async function restore(id: string) {
    setRestoreId(null);
    try {
      await call('snapshots:restore', { id: props.id, snapshotId: id });
      notify('ok', t('detail.snap.restored', { id }));
    } catch (e) {
      setError(e);
    }
  }
  return (
    <>
      <p className="muted">{t('detail.snap.hint')}</p>
      <form
        className="with-button"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <Field label={t('detail.snap.name')} hint={t('detail.snap.nameHint')}>
          {(id) => (
            <input
              id={id}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              pattern="[A-Za-z0-9._-]{1,64}"
              required
            />
          )}
        </Field>
        <button type="submit" className="primary" disabled={!/^[A-Za-z0-9._-]{1,64}$/.test(name)}>
          {t('detail.snap.create')}
        </button>
      </form>
      {error ? <ErrorBox error={error} /> : null}
      {snaps.length === 0 ? (
        <p className="muted">{t('detail.snap.empty')}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">{t('detail.tab.snapshots')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('detail.snap.name')}</th>
                <th scope="col">ID</th>
                <th scope="col">{t('audit.col.time')}</th>
                <th scope="col">{t('sandboxes.col.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {snaps.map((e) => (
                <tr key={e.seq}>
                  <td className="plain">{String(e.details?.['name'] ?? '')}</td>
                  <td className="plain mono">{String(e.details?.['snapshotId'])}</td>
                  <td className="mono">{formatTimestamp(e.ts)}</td>
                  <td>
                    <button
                      type="button"
                      onClick={() => setRestoreId(String(e.details?.['snapshotId']))}
                    >
                      {t('detail.snap.restore')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {restoreId ? (
        <ConfirmDialog
          title={t('detail.snap.restore')}
          confirmLabel={t('detail.snap.restore')}
          danger
          onClose={() => setRestoreId(null)}
          onConfirm={() => void restore(restoreId)}
        >
          <p>{t('detail.snap.restoreConfirm', { id: restoreId })}</p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}
