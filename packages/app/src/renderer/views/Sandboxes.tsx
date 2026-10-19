import { useEffect, useMemo, useState } from 'react';
import type { SandboxView } from '@abox/core';
import { call } from '../api';
import { useApp } from '../context';
import { useNow, useQuery, useSandboxUsage } from '../hooks';
import {
  Banner,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorBox,
  IsolationBadge,
  Loading,
  OwnerBadge,
  StateBadge,
  Badge,
  Safe,
} from '../components/ui';
import { distinct, EMPTY_FILTERS, filterSandboxes } from '../../shared/sandbox-filter';
import type { SandboxFilters } from '../../shared/sandbox-filter';
import {
  formatBytes,
  formatClock,
  formatDuration,
  remainingMs,
  safeInline,
  safeText,
} from '../../shared/format';
import { UsageLines } from '../components/usage';
import { OverflowMenu } from '../components/OverflowMenu';
import type { MenuAction } from '../components/OverflowMenu';
import { NewSandboxDialog } from './NewSandbox';
import { SANDBOX_STATES } from '../../shared/constants';

const EXTEND_PRESETS = ['30m', '1h', '4h', '1d'] as const;

export function SandboxesView() {
  const { t, navigate, notify, route } = useApp();
  const list = useQuery('sandboxes:list', {}, { pollMs: 4000 });
  const [filters, setFilters] = useState<SandboxFilters>(EMPTY_FILTERS);
  const [creating, setCreating] = useState(false);
  const [extendFor, setExtendFor] = useState<SandboxView | null>(null);
  const [deleteFor, setDeleteFor] = useState<SandboxView | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const now = useNow(1000);
  // The `n` shortcut (from any view) lands here with `create` set.
  useEffect(() => {
    if (route.create) setCreating(true);
  }, [route]);

  const all = list.data?.sandboxes ?? [];
  const shown = useMemo(() => filterSandboxes(all, filters), [all, filters]);
  // Live cpu / memory only for what is on screen and running.
  const runningShown = useMemo(
    () => shown.filter((s) => s.state === 'running' && !s.stale).map((s) => s.id),
    [shown],
  );
  const usage = useSandboxUsage(runningShown);
  const owners = useMemo(() => distinct(all, (s) => s.owner), [all]);
  const templates = useMemo(() => distinct(all, (s) => s.template), [all]);
  const staleCount = all.filter((s) => s.stale || s.missingInBackend).length;
  const orphans = list.data?.orphans ?? [];
  const unreachable = list.data?.unreachableHosts ?? [];
  // Freshness of what the table shows: the time of the last successful answer of the manager.
  const asOf = list.updatedAt;
  const outdated = asOf !== undefined && (list.error !== undefined || now - asOf > 20_000);

  async function act(s: SandboxView, channel: 'sandboxes:start' | 'sandboxes:stop', okKey: string) {
    setBusyId(s.id);
    try {
      await call(channel, { id: s.id });
      notify('ok', t(okKey, { name: safeInline(s.name, 60) }));
      await list.reload();
    } catch (e) {
      notify('error', (e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  async function remove(s: SandboxView) {
    setBusyId(s.id);
    try {
      await call('sandboxes:remove', { id: s.id });
      notify('ok', t('sandboxes.removed', { name: safeInline(s.name, 60) }));
      setDeleteFor(null);
      await list.reload();
    } catch (e) {
      notify('error', (e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  /** The less used actions of a row. Delete keeps its confirmation dialog. */
  function rowMenu(s: SandboxView): MenuAction[] {
    return [
      {
        id: 'open',
        label: t('sandboxes.action.open'),
        onSelect: () => navigate({ view: 'detail', sandboxId: s.id }),
      },
      { id: 'extend', label: t('sandboxes.action.extend'), onSelect: () => setExtendFor(s) },
      {
        id: 'export',
        label: t('sandboxes.action.export'),
        onSelect: () => navigate({ view: 'detail', sandboxId: s.id, tab: 'files' }),
      },
      {
        id: 'snapshots',
        label: t('sandboxes.action.snapshots'),
        onSelect: () => navigate({ view: 'detail', sandboxId: s.id, tab: 'snapshots' }),
      },
      {
        id: 'delete',
        label: t('sandboxes.action.delete'),
        danger: true,
        disabled: busyId === s.id,
        onSelect: () => setDeleteFor(s),
      },
    ];
  }

  return (
    <section aria-labelledby="h-sandboxes">
      <header className="page-head">
        <div>
          <h1 id="h-sandboxes">{t('sandboxes.title')}</h1>
          {asOf !== undefined ? (
            <p className="muted small" data-testid="as-of">
              {t('sandboxes.asOf', { time: formatClock(asOf) })}
              {outdated ? (
                <>
                  {' '}
                  <Badge tone="warn" title={t('sandboxes.outdated.hint')}>
                    {t('sandboxes.outdated')}
                  </Badge>
                </>
              ) : null}
            </p>
          ) : null}
        </div>
        <div className="actions">
          <button type="button" onClick={() => void list.reload()}>
            {t('common.refresh')}
          </button>
          <button type="button" className="primary" onClick={() => setCreating(true)}>
            {t('sandboxes.new')}
          </button>
        </div>
      </header>

      {list.error ? <ErrorBox error={list.error} /> : null}

      {orphans.length > 0 ? (
        <Banner tone="warn">
          <strong>{t('sandboxes.orphans.title', { count: orphans.length })}</strong>
          <p>{t('sandboxes.orphans.text')}</p>
          <ul className="plain-list">
            {orphans.slice(0, 5).map((o) => (
              <li key={o.id} className="plain">
                <Safe text={o.id} max={80} /> ({safeInline(o.backend, 30)},{' '}
                <Safe text={o.template} max={60} />)
              </li>
            ))}
          </ul>
          <button type="button" onClick={() => navigate({ view: 'settings' })}>
            {t('sandboxes.orphans.action')}
          </button>
        </Banner>
      ) : null}
      {staleCount > 0 ? (
        <Banner tone="warn">
          <strong>{t('sandboxes.stale.title', { count: staleCount })}</strong>{' '}
          {t('sandboxes.stale.text')}{' '}
          <button type="button" onClick={() => navigate({ view: 'settings' })}>
            {t('sandboxes.orphans.action')}
          </button>
        </Banner>
      ) : null}
      {unreachable.length > 0 ? (
        <Banner tone="warn">
          {t('sandboxes.unreachable', { hosts: safeInline(unreachable.join(', '), 300) })}
        </Banner>
      ) : null}

      {list.loading && !list.data ? <Loading /> : null}

      {list.data && all.length === 0 ? (
        <EmptyState title={t('sandboxes.empty.title')} text={t('sandboxes.empty.text')}>
          {/* One primary button per view: the header carries it */}
          <button type="button" onClick={() => setCreating(true)}>
            {t('sandboxes.empty.action')}
          </button>
        </EmptyState>
      ) : null}

      {all.length > 0 ? (
        <>
          <form
            className="filters"
            role="search"
            aria-label={t('sandboxes.filters')}
            onSubmit={(e) => e.preventDefault()}
          >
            <label>
              {t('sandboxes.filter.text')}
              <input
                type="search"
                data-shortcut-search=""
                value={filters.text}
                onChange={(e) => setFilters({ ...filters, text: e.target.value })}
              />
            </label>
            <label>
              {t('sandboxes.col.state')}
              <select
                value={filters.state}
                onChange={(e) => setFilters({ ...filters, state: e.target.value })}
              >
                <option value="">{t('common.all')}</option>
                <option value="active">{t('sandboxes.filter.active')}</option>
                {SANDBOX_STATES.map((s) => (
                  <option key={s} value={s}>
                    {t(`state.${s}`)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t('sandboxes.col.owner')}
              <select
                value={filters.owner}
                onChange={(e) => setFilters({ ...filters, owner: e.target.value })}
              >
                <option value="">{t('common.all')}</option>
                <option value="agent">{t('sandboxes.filter.anyAgent')}</option>
                {owners.map((o) => (
                  <option key={o} value={o}>
                    {safeInline(o, 80)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t('sandboxes.col.template')}
              <select
                value={filters.template}
                onChange={(e) => setFilters({ ...filters, template: e.target.value })}
              >
                <option value="">{t('common.all')}</option>
                {templates.map((x) => (
                  <option key={x} value={x}>
                    {safeInline(x, 80)}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" onClick={() => setFilters(EMPTY_FILTERS)}>
              {t('common.reset')}
            </button>
          </form>

          <div className="table-wrap">
            <table>
              <caption className="sr-only">{t('sandboxes.table')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('sandboxes.col.name')}</th>
                  <th scope="col">{t('sandboxes.col.host')}</th>
                  <th scope="col">{t('sandboxes.col.template')}</th>
                  <th scope="col">{t('sandboxes.col.state')}</th>
                  <th scope="col">{t('sandboxes.col.owner')}</th>
                  <th scope="col">{t('sandboxes.col.backend')}</th>
                  <th scope="col">{t('sandboxes.col.ttl')}</th>
                  <th scope="col">{t('sandboxes.col.resources')}</th>
                  <th scope="col">{t('sandboxes.col.workspace')}</th>
                  <th scope="col">{t('sandboxes.col.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((s) => {
                  const live =
                    s.state === 'running' || s.state === 'created' || s.state === 'stopped';
                  const left = remainingMs(s.expiresAt, now);
                  return (
                    <tr key={s.id} data-sandbox-id={s.id}>
                      <th scope="row">
                        <button
                          type="button"
                          className="linklike"
                          onClick={() => navigate({ view: 'detail', sandboxId: s.id })}
                        >
                          <Safe text={s.name} max={80} />
                        </button>
                        <div className="muted small">
                          <Safe text={s.id} max={80} />
                        </div>
                      </th>
                      <td>
                        <Safe text={s.host} max={60} />
                      </td>
                      <td>
                        <Safe text={s.template} max={80} />
                      </td>
                      <td>
                        <StateBadge state={s.state} stale={s.stale} />
                        {s.stale || !s.hostReachable ? (
                          <div className="muted small" data-testid="stale-note">
                            {!s.hostReachable ? `${t('sandboxes.hostUnreachable')} · ` : ''}
                            {s.lastSeenAt
                              ? t('sandboxes.lastSeen', { time: formatClock(s.lastSeenAt) })
                              : t('sandboxes.neverSeen')}
                          </div>
                        ) : null}
                        {s.error ? (
                          <div className="small danger-text">
                            <Safe text={s.error} max={160} />
                          </div>
                        ) : null}
                      </td>
                      <td>
                        <OwnerBadge owner={s.owner} />
                        {s.humanAttached ? (
                          <div>
                            <Badge tone="warn">{t('sandboxes.humanAttached')}</Badge>
                          </div>
                        ) : null}
                      </td>
                      <td>
                        <div className="badges">
                          <Badge tone="neutral">{safeInline(s.backend, 30)}</Badge>
                          <IsolationBadge level={s.isolation} />
                          {s.network.mode === 'open' ? (
                            <Badge tone="danger">{t('network.open')}</Badge>
                          ) : null}
                        </div>
                      </td>
                      <td title={new Date(s.expiresAt).toLocaleString()}>
                        {s.state === 'expired' || (live && left === 0) ? (
                          <Badge tone="warn">{t('state.expired')}</Badge>
                        ) : live ? (
                          <span className="mono">{formatDuration(left)}</span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="small">
                        {usage[s.id] ? (
                          <UsageLines
                            usage={usage[s.id]!}
                            cpus={s.resources.cpus}
                            memoryBytes={s.resources.memoryBytes}
                          />
                        ) : null}
                        <span className={usage[s.id] ? 'muted' : undefined}>
                          {usage[s.id] ? `${t('sandboxes.configured')} ` : ''}
                          {s.resources.cpus} CPU, {formatBytes(s.resources.memoryBytes)}
                        </span>
                      </td>
                      <td className="path plain" title={safeInline(s.workspace?.source ?? '', 500)}>
                        {s.workspace ? (
                          <>
                            <span className="muted small">{s.workspace.mode}</span>{' '}
                            <Safe text={s.workspace.source ?? s.workspace.sandboxPath} max={120} />
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>
                        <div className="row-actions">
                          <button
                            type="button"
                            disabled={s.state !== 'running' || s.stale || !s.hostReachable}
                            title={
                              s.state !== 'running' || s.stale || !s.hostReachable
                                ? t('sandboxes.action.shellUnavailable')
                                : undefined
                            }
                            aria-label={t('sandboxes.action.shellNamed', {
                              name: safeInline(s.name, 60),
                            })}
                            onClick={() =>
                              navigate({ view: 'detail', sandboxId: s.id, tab: 'terminal' })
                            }
                          >
                            {t('sandboxes.action.shell')}
                          </button>
                          {s.state === 'running' ? (
                            <button
                              type="button"
                              disabled={busyId === s.id}
                              aria-label={t('sandboxes.action.stopNamed', {
                                name: safeInline(s.name, 60),
                              })}
                              onClick={() => void act(s, 'sandboxes:stop', 'sandboxes.stopped')}
                            >
                              {t('sandboxes.action.stop')}
                            </button>
                          ) : null}
                          {s.state === 'stopped' || s.state === 'created' ? (
                            <button
                              type="button"
                              disabled={busyId === s.id}
                              aria-label={t('sandboxes.action.startNamed', {
                                name: safeInline(s.name, 60),
                              })}
                              onClick={() => void act(s, 'sandboxes:start', 'sandboxes.started')}
                            >
                              {t('sandboxes.action.start')}
                            </button>
                          ) : null}
                          <OverflowMenu
                            label={t('menu.more', { name: safeInline(s.name, 60) })}
                            items={rowMenu(s)}
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {shown.length === 0 ? <p className="muted pad">{t('sandboxes.noMatch')}</p> : null}
          </div>
        </>
      ) : null}

      {creating ? (
        <NewSandboxDialog
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            void list.reload();
            navigate({ view: 'detail', sandboxId: id });
          }}
        />
      ) : null}
      {extendFor ? (
        <ExtendDialog
          sandbox={extendFor}
          onClose={() => setExtendFor(null)}
          onDone={() => {
            setExtendFor(null);
            void list.reload();
          }}
        />
      ) : null}
      {deleteFor ? (
        <ConfirmDialog
          title={t('sandboxes.delete.title')}
          confirmLabel={t('sandboxes.delete.confirm')}
          danger
          busy={busyId === deleteFor.id}
          onClose={() => setDeleteFor(null)}
          onConfirm={() => void remove(deleteFor)}
        >
          <p>{t('sandboxes.delete.text', { name: safeInline(deleteFor.name, 60) })}</p>
          <p className="muted">{t('sandboxes.delete.hint')}</p>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}

export function ExtendDialog(props: { sandbox: SandboxView; onClose(): void; onDone(): void }) {
  const { t, notify } = useApp();
  const [ttl, setTtl] = useState<string>('1h');
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<{ reasons: string[]; risks: string[] } | null>(
    null,
  );
  const [error, setError] = useState<unknown>();
  const value = ttl === 'custom' ? custom.trim() : ttl;

  async function run(confirmed: boolean) {
    setBusy(true);
    setError(undefined);
    try {
      const r = await call('sandboxes:extend', { id: props.sandbox.id, ttl: value, confirmed });
      if (r.status === 'confirmation_required') {
        setConfirmation({ reasons: r.reasons, risks: r.risks });
      } else {
        notify('ok', t('sandboxes.extended', { name: safeInline(props.sandbox.name, 60) }));
        props.onDone();
      }
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={t('sandboxes.extend.title', { name: safeInline(props.sandbox.name, 60) })}
      onClose={props.onClose}
      footer={
        <>
          <button type="button" onClick={props.onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy || value === ''}
            onClick={() => void run(confirmation !== null)}
          >
            {confirmation ? t('common.confirm') : t('sandboxes.extend.apply')}
          </button>
        </>
      }
    >
      <p className="muted">{t('sandboxes.extend.hint')}</p>
      <fieldset>
        <legend>{t('sandboxes.extend.by')}</legend>
        {EXTEND_PRESETS.map((p) => (
          <label key={p} className="inline">
            <input type="radio" name="ttl" checked={ttl === p} onChange={() => setTtl(p)} /> {p}
          </label>
        ))}
        <label className="inline">
          <input
            type="radio"
            name="ttl"
            checked={ttl === 'custom'}
            onChange={() => setTtl('custom')}
          />{' '}
          {t('common.custom')}
        </label>
        {ttl === 'custom' ? (
          <input
            type="text"
            aria-label={t('sandboxes.extend.custom')}
            placeholder="90m"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
          />
        ) : null}
      </fieldset>
      {confirmation ? (
        <Banner tone="warn">
          <ul>
            {[...confirmation.reasons, ...confirmation.risks].map((x, i) => (
              <li key={i} className="plain">
                {safeText(x)}
              </li>
            ))}
          </ul>
        </Banner>
      ) : null}
      {error ? <ErrorBox error={error} /> : null}
    </Dialog>
  );
}
