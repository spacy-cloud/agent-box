import { useState } from 'react';
import { call } from '../api';
import { useApp } from '../context';
import { useNow, useQuery } from '../hooks';
import { Badge, Banner, ConfirmDialog, ErrorBox, Loading, Safe } from './ui';
import { formatBytes, formatDuration, safeInline } from '../../shared/format';
import type { CacheRemoveResult, CacheView } from '../../shared/types';

type Ask = { kind: 'one'; cache: CacheView } | { kind: 'all' };

const sizeOf = (caches: readonly CacheView[]): number =>
  caches.reduce((sum, c) => sum + (c.sizeBytes ?? 0), 0);

/**
 * The package caches of all hosts (`abox cache ls`): what they are, how big, whether a sandbox still uses them,
 * and the way to remove them. Removing is always confirmed; a cache only costs download time, so nothing else is
 * lost. The manager refuses a cache a sandbox uses and skips those on "remove all"; the buttons mirror that.
 */
export function CachesSection() {
  const { t, notify } = useApp();
  // sizes are measured by the engine (slow on big stores): no live refetch, the human reloads or removes
  const list = useQuery('caches:list', undefined, { live: false });
  const now = useNow(30_000);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [result, setResult] = useState<CacheRemoveResult | null>(null);

  const data = list.data;
  const caches = data?.caches ?? [];
  const removable = caches.filter((c) => !c.inUse);

  function sizeText(c: CacheView): string {
    return c.sizeBytes === null ? t('settings.caches.sizeUnknown') : formatBytes(c.sizeBytes);
  }

  async function remove(a: Ask) {
    setBusy(true);
    setError(undefined);
    setResult(null);
    try {
      const res = await call(
        'caches:remove',
        a.kind === 'one' ? { keys: [a.cache.key], host: a.cache.host } : { all: true },
      );
      setAsk(null);
      setResult(res);
      if (res.removed.length > 0) {
        notify(
          'ok',
          t('settings.caches.removed', {
            count: res.removed.length,
            size: formatBytes(sizeOf(res.removed)),
          }),
        );
      }
      await list.reload();
    } catch (e) {
      setAsk(null);
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h2 id="h-caches">{t('settings.caches')}</h2>
      <p className="muted">{t('settings.caches.hint')}</p>
      <div className="actions">
        <button type="button" onClick={() => void list.reload()} disabled={busy || list.loading}>
          {t('settings.caches.reload')}
        </button>
        <button
          type="button"
          className="danger"
          disabled={busy || removable.length === 0}
          title={
            caches.length > 0 && removable.length === 0 ? t('settings.caches.allInUse') : undefined
          }
          onClick={() => setAsk({ kind: 'all' })}
        >
          {t('settings.caches.removeAll')}
        </button>
      </div>
      {list.error ? <ErrorBox error={list.error} /> : null}
      {error ? <ErrorBox error={error} /> : null}
      {result ? <RemoveResult result={result} /> : null}
      {!data && list.loading ? <Loading /> : null}
      {data ? (
        <>
          {data.unreachable.length > 0 ? (
            <Banner tone="warn">
              <strong>{t('settings.caches.unreachable')}</strong>
              <ul className="plain-list">
                {data.unreachable.map((u) => (
                  <li key={u.host} className="plain small">
                    <code>{safeInline(u.host, 60)}</code>: {safeInline(u.error, 200)}
                  </li>
                ))}
              </ul>
            </Banner>
          ) : null}
          {caches.length === 0 ? (
            <p className="muted">{t('settings.caches.empty')}</p>
          ) : (
            <>
              <dl className="kv-list" data-testid="caches-summary">
                <dt>{t('settings.caches.count')}</dt>
                <dd>{caches.length}</dd>
                <dt>{t('settings.caches.totalSize')}</dt>
                <dd>{formatBytes(data.totalBytes)}</dd>
              </dl>
              <div className="table-wrap">
                <table>
                  <caption className="sr-only">{t('settings.caches')}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t('settings.caches.col.project')}</th>
                      <th scope="col">{t('sandboxes.col.template')}</th>
                      <th scope="col">{t('settings.caches.col.name')}</th>
                      <th scope="col">{t('settings.caches.col.size')}</th>
                      <th scope="col">{t('settings.caches.col.lastUsed')}</th>
                      <th scope="col">{t('sandboxes.col.state')}</th>
                      <th scope="col">{t('sandboxes.col.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {caches.map((c) => (
                      <CacheRow
                        key={`${c.host}/${c.key}`}
                        cache={c}
                        now={now}
                        busy={busy}
                        onRemove={() => setAsk({ kind: 'one', cache: c })}
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
          title={ask.kind === 'one' ? t('settings.caches.remove') : t('settings.caches.removeAll')}
          confirmLabel={
            ask.kind === 'one' ? t('settings.caches.remove') : t('settings.caches.removeAll')
          }
          danger
          busy={busy}
          onClose={() => setAsk(null)}
          onConfirm={() => void remove(ask)}
        >
          {ask.kind === 'one' ? (
            <p>
              {t('settings.caches.confirmOne', {
                name: safeInline(ask.cache.name, 60),
                project: safeInline(ask.cache.project, 120),
                size: sizeText(ask.cache),
              })}
            </p>
          ) : (
            <p>
              {t('settings.caches.confirmAll', {
                count: removable.length,
                size: formatBytes(sizeOf(removable)),
              })}
            </p>
          )}
          <p className="muted">{t('settings.caches.confirmLoss')}</p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}

function CacheRow(props: { cache: CacheView; now: number; busy: boolean; onRemove(): void }) {
  const { t } = useApp();
  const c = props.cache;
  const where = [
    c.host !== 'local' ? c.host : undefined,
    c.owner !== 'human' ? c.owner : undefined,
  ].filter((x): x is string => x !== undefined);
  const name = safeInline(c.name, 60);
  return (
    <tr>
      <th scope="row">
        <Safe text={c.project} max={80} />
        {where.length > 0 ? (
          <div className="muted small">
            <Safe text={where.join(' · ')} max={80} />
          </div>
        ) : null}
      </th>
      <td>
        <Safe text={c.stack} max={60} />
      </td>
      <td>
        <Safe text={c.name} max={60} />
      </td>
      <td className="mono">
        {c.sizeBytes === null ? t('settings.caches.sizeUnknown') : formatBytes(c.sizeBytes)}
      </td>
      <td>
        {t('settings.caches.age', { time: formatDuration(Math.max(0, props.now - c.lastUsedAt)) })}
      </td>
      <td>
        {c.inUse ? (
          <Badge tone="info" title={t('settings.caches.inUseHint')}>
            {t('settings.caches.inUse')}
          </Badge>
        ) : (
          <span className="muted">{t('settings.caches.unused')}</span>
        )}
      </td>
      <td>
        <button
          type="button"
          className="danger"
          disabled={props.busy || c.inUse}
          title={c.inUse ? t('settings.caches.inUseHint') : undefined}
          aria-label={t('settings.caches.removeNamed', {
            name,
            project: safeInline(c.project, 60),
          })}
          onClick={props.onRemove}
        >
          {t('settings.caches.remove')}
        </button>
      </td>
    </tr>
  );
}

/** What a removal did: the removed caches, those it left alone (a sandbox uses them) and failures. */
function RemoveResult(props: { result: CacheRemoveResult }) {
  const { t } = useApp();
  const r = props.result;
  const clean = r.skipped.length === 0 && r.errors.length === 0;
  return (
    <Banner tone={clean && r.removed.length > 0 ? 'ok' : 'warn'}>
      <strong>
        {r.removed.length > 0
          ? t('settings.caches.removed', {
              count: r.removed.length,
              size: formatBytes(sizeOf(r.removed)),
            })
          : t('settings.caches.removedNone')}
      </strong>
      {r.skipped.length > 0 ? (
        <>
          <div>{t('settings.caches.skipped')}</div>
          <ul className="plain-list">
            {r.skipped.map((s) => (
              <li key={`${s.cache.host}/${s.cache.key}`} className="plain small">
                {safeInline(s.cache.name, 60)} ({safeInline(s.cache.project, 80)}):{' '}
                {safeInline(s.reason, 200)}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {r.errors.length > 0 ? (
        <>
          <div>{t('settings.caches.errors')}</div>
          <ul className="plain-list">
            {r.errors.map((e, i) => (
              <li key={i} className="plain small">
                {safeInline(e, 300)}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Banner>
  );
}
