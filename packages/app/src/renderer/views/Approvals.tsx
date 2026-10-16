import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { ApprovalView } from '@abox/core';
import { call } from '../api';
import { useApp } from '../context';
import { useNow, useQuery } from '../hooks';
import {
  AgentText,
  Badge,
  Banner,
  EmptyState,
  ErrorBox,
  Loading,
  OwnerBadge,
} from '../components/ui';
import { approvalRows, requestTemplateName, riskHints } from '../../shared/approval-diff';
import type { ApprovalRow } from '../../shared/approval-diff';
import { formatDuration, formatTimestamp, remainingMs } from '../../shared/format';

export function ApprovalsView() {
  const { t, route, navigate, notify } = useApp();
  const [showHistory, setShowHistory] = useState(false);
  const pending = useQuery('approvals:list', { status: 'pending' }, { pollMs: 3000 });
  const history = useQuery('approvals:list', { limit: 30 }, { enabled: showHistory, pollMs: 5000 });
  const [selectedId, setSelectedId] = useState<string | undefined>(route.approvalId);
  const queueRef = useRef<HTMLUListElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const now = useNow(1000);

  const pend = pending.data ?? [];
  const decided = (history.data ?? []).filter((a) => a.status !== 'pending');
  const all = useMemo(
    () => [...pend, ...(showHistory ? decided : [])],
    [pend, decided, showHistory],
  );
  const selected = all.find((a) => a.id === selectedId) ?? pend[0];

  // keep a valid selection when the queue changes (without moving focus)
  useEffect(() => {
    if (route.approvalId && all.some((a) => a.id === route.approvalId))
      setSelectedId(route.approvalId);
  }, [route.approvalId, all.length]);

  function onQueueKey(e: KeyboardEvent<HTMLUListElement>) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const buttons = [
      ...(queueRef.current?.querySelectorAll<HTMLButtonElement>('button[data-approval]') ?? []),
    ];
    const i = buttons.findIndex((b) => b === document.activeElement);
    const next =
      buttons[e.key === 'ArrowDown' ? Math.min(i + 1, buttons.length - 1) : Math.max(i - 1, 0)];
    if (next) {
      e.preventDefault();
      next.focus();
    }
  }

  async function afterDecision(msgKey: string, a: ApprovalView) {
    notify('ok', t(msgKey, { agent: a.requester.replace(/^agent:/, '') }));
    await Promise.all([pending.reload(), showHistory ? history.reload() : Promise.resolve()]);
    // back to the queue: the next request must not be answerable with a stray key press
    queueRef.current?.querySelector<HTMLButtonElement>('button[data-approval]')?.focus();
  }

  return (
    <section aria-labelledby="h-approvals">
      <header className="page-head">
        <h1 id="h-approvals">{t('approvals.title')}</h1>
        <div className="actions">
          <label className="inline">
            <input
              type="checkbox"
              checked={showHistory}
              onChange={(e) => setShowHistory(e.target.checked)}
            />{' '}
            {t('approvals.showHistory')}
          </label>
        </div>
      </header>
      {pending.error ? <ErrorBox error={pending.error} /> : null}
      {pending.loading && !pending.data ? <Loading /> : null}

      {pending.data && pend.length === 0 && !showHistory ? (
        <EmptyState title={t('approvals.empty.title')} text={t('approvals.empty.text')} />
      ) : null}

      {all.length > 0 ? (
        <div className="approvals-layout">
          <div>
            <h2 className="h-small" id="h-queue">
              {t('approvals.queue')}{' '}
              <span className="muted">({t('approvals.pending', { count: pend.length })})</span>
            </h2>
            <ul className="queue" ref={queueRef} aria-labelledby="h-queue" onKeyDown={onQueueKey}>
              {all.map((a) => (
                <li key={a.id}>
                  <button
                    type="button"
                    data-approval={a.id}
                    className={`queue-item${selected?.id === a.id ? ' selected' : ''}`}
                    aria-current={selected?.id === a.id ? 'true' : undefined}
                    onClick={() => {
                      setSelectedId(a.id);
                      requestAnimationFrame(() => dialogRef.current?.focus());
                    }}
                  >
                    <span className="plain">
                      <strong>{a.requester.replace(/^agent:/, '')}</strong> &middot;{' '}
                      {kindLabel(t, a.kind)}
                    </span>
                    <span className="muted small plain">
                      {requestTemplateName(a.request) ?? a.sandboxId ?? ''}
                      {a.status === 'pending'
                        ? ` · ${t('approvals.expiresIn', { time: formatDuration(remainingMs(a.expiresAt, now)) })}`
                        : ` · ${t(`approvals.status.${a.status}`)}`}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          {selected ? (
            <ApprovalDialog
              key={selected.id}
              approval={selected}
              dialogRef={dialogRef}
              now={now}
              onApproved={(a) => void afterDecision('approvals.approvedToast', a)}
              onDenied={(a) => void afterDecision('approvals.deniedToast', a)}
              onPermanent={() => navigate({ view: 'policy', hint: 'permanent-allow' })}
            />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export function ApprovalDialog(props: {
  approval: ApprovalView;
  dialogRef?: React.RefObject<HTMLElement | null>;
  now: number;
  onApproved(a: ApprovalView): void;
  onDenied(a: ApprovalView): void;
  onPermanent(): void;
}) {
  const { t } = useApp();
  const a = props.approval;
  const titleId = useId();
  const descId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [showSame, setShowSame] = useState(false);
  const isPending = a.status === 'pending';

  const rows = useMemo(() => approvalRows(a.request), [a.request]);
  const hints = useMemo(() => riskHints(a.kind, a.request), [a.kind, a.request]);
  const changed = rows.filter((r) => r.changed);
  const info = rows.filter((r) => !r.changed && r.standard === null);
  const same = rows.filter((r) => !r.changed && r.standard !== null);

  async function decide(kind: 'approve' | 'deny') {
    if (busy || !isPending) return;
    setBusy(true);
    setError(undefined);
    try {
      await call(kind === 'approve' ? 'approvals:approve' : 'approvals:deny', { id: a.id });
      if (kind === 'approve') props.onApproved(a);
      else props.onDenied(a);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLElement>) {
    if (!isPending) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      void decide('deny');
    } else if (e.key === 'Enter' && e.target === e.currentTarget && !e.repeat) {
      // Only when the dialog itself has focus (not a button inside it, which handles its own Enter)
      e.preventDefault();
      void decide('approve');
    }
  }

  return (
    <section
      className="approval-dialog"
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      aria-describedby={descId}
      tabIndex={0}
      ref={props.dialogRef as React.RefObject<HTMLElement>}
      onKeyDown={onKeyDown}
      data-approval-id={a.id}
    >
      <h2 id={titleId}>{kindLabel(t, a.kind)}</h2>
      <p id={descId} className="meta">
        <OwnerBadge owner={a.requester} />
        {a.sandboxId ? <span className="plain"> &middot; {a.sandboxId}</span> : null}
        {' · '}
        {t('approvals.requestedAt', { time: formatTimestamp(a.createdAt) })}
        {isPending
          ? ` · ${t('approvals.expiresIn', { time: formatDuration(remainingMs(a.expiresAt, props.now)) })}`
          : null}
      </p>

      {!isPending ? (
        <Banner tone="info">
          {t(`approvals.status.${a.status}`)}
          {a.decidedBy ? ` · ${a.decidedBy}` : ''}
          {a.decidedAt ? ` · ${formatTimestamp(a.decidedAt)}` : ''}
        </Banner>
      ) : null}

      <AgentText text={a.reason} label={t('approvals.agentReason')} />

      <h3>{t('approvals.risks')}</h3>
      {hints.length === 0 && a.risks.length === 0 ? (
        <p className="muted">{t('approvals.noRisks')}</p>
      ) : null}
      {hints.length > 0 ? (
        <ul className="chips" aria-label={t('approvals.riskHints')}>
          {hints.map((h) => (
            <li key={h}>
              <Badge
                tone={h === 'isolation_none' || h === 'open_network' ? 'strong-danger' : 'warn'}
              >
                {t(`approvals.hint.${h}`)}
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
      {a.risks.length > 0 ? (
        <ul className="risk-list">
          {a.risks.map((r, i) => (
            <li key={i} className="plain">
              {r}
            </li>
          ))}
        </ul>
      ) : null}

      <h3>{t('approvals.options')}</h3>
      <div className="table-wrap">
        <table className="diff-table">
          <caption className="sr-only">{t('approvals.optionsCaption')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('approvals.col.option')}</th>
              <th scope="col">{t('approvals.col.standard')}</th>
              <th scope="col">{t('approvals.col.requested')}</th>
            </tr>
          </thead>
          {changed.length > 0 ? (
            <tbody>
              <tr className="group-head">
                <th scope="colgroup" colSpan={3}>
                  {t('approvals.group.changed')}
                </th>
              </tr>
              {changed.map((r) => (
                <DiffRow key={r.path} row={r} />
              ))}
            </tbody>
          ) : null}
          {info.length > 0 ? (
            <tbody>
              <tr className="group-head">
                <th scope="colgroup" colSpan={3}>
                  {t('approvals.group.info')}
                </th>
              </tr>
              {info.map((r) => (
                <DiffRow key={r.path} row={r} />
              ))}
            </tbody>
          ) : null}
          {showSame && same.length > 0 ? (
            <tbody>
              <tr className="group-head">
                <th scope="colgroup" colSpan={3}>
                  {t('approvals.group.same')}
                </th>
              </tr>
              {same.map((r) => (
                <DiffRow key={r.path} row={r} />
              ))}
            </tbody>
          ) : null}
        </table>
      </div>
      {changed.length === 0 ? <p className="muted">{t('approvals.noDeviation')}</p> : null}
      {same.length > 0 ? (
        <button
          type="button"
          className="linklike"
          onClick={() => setShowSame((v) => !v)}
          aria-expanded={showSame}
        >
          {showSame ? t('approvals.hideSame') : t('approvals.showSame', { count: same.length })}
        </button>
      ) : null}

      {a.kind === 'template_trust' ? (
        <p className="muted">{t('approvals.kind.template_trust.hint')}</p>
      ) : null}
      {error ? <ErrorBox error={error} /> : null}

      {isPending ? (
        <>
          <div className="dialog-actions">
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => void decide('deny')}
            >
              {t('approvals.deny')}
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => void decide('approve')}
            >
              {t('approvals.allowOnce')}
            </button>
            <button type="button" className="linklike" onClick={props.onPermanent}>
              {t('approvals.allowPermanent')}
            </button>
          </div>
          <p className="muted small">{t('approvals.keys')}</p>
        </>
      ) : null}
    </section>
  );
}

function kindLabel(t: (k: string) => string, kind: string): string {
  const label = t(`approvals.kind.${kind}`);
  return label.startsWith('approvals.kind.') ? kind : label;
}

function DiffRow(props: { row: ApprovalRow }) {
  const { t } = useApp();
  const r = props.row;
  return (
    <tr className={r.changed ? 'row-changed' : ''}>
      <th scope="row">
        <code className="nowrap">{r.path}</code>
      </th>
      <td className="plain pre-line std-col">
        {r.standard === null ? '\u2014' : r.standard || t('common.none')}
      </td>
      <td className="plain pre-line">
        {r.changed ? <span aria-label={t('approvals.changedMark')}>{'\u0394 '}</span> : null}
        {r.requested || t('common.none')}
      </td>
    </tr>
  );
}
