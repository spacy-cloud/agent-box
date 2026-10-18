import { useEffect, useMemo, useState } from 'react';
import type { ApprovalView } from '@abox/core';
import { call } from '../api';
import { useApp } from '../context';
import { useQuery } from '../hooks';
import { Banner, Dialog, ErrorBox, Loading, Safe } from './ui';
import { PolicyDiff, diffLines, hasChanges } from './PolicyDiff';
import { applyPolicyEdits, proposePolicyChange } from '../../shared/policy-edit';
import type { PolicyChangeItem } from '../../shared/policy-edit';
import { safeInline } from '../../shared/format';
import type { PolicyValidation } from '../../shared/types';

/**
 * "Allow permanently": the policy change that would let requests like this one pass, shown as a diff of
 * `policy.yaml` with a confirmation. Nothing is written before the confirmation; the write is the normal
 * policy edit (validated, revisioned, audited). The request itself stays pending: it is decided separately
 * (allow once or deny), so changing the policy is never a side effect of a decision, and a decision is
 * never a side effect of a policy change.
 *
 * Two sources: an approval request (`approval`: the changes are derived from what the engine found), or a
 * destination of a sandbox's network log (`network`: the manager proposes the edit, see `network:propose`; the
 * caller allows the sandbox itself after `onDone`, with `null` when the profile covers the destination already).
 */
export function PolicyChangeDialog(props: {
  approval?: ApprovalView;
  network?: { id: string; destinations: string[] };
  onClose(): void;
  onDone(revision: number | null): void;
}) {
  const { t, navigate, notify } = useApp();
  const a = props.approval;
  const doc = useQuery('policy:get', undefined, { live: false, enabled: a !== undefined });
  const np = useQuery(
    'network:propose',
    props.network ?? { id: 'none/00000000', destinations: ['none.invalid'] },
    { live: false, enabled: props.network !== undefined },
  );
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set());
  const [validation, setValidation] = useState<PolicyValidation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  const view = doc.data?.view;
  const context = a ? a.requester.replace(/^agent:/, '') : '';
  const requestProfile = (a?.request as { profile?: unknown } | null | undefined)?.profile;
  const profileName = a
    ? typeof requestProfile === 'string'
      ? requestProfile
      : view?.contexts?.[context]?.profile
    : np.data?.profile;
  const profile = profileName ? view?.profiles?.[profileName] : undefined;
  const usedBy = useMemo(
    () =>
      a
        ? Object.entries(view?.contexts ?? {})
            .filter(([, c]) => c.profile === profileName)
            .map(([id]) => id)
        : (np.data?.usedBy ?? []),
    [a, view, profileName, np.data],
  );

  const proposal = useMemo(
    () =>
      a && profile && profileName
        ? proposePolicyChange({
            profile,
            profileName,
            kinds: a.kinds,
            request: a.request,
            base: a.base,
          })
        : null,
    [profile, profileName, a],
  );
  const chosen: PolicyChangeItem[] = (proposal?.items ?? []).filter((i) => !skipped.has(i.id));

  const result = useMemo(
    () =>
      doc.data && profile && profileName && chosen.length > 0
        ? applyPolicyEdits(
            doc.data.text,
            profileName,
            profile,
            chosen.map((i) => i.edit),
          )
        : null,
    [doc.data, profile, profileName, chosen.map((i) => i.id).join('\n')],
  );
  const currentText = a ? doc.data?.text : np.data?.current;
  const baseHash = a ? doc.data?.view.policy.contentHash : np.data?.baseHash;
  const proposedText = a ? (result?.ok ? result.text : null) : (np.data?.proposed ?? null);
  const lines = useMemo(
    () =>
      currentText !== undefined && proposedText !== null
        ? diffLines(currentText, proposedText)
        : [],
    [currentText, proposedText],
  );
  const changed = hasChanges(lines);

  // The manager's own validator has the last word on the proposed text.
  useEffect(() => {
    setValidation(null);
    if (proposedText === null) return;
    let cancelled = false;
    void call('policy:validate', { text: proposedText }).then(
      (v) => !cancelled && setValidation(v),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [proposedText]);

  async function apply() {
    if (baseHash === undefined || proposedText === null) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await call('policy:set', { text: proposedText, baseHash });
      // from the network log the caller says the rest (the destination is allowed for the sandbox right after)
      if (a) notify('ok', t('perm.done', { rev: r.revision }));
      props.onDone(r.revision);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const canApply = !busy && changed && validation?.ok === true;
  const covered = props.network !== undefined && np.data !== undefined && np.data.proposed === null;
  const hasItems = a ? (proposal?.items.length ?? 0) > 0 : (np.data?.added.length ?? 0) > 0;

  return (
    <Dialog
      title={t('perm.title')}
      onClose={props.onClose}
      wide
      footer={
        <>
          <button type="button" onClick={props.onClose} autoFocus>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="linklike"
            onClick={() => {
              props.onClose();
              navigate({ view: 'policy' });
            }}
          >
            {t('perm.openEditor')}
          </button>
          {hasItems ? (
            <button
              type="button"
              className="primary"
              disabled={!canApply}
              onClick={() => void apply()}
            >
              {t('perm.apply')}
            </button>
          ) : null}
          {covered ? (
            <button type="button" className="primary" onClick={() => props.onDone(null)}>
              {t('perm.network.onlyThis')}
            </button>
          ) : null}
        </>
      }
    >
      {doc.error ? <ErrorBox error={doc.error} /> : null}
      {np.error ? <ErrorBox error={np.error} /> : null}
      {(a && !doc.data && doc.loading) || (props.network && !np.data && np.loading) ? (
        <Loading />
      ) : null}
      <Banner tone="warn">{t(a ? 'perm.warning' : 'perm.warning.network')}</Banner>
      {a && doc.data && !profile ? <Banner tone="warn">{t('perm.noProfile')}</Banner> : null}
      {profileName && (profile || np.data) ? (
        <p>
          {t('perm.scope', { profile: safeInline(profileName, 60) })}
          {usedBy.length > 0 ? (
            <>
              {' '}
              {t('perm.usedBy')} <Safe text={usedBy.join(', ')} max={200} />.
            </>
          ) : null}
        </p>
      ) : null}

      {np.data && np.data.added.length > 0 ? (
        <fieldset>
          <legend>{t('perm.changes')}</legend>
          <ul className="plain-list">
            {np.data.added.map((d) => (
              <li key={d}>
                <span className="plain">
                  {t('perm.change.domain', { domain: safeInline(d, 120) })}
                </span>
              </li>
            ))}
          </ul>
        </fieldset>
      ) : null}

      {covered ? (
        <p className="muted">
          {t('perm.network.covered', { profile: safeInline(np.data!.profile, 60) })}
        </p>
      ) : null}

      {proposal && proposal.items.length > 0 ? (
        <fieldset>
          <legend>{t('perm.changes')}</legend>
          <ul className="plain-list check-list">
            {proposal.items.map((i) => (
              <li key={i.id}>
                <label className="inline">
                  <input
                    type="checkbox"
                    checked={!skipped.has(i.id)}
                    onChange={(e) => {
                      const next = new Set(skipped);
                      if (e.target.checked) next.delete(i.id);
                      else next.add(i.id);
                      setSkipped(next);
                    }}
                  />{' '}
                  <span className="plain">
                    {t(
                      i.labelKey,
                      Object.fromEntries(
                        Object.entries(i.params).map(([k, v]) => [k, safeInline(v, 120)]),
                      ),
                    )}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      ) : null}

      {proposal && proposal.unsupported.length > 0 ? (
        <>
          <h3 className="h-small">{t('perm.unsupported')}</h3>
          <ul className="reason-list">
            {proposal.unsupported.map((u) => (
              <li key={u.kind}>
                <strong>{t(`perm.kind.${knownKind(u.kind)}`)}</strong>:{' '}
                {t(`perm.reason.${u.reason}`)}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {a && proposal && proposal.items.length === 0 ? (
        <p className="muted">{t('perm.nothing')}</p>
      ) : null}

      {result && !result.ok ? (
        <Banner tone="danger">{t(`perm.error.${result.error}`)}</Banner>
      ) : null}

      {proposedText !== null && changed ? (
        <>
          <h3 className="h-small">{t('perm.diff')}</h3>
          <PolicyDiff lines={lines} label={t('policy.diffLabel')} />
          <div aria-live="polite">
            {validation && !validation.ok ? (
              <Banner tone="danger" role="alert">
                <strong>{t('policy.invalid')}</strong>
                <ul>
                  {validation.issues.map((i, n) => (
                    <li key={n} className="plain">
                      {i.path ? <code>{safeInline(i.path, 120)}</code> : null}{' '}
                      {safeInline(i.message, 300)}
                    </li>
                  ))}
                </ul>
              </Banner>
            ) : null}
          </div>
        </>
      ) : null}
      {error ? <ErrorBox error={error} /> : null}
    </Dialog>
  );
}

const KINDS = [
  'isolation_none',
  'template_trust',
  'host_zone',
  'mount',
  'network_open',
  'secret_env',
  'secret_file',
  'private_address',
  'image_registry',
  'network_domains',
  'strict_mode',
  'exec',
];
/** A finding kind this version has a label for (others are shown generically, never as a raw key). */
function knownKind(kind: string): string {
  return KINDS.includes(kind) ? kind : 'unknown';
}
