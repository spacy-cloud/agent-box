import { useEffect, useId, useState } from 'react';
import type { TFn } from '../i18n';
import { call } from '../api';
import { useApp } from '../context';
import { Banner, Dialog, ErrorBox, Loading } from './ui';
import { ProjectFolderPicker } from './ProjectFolder';
import { safeInline } from '../../shared/format';
import type { TemplateDraft } from '../../shared/types';

/** One line that says what the draft builds on and why (localised from the structured answer of the manager). */
export function draftBaseText(t: TFn, d: TemplateDraft): string {
  const files = d.base.files.map((f) => safeInline(f, 80)).join(', ');
  switch (d.base.basis) {
    case 'markers':
      return t('tpl.from.markers', { template: safeInline(d.base.template ?? '', 40), files });
    case 'chosen':
      return t('tpl.from.chosen', { template: safeInline(d.base.template ?? '', 40) });
    default:
      return t('tpl.from.fallback');
  }
}

/**
 * "Create template from project": pick a project folder, the manager's detection (the same as the suggestion
 * in New sandbox) chooses the built-in template to build on, and a draft that `extends` it is created, named
 * after the folder. Nothing is saved here: the draft opens in the editor.
 */
export function FromProjectDialog(props: {
  initialDir: string;
  /** Built-in and user templates the draft may build on. */
  bases: string[];
  onClose(): void;
  onCreate(draft: TemplateDraft): void;
}) {
  const { t } = useApp();
  const [dir, setDir] = useState(props.initialDir);
  const [base, setBase] = useState('');
  const [name, setName] = useState('');
  const [touched, setTouched] = useState(false);
  const [draft, setDraft] = useState<TemplateDraft>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const baseId = useId();
  const nameId = useId();

  useEffect(() => {
    setError(undefined);
    if (dir === '') {
      setDraft(undefined);
      return;
    }
    let cancelled = false;
    setLoading(true);
    call('templates:draft', { path: dir, ...(base ? { base } : {}) }).then(
      (d) => {
        if (cancelled) return;
        setDraft(d);
        setName((n) => (touched && n !== '' ? n : d.name));
        setLoading(false);
      },
      (e: unknown) => {
        if (cancelled) return;
        setDraft(undefined);
        setError(e);
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
    // `touched` is read when an answer arrives; a change of it alone does not need a new request
  }, [dir, base]);

  async function create(): Promise<void> {
    if (!draft) return;
    setBusy(true);
    setError(undefined);
    try {
      // asks again with the name, so the manager checks it and writes it into the text
      props.onCreate(
        name === draft.name
          ? draft
          : await call('templates:draft', { path: dir, name, ...(base ? { base } : {}) }),
      );
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }

  const options = [
    ...new Set([
      ...(draft?.base.template ? [draft.base.template] : []),
      ...(draft?.alternatives.map((a) => a.template) ?? []),
      ...props.bases,
    ]),
  ];
  return (
    <Dialog
      title={t('tpl.from.title')}
      onClose={() => !busy && props.onClose()}
      wide
      footer={
        <>
          <button type="button" onClick={props.onClose} disabled={busy} autoFocus>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="primary"
            disabled={!draft || loading || busy || name.trim() === ''}
            onClick={() => void create()}
          >
            {t('tpl.from.create')}
          </button>
        </>
      }
    >
      <p className="muted">{t('tpl.from.intro')}</p>
      <ProjectFolderPicker
        value={dir}
        onChange={(d) => {
          setDir(d);
          setBase('');
          setTouched(false);
        }}
        applyLabel={t('tpl.from.apply')}
        hint={t('tpl.from.folderHint')}
      />
      {loading ? <Loading /> : null}
      {error ? <ErrorBox error={error} /> : null}
      {draft ? (
        <div data-testid="draft-detection">
          <Banner tone={draft.base.basis === 'fallback' ? 'warn' : 'info'}>
            <span className="plain">{draftBaseText(t, draft)}</span>
          </Banner>
          {draft.alternatives.length > 0 ? (
            <p className="muted">
              {t('new.suggest.others', {
                templates: draft.alternatives.map((a) => safeInline(a.template, 40)).join(', '),
              })}
            </p>
          ) : null}
          {draft.projectTemplates.length > 0 ? (
            <p className="muted">
              {t('tpl.from.projectTemplates', {
                templates: draft.projectTemplates.map((n) => safeInline(n, 40)).join(', '),
              })}
            </p>
          ) : null}
          {draft.skipped.length > 0 ? (
            <p className="muted">
              {t('new.suggest.skipped', {
                templates: draft.skipped.map((s) => safeInline(s.template, 40)).join(', '),
              })}
            </p>
          ) : null}
          <div className="form-grid">
            <div className="field">
              <label htmlFor={baseId}>{t('tpl.from.base')}</label>
              <select id={baseId} value={base} onChange={(e) => setBase(e.target.value)}>
                <option value="">
                  {draft.base.template && base === ''
                    ? t('tpl.from.baseDetected', { template: draft.base.template })
                    : t('tpl.from.baseAuto')}
                </option>
                {options.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor={nameId}>{t('tpl.f.name')}</label>
              <input
                id={nameId}
                type="text"
                value={name}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => {
                  setName(e.target.value);
                  setTouched(true);
                }}
              />
              <small className="muted">{t('tpl.f.nameHint')}</small>
            </div>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}
