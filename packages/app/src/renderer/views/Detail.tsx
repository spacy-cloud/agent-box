import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AuditEntry, DirEntry, ExportSandboxResult, ResourceUsage } from '@abox/core';
import { call } from '../api';
import { useApp } from '../context';
import { useNow, useQuery, useSandboxUsage } from '../hooks';
import { TerminalPane } from '../components/Terminal';
import { FileTree } from '../components/FileTree';
import type { TreeSelection } from '../components/FileTree';
import { UsageLines } from '../components/usage';
import { NetworkTab } from '../components/NetworkLog';
import { PortsPanel } from '../components/PortsPanel';
import { SnapshotsTab } from '../components/SnapshotsTab';
import { UnifiedDiff } from '../components/review';
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
  ScrollText,
  Safe,
  StateBadge,
  Tabs,
} from '../components/ui';
import { overviewRows } from '../../shared/overview';
import {
  formatDuration,
  formatTimestamp,
  remainingMs,
  safeInline,
  safeText,
  shortId,
} from '../../shared/format';
import { ExtendDialog } from './Sandboxes';

const TABS = ['overview', 'terminal', 'activity', 'network', 'files', 'logs', 'snapshots'] as const;
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
  const usage = useSandboxUsage(s && s.state === 'running' && !s.stale ? [s.id] : []);

  async function run(fn: () => Promise<unknown>, okKey: string) {
    setBusy(true);
    try {
      await fn();
      notify('ok', t(okKey, { name: safeInline(s?.name ?? '', 60) }));
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
                {safeInline(s.name, 120)}
              </h1>
              <div className="badges">
                <StateBadge state={s.state} stale={s.stale} />
                <OwnerBadge owner={s.owner} />
                <Badge tone="neutral">{s.backend}</Badge>
                <IsolationBadge level={s.isolation} />
                <Safe text={s.id} max={80} className="muted mono" />
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
          {s.humanAttached ? (
            <Banner tone="warn">
              <strong>{t('detail.humanAttached.title')}</strong>{' '}
              {t('detail.humanAttached.text', { owner: safeInline(s.owner, 80) })}
            </Banner>
          ) : null}
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
              <Safe text={s.error} max={400} />
            </Banner>
          ) : null}
          <Tabs
            label={t('detail.tabs')}
            active={tab}
            onChange={(x) => setTab(x as Tab)}
            tabs={TABS.map((id) => ({ id, label: t(`detail.tab.${id}`) }))}
          >
            {tab === 'overview' ? (
              <OverviewTab
                id={s.id}
                template={s.template}
                sandbox={s}
                now={now}
                usage={usage[s.id]}
              />
            ) : null}
            {tab === 'terminal' ? (
              <TerminalTab id={s.id} name={s.name} state={s.state} owner={s.owner} />
            ) : null}
            {tab === 'activity' ? <ActivityTab id={s.id} /> : null}
            {tab === 'network' ? <NetworkTab id={s.id} /> : null}
            {tab === 'files' ? <FilesTab id={s.id} /> : null}
            {tab === 'logs' ? <LogsTab id={s.id} /> : null}
            {tab === 'snapshots' ? (
              <SnapshotsTab id={s.id} name={s.name} template={s.template} backend={s.backend} />
            ) : null}
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
                    notify('ok', t('sandboxes.removed', { name: safeInline(s.name, 60) }));
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
              <p>{t('sandboxes.delete.text', { name: safeInline(s.name, 60) })}</p>
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
  usage?: ResourceUsage | undefined;
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
                      <li key={v}>{safeText(v)}</li>
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
          {props.usage ? (
            <tr>
              <th scope="row">{t('detail.opt.usage')}</th>
              <td>
                <UsageLines
                  usage={props.usage}
                  cpus={s.resources.cpus}
                  memoryBytes={s.resources.memoryBytes}
                />
              </td>
            </tr>
          ) : null}
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
            <td>
              <Safe text={s.template} max={120} />
            </td>
          </tr>
          <tr>
            <th scope="row">{t('detail.opt.host')}</th>
            <td>
              <Safe text={s.host} max={120} />
            </td>
          </tr>
          <tr>
            <th scope="row">{t('detail.opt.processes')}</th>
            <td>{s.processes.length}</td>
          </tr>
        </tbody>
      </table>
      <PortsPanel sandbox={s} />
    </>
  );
}

function TerminalTab(props: { id: string; name: string; state: string; owner: string }) {
  const { t } = useApp();
  if (props.state !== 'running') {
    return (
      <EmptyState
        title={t('detail.terminal.notRunning.title')}
        text={t('detail.terminal.notRunning.text')}
      />
    );
  }
  return (
    <>
      <p className="muted">{t('detail.terminal.intro')}</p>
      {props.owner.startsWith('agent:') ? (
        <Banner tone="info">
          {t('detail.terminal.takeover', { owner: safeInline(props.owner, 80) })}
        </Banner>
      ) : null}
      <TerminalPane
        target={{ kind: 'sandbox', id: props.id }}
        kindLabel={t('terminal.kind.sandbox')}
        title={safeInline(props.name, 80)}
        subtitle={safeInline(props.id, 80)}
      />
    </>
  );
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
              <td>
                <Safe text={e.actor} max={80} />
              </td>
              <td>
                <code>
                  <Safe text={e.action} max={100} />
                </code>
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
                      {safeInline(e.sandboxId, 80)}
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
                    <ScrollText
                      className="log"
                      text={JSON.stringify(e.details, null, 2)}
                      label={t('audit.col.details')}
                    />
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
  return safeInline(keys.join(', '), 120) || '{}';
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
  const [sel, setSel] = useState<TreeSelection>({ path: '', entry: null });
  const [treeKey, setTreeKey] = useState(0);
  const [exp, setExp] = useState<ExportSandboxResult | null>(null);
  const [expError, setExpError] = useState<unknown>();
  const [expBusy, setExpBusy] = useState(false);
  const [branch, setBranch] = useState(`abox/${shortId(props.id)}`);
  const [branchConfirm, setBranchConfirm] = useState(false);
  const [copyTarget, setCopyTarget] = useState('');

  const sandboxId = props.id;
  const loadDir = useCallback(
    (path: string): Promise<DirEntry[]> =>
      call('files:list', { id: sandboxId, ...(path ? { path } : {}) }),
    [sandboxId],
  );
  /** The folder a copy-in goes to by default: the selected folder, or the folder of the selected file. */
  const dirOfSelection =
    sel.entry?.type === 'dir' || sel.entry === null
      ? sel.path
      : sel.path.includes('/')
        ? sel.path.slice(0, sel.path.lastIndexOf('/'))
        : '';

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

  async function copyIn() {
    try {
      const target = dirOfSelection ? `${dirOfSelection}/` : '';
      const r = await call('files:copyIn', {
        id: props.id,
        sandboxPath: copyTarget || target || '.',
      });
      if (r.copied) {
        notify('ok', t('detail.files.copiedIn', { path: r.copied }));
        setTreeKey((k) => k + 1);
      }
    } catch (e) {
      notify('error', (e as Error).message);
    }
  }

  async function copyOut(sandboxPath: string) {
    try {
      const r = await call('files:copyOut', { id: props.id, sandboxPath });
      if (r.copied) notify('ok', t('detail.files.copiedOut', { path: r.copied }));
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
      <p className="muted small">{t('detail.files.treeHint')}</p>
      <div className="actions" data-testid="file-actions">
        <button type="button" onClick={() => setTreeKey((k) => k + 1)}>
          {t('common.refresh')}
        </button>
        <button type="button" disabled={sel.path === ''} onClick={() => void copyOut(sel.path)}>
          {t('detail.files.copyOut')}
          {sel.path !== '' ? <span className="sr-only"> {safeInline(sel.path, 120)}</span> : null}
        </button>
        <span className="muted small plain" aria-live="polite">
          {t('detail.files.selected', {
            path: sel.path === '' ? t('detail.files.root') : safeInline(sel.path, 160),
          })}
        </span>
      </div>
      <FileTree
        load={loadDir}
        reloadKey={treeKey}
        rootLabel={t('detail.files.root')}
        label={t('detail.files.dir')}
        onSelect={setSel}
      />

      <div className="with-button">
        <Field label={t('detail.files.copyInTarget')} hint={t('detail.files.copyInHint')}>
          {(id) => (
            <input
              id={id}
              type="text"
              value={copyTarget}
              placeholder={dirOfSelection ? `${dirOfSelection}/` : '.'}
              onChange={(e) => setCopyTarget(e.target.value)}
              spellCheck={false}
            />
          )}
        </Field>
        <button type="button" onClick={() => void copyIn()}>
          {t('detail.files.copyIn')}
        </button>
      </div>

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
                    <code>{safeInline(f.path, 200)}</code> - {safeInline(f.reason, 300)}
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
                    {safeText(w)}
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
                          <code>{safeInline(f.path, 200)}</code>
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
          {exp.content ? (
            <UnifiedDiff text={exp.content} label={t('detail.files.diffLabel')} />
          ) : null}
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

// -- logs ----------------------------------------------------------------------------------------------------

function SandboxOutput(props: { id: string }) {
  const { t } = useApp();
  const q = useQuery('sandboxes:logs', { id: props.id, tail: 300 }, { pollMs: 3000, live: false });
  return (
    <>
      <h2 className="h-small">{t('detail.logs.sandbox')}</h2>
      <p className="muted small">{t('detail.logs.sandboxHint')}</p>
      {q.error ? <ErrorBox error={q.error} /> : null}
      <pre
        className="log plain"
        role="group"
        tabIndex={0}
        aria-label={t('detail.logs.sandboxOutput')}
        aria-live="off"
      >
        {safeText(q.data?.content ?? '')}
      </pre>
    </>
  );
}

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
  const cur = list.find((p) => p.id === sel);
  return (
    <>
      <SandboxOutput id={props.id} />
      <h2 className="h-small">{t('detail.logs.processes')}</h2>
      {list.length === 0 ? (
        <EmptyState title={t('detail.logs.empty.title')} text={t('detail.logs.empty.text')} />
      ) : (
        <>
          <Field label={t('detail.logs.process')}>
            {(id) => (
              <select id={id} value={sel ?? ''} onChange={(e) => setSel(e.target.value)}>
                {list.map((p) => (
                  <option key={p.id} value={p.id}>
                    {safeInline(p.id, 40)} - {safeInline(p.command, 60)} ({p.status})
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
          <pre
            className="log plain"
            role="group"
            tabIndex={0}
            aria-label={t('detail.logs.output')}
            aria-live="off"
          >
            {safeText(logs.data?.content ?? '')}
          </pre>
          {logs.data?.truncated ? (
            <p className="muted small">{t('detail.logs.truncated')}</p>
          ) : null}
        </>
      )}
    </>
  );
}
