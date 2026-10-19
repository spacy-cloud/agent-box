import { useState } from 'react';
import { call } from '../api';
import { useApp } from '../context';
import { useNow, useQuery } from '../hooks';
import { Badge, Banner, ConfirmDialog, ErrorBox, Loading, Safe } from './ui';
import { formatBytes, formatDuration, formatTimestamp, safeInline } from '../../shared/format';
import type { DeleteSnapshotsResult, SnapshotEntry } from '../../shared/types';

const keyOf = (s: SnapshotEntry): string => `${s.backend}|${s.sandboxId}|${s.id}`;

const sizeOf = (list: readonly SnapshotEntry[]): number =>
  list.reduce((sum, s) => sum + (s.sizeBytes ?? 0), 0);

/**
 * Every snapshot of every backend, for cleanup (`abox snapshot ls --all`): which sandbox it belongs to, how big and
 * how old it is, and the total. Snapshots of sandboxes that no longer exist are marked and can be selected in one
 * step. Deleting is always confirmed and only ever removes the chosen snapshots: sandboxes stay, and a sandbox that
 * was created from a snapshot keeps its files.
 */
export function SnapshotsSection() {
  const { t, notify } = useApp();
  // the engine is asked (sizes are cached there); no live refetch, the human reloads or deletes
  const list = useQuery('snapshots:listAll', undefined, { live: false });
  const now = useNow(30_000);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [result, setResult] = useState<DeleteSnapshotsResult | null>(null);

  const data = list.data;
  const snapshots = data?.snapshots ?? [];
  // what is selected and still listed (a reload may have dropped some)
  const selected = snapshots.filter((s) => picked.has(keyOf(s)));
  const orphaned = snapshots.filter((s) => s.orphaned);
  const deletable = snapshots.filter((s) => s.deletable);

  function toggle(s: SnapshotEntry, on: boolean) {
    setPicked((p) => {
      const next = new Set(p);
      if (on) next.add(keyOf(s));
      else next.delete(keyOf(s));
      return next;
    });
  }

  async function remove() {
    setBusy(true);
    setError(undefined);
    setResult(null);
    try {
      const res = await call('snapshots:delete', {
        refs: selected.map((s) => ({
          backend: s.backend,
          sandboxId: s.sandboxId,
          snapshotId: s.id,
        })),
      });
      setAsk(false);
      setResult(res);
      setPicked(new Set());
      if (res.removed.length > 0) {
        const gone = new Set(res.removed.map((r) => r.snapshotId));
        notify(
          'ok',
          t('snapshots.deleted', {
            count: res.removed.length,
            size: formatBytes(sizeOf(selected.filter((s) => gone.has(s.id)))),
          }),
        );
      }
      await list.reload();
    } catch (e) {
      setAsk(false);
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h2 id="h-snapshots">{t('settings.snapshots')}</h2>
      <p className="muted">{t('settings.snapshots.hint')}</p>
      <div className="actions">
        <button type="button" onClick={() => void list.reload()} disabled={busy || list.loading}>
          {t('settings.snapshots.reload')}
        </button>
        <button
          type="button"
          disabled={busy || orphaned.length === 0}
          onClick={() =>
            setPicked(new Set(orphaned.filter((s) => s.deletable).map((s) => keyOf(s))))
          }
        >
          {t('settings.snapshots.selectOrphaned')}
        </button>
        <button
          type="button"
          className="danger"
          disabled={busy || selected.length === 0}
          onClick={() => setAsk(true)}
        >
          {t('settings.snapshots.deleteSelected', { count: selected.length })}
        </button>
      </div>
      {list.error ? <ErrorBox error={list.error} /> : null}
      {error ? <ErrorBox error={error} /> : null}
      {result ? <DeleteResult result={result} /> : null}
      {!data && list.loading ? <Loading /> : null}
      {data ? (
        <>
          {data.unreachable.length > 0 ? (
            <Banner tone="warn">
              <strong>{t('settings.snapshots.unreachable')}</strong>
              <ul className="plain-list">
                {data.unreachable.map((u) => (
                  <li key={`${u.host}/${u.backend}`} className="plain small">
                    <code>{safeInline(`${u.backend} @ ${u.host}`, 80)}</code>:{' '}
                    {safeInline(u.error, 200)}
                  </li>
                ))}
              </ul>
            </Banner>
          ) : null}
          {snapshots.length === 0 ? (
            <p className="muted">{t('settings.snapshots.empty')}</p>
          ) : (
            <>
              <dl className="kv-list" data-testid="snapshots-summary">
                <dt>{t('settings.snapshots.count')}</dt>
                <dd>{snapshots.length}</dd>
                <dt>{t('settings.snapshots.totalSize')}</dt>
                <dd>{formatBytes(data.totalBytes)}</dd>
                <dt>{t('settings.snapshots.orphanedCount')}</dt>
                <dd>
                  {orphaned.length} ({formatBytes(sizeOf(orphaned))})
                </dd>
              </dl>
              <div className="table-wrap">
                <table>
                  <caption className="sr-only">{t('settings.snapshots')}</caption>
                  <thead>
                    <tr>
                      <th scope="col">
                        <input
                          type="checkbox"
                          aria-label={t('settings.snapshots.selectAll')}
                          disabled={busy || deletable.length === 0}
                          checked={
                            deletable.length > 0 && deletable.every((s) => picked.has(keyOf(s)))
                          }
                          onChange={(e) =>
                            setPicked(
                              e.target.checked
                                ? new Set(deletable.map((s) => keyOf(s)))
                                : new Set(),
                            )
                          }
                        />
                      </th>
                      <th scope="col">{t('detail.snap.name')}</th>
                      <th scope="col">{t('settings.snapshots.col.sandbox')}</th>
                      <th scope="col">{t('snapshots.col.size')}</th>
                      <th scope="col">{t('snapshots.col.age')}</th>
                      <th scope="col">{t('sandboxes.col.state')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshots.map((s) => (
                      <SnapshotRow
                        key={keyOf(s)}
                        snapshot={s}
                        now={now}
                        busy={busy}
                        checked={picked.has(keyOf(s))}
                        onToggle={(on) => toggle(s, on)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      ) : null}
      {ask ? (
        <ConfirmDialog
          title={t('settings.snapshots.deleteTitle')}
          confirmLabel={t('snapshots.delete')}
          danger
          busy={busy}
          onClose={() => setAsk(false)}
          onConfirm={() => void remove()}
        >
          <p>
            {t('settings.snapshots.confirm', {
              count: selected.length,
              size: formatBytes(sizeOf(selected)),
            })}
          </p>
          <p className="muted">{t('snapshots.deleteKeeps')}</p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}

function SnapshotRow(props: {
  snapshot: SnapshotEntry;
  now: number;
  busy: boolean;
  checked: boolean;
  onToggle(on: boolean): void;
}) {
  const { t } = useApp();
  const s = props.snapshot;
  const sandbox = s.sandboxName ?? s.sandboxId;
  return (
    <tr>
      <td>
        <input
          type="checkbox"
          checked={props.checked}
          disabled={props.busy || !s.deletable}
          title={s.deletable ? undefined : t('snapshots.deleteUnsupported')}
          aria-label={t('settings.snapshots.selectRow', {
            name: safeInline(s.name, 60),
            sandbox: safeInline(sandbox, 60),
          })}
          onChange={(e) => props.onToggle(e.target.checked)}
        />
      </td>
      <th scope="row">
        <Safe text={s.name} max={80} />
        <div className="muted small">
          <Safe text={s.id} max={80} className="mono" />
        </div>
      </th>
      <td>
        <Safe text={sandbox} max={60} />
        <div className="muted small">
          <Safe text={s.sandboxId} max={60} className="mono" />
        </div>
      </td>
      <td className="mono">
        {s.sizeBytes === undefined ? t('snapshots.sizeUnknown') : formatBytes(s.sizeBytes)}
      </td>
      <td title={formatTimestamp(s.createdAt)}>
        {t('snapshots.age', { time: formatDuration(Math.max(0, props.now - s.createdAt)) })}
      </td>
      <td>
        {s.orphaned ? (
          <Badge tone="warn" title={t('settings.snapshots.orphanedHint')}>
            {t('settings.snapshots.orphaned')}
          </Badge>
        ) : (
          <span className="muted">{t('settings.snapshots.sandboxExists')}</span>
        )}
      </td>
    </tr>
  );
}

/** What a deletion did: how many went, and the snapshots that could not be deleted with the reason. */
function DeleteResult(props: { result: DeleteSnapshotsResult }) {
  const { t } = useApp();
  const r = props.result;
  return (
    <Banner tone={r.errors.length === 0 && r.removed.length > 0 ? 'ok' : 'warn'}>
      <strong>
        {r.removed.length > 0
          ? t('settings.snapshots.removedCount', { count: r.removed.length })
          : t('settings.snapshots.removedNone')}
      </strong>
      {r.errors.length > 0 ? (
        <>
          <div>{t('settings.snapshots.errors')}</div>
          <ul className="plain-list">
            {r.errors.map((e, i) => (
              <li key={i} className="plain small">
                <code>{safeInline(e.ref.snapshotId, 80)}</code>: {safeInline(e.message, 300)}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Banner>
  );
}
