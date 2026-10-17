import { useEffect, useMemo, useReducer, useState } from 'react';
import { call } from '../api';
import { useApp } from '../context';
import { useNow, useQuery } from '../hooks';
import {
  Badge,
  Banner,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorBox,
  Field,
  Loading,
} from '../components/ui';
import { hostColor } from '../components/Terminal';
import { useSshTabs } from './ssh-tabs';
import { NewSandboxDialog } from './NewSandbox';
import {
  canTrust,
  hostKeyReducer,
  initialHostKeyState,
  primaryFingerprint,
} from '../../shared/host-key-flow';
import { formatDuration, formatTimestamp } from '../../shared/format';
import { FORWARD_KINDS, HOST_BACKENDS, HOST_ZONES, ISOLATION_LEVELS } from '../../shared/constants';
import type {
  ForwardState,
  HostProfile,
  HostRow,
  ImportPreview,
  PortForward,
} from '../../shared/types';

export function HostsView() {
  const { t, notify, navigate } = useApp();
  const ssh = useSshTabs();
  const q = useQuery('hosts:list', undefined, { pollMs: 5000 });
  const fw = useQuery('hosts:forwards', undefined, { pollMs: 2500, live: false });
  const [edit, setEdit] = useState<HostProfile | 'new' | null>(null);
  const [importing, setImporting] = useState(false);
  const [keyFor, setKeyFor] = useState<{ host: HostProfile; then?: 'terminal' | 'test' } | null>(
    null,
  );
  const [forwardsFor, setForwardsFor] = useState<string | null>(null);
  const [removeFor, setRemoveFor] = useState<HostRow | null>(null);
  /** Host id the New sandbox wizard is open for (`local` = this computer). */
  const [createOn, setCreateOn] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const now = useNow(15_000);

  const rows = q.data ?? [];
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const list = rows.filter(
      (r) =>
        f === '' ||
        [
          r.profile.id,
          r.profile.hostname,
          r.profile.sshConfigAlias,
          r.profile.user,
          ...r.profile.tags,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(f),
    );
    return [...list].sort((a, b) => {
      if (a.profile.kind === 'local') return -1;
      if (b.profile.kind === 'local') return 1;
      if (a.profile.favorite !== b.profile.favorite) return a.profile.favorite ? -1 : 1;
      return a.profile.id.localeCompare(b.profile.id);
    });
  }, [rows, filter]);

  async function test(row: HostRow) {
    setBusy(row.profile.id);
    try {
      const r = await call('hosts:test', { id: row.profile.id });
      await q.reload();
      const hk = r.row.status.hostKey;
      if (hk === 'unknown' || hk === 'changed') setKeyFor({ host: row.profile, then: 'test' });
      else notify('ok', t('hosts.tested', { host: row.profile.id }));
    } catch (e) {
      notify('error', (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function terminal(row: HostRow) {
    setBusy(row.profile.id);
    try {
      const k = await call('hosts:keyCheck', { id: row.profile.id });
      if (k.status === 'trusted') ssh.open(row.profile);
      else setKeyFor({ host: row.profile, then: 'terminal' });
    } catch (e) {
      notify('error', (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function toggleFavorite(row: HostRow) {
    try {
      await call('hosts:update', {
        id: row.profile.id,
        patch: { favorite: !row.profile.favorite },
      });
      await q.reload();
    } catch (e) {
      notify('error', (e as Error).message);
    }
  }

  async function remove(row: HostRow) {
    try {
      await call('hosts:remove', { id: row.profile.id });
      notify('ok', t('hosts.removed', { host: row.profile.id }));
      setRemoveFor(null);
      await q.reload();
    } catch (e) {
      setRemoveFor(null);
      notify('error', (e as Error).message);
    }
  }

  return (
    <section aria-labelledby="h-hosts">
      <header className="page-head">
        <div>
          <h1 id="h-hosts">{t('hosts.title')}</h1>
          <p className="muted">{t('hosts.intro')}</p>
        </div>
        <div className="actions">
          <button type="button" onClick={() => void q.reload()}>
            {t('common.refresh')}
          </button>
          <button type="button" onClick={() => setImporting(true)}>
            {t('hosts.import')}
          </button>
          <button type="button" className="primary" onClick={() => setEdit('new')}>
            {t('hosts.add')}
          </button>
        </div>
      </header>

      <Banner tone="info">{t('hosts.noSecrets')}</Banner>
      {q.error ? <ErrorBox error={q.error} /> : null}
      {q.loading && !q.data ? <Loading /> : null}

      {q.data && rows.length <= 1 ? (
        <EmptyState title={t('hosts.empty.title')} text={t('hosts.empty.text')} />
      ) : null}

      {rows.length > 0 ? (
        <>
          <form className="filters" role="search" onSubmit={(e) => e.preventDefault()}>
            <label>
              {t('hosts.search')}
              <input
                type="search"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                autoComplete="off"
              />
            </label>
          </form>
          <div className="table-wrap">
            <table>
              <caption className="sr-only">{t('hosts.table')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('hosts.col.host')}</th>
                  <th scope="col">{t('hosts.col.target')}</th>
                  <th scope="col">{t('hosts.col.zone')}</th>
                  <th scope="col">{t('hosts.col.backends')}</th>
                  <th scope="col">{t('hosts.col.status')}</th>
                  <th scope="col">{t('sandboxes.col.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <HostLine
                    key={r.profile.id}
                    row={r}
                    now={now}
                    busy={busy === r.profile.id}
                    onCreate={() => setCreateOn(r.profile.id)}
                    onFavorite={() => void toggleFavorite(r)}
                    onTest={() => void test(r)}
                    onTerminal={() => void terminal(r)}
                    onKey={() => setKeyFor({ host: r.profile })}
                    onForwards={() => setForwardsFor(r.profile.id)}
                    onEdit={() => setEdit(r.profile)}
                    onRemove={() => setRemoveFor(r)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {edit ? (
        <HostDialog
          host={edit === 'new' ? null : edit}
          onClose={() => setEdit(null)}
          onSaved={(id) => {
            setEdit(null);
            notify('ok', t('hosts.saved', { host: id }));
            void q.reload();
          }}
        />
      ) : null}
      {importing ? (
        <ImportDialog
          onClose={() => setImporting(false)}
          onDone={(n) => {
            setImporting(false);
            notify('ok', t('hosts.imported', { count: n }));
            void q.reload();
          }}
        />
      ) : null}
      {keyFor ? (
        <HostKeyDialog
          host={keyFor.host}
          purpose={keyFor.then}
          onClose={(trusted) => {
            const then = keyFor.then;
            const host = keyFor.host;
            setKeyFor(null);
            void q.reload();
            if (trusted && then === 'terminal') ssh.open(host);
            if (trusted && then === 'test') {
              const row = rows.find((x) => x.profile.id === host.id);
              if (row) void test(row);
            }
          }}
        />
      ) : null}
      {forwardsFor ? (
        <ForwardsDialog
          host={rows.find((r) => r.profile.id === forwardsFor)?.profile ?? null}
          states={(fw.data ?? []).filter((s) => s.host === forwardsFor)}
          onChanged={() => {
            void q.reload();
            void fw.reload();
          }}
          onClose={() => setForwardsFor(null)}
        />
      ) : null}
      {createOn ? (
        <NewSandboxDialog
          host={createOn}
          onClose={() => setCreateOn(null)}
          onCreated={(id) => {
            setCreateOn(null);
            navigate({ view: 'detail', sandboxId: id });
          }}
        />
      ) : null}
      {removeFor ? (
        <ConfirmDialog
          title={t('hosts.remove.title')}
          confirmLabel={t('hosts.remove.confirm')}
          danger
          onClose={() => setRemoveFor(null)}
          onConfirm={() => void remove(removeFor)}
        >
          <p>{t('hosts.remove.text', { host: removeFor.profile.id })}</p>
          <p className="muted">{t('hosts.remove.hint')}</p>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}

// -- one row ---------------------------------------------------------------------------------------------------

function targetText(p: HostProfile, thisComputer: string): string {
  if (p.kind === 'local') return thisComputer;
  const dest = p.sshConfigAlias ? `${p.sshConfigAlias} (ssh_config)` : (p.hostname ?? '-');
  return `${p.user ? `${p.user}@` : ''}${dest}${p.port && p.port !== 22 ? `:${p.port}` : ''}${
    p.proxyJump ? ` via ${p.proxyJump}` : ''
  }`;
}

const ZONE_TONE = {
  workstation: 'neutral',
  lab: 'info',
  shared: 'warn',
  restricted: 'danger',
} as const;

function HostLine(props: {
  row: HostRow;
  now: number;
  busy: boolean;
  onCreate(): void;
  onFavorite(): void;
  onTest(): void;
  onTerminal(): void;
  onKey(): void;
  onForwards(): void;
  onEdit(): void;
  onRemove(): void;
}) {
  const { t } = useApp();
  const { row } = props;
  const p = row.profile;
  const local = p.kind === 'local';
  return (
    <tr>
      <th scope="row" className="plain">
        <span className="host-name">
          {!local ? (
            <span
              className="host-swatch"
              aria-hidden="true"
              style={{ background: hostColor(p.id) }}
            />
          ) : null}
          <span>{p.id}</span>
          {!local ? (
            <button
              type="button"
              className="star"
              aria-pressed={p.favorite}
              aria-label={t('hosts.favorite', { host: p.id })}
              onClick={props.onFavorite}
            >
              <span aria-hidden="true">{p.favorite ? '★' : '☆'}</span>
            </button>
          ) : null}
        </span>
        {p.tags.length > 0 ? (
          <span className="tags">
            {p.tags.map((tag) => (
              <Badge key={tag} tone="neutral">
                {tag}
              </Badge>
            ))}
          </span>
        ) : null}
      </th>
      <td className="plain">{targetText(p, t('hosts.thisComputer'))}</td>
      <td>
        <Badge
          tone={ZONE_TONE[p.zone]}
          title={
            row.requiresApproval
              ? t('hosts.zone.needsApproval', { level: row.minIsolation })
              : t('hosts.zone.noApproval')
          }
        >
          {t(`hosts.zone.${p.zone}`)}
        </Badge>
        {row.requiresApproval ? (
          <div className="muted small">
            {t('hosts.zone.needsApproval', { level: row.minIsolation })}
          </div>
        ) : null}
      </td>
      <td className="plain">{p.backends.join(', ') || '—'}</td>
      <td>
        <StatusCell row={row} now={props.now} />
      </td>
      <td>
        <div className="row-actions">
          <button type="button" onClick={props.onCreate}>
            {t('hosts.action.create')}
            <span className="sr-only"> {p.id}</span>
          </button>
          {!local ? (
            <>
              <button type="button" disabled={props.busy} onClick={props.onTest}>
                {props.busy ? t('hosts.testing') : t('hosts.action.test')}
                <span className="sr-only"> {p.id}</span>
              </button>
              <button type="button" disabled={props.busy} onClick={props.onTerminal}>
                {t('hosts.action.terminal')}
                <span className="sr-only"> {p.id}</span>
              </button>
              <button type="button" onClick={props.onKey}>
                {t('hosts.action.key')}
                <span className="sr-only"> {p.id}</span>
              </button>
              <button type="button" onClick={props.onForwards}>
                {t('hosts.action.forwards')}
                {p.portForwards.length > 0
                  ? ` (${row.forwardsRunning}/${p.portForwards.length})`
                  : ''}
                <span className="sr-only"> {p.id}</span>
              </button>
              <button type="button" onClick={props.onEdit}>
                {t('hosts.action.edit')}
                <span className="sr-only"> {p.id}</span>
              </button>
              <button type="button" className="danger" onClick={props.onRemove}>
                {t('hosts.action.remove')}
                <span className="sr-only"> {p.id}</span>
              </button>
            </>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

function StatusCell(props: { row: HostRow; now: number }) {
  const { t } = useApp();
  const s = props.row.status;
  if (s.state === 'local') return <Badge tone="ok">{t('hosts.status.local')}</Badge>;
  if (s.state === 'unknown') {
    return (
      <>
        <Badge tone="neutral">{t('hosts.status.unknown')}</Badge>
        <div className="muted small">{t('hosts.status.unknownHint')}</div>
      </>
    );
  }
  const ago = s.checkedAt ? formatDuration(props.now - s.checkedAt) : '';
  return (
    <>
      <Badge tone={s.state === 'reachable' ? 'ok' : 'danger'}>
        {s.state === 'reachable' ? t('hosts.status.reachable') : t('hosts.status.unreachable')}
      </Badge>{' '}
      {s.hostKey === 'unknown' ? <Badge tone="warn">{t('hosts.hostKey.unknown')}</Badge> : null}
      {s.hostKey === 'changed' ? (
        <Badge tone="strong-danger">⚠ {t('hosts.hostKey.changed')}</Badge>
      ) : null}
      <div className="muted small plain">
        {s.latencyMs !== null ? `${s.latencyMs} ms` : null}
        {s.backends.length > 0
          ? ` · ${s.backends
              .map((b) =>
                b.ok
                  ? `${b.name} ${b.version ?? ''}${b.rootless ? ' (rootless)' : ''}`
                  : `${b.name}: ${t('hosts.backend.unusable')}`,
              )
              .join(', ')}`
          : null}
      </div>
      {s.state === 'unreachable' && s.error ? (
        <div className="danger-text small plain">{s.error}</div>
      ) : null}
      {s.stale || s.state === 'unreachable' ? (
        <div className="muted small">
          {s.lastOkAt
            ? t('hosts.status.staleSince', { time: formatTimestamp(s.lastOkAt) })
            : t('hosts.status.stale', { time: ago })}
        </div>
      ) : (
        <div className="muted small">{t('hosts.status.checked', { time: ago })}</div>
      )}
      {s.warnings.map((w, i) => (
        <div key={i} className="warn-text small plain">
          {w}
        </div>
      ))}
    </>
  );
}

// -- add / edit ----------------------------------------------------------------------------------------------------

interface Draft {
  id: string;
  hostname: string;
  alias: string;
  user: string;
  port: string;
  proxyJump: string;
  identityFile: string;
  zone: (typeof HOST_ZONES)[number];
  minIsolation: string;
  backends: string[];
  engineSocket: string;
  tags: string;
  favorite: boolean;
}

function draftOf(p: HostProfile | null): Draft {
  return {
    id: p?.id ?? '',
    hostname: p?.hostname ?? '',
    alias: p?.sshConfigAlias ?? '',
    user: p?.user ?? '',
    port: p?.port ? String(p.port) : '',
    proxyJump: p?.proxyJump ?? '',
    identityFile: p?.identityFile ?? '',
    zone: p?.zone ?? 'shared',
    minIsolation: p?.minIsolation ?? '',
    backends: [...(p?.backends ?? [])],
    engineSocket: p?.engineSocket ?? '',
    tags: (p?.tags ?? []).join(', '),
    favorite: p?.favorite ?? false,
  };
}

function HostDialog(props: {
  host: HostProfile | null;
  onClose(): void;
  onSaved(id: string): void;
}) {
  const { t } = useApp();
  const editing = props.host !== null;
  const [d, setD] = useState<Draft>(() => draftOf(props.host));
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));

  async function save() {
    setBusy(true);
    setError(undefined);
    const tags = d.tags
      .split(/[,\s]+/)
      .map((x) => x.trim())
      .filter(Boolean);
    try {
      if (!editing) {
        const r = await call('hosts:add', {
          id: d.id.trim(),
          ...(d.hostname.trim() ? { hostname: d.hostname.trim() } : {}),
          ...(d.alias.trim() ? { sshConfigAlias: d.alias.trim() } : {}),
          ...(d.user.trim() ? { user: d.user.trim() } : {}),
          ...(d.port.trim() ? { port: Number(d.port) } : {}),
          ...(d.proxyJump.trim() ? { proxyJump: d.proxyJump.trim() } : {}),
          ...(d.identityFile.trim() ? { identityFile: d.identityFile.trim() } : {}),
          zone: d.zone,
          ...(d.minIsolation
            ? { minIsolation: d.minIsolation as (typeof ISOLATION_LEVELS)[number] }
            : {}),
          backends: d.backends as Array<(typeof HOST_BACKENDS)[number]>,
          ...(d.engineSocket.trim() ? { engineSocket: d.engineSocket.trim() } : {}),
          tags,
          favorite: d.favorite,
        });
        props.onSaved(r.profile.id);
      } else {
        const r = await call('hosts:update', {
          id: d.id,
          patch: {
            hostname: d.hostname.trim() || null,
            sshConfigAlias: d.alias.trim() || null,
            user: d.user.trim() || null,
            port: d.port.trim() ? Number(d.port) : null,
            proxyJump: d.proxyJump.trim() || null,
            identityFile: d.identityFile.trim() || null,
            zone: d.zone,
            minIsolation: d.minIsolation
              ? (d.minIsolation as (typeof ISOLATION_LEVELS)[number])
              : null,
            backends: d.backends as Array<(typeof HOST_BACKENDS)[number]>,
            engineSocket: d.engineSocket.trim() || null,
            tags,
            favorite: d.favorite,
          },
        });
        props.onSaved(r.profile.id);
      }
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={editing ? t('hosts.edit.title', { host: d.id }) : t('hosts.add.title')}
      onClose={props.onClose}
      wide
      footer={
        <>
          <button type="button" onClick={props.onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            form="host-form"
            className="primary"
            disabled={busy || d.id.trim() === ''}
          >
            {t('common.save')}
          </button>
        </>
      }
    >
      <form
        id="host-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <p className="muted">{t('hosts.form.noSecrets')}</p>
        <div className="form-grid">
          <Field label={t('hosts.form.id')} hint={t('hosts.form.idHint')}>
            {(id) => (
              <input
                id={id}
                type="text"
                value={d.id}
                disabled={editing}
                onChange={(e) => set('id', e.target.value)}
                autoComplete="off"
                spellCheck={false}
                required
              />
            )}
          </Field>
          <Field label={t('hosts.form.hostname')} hint={t('hosts.form.hostnameHint')}>
            {(id) => (
              <input
                id={id}
                type="text"
                value={d.hostname}
                onChange={(e) => set('hostname', e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            )}
          </Field>
          <Field label={t('hosts.form.alias')} hint={t('hosts.form.aliasHint')}>
            {(id) => (
              <input
                id={id}
                type="text"
                value={d.alias}
                onChange={(e) => set('alias', e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            )}
          </Field>
          <Field label={t('hosts.form.user')} hint={t('hosts.form.userHint')}>
            {(id) => (
              <input
                id={id}
                type="text"
                value={d.user}
                onChange={(e) => set('user', e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            )}
          </Field>
          <Field label={t('hosts.form.port')}>
            {(id) => (
              <input
                id={id}
                type="text"
                inputMode="numeric"
                value={d.port}
                onChange={(e) => set('port', e.target.value)}
                autoComplete="off"
              />
            )}
          </Field>
          <Field label={t('hosts.form.proxyJump')} hint={t('hosts.form.proxyJumpHint')}>
            {(id) => (
              <input
                id={id}
                type="text"
                value={d.proxyJump}
                onChange={(e) => set('proxyJump', e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            )}
          </Field>
          <Field label={t('hosts.form.identity')} hint={t('hosts.form.identityHint')}>
            {(id) => (
              <input
                id={id}
                type="text"
                value={d.identityFile}
                onChange={(e) => set('identityFile', e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            )}
          </Field>
          <Field label={t('hosts.form.zone')} hint={t(`hosts.zone.${d.zone}.hint`)}>
            {(id) => (
              <select
                id={id}
                value={d.zone}
                onChange={(e) => set('zone', e.target.value as Draft['zone'])}
              >
                {HOST_ZONES.map((z) => (
                  <option key={z} value={z}>
                    {t(`hosts.zone.${z}`)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label={t('hosts.form.minIsolation')} hint={t('hosts.form.minIsolationHint')}>
            {(id) => (
              <select
                id={id}
                value={d.minIsolation}
                onChange={(e) => set('minIsolation', e.target.value)}
              >
                <option value="">{t('hosts.form.byZone')}</option>
                {ISOLATION_LEVELS.map((l) => (
                  <option key={l} value={l}>
                    {t(`isolation.${l}`)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label={t('hosts.form.engineSocket')} hint={t('hosts.form.engineSocketHint')}>
            {(id) => (
              <input
                id={id}
                type="text"
                value={d.engineSocket}
                onChange={(e) => set('engineSocket', e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            )}
          </Field>
          <Field label={t('hosts.form.tags')} hint={t('hosts.form.tagsHint')}>
            {(id) => (
              <input
                id={id}
                type="text"
                value={d.tags}
                onChange={(e) => set('tags', e.target.value)}
                autoComplete="off"
              />
            )}
          </Field>
          <fieldset className="wide-col">
            <legend>{t('hosts.form.backends')}</legend>
            {HOST_BACKENDS.map((b) => (
              <label key={b} className="inline">
                <input
                  type="checkbox"
                  checked={d.backends.includes(b)}
                  onChange={(e) =>
                    set(
                      'backends',
                      e.target.checked ? [...d.backends, b] : d.backends.filter((x) => x !== b),
                    )
                  }
                />
                {b}
              </label>
            ))}
            <div className="muted small">{t('hosts.form.backendsHint')}</div>
          </fieldset>
          <label className="inline wide-col">
            <input
              type="checkbox"
              checked={d.favorite}
              onChange={(e) => set('favorite', e.target.checked)}
            />
            {t('hosts.form.favorite')}
          </label>
        </div>
        {error ? <ErrorBox error={error} /> : null}
      </form>
    </Dialog>
  );
}

// -- import from ~/.ssh/config ---------------------------------------------------------------------------------------

function ImportDialog(props: { onClose(): void; onDone(count: number): void }) {
  const { t } = useApp();
  const [preview, setPreview] = useState<ImportPreview>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    call('hosts:importPreview').then(
      (p) => {
        if (!cancelled) setPreview(p);
      },
      (e: unknown) => {
        if (!cancelled) setError(e);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  async function apply() {
    setBusy(true);
    setError(undefined);
    try {
      const r = await call('hosts:importApply', { ids: [...selected] });
      props.onDone(r.added.length);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }
  const toggle = (id: string, on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });

  return (
    <Dialog
      title={t('hosts.import.title')}
      onClose={props.onClose}
      wide
      footer={
        <>
          <button type="button" onClick={props.onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy || selected.size === 0}
            onClick={() => void apply()}
          >
            {t('hosts.import.apply', { count: selected.size })}
          </button>
        </>
      }
    >
      <p className="muted">{t('hosts.import.intro')}</p>
      {error ? <ErrorBox error={error} /> : null}
      {!preview && !error ? <Loading /> : null}
      {preview ? (
        <>
          <p className="muted plain">{t('hosts.import.file', { path: preview.path })}</p>
          {preview.warnings.map((w, i) => (
            <Banner key={i} tone="warn">
              <span className="plain">{w}</span>
            </Banner>
          ))}
          {preview.hosts.length === 0 ? <p>{t('hosts.import.none')}</p> : null}
          {preview.hosts.length > 0 ? (
            <>
              <Banner tone="info">{t('hosts.import.defaults')}</Banner>
              <div className="actions">
                <button
                  type="button"
                  onClick={() => setSelected(new Set(preview.hosts.map((h) => h.id)))}
                >
                  {t('hosts.import.selectAll')}
                </button>
                <button type="button" onClick={() => setSelected(new Set())}>
                  {t('hosts.import.selectNone')}
                </button>
              </div>
              <div className="table-wrap">
                <table>
                  <caption className="sr-only">{t('hosts.import.table')}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t('hosts.import.col.select')}</th>
                      <th scope="col">{t('hosts.import.col.alias')}</th>
                      <th scope="col">{t('hosts.col.target')}</th>
                      <th scope="col">{t('hosts.import.col.notes')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.hosts.map((h) => (
                      <tr key={h.id}>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={t('hosts.import.selectOne', { alias: h.alias })}
                            checked={selected.has(h.id)}
                            onChange={(e) => toggle(h.id, e.target.checked)}
                          />
                        </td>
                        <th scope="row" className="plain">
                          {h.alias}
                          <div className="muted small">→ {h.id}</div>
                        </th>
                        <td className="plain">
                          {h.user ? `${h.user}@` : ''}
                          {h.hostname ?? h.alias}
                          {h.port ? `:${h.port}` : ''}
                          {h.proxyJump ? ` via ${h.proxyJump}` : ''}
                          {h.identityFile ? (
                            <div className="muted small">{h.identityFile}</div>
                          ) : null}
                        </td>
                        <td>
                          {h.warnings.map((w, i) => (
                            <div key={i} className="warn-text small plain">
                              {w}
                            </div>
                          ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
          {preview.skipped.length > 0 ? (
            <p className="muted small plain">
              {t('hosts.import.skipped', {
                patterns: preview.skipped.map((s) => s.pattern).join(', '),
              })}
            </p>
          ) : null}
        </>
      ) : null}
    </Dialog>
  );
}

// -- host key dialog --------------------------------------------------------------------------------------------------

/**
 * Shows the SHA256 fingerprint(s) a server presents. An unknown key is trusted only after the explicit
 * confirmation; a changed key blocks everything until the stored key is forgotten (second confirmation).
 */
export function HostKeyDialog(props: {
  host: HostProfile;
  purpose?: 'terminal' | 'test';
  onClose(trusted: boolean): void;
}) {
  const { t } = useApp();
  const [state, dispatch] = useReducer(hostKeyReducer, initialHostKeyState);
  const [selected, setSelected] = useState<string>('');
  const [error, setError] = useState<unknown>();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    dispatch({ type: 'check' });
    setError(undefined);
    call('hosts:keyCheck', { id: props.host.id }).then(
      (view) => {
        if (cancelled) return;
        dispatch({ type: 'checked', view });
        setSelected(primaryFingerprint(view.keys)?.fingerprint ?? '');
      },
      (e: unknown) => {
        if (cancelled) return;
        setError(e);
        dispatch({ type: 'failed', message: (e as Error).message });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [props.host.id, attempt]);

  async function trust() {
    dispatch({ type: 'trust' });
    try {
      await call('hosts:keyTrust', { id: props.host.id, fingerprint: selected });
      dispatch({ type: 'trusted' });
    } catch (e) {
      setError(e);
      dispatch({ type: 'failed', message: (e as Error).message });
    }
  }
  async function forget() {
    dispatch({ type: 'forgetConfirm' });
    try {
      await call('hosts:keyForget', { id: props.host.id });
      dispatch({ type: 'forgotten' });
      setAttempt((n) => n + 1);
    } catch (e) {
      setError(e);
      dispatch({ type: 'failed', message: (e as Error).message });
    }
  }

  const title = t('hosts.key.title', { host: props.host.id });
  const close = () => props.onClose(state.phase === 'trusted');

  return (
    <Dialog
      title={title}
      onClose={close}
      wide
      footer={
        <>
          {state.phase === 'unknown' ? (
            <>
              <button type="button" onClick={close} autoFocus>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="primary"
                disabled={!canTrust(state) || selected === ''}
                onClick={() => void trust()}
              >
                {t('hosts.key.trust')}
              </button>
            </>
          ) : state.phase === 'changed' ? (
            <button type="button" onClick={close} autoFocus>
              {t('hosts.key.cancelBlocked')}
            </button>
          ) : state.phase === 'trusted' ? (
            <button type="button" className="primary" onClick={close} autoFocus>
              {props.purpose === 'terminal' ? t('hosts.key.openTerminal') : t('common.close')}
            </button>
          ) : (
            <button type="button" onClick={close}>
              {t('common.close')}
            </button>
          )}
        </>
      }
    >
      <p className="plain muted">
        {props.host.user ? `${props.host.user}@` : ''}
        {props.host.sshConfigAlias ?? props.host.hostname}
      </p>
      {state.phase === 'checking' ? <Loading /> : null}
      {state.phase === 'error' ? (
        <>
          {error ? <ErrorBox error={error} /> : null}
          <button type="button" onClick={() => setAttempt((n) => n + 1)}>
            {t('common.retry')}
          </button>
        </>
      ) : null}

      {state.phase === 'unknown' ? (
        <>
          <Banner tone="warn">
            <strong>{t('hosts.key.unknown.title')}</strong>
            <p>{t('hosts.key.unknown.text')}</p>
          </Banner>
          <fieldset>
            <legend>{t('hosts.key.fingerprints')}</legend>
            {state.keys.map((k) => (
              <label key={k.fingerprint} className="fp-row">
                <input
                  type="radio"
                  name="fp"
                  checked={selected === k.fingerprint}
                  onChange={() => setSelected(k.fingerprint)}
                  disabled={state.busy}
                />
                <span>
                  <span className="muted small">{k.type}</span>
                  <br />
                  <code className="fp">{k.fingerprint}</code>
                </span>
              </label>
            ))}
          </fieldset>
          <p className="muted small">{t('hosts.key.verifyHow')}</p>
          <label className="inline">
            <input
              type="checkbox"
              checked={state.confirmed}
              disabled={state.busy}
              onChange={(e) => dispatch({ type: 'confirm', value: e.target.checked })}
            />
            {t('hosts.key.confirm')}
          </label>
          {error ? <ErrorBox error={error} /> : null}
        </>
      ) : null}

      {state.phase === 'changed' ? (
        <>
          <Banner tone="danger" role="alert">
            <strong>{t('hosts.key.changed.title')}</strong>
            <p>{t('hosts.key.changed.text')}</p>
          </Banner>
          <dl className="kv-list">
            <dt>{t('hosts.key.stored')}</dt>
            <dd>
              {state.stored.map((k) => (
                <div key={k.fingerprint}>
                  <span className="muted small">{k.type}</span>{' '}
                  <code className="fp">{k.fingerprint}</code>
                </div>
              ))}
            </dd>
            <dt>{t('hosts.key.presented')}</dt>
            <dd>
              {state.presented.map((k) => (
                <div key={k.fingerprint}>
                  <span className="muted small">{k.type}</span>{' '}
                  <code className="fp">{k.fingerprint}</code>
                </div>
              ))}
            </dd>
          </dl>
          {state.forget === 'none' ? (
            <button
              type="button"
              className="danger"
              onClick={() => dispatch({ type: 'forgetRequest' })}
            >
              {t('hosts.key.forget')}
            </button>
          ) : (
            <Banner tone="danger" role="alert">
              <strong>{t('hosts.key.forget.confirmTitle')}</strong>
              <p>{t('hosts.key.forget.confirmText')}</p>
              <div className="actions">
                <button
                  type="button"
                  onClick={() => dispatch({ type: 'forgetCancel' })}
                  disabled={state.forget === 'busy'}
                  autoFocus
                >
                  {t('common.back')}
                </button>
                <button
                  type="button"
                  className="danger"
                  disabled={state.forget === 'busy'}
                  onClick={() => void forget()}
                >
                  {t('hosts.key.forget.confirm')}
                </button>
              </div>
            </Banner>
          )}
          {error ? <ErrorBox error={error} /> : null}
        </>
      ) : null}

      {state.phase === 'trusted' ? (
        <>
          <Banner tone="ok">
            {state.justTrusted ? t('hosts.key.nowTrusted') : t('hosts.key.alreadyTrusted')}
          </Banner>
          {state.keys.map((k) => (
            <div key={k.fingerprint}>
              <span className="muted small">{k.type}</span>{' '}
              <code className="fp">{k.fingerprint}</code>
            </div>
          ))}
        </>
      ) : null}
    </Dialog>
  );
}

// -- port forwards ---------------------------------------------------------------------------------------------------

function ForwardsDialog(props: {
  host: HostProfile | null;
  states: ForwardState[];
  onChanged(): void;
  onClose(): void;
}) {
  const { t, notify } = useApp();
  const [error, setError] = useState<unknown>();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<(typeof FORWARD_KINDS)[number]>('local');
  const [listen, setListen] = useState('');
  const [target, setTarget] = useState('');
  const host = props.host;
  if (!host) return null;
  const forwards: PortForward[] = host.portForwards;

  async function run(fn: () => Promise<unknown>) {
    setError(undefined);
    try {
      await fn();
      props.onChanged();
    } catch (e) {
      setError(e);
    }
  }
  const stateOf = (n: string) => props.states.find((s) => s.name === n);

  return (
    <Dialog
      title={t('hosts.fw.title', { host: host.id })}
      onClose={props.onClose}
      wide
      footer={
        <button type="button" onClick={props.onClose} autoFocus>
          {t('common.close')}
        </button>
      }
    >
      <p className="muted">{t('hosts.fw.intro')}</p>
      {forwards.length === 0 ? <p>{t('hosts.fw.none')}</p> : null}
      {forwards.length > 0 ? (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">{t('hosts.fw.table')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('hosts.fw.col.name')}</th>
                <th scope="col">{t('hosts.fw.col.kind')}</th>
                <th scope="col">{t('hosts.fw.col.spec')}</th>
                <th scope="col">{t('hosts.col.status')}</th>
                <th scope="col">{t('sandboxes.col.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {forwards.map((f) => {
                const st = stateOf(f.name);
                return (
                  <tr key={f.name}>
                    <th scope="row" className="plain">
                      {f.name}
                    </th>
                    <td>{t(`hosts.fw.kind.${f.kind}`)}</td>
                    <td className="plain mono">
                      {f.listen}
                      {f.target ? ` → ${f.target}` : ''}
                    </td>
                    <td>
                      {st?.state === 'running' ? (
                        <Badge tone="ok">{t('hosts.fw.running')}</Badge>
                      ) : st?.state === 'failed' ? (
                        <>
                          <Badge tone="danger">{t('hosts.fw.failed')}</Badge>
                          <div className="danger-text small plain">{st.error}</div>
                        </>
                      ) : (
                        <Badge tone="neutral">{t('hosts.fw.stopped')}</Badge>
                      )}
                    </td>
                    <td>
                      <div className="row-actions">
                        {st?.state === 'running' ? (
                          <button
                            type="button"
                            onClick={() =>
                              void run(() =>
                                call('hosts:forwardStop', { id: host.id, name: f.name }),
                              )
                            }
                          >
                            {t('hosts.fw.stop')}
                            <span className="sr-only"> {f.name}</span>
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() =>
                              void run(() =>
                                call('hosts:forwardStart', { id: host.id, name: f.name }),
                              )
                            }
                          >
                            {t('hosts.fw.start')}
                            <span className="sr-only"> {f.name}</span>
                          </button>
                        )}
                        <button
                          type="button"
                          className="danger"
                          onClick={() =>
                            void run(async () => {
                              await call('hosts:forwardStop', { id: host.id, name: f.name });
                              await call('hosts:update', {
                                id: host.id,
                                patch: { portForwards: forwards.filter((x) => x.name !== f.name) },
                              });
                              notify('ok', t('hosts.fw.removed', { name: f.name }));
                            })
                          }
                        >
                          {t('hosts.action.remove')}
                          <span className="sr-only"> {f.name}</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      <h3 className="h-small">{t('hosts.fw.add')}</h3>
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await call('hosts:update', {
              id: host.id,
              patch: {
                portForwards: [
                  ...forwards,
                  {
                    name: name.trim(),
                    kind,
                    listen: listen.trim(),
                    ...(kind !== 'dynamic' && target.trim() ? { target: target.trim() } : {}),
                  },
                ],
              },
            });
            setName('');
            setListen('');
            setTarget('');
          });
        }}
      >
        <Field label={t('hosts.fw.col.name')}>
          {(id) => (
            <input
              id={id}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="off"
              required
            />
          )}
        </Field>
        <Field label={t('hosts.fw.col.kind')}>
          {(id) => (
            <select
              id={id}
              value={kind}
              onChange={(e) => setKind(e.target.value as (typeof FORWARD_KINDS)[number])}
            >
              {FORWARD_KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`hosts.fw.kind.${k}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={t('hosts.fw.listen')} hint={t('hosts.fw.listenHint')}>
          {(id) => (
            <input
              id={id}
              type="text"
              value={listen}
              onChange={(e) => setListen(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              required
            />
          )}
        </Field>
        {kind !== 'dynamic' ? (
          <Field label={t('hosts.fw.target')} hint={t('hosts.fw.targetHint')}>
            {(id) => (
              <input
                id={id}
                type="text"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                required
              />
            )}
          </Field>
        ) : null}
        <div className="actions wide-col">
          <button type="submit" className="primary">
            {t('hosts.fw.addButton')}
          </button>
        </div>
      </form>
      {error ? <ErrorBox error={error} /> : null}
    </Dialog>
  );
}
