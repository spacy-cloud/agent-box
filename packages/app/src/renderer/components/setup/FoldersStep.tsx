import { useEffect, useMemo, useRef, useState } from 'react';
import { call } from '../../api';
import { useApp } from '../../context';
import { useQuery } from '../../hooks';
import { Badge, Banner, ErrorBox, Field, Loading } from '../ui';
import { PolicyDiff, diffLines, hasChanges } from '../PolicyDiff';
import { safeInline } from '../../../shared/format';
import type { PolicyValidation, SetupRootsFolder } from '../../../shared/types';

/**
 * Step 2: which folders contain the projects agents may work on (`workspace.roots` of an agent profile). The text of
 * policy.yaml is proposed by the main process, shown as a diff and only written after an explicit confirmation, through
 * the normal policy edit (validated, revisioned, audited). Nothing is widened silently.
 */
export function FoldersStep(props: {
  folders: string[];
  setFolders(next: string[]): void;
  profile: string | undefined;
  setProfile(p: string | undefined): void;
  /** The roots (as written to policy.yaml) that were saved. */
  onSaved(entries: string[]): void;
}) {
  const { t, notify } = useApp();
  const { folders, setFolders, profile, setProfile } = props;
  const roots = useQuery(
    'setup:roots',
    { ...(profile ? { profile } : {}), folders },
    { live: false },
  );
  const data = roots.data;
  const [draft, setDraft] = useState('');
  const [validation, setValidation] = useState<PolicyValidation | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const confirmRef = useRef<HTMLButtonElement>(null);

  const lines = useMemo(
    () => (data?.proposed ? diffLines(data.current, data.proposed) : []),
    [data?.current, data?.proposed],
  );
  const changed = hasChanges(lines);

  // The manager's own validator has the last word on the proposed text.
  useEffect(() => {
    setValidation(null);
    setConfirming(false);
    const text = data?.proposed;
    if (!text) return;
    let cancelled = false;
    void call('policy:validate', { text }).then(
      (v) => !cancelled && setValidation(v),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [data?.proposed]);

  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);

  function add(dir: string) {
    const d = dir.trim();
    if (d === '' || folders.includes(d)) return;
    setFolders([...folders, d]);
    setDraft('');
  }
  async function browse() {
    try {
      const dir = await call('dialog:pickDirectory');
      if (dir) add(dir);
    } catch (e) {
      setError(e);
    }
  }
  async function save() {
    if (!data?.proposed) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await call('policy:set', { text: data.proposed, baseHash: data.baseHash });
      notify('ok', t('setup.folders.saved', { rev: r.revision }));
      setConfirming(false);
      setFolders([]);
      props.onSaved(newOnes.map((f) => f.entry ?? f.input));
      await roots.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const newOnes = data?.folders.filter((f) => f.status === 'new') ?? [];
  return (
    <>
      <Banner tone="info">
        <strong>{t('setup.folders.whatTitle')}</strong>
        <p>{t('setup.folders.what')}</p>
        <p>{t('setup.folders.whatNot')}</p>
      </Banner>
      {roots.error ? <ErrorBox error={roots.error} /> : null}
      {roots.loading && !data ? <Loading /> : null}
      {data && data.profile === null ? (
        <Banner tone="warn">{t('setup.folders.noProfile')}</Banner>
      ) : null}
      {data && data.profile !== null ? (
        <>
          {data.profiles.length > 1 ? (
            <Field label={t('setup.folders.profile')} hint={t('setup.folders.profileHint')}>
              {(id) => (
                <select
                  id={id}
                  value={data.profile ?? ''}
                  onChange={(e) => {
                    setProfile(e.target.value);
                  }}
                >
                  {data.profiles.map((p) => (
                    <option key={p.name} value={p.name}>
                      {safeInline(p.name, 60)} ({safeInline(p.usedBy.join(', '), 100)})
                    </option>
                  ))}
                </select>
              )}
            </Field>
          ) : (
            <p className="muted">
              {t('setup.folders.scope', {
                profile: safeInline(data.profile, 60),
                contexts: safeInline(data.usedBy.join(', '), 160),
              })}
            </p>
          )}
          <h4 className="h-small" id="h-roots-now">
            {t('setup.folders.now')}
          </h4>
          {data.roots.length === 0 ? (
            <p className="muted">{t('setup.folders.noneYet')}</p>
          ) : (
            <ul
              className="plain-list mono"
              aria-labelledby="h-roots-now"
              data-testid="current-roots"
            >
              {data.roots.map((r) => (
                <li key={r} className="plain">
                  {safeInline(r, 200)}
                </li>
              ))}
            </ul>
          )}

          <h4 className="h-small">{t('setup.folders.add')}</h4>
          <Field label={t('setup.folders.field')} hint={t('setup.folders.fieldHint')}>
            {(id) => (
              <div className="with-button wrap">
                <input
                  id={id}
                  type="text"
                  value={draft}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="~/projects"
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      add(draft);
                    }
                  }}
                />
                <button type="button" disabled={draft.trim() === ''} onClick={() => add(draft)}>
                  {t('setup.folders.addButton')}
                </button>
                <button type="button" onClick={() => void browse()}>
                  {t('common.browse')}
                </button>
              </div>
            )}
          </Field>

          {data.folders.length > 0 ? (
            <ul className="plain-list folder-list" aria-label={t('setup.folders.chosen')}>
              {data.folders.map((f) => (
                <FolderRow
                  key={f.input}
                  folder={f}
                  onRemove={() => setFolders(folders.filter((x) => x !== f.input))}
                />
              ))}
            </ul>
          ) : null}

          {data.error ? <Banner tone="danger">{t(`perm.error.${data.error}`)}</Banner> : null}

          {data.proposed && changed ? (
            <>
              <h4 className="h-small">{t('setup.folders.diff')}</h4>
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
              {!confirming ? (
                <div className="actions">
                  <button
                    type="button"
                    className="primary"
                    disabled={validation?.ok !== true}
                    onClick={() => setConfirming(true)}
                  >
                    {t('setup.folders.review')}
                  </button>
                </div>
              ) : (
                <Banner tone="warn">
                  <strong>{t('setup.folders.confirmTitle')}</strong>
                  <p>
                    {t('setup.folders.confirm', {
                      count: newOnes.length,
                      profile: safeInline(data.profile, 60),
                      contexts: safeInline(data.usedBy.join(', '), 160),
                    })}
                  </p>
                  <ul className="plain-list mono">
                    {newOnes.map((f) => (
                      <li key={f.input} className="plain">
                        {safeInline(f.entry ?? f.input, 200)}
                      </li>
                    ))}
                  </ul>
                  <div className="actions">
                    <button type="button" onClick={() => setConfirming(false)} disabled={busy}>
                      {t('common.cancel')}
                    </button>
                    <button
                      type="button"
                      className="primary"
                      ref={confirmRef}
                      disabled={busy}
                      onClick={() => void save()}
                    >
                      {t('setup.folders.save')}
                    </button>
                  </div>
                </Banner>
              )}
            </>
          ) : null}
          {error ? <ErrorBox error={error} /> : null}
        </>
      ) : null}
    </>
  );
}

function FolderRow(props: { folder: SetupRootsFolder; onRemove(): void }) {
  const { t } = useApp();
  const f = props.folder;
  const label = f.path ?? f.input;
  return (
    <li className="folder-row">
      <div className="folder-main">
        <code className="plain">{safeInline(label, 200)}</code>{' '}
        {f.status === 'new' ? <Badge tone="info">{t('setup.folders.status.new')}</Badge> : null}
        {f.status === 'covered' ? (
          <Badge tone="neutral">{t('setup.folders.status.covered')}</Badge>
        ) : null}
        {f.status === 'refused' ? (
          <Badge tone="danger">{t('setup.folders.status.refused')}</Badge>
        ) : null}
        {f.status === 'covered' && f.coveredBy ? (
          <div className="muted small plain">
            {t('setup.folders.coveredBy', { root: safeInline(f.coveredBy, 160) })}
          </div>
        ) : null}
        {f.status === 'refused' && f.reason ? (
          <div className="danger-text small plain">{safeInline(f.reason, 400)}</div>
        ) : null}
        {f.status === 'new' && f.looksLikeProject ? (
          <div className="warn-text small">{t('setup.folders.looksLikeProject')}</div>
        ) : null}
      </div>
      <button
        type="button"
        aria-label={t('setup.folders.removeNamed', { path: safeInline(label, 120) })}
        onClick={props.onRemove}
      >
        {t('common.remove')}
      </button>
    </li>
  );
}
