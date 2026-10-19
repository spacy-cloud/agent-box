import { useState } from 'react';
import type { BackendKind } from '@abox/core';
import { call } from '../api';
import { useApp } from '../context';
import { useNow, useQuery } from '../hooks';
import { CloneSnapshotDialog } from './CloneSnapshotDialog';
import { Banner, ConfirmDialog, ErrorBox, Field, Loading, Safe } from './ui';
import { OverflowMenu } from './OverflowMenu';
import { formatBytes, formatDuration, formatTimestamp, safeInline } from '../../shared/format';
import type { SnapshotView } from '../../shared/types';

/**
 * The Snapshots tab of a sandbox: take a snapshot, restore the sandbox to one, start a new sandbox from one
 * ("clone") or delete it. Restore and delete are confirmed; clone is a normal create (the dialog shows the
 * manager's confirmation when the template needs one). What a backend cannot do is disabled with the reason.
 */
export function SnapshotsTab(props: {
  id: string;
  name: string;
  template: string;
  backend: BackendKind;
}) {
  const { t, notify } = useApp();
  const snapshots = useQuery('snapshots:list', { id: props.id }, { pollMs: 5000 });
  const now = useNow(30_000);
  const [name, setName] = useState('');
  const [restoreSnap, setRestoreSnap] = useState<SnapshotView | null>(null);
  const [deleteSnap, setDeleteSnap] = useState<SnapshotView | null>(null);
  const [cloneSnap, setCloneSnap] = useState<SnapshotView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const snaps = snapshots.data ?? [];

  async function create() {
    setError(undefined);
    try {
      const r = await call('snapshots:create', { id: props.id, name });
      notify('ok', t('detail.snap.created', { id: r.snapshotId }));
      setName('');
      await snapshots.reload();
    } catch (e) {
      setError(e);
    }
  }
  async function restore(snap: SnapshotView) {
    setRestoreSnap(null);
    try {
      await call('snapshots:restore', { id: props.id, snapshotId: snap.id });
      notify('ok', t('detail.snap.restored', { id: snap.id }));
    } catch (e) {
      setError(e);
    }
  }
  async function remove(snap: SnapshotView) {
    setBusy(true);
    setError(undefined);
    try {
      const r = await call('snapshots:delete', {
        refs: [{ backend: props.backend, sandboxId: props.id, snapshotId: snap.id }],
      });
      setDeleteSnap(null);
      const failed = r.errors[0];
      if (failed) {
        setError(Object.assign(new Error(failed.message), { code: failed.code }));
      } else {
        notify('ok', t('snapshots.deleted', { count: 1, size: formatBytes(snap.sizeBytes ?? 0) }));
      }
      await snapshots.reload();
    } catch (e) {
      setDeleteSnap(null);
      setError(e);
    } finally {
      setBusy(false);
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
              pattern="[A-Za-z0-9._\-]{1,64}"
              required
            />
          )}
        </Field>
        <button type="submit" className="primary" disabled={!/^[A-Za-z0-9._-]{1,64}$/.test(name)}>
          {t('detail.snap.create')}
        </button>
      </form>
      {error ? <ErrorBox error={error} /> : null}
      {snapshots.error ? <ErrorBox error={snapshots.error} /> : null}
      {snapshots.loading && !snapshots.data ? <Loading /> : null}
      {snapshots.data && snaps.length === 0 ? (
        <p className="muted">{t('detail.snap.empty')}</p>
      ) : null}
      {snaps.length > 0 ? (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">{t('detail.tab.snapshots')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('detail.snap.name')}</th>
                <th scope="col">{t('snapshots.col.size')}</th>
                <th scope="col">{t('snapshots.col.age')}</th>
                <th scope="col">{t('sandboxes.col.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {snaps.map((snap) => {
                const label = safeInline(snap.name, 60);
                return (
                  <tr key={snap.id}>
                    <td>
                      <Safe text={snap.name} max={80} />
                      <div className="muted small">
                        <Safe text={snap.id} max={80} className="mono" />
                      </div>
                    </td>
                    <td className="mono">
                      {snap.sizeBytes === undefined
                        ? t('snapshots.sizeUnknown')
                        : formatBytes(snap.sizeBytes)}
                    </td>
                    <td title={formatTimestamp(snap.createdAt)}>
                      {t('snapshots.age', {
                        time: formatDuration(Math.max(0, now - snap.createdAt)),
                      })}
                    </td>
                    <td>
                      <div className="row-actions">
                        <button
                          type="button"
                          aria-label={t('snapshots.restoreNamed', { name: label })}
                          onClick={() => setRestoreSnap(snap)}
                        >
                          {t('detail.snap.restore')}
                        </button>
                        <button
                          type="button"
                          aria-label={t('snapshots.cloneNamed', { name: label })}
                          disabled={!snap.cloneable}
                          title={
                            snap.cloneable
                              ? undefined
                              : t(`snapshots.cloneBlocked.${snap.cloneBlocked ?? 'backend'}`)
                          }
                          onClick={() => setCloneSnap(snap)}
                        >
                          {t('snapshots.clone')}
                        </button>
                        <OverflowMenu
                          label={t('menu.more', { name: label })}
                          items={[
                            {
                              id: 'delete',
                              label: t('snapshots.delete'),
                              danger: true,
                              disabled: !snap.deletable,
                              ...(snap.deletable
                                ? {}
                                : { title: t('snapshots.deleteUnsupported') }),
                              onSelect: () => setDeleteSnap(snap),
                            },
                          ]}
                        />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      {snaps.some((s) => !s.deletable) ? (
        <Banner tone="info">{t('snapshots.deleteUnsupported')}</Banner>
      ) : null}
      {restoreSnap ? (
        <ConfirmDialog
          title={t('detail.snap.restore')}
          confirmLabel={t('detail.snap.restore')}
          danger
          onClose={() => setRestoreSnap(null)}
          onConfirm={() => void restore(restoreSnap)}
        >
          <p>{t('detail.snap.restoreConfirm', { id: restoreSnap.id })}</p>
        </ConfirmDialog>
      ) : null}
      {deleteSnap ? (
        <ConfirmDialog
          title={t('snapshots.delete')}
          confirmLabel={t('snapshots.delete')}
          danger
          busy={busy}
          onClose={() => setDeleteSnap(null)}
          onConfirm={() => void remove(deleteSnap)}
        >
          <p>
            {t('snapshots.deleteConfirm', {
              name: safeInline(deleteSnap.name, 60),
              size:
                deleteSnap.sizeBytes === undefined
                  ? t('snapshots.sizeUnknown')
                  : formatBytes(deleteSnap.sizeBytes),
            })}
          </p>
          <p className="muted">{t('snapshots.deleteKeeps')}</p>
        </ConfirmDialog>
      ) : null}
      {cloneSnap ? (
        <CloneSnapshotDialog
          sandboxId={props.id}
          sandboxName={props.name}
          snapshot={cloneSnap}
          template={props.template}
          onClose={() => setCloneSnap(null)}
        />
      ) : null}
    </>
  );
}
