import { useEffect, useRef, useState } from 'react';
import type { ApprovalItem } from '@abox/core';
import { call } from '../api';
import { useApp } from '../context';
import { useQuery } from '../hooks';
import { TemplateReviewPanel } from './review';
import { Banner, Dialog, ErrorBox, Field, Loading } from './ui';
import { safeInline, safeText } from '../../shared/format';

type Step = 'form' | 'creating' | 'confirm' | 'error';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TTL_RE = /^\d{1,6}(ms|s|m|h|d)$/;

/**
 * "Clone": a new sandbox that starts with the files of a snapshot. It is created like any other sandbox: the
 * manager applies the policy, the template's network, limits and secrets and asks for the same confirmations.
 * The snapshot only supplies the filesystem, so the dialog asks for little: a name and optionally a lifetime.
 */
export function CloneSnapshotDialog(props: {
  /** The sandbox the snapshot was taken of. */
  sandboxId: string;
  sandboxName: string;
  snapshot: { id: string; name: string };
  /** The template the snapshot was taken with (the only one it fits). */
  template: string;
  onClose(): void;
}) {
  const { t, notify, navigate } = useApp();
  const [step, setStep] = useState<Step>('form');
  const [name, setName] = useState('');
  const [ttl, setTtl] = useState('');
  const [progress, setProgress] = useState<string[]>([]);
  const [confirmation, setConfirmation] = useState<{
    reasons: string[];
    risks: string[];
    items: ApprovalItem[];
  } | null>(null);
  const [error, setError] = useState<unknown>();
  const [cancelling, setCancelling] = useState(false);
  const cancelled = useRef(false);
  const key = useRef(`clone-${Math.random().toString(36).slice(2)}`);
  const logRef = useRef<HTMLPreElement>(null);

  const nameOk = name.trim() === '' || NAME_RE.test(name.trim());
  const ttlOk = ttl.trim() === '' || TTL_RE.test(ttl.trim());
  const needsReview =
    step === 'confirm' && Boolean(confirmation?.items.some((i) => i.kind === 'template_trust'));
  const review = useQuery(
    'templates:review',
    { name: props.template },
    {
      enabled: needsReview,
      live: false,
    },
  );

  useEffect(() => {
    return window.abox.on('evt:progress', (ev) => {
      if (ev.key !== key.current) return;
      setProgress((p) => [...p.slice(-400), ev.line]);
    });
  }, []);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [progress]);

  async function create(confirmed: boolean) {
    setStep('creating');
    setProgress([]);
    setError(undefined);
    cancelled.current = false;
    setCancelling(false);
    try {
      const res = await call('snapshots:clone', {
        source: { sandboxId: props.sandboxId, snapshotId: props.snapshot.id },
        request: {
          template: props.template,
          ...(name.trim() ? { name: name.trim() } : {}),
          ...(ttl.trim() ? { overrides: { ttl: ttl.trim() } } : {}),
          confirmed,
          progressKey: key.current,
        },
      });
      if (res.status === 'created') {
        notify('ok', t('snapshots.cloned', { name: safeInline(res.sandbox.name, 60) }));
        props.onClose();
        navigate({ view: 'detail', sandboxId: res.sandbox.id });
      } else if (res.status === 'confirmation_required') {
        setConfirmation({ reasons: res.reasons, risks: res.risks, items: res.items });
        setStep('confirm');
      } else {
        // a human is never put in the approval queue; show the message anyway
        setError(new Error(res.message));
        setStep('error');
      }
    } catch (e) {
      if (cancelled.current) {
        notify('info', t('new.cancelled'));
        setStep('form');
        return;
      }
      setError(e);
      setStep('error');
    }
  }

  function cancelCreate() {
    cancelled.current = true;
    setCancelling(true);
    void call('jobs:cancel', { key: key.current }).catch(() => undefined);
  }

  const footer = (
    <>
      {step === 'creating' ? (
        <button type="button" onClick={cancelCreate} disabled={cancelling}>
          {t('common.cancel')}
        </button>
      ) : (
        <button type="button" onClick={props.onClose}>
          {t('common.cancel')}
        </button>
      )}
      {step === 'form' ? (
        <button
          type="button"
          className="primary"
          disabled={!nameOk || !ttlOk}
          onClick={() => void create(false)}
        >
          {t('snapshots.cloneCreate')}
        </button>
      ) : null}
      {step === 'confirm' ? (
        <>
          <button type="button" onClick={() => setStep('form')}>
            {t('common.back')}
          </button>
          <button type="button" className="primary" onClick={() => void create(true)}>
            {t('new.confirmCreate')}
          </button>
        </>
      ) : null}
      {step === 'error' ? (
        <button type="button" onClick={() => setStep('form')}>
          {t('common.back')}
        </button>
      ) : null}
    </>
  );

  return (
    <Dialog
      title={t('snapshots.cloneTitle')}
      onClose={step === 'creating' ? () => undefined : props.onClose}
      footer={footer}
    >
      {step === 'form' ? (
        <>
          <p>
            {t('snapshots.cloneIntro', {
              name: safeInline(props.snapshot.name, 60),
              sandbox: safeInline(props.sandboxName, 60),
            })}
          </p>
          <dl className="kv-list">
            <dt>{t('sandboxes.col.template')}</dt>
            <dd className="plain">{safeInline(props.template, 80)}</dd>
          </dl>
          <Field label={t('snapshots.cloneName')} hint={t('detail.snap.nameHint')}>
            {(id) => (
              <input
                id={id}
                type="text"
                value={name}
                aria-invalid={!nameOk}
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </Field>
          <Field label={t('snapshots.cloneTtl')} hint={t('snapshots.cloneTtlHint')}>
            {(id) => (
              <input
                id={id}
                type="text"
                value={ttl}
                aria-invalid={!ttlOk}
                placeholder="2h"
                onChange={(e) => setTtl(e.target.value)}
              />
            )}
          </Field>
          <p className="muted">{t('snapshots.cloneWorkspace')}</p>
          <p className="muted">{t('snapshots.cloneRules')}</p>
        </>
      ) : null}
      {step === 'creating' ? (
        <>
          <p role="status">{cancelling ? t('new.cancelling') : t('snapshots.cloneCreating')}</p>
          <pre className="log plain" ref={logRef} aria-live="polite" aria-label={t('new.progress')}>
            {progress.join('\n')}
          </pre>
        </>
      ) : null}
      {step === 'confirm' && confirmation ? (
        <>
          <Banner tone="warn">
            <strong>{t('new.confirmTitle')}</strong>
            <p>{t('new.confirmText')}</p>
          </Banner>
          <ul className="item-list">
            {confirmation.items.map((it, i) => (
              <li key={i}>
                <strong className="plain">{safeText(it.reason)}</strong>
                <div className="danger-text plain">{safeText(it.risk)}</div>
              </li>
            ))}
            {confirmation.items.length === 0
              ? [...confirmation.reasons, ...confirmation.risks].map((x, i) => (
                  <li key={i} className="plain">
                    {safeText(x)}
                  </li>
                ))
              : null}
          </ul>
          {needsReview ? (
            <>
              <h3>{t('new.review.title')}</h3>
              {review.loading && !review.data ? <Loading /> : null}
              {review.error ? (
                <Banner tone="warn">
                  <span className="plain">
                    {t('new.review.unavailable', {
                      message: safeInline(review.error.message, 300),
                    })}
                  </span>
                </Banner>
              ) : null}
              {review.data ? <TemplateReviewPanel review={review.data} /> : null}
            </>
          ) : null}
        </>
      ) : null}
      {step === 'error' ? <ErrorBox error={error} /> : null}
    </Dialog>
  );
}
