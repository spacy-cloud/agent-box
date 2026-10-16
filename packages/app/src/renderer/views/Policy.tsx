import { useEffect, useMemo, useState } from 'react';
import type { ResolvedProfile } from '@abox/core';
import { call } from '../api';
import { useApp } from '../context';
import { useQuery } from '../hooks';
import { Banner, Dialog, ErrorBox, Loading, Badge } from '../components/ui';
import { diffLines, hasChanges } from '../../shared/line-diff';
import { formatTimestamp } from '../../shared/format';
import type { PolicyValidation } from '../../shared/types';

type Mode = 'view' | 'edit' | 'review';

const KNOWN_ACTORS = ['human', 'external-edit', 'system'];

export function PolicyView() {
  const { t, route, notify } = useApp();
  const doc = useQuery('policy:get', undefined, { pollMs: 5000 });
  const revs = useQuery('policy:revisions', undefined, { pollMs: 8000 });
  const [mode, setMode] = useState<Mode>('view');
  const [draft, setDraft] = useState('');
  const [baseText, setBaseText] = useState('');
  const [baseHash, setBaseHash] = useState('');
  const [validation, setValidation] = useState<PolicyValidation | null>(null);
  const [saveError, setSaveError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [viewRev, setViewRev] = useState<number | null>(null);

  // live validation while editing (the manager's own validator; the GUI has no policy rules)
  useEffect(() => {
    if (mode === 'view') return;
    let cancelled = false;
    const id = setTimeout(() => {
      void call('policy:validate', { text: draft }).then(
        (v) => !cancelled && setValidation(v),
        () => undefined,
      );
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [draft, mode]);

  const diff = useMemo(() => diffLines(baseText, draft), [baseText, draft]);
  const changed = hasChanges(diff);
  const externallyChanged =
    mode !== 'view' && doc.data && doc.data.view.policy.contentHash !== baseHash;

  function startEdit(text?: string) {
    if (!doc.data) return;
    setDraft(text ?? doc.data.text);
    setBaseText(doc.data.text);
    setBaseHash(doc.data.view.policy.contentHash);
    setValidation(null);
    setSaveError(undefined);
    setMode('edit');
  }

  async function save() {
    setBusy(true);
    setSaveError(undefined);
    try {
      const r = await call('policy:set', { text: draft, baseHash });
      notify('ok', t('policy.saved', { rev: r.revision }));
      setMode('view');
      await Promise.all([doc.reload(), revs.reload()]);
    } catch (e) {
      setSaveError(e);
    } finally {
      setBusy(false);
    }
  }

  const view = doc.data?.view;
  return (
    <section aria-labelledby="h-policy">
      <header className="page-head">
        <h1 id="h-policy">{t('policy.title')}</h1>
        <div className="actions">
          {mode === 'view' ? (
            <button
              type="button"
              className="primary"
              onClick={() => startEdit()}
              disabled={!doc.data}
            >
              {t('policy.edit')}
            </button>
          ) : null}
        </div>
      </header>

      {route.hint === 'permanent-allow' ? (
        <Banner tone="info">
          <strong>{t('policy.permanent.title')}</strong>
          <p>{t('policy.permanent.text')}</p>
        </Banner>
      ) : null}
      {doc.error ? <ErrorBox error={doc.error} /> : null}
      {!doc.data && doc.loading ? <Loading /> : null}

      {doc.data && view ? (
        <>
          <p className="muted">
            {doc.data.source === 'default'
              ? t('policy.sourceDefault')
              : t('policy.sourceFile', { path: doc.data.path ?? '' })}
            {' · '}
            {t('policy.revision', { rev: view.policy.revision ?? '-' })}
            {' · '}
            <code title={view.policy.contentHash}>{view.policy.contentHash.slice(0, 12)}</code>
          </p>

          {mode === 'view' ? (
            <>
              <h2>{t('policy.profiles')}</h2>
              <div className="profiles">
                {Object.entries(view.profiles ?? {}).map(([name, p]) => (
                  <ProfileCard
                    key={name}
                    name={name}
                    profile={p}
                    contexts={Object.entries(view.contexts ?? {})
                      .filter(([, c]) => c.profile === name)
                      .map(([id]) => id)}
                  />
                ))}
              </div>
              <h2>{t('policy.contexts')}</h2>
              {Object.keys(view.contexts ?? {}).length === 0 ? (
                <p className="muted">{t('common.none')}</p>
              ) : (
                <div className="table-wrap">
                  <table>
                    <caption className="sr-only">{t('policy.contexts')}</caption>
                    <thead>
                      <tr>
                        <th scope="col">{t('policy.context')}</th>
                        <th scope="col">{t('policy.profile')}</th>
                        <th scope="col">{t('policy.hosts')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(view.contexts ?? {}).map(([id, c]) => (
                        <tr key={id}>
                          <th scope="row" className="plain">
                            {id}
                          </th>
                          <td className="plain">{c.profile}</td>
                          <td className="plain">{(c.hosts ?? []).join(', ') || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <h2>YAML</h2>
              <pre className="code plain" tabIndex={0} aria-label={t('policy.yamlLabel')}>
                {doc.data.text}
              </pre>
            </>
          ) : null}

          {mode === 'edit' ? (
            <>
              <h2>{t('policy.editing')}</h2>
              <p className="muted">{t('policy.editHint')}</p>
              {externallyChanged ? <Banner tone="warn">{t('policy.externalChange')}</Banner> : null}
              <label htmlFor="policy-editor" className="sr-only">
                {t('policy.yamlLabel')}
              </label>
              <textarea
                id="policy-editor"
                className="code editor"
                spellCheck={false}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                aria-describedby="policy-validation"
              />
              <div id="policy-validation" aria-live="polite">
                {validation?.ok ? <Banner tone="ok">{t('policy.valid')}</Banner> : null}
                {validation && !validation.ok ? (
                  <Banner tone="danger" role="alert">
                    <strong>{t('policy.invalid')}</strong>
                    <ul>
                      {validation.issues.map((i, n) => (
                        <li key={n} className="plain">
                          {i.line ? (
                            <code>
                              {i.line}:{i.column ?? 1}
                            </code>
                          ) : null}{' '}
                          {i.path ? <code>{i.path}</code> : null} {i.message}
                        </li>
                      ))}
                    </ul>
                  </Banner>
                ) : null}
              </div>
              <div className="actions">
                <button type="button" onClick={() => setMode('view')}>
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={!validation?.ok || !changed}
                  onClick={() => setMode('review')}
                >
                  {t('policy.review')}
                </button>
              </div>
            </>
          ) : null}

          {mode === 'review' ? (
            <>
              <h2>{t('policy.reviewTitle')}</h2>
              <Banner tone="warn">{t('policy.reviewWarning')}</Banner>
              <pre className="diff plain" tabIndex={0} aria-label={t('policy.diffLabel')}>
                {diff
                  .map((l, i) => ({ l, i }))
                  .filter(({ l, i }) => l.kind !== 'same' || nearChange(diff, i, 2))
                  .map(({ l, i }) => (
                    <span
                      key={i}
                      className={l.kind === 'add' ? 'diff-add' : l.kind === 'del' ? 'diff-del' : ''}
                    >
                      {l.kind === 'add' ? '+ ' : l.kind === 'del' ? '- ' : '  '}
                      {l.text}
                      {'\n'}
                    </span>
                  ))}
              </pre>
              {externallyChanged ? <Banner tone="warn">{t('policy.externalChange')}</Banner> : null}
              {saveError ? <ErrorBox error={saveError} /> : null}
              <div className="actions">
                <button type="button" onClick={() => setMode('edit')} disabled={busy}>
                  {t('common.back')}
                </button>
                <button
                  type="button"
                  className="primary"
                  onClick={() => void save()}
                  disabled={busy}
                >
                  {t('policy.apply')}
                </button>
              </div>
            </>
          ) : null}

          <h2>{t('policy.history')}</h2>
          {revs.error ? <ErrorBox error={revs.error} /> : null}
          {revs.data && revs.data.length === 0 ? (
            <p className="muted">{t('policy.historyEmpty')}</p>
          ) : null}
          {revs.data && revs.data.length > 0 ? (
            <div className="table-wrap">
              <table>
                <caption className="sr-only">{t('policy.history')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('policy.rev')}</th>
                    <th scope="col">{t('audit.col.time')}</th>
                    <th scope="col">{t('audit.col.actor')}</th>
                    <th scope="col">Hash</th>
                    <th scope="col">{t('sandboxes.col.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {revs.data.map((r) => (
                    <tr key={r.rev}>
                      <td>
                        {r.rev}
                        {r.contentHash === view.policy.contentHash ? (
                          <>
                            {' '}
                            <Badge tone="ok">{t('policy.hist.current')}</Badge>
                          </>
                        ) : null}
                      </td>
                      <td className="mono">{formatTimestamp(r.ts)}</td>
                      <td className="plain">
                        {KNOWN_ACTORS.includes(r.actor) ? t(`policy.actor.${r.actor}`) : r.actor}
                      </td>
                      <td className="mono" title={r.contentHash}>
                        {r.contentHash.slice(0, 12)}
                      </td>
                      <td>
                        <button type="button" onClick={() => setViewRev(r.rev)}>
                          {t('policy.hist.view')}
                          <span className="sr-only"> {r.rev}</span>
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {viewRev !== null ? (
            <RevisionDialog
              rev={viewRev}
              currentText={doc.data.text}
              canEdit={mode === 'view'}
              onUse={(text) => {
                setViewRev(null);
                startEdit(text);
              }}
              onClose={() => setViewRev(null)}
            />
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function RevisionDialog(props: {
  rev: number;
  currentText: string;
  canEdit: boolean;
  onUse(text: string): void;
  onClose(): void;
}) {
  const { t } = useApp();
  const q = useQuery('policy:revision', { rev: props.rev }, { live: false });
  const diff = useMemo(
    () => (q.data ? diffLines(q.data.content, props.currentText) : []),
    [q.data, props.currentText],
  );
  const differs = hasChanges(diff);
  return (
    <Dialog
      title={t('policy.rev.title', { rev: props.rev })}
      onClose={props.onClose}
      wide
      footer={
        <>
          <button type="button" onClick={props.onClose} autoFocus>
            {t('common.close')}
          </button>
          {props.canEdit && q.data && differs ? (
            <button type="button" className="primary" onClick={() => props.onUse(q.data!.content)}>
              {t('policy.rev.use')}
            </button>
          ) : null}
        </>
      }
    >
      {q.error ? <ErrorBox error={q.error} /> : null}
      {!q.data && q.loading ? <Loading /> : null}
      {q.data ? (
        <>
          <p className="muted plain">
            {formatTimestamp(q.data.ts)} · {q.data.actor} ·{' '}
            <code title={q.data.contentHash}>{q.data.contentHash.slice(0, 12)}</code>
          </p>
          <p className="muted">{t('policy.rev.useHint')}</p>
          <h3 className="h-small">{differs ? t('policy.rev.diff') : t('policy.rev.same')}</h3>
          {differs ? (
            <pre className="diff plain" tabIndex={0} aria-label={t('policy.rev.diffLabel')}>
              {diff
                .map((l, i) => ({ l, i }))
                .filter(({ l, i }) => l.kind !== 'same' || nearChange(diff, i, 2))
                .map(({ l, i }) => (
                  <span
                    key={i}
                    className={l.kind === 'add' ? 'diff-add' : l.kind === 'del' ? 'diff-del' : ''}
                  >
                    {l.kind === 'add' ? '+ ' : l.kind === 'del' ? '- ' : '  '}
                    {l.text}
                    {'\n'}
                  </span>
                ))}
            </pre>
          ) : null}
          <h3 className="h-small">{t('policy.rev.content')}</h3>
          <pre
            className="code plain"
            tabIndex={0}
            aria-label={t('policy.rev.contentLabel', { rev: props.rev })}
          >
            {q.data.content}
          </pre>
        </>
      ) : null}
    </Dialog>
  );
}

function nearChange(diff: Array<{ kind: string }>, i: number, ctx: number): boolean {
  for (let d = -ctx; d <= ctx; d++) {
    const x = diff[i + d];
    if (x && x.kind !== 'same') return true;
  }
  return false;
}

function ProfileCard(props: { name: string; profile: ResolvedProfile; contexts: string[] }) {
  const { t } = useApp();
  const p = props.profile;
  return (
    <article className="card" aria-labelledby={`prof-${props.name}`}>
      <h3 id={`prof-${props.name}`} className="plain">
        {props.name}{' '}
        <Badge tone={p.approval === 'strict' ? 'warn' : p.approval === 'open' ? 'info' : 'neutral'}>
          {t(`policy.approval.${p.approval}`)}
        </Badge>
      </h3>
      {props.contexts.length > 0 ? (
        <p className="muted small plain">
          {t('policy.usedBy', { contexts: props.contexts.join(', ') })}
        </p>
      ) : null}
      <dl className="kv-list">
        <dt>{t('policy.templates')}</dt>
        <dd className="plain">{p.templates.join(', ')}</dd>
        <dt>{t('policy.limits')}</dt>
        <dd className="plain">
          {p.limits.sandboxes} {t('policy.sandboxes')}, {p.limits.cpus} CPU, {p.limits.memory}, TTL{' '}
          {p.limits.ttl}
        </dd>
        <dt>{t('policy.workspace')}</dt>
        <dd className="plain">
          {p.workspace.modes.join(', ')} ({p.workspace.roots.join(', ')})
        </dd>
        <dt>{t('policy.network')}</dt>
        <dd className="plain">
          {p.network.modes.map((m) => t(`network.${m}`)).join(', ')}
          {p.network.allow_presets.length > 0 ? ` · ${p.network.allow_presets.join(', ')}` : ''}
        </dd>
        <dt>{t('policy.mounts')}</dt>
        <dd className="plain">
          {p.mounts === null
            ? t('policy.denied')
            : `${p.mounts.roots.join(', ')} (${p.mounts.access.join('/')})`}
        </dd>
        <dt>{t('policy.secrets')}</dt>
        <dd className="plain">
          {p.secrets.allowed.join(', ') || t('common.none')} ({p.secrets.inject.join('/')})
        </dd>
        <dt>{t('policy.isolation')}</dt>
        <dd className="plain">
          min {p.isolation.min}, open network {p.isolation.network_open}, mounts{' '}
          {p.isolation.mounts}
        </dd>
        <dt>{t('policy.hosts')}</dt>
        <dd className="plain">{p.hosts.join(', ')}</dd>
      </dl>
    </article>
  );
}
