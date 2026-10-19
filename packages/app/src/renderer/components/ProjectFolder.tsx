import { useEffect, useId, useState } from 'react';
import { call } from '../api';
import { useApp } from '../context';
import { useQuery } from '../hooks';
import { ErrorBox, Field } from './ui';

/**
 * Picks the project folder whose `.sandbox/*.yaml` are offered as project templates: a path field, the
 * native folder dialog and the folders used recently (kept by the main process in the app's settings).
 * The main process checks every folder (absolute, a directory, canonical) before it is applied, and the
 * value handed to `onChange` is the canonical path it returned. An empty value means "no project folder".
 */
export function ProjectFolderPicker(props: {
  value: string;
  onChange(dir: string): void;
  /** Text of the apply button (default: "Show templates"), and the hint under the field. */
  applyLabel?: string;
  hint?: string;
}) {
  const { t } = useApp();
  const recent = useQuery('projects:recent', undefined, { live: false });
  const [draft, setDraft] = useState(props.value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const recentId = useId();
  useEffect(() => setDraft(props.value), [props.value]);

  async function use(dir: string): Promise<void> {
    const wanted = dir.trim();
    setError(undefined);
    if (wanted === '') {
      props.onChange('');
      return;
    }
    setBusy(true);
    try {
      const r = await call('projects:remember', { dir: wanted });
      setDraft(r.dir);
      props.onChange(r.dir);
      await recent.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  async function browse(): Promise<void> {
    try {
      const dir = await call('dialog:pickDirectory');
      if (dir) await use(dir);
    } catch (e) {
      setError(e);
    }
  }

  const others = (recent.data ?? []).filter((d) => d !== props.value);
  return (
    <div className="project-picker" data-testid="project-picker">
      <Field label={t('project.label')} hint={props.hint ?? t('project.hint')}>
        {(id) => (
          <div className="with-button wrap">
            <input
              id={id}
              type="text"
              value={draft}
              autoComplete="off"
              spellCheck={false}
              placeholder="/home/…/project"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void use(draft);
                }
              }}
            />
            <button
              type="button"
              disabled={busy || draft.trim() === props.value}
              onClick={() => void use(draft)}
            >
              {props.applyLabel ?? t('project.apply')}
            </button>
            <button type="button" onClick={() => void browse()}>
              {t('common.browse')}
            </button>
            {props.value ? (
              <button type="button" onClick={() => void use('')}>
                {t('project.clear')}
              </button>
            ) : null}
          </div>
        )}
      </Field>
      {others.length > 0 ? (
        <div className="field">
          <label htmlFor={recentId}>{t('project.recent')}</label>
          <select
            id={recentId}
            value=""
            onChange={(e) => {
              if (e.target.value) void use(e.target.value);
            }}
          >
            <option value="">{t('project.recentPlaceholder')}</option>
            {others.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {error ? <ErrorBox error={error} /> : null}
    </div>
  );
}
