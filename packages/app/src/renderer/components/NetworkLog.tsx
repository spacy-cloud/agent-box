import { useState } from 'react';
import type { NetworkLogEntry } from '@abox/core';
import { call } from '../api';
import { useApp } from '../context';
import { useQuery } from '../hooks';
import { formatTimestamp, safeInline } from '../../shared/format';
import {
  Badge,
  Banner,
  ConfirmDialog,
  Disclosure,
  EmptyState,
  ErrorBox,
  Loading,
  Safe,
} from './ui';
import { PolicyChangeDialog } from './PolicyChangeDialog';

/** `host` for the default ports, `host:port` otherwise (the form an allowlist entry takes). */
function destinationLabel(e: Pick<NetworkLogEntry, 'host' | 'port'>, unreadable: string): string {
  if (e.host === '') return unreadable;
  return e.port === 443 || e.port === 80 || e.port < 1 ? e.host : `${e.host}:${e.port}`;
}

/** What the badge says about a destination: the newest decision, with the history that matters. */
function decisionOf(e: NetworkLogEntry): {
  tone: 'ok' | 'warn' | 'danger';
  key: 'allowed' | 'denied' | 'now' | 'failed';
} {
  if (e.denied > 0 && e.allowedNow) return { tone: 'warn', key: 'now' };
  if (e.decision === 'deny') return { tone: 'danger', key: 'denied' };
  if (e.reasonKind === 'connect_failed') return { tone: 'warn', key: 'failed' };
  return { tone: 'ok', key: 'allowed' };
}

/** Which explanation of "can not be allowed" applies (the manager's own text is kept for what it names itself). */
function whyKey(e: NetworkLogEntry): string {
  switch (e.reasonKind) {
    case 'blocked_address':
    case 'ip_literal':
    case 'dns_failed':
    case 'plain_http_injection':
    case 'method_not_allowed':
    case 'invalid_request':
      return e.reasonKind;
    case 'not_in_allowlist':
    case 'port_not_allowed':
      return 'destination';
    default:
      return 'other';
  }
}

type Pending =
  | { kind: 'permanent'; entry: NetworkLogEntry; pattern: string }
  | { kind: 'wildcard'; entry: NetworkLogEntry; pattern: string }
  | { kind: 'confirm'; pattern: string; reasons: string[]; risks: string[] };

/**
 * The "Netz" tab of a sandbox: what the egress proxy allowed and denied, grouped by destination, with
 * "allow for this sandbox" and "allow permanently" for what the manager says can be allowed. The decisions
 * about what is allowed are the manager's: this view only shows its answer (`allow` of each entry) and offers
 * the buttons. Live: refetched every few seconds and on every change tick, like the activity tab.
 */
export function NetworkTab(props: { id: string }) {
  const { t, notify } = useApp();
  const [onlyDenied, setOnlyDenied] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>();
  const q = useQuery(
    'network:log',
    { id: props.id, limit: 500, ...(onlyDenied ? { denied: true } : {}) },
    { pollMs: 4000 },
  );

  /** Allows `pattern` for this sandbox; the manager may ask for a confirmation first (wildcards). */
  async function allowOnce(pattern: string, confirmed: boolean, then?: () => void): Promise<void> {
    setBusy(pattern);
    setError(undefined);
    try {
      const r = await call('network:allow', {
        id: props.id,
        destinations: [pattern],
        ...(confirmed ? { confirmed: true } : {}),
      });
      if (r.status === 'confirmation_required') {
        setPending({ kind: 'confirm', pattern, reasons: r.reasons, risks: r.risks });
        return;
      }
      setPending(null);
      notify('ok', t('net.allowed', { destination: safeInline(pattern, 120) }));
      then?.();
      await q.reload();
    } catch (e) {
      setPending(null);
      setError(e);
    } finally {
      setBusy(null);
    }
  }

  if (q.error && !q.data) return <ErrorBox error={q.error} />;
  if (!q.data) return <Loading />;
  const log = q.data;

  if (log.mode === 'none') {
    return <EmptyState title={t('net.none.title')} text={t('net.none.text')} />;
  }
  if (log.mode === 'open') {
    return <EmptyState title={t('net.open.title')} text={t('net.open.text')} />;
  }

  return (
    <>
      <p className="muted">{t('net.intro')}</p>
      <div className="net-toolbar">
        <label>
          <input
            type="checkbox"
            checked={onlyDenied}
            onChange={(e) => setOnlyDenied(e.target.checked)}
          />
          {t('net.filter.denied')}
        </label>
        <span className="muted" role="status">
          {t('net.summary', {
            denied: log.totals.denied,
            allowed: log.totals.allowed,
            destinations: log.totals.destinations,
          })}
        </span>
      </div>
      {q.error ? <ErrorBox error={q.error} /> : null}
      {error ? <ErrorBox error={error} /> : null}
      {log.truncated ? <Banner tone="info">{t('net.truncated')}</Banner> : null}
      {log.entries.length === 0 ? (
        <p className="muted">{t(onlyDenied ? 'net.empty.denied' : 'net.empty')}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">{t('net.table')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('net.col.domain')}</th>
                <th scope="col">{t('net.col.decision')}</th>
                <th scope="col">{t('net.col.count')}</th>
                <th scope="col">{t('net.col.last')}</th>
                <th scope="col">{t('net.col.reason')}</th>
                <th scope="col">{t('net.col.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {log.entries.map((e) => (
                <Row
                  key={`${e.host}:${e.port}`}
                  entry={e}
                  busy={busy}
                  onOnce={(p) => void allowOnce(p, false)}
                  onPermanent={(pattern) => setPending({ kind: 'permanent', entry: e, pattern })}
                  onWildcard={(pattern) => setPending({ kind: 'wildcard', entry: e, pattern })}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small">{t('net.once.note')}</p>

      {pending?.kind === 'permanent' ? (
        <PolicyChangeDialog
          network={{ id: props.id, destinations: [pending.pattern] }}
          onClose={() => setPending(null)}
          onDone={(rev) => {
            const pattern = pending.pattern;
            setPending(null);
            void allowOnce(pattern, false, () => {
              if (rev !== null)
                notify(
                  'ok',
                  t('net.permanent.done', { rev, destination: safeInline(pattern, 120) }),
                );
            });
          }}
        />
      ) : null}
      {pending?.kind === 'wildcard' ? (
        <ConfirmDialog
          title={t('net.wildcard.title')}
          confirmLabel={t('net.wildcard.confirm')}
          danger
          busy={busy !== null}
          onClose={() => setPending(null)}
          onConfirm={() => void allowOnce(pending.pattern, true)}
        >
          <p>
            {t('net.wildcard.text', {
              pattern: safeInline(pending.pattern, 120),
              host: safeInline(pending.entry.host, 120),
            })}
          </p>
          <Banner tone="warn">{t('net.wildcard.risk')}</Banner>
        </ConfirmDialog>
      ) : null}
      {pending?.kind === 'confirm' ? (
        <ConfirmDialog
          title={t('net.confirm.title')}
          confirmLabel={t('common.confirm')}
          busy={busy !== null}
          onClose={() => setPending(null)}
          onConfirm={() => void allowOnce(pending.pattern, true)}
        >
          <ul className="plain-list">
            {[...pending.reasons, ...pending.risks].map((x, i) => (
              <li key={i} className="plain">
                <Safe text={x} max={400} />
              </li>
            ))}
          </ul>
        </ConfirmDialog>
      ) : null}
    </>
  );
}

function Row(props: {
  entry: NetworkLogEntry;
  busy: string | null;
  onOnce(pattern: string): void;
  onPermanent(pattern: string): void;
  onWildcard(pattern: string): void;
}) {
  const { t } = useApp();
  const e = props.entry;
  const label = destinationLabel(e, t('net.unreadable'));
  const d = decisionOf(e);
  const allow = e.allow;
  return (
    <tr>
      <th scope="row" className="plain net-domain">
        <Safe text={label} max={120} className="mono" />
      </th>
      <td>
        <Badge tone={d.tone}>{t(`net.decision.${d.key}`)}</Badge>
      </td>
      <td className="mono">
        {e.count}
        {e.denied > 0 && e.allowed > 0 ? (
          <div className="muted small">
            {t('net.count.detail', { denied: e.denied, allowed: e.allowed })}
          </div>
        ) : null}
      </td>
      <td className="nowrap">{formatTimestamp(e.lastSeen)}</td>
      <td>
        {e.reasonKind && (e.denied > 0 || e.reasonKind === 'connect_failed') ? (
          <>
            <div>{t(`net.reason.${e.reasonKind}`)}</div>
            {e.reason ? (
              <div className="muted small">
                <Safe text={e.reason} max={120} className="mono" />
              </div>
            ) : null}
          </>
        ) : (
          '—'
        )}
      </td>
      <td>
        {e.denied > 0 && e.allowedNow ? (
          <span className="muted">{t('net.already')}</span>
        ) : allow?.possible && allow.pattern ? (
          <div className="row-actions">
            <button
              type="button"
              disabled={props.busy !== null}
              aria-label={t('net.action.once.for', { destination: safeInline(label, 120) })}
              onClick={() => props.onOnce(allow.pattern!)}
            >
              {t('net.action.once')}
            </button>
            <button
              type="button"
              disabled={props.busy !== null}
              aria-label={t('net.action.permanent.for', { destination: safeInline(label, 120) })}
              onClick={() => props.onPermanent(allow.pattern!)}
            >
              {t('net.action.permanent')}
            </button>
            {allow.wildcard ? (
              <button
                type="button"
                className="linklike"
                disabled={props.busy !== null}
                aria-label={t('net.action.wildcard.for', {
                  pattern: safeInline(allow.wildcard, 120),
                })}
                onClick={() => props.onWildcard(allow.wildcard!)}
              >
                {t('net.action.wildcard')}
              </button>
            ) : null}
          </div>
        ) : allow && !allow.possible ? (
          <Disclosure label={t('net.cannot')}>
            <p className="small plain">{t(`net.why.${whyKey(e)}`)}</p>
            {whyKey(e) === 'destination' ? (
              <p className="small muted plain">{safeInline(allow.why ?? '', 600)}</p>
            ) : null}
          </Disclosure>
        ) : (
          '—'
        )}
      </td>
    </tr>
  );
}
