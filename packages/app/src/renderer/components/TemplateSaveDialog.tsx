import { useEffect, useState } from 'react';
import { call } from '../api';
import { useApp } from '../context';
import { Badge, Banner, Dialog, ErrorBox, Loading } from './ui';
import { PolicyDiff, diffLines, hasChanges } from './PolicyDiff';
import { safeInline, safeText } from '../../shared/format';
import type { TemplateSaved, TemplateSavePlanView } from '../../shared/types';

export type SaveTarget = 'user' | 'project';

/**
 * Review before a template is saved: where the file goes (the user template directory or `.sandbox/` of the
 * picked project), the difference between the file as it is now and the text in the editor, whether
 * sandboxes were created from a template of that name, and what the save does not do (trust a project
 * template). Nothing is written before the button of this dialog is pressed. What the dialog shows comes from
 * the manager (`templates:savePlan`: the same path checks as the save).
 */
export function TemplateSaveDialog(props: {
  yaml: string;
  name: string;
  /** The folder picked above the list ('' = none): the project target needs it. */
  projectDir: string;
  /** The editor holds the saved user template of this name: replacing its file is what the human expects. */
  inPlace: boolean;
  initialTarget: SaveTarget;
  onClose(): void;
  onSaved(r: TemplateSaved): void;
}) {
  const { t } = useApp();
  const [target, setTarget] = useState<SaveTarget>(
    props.initialTarget === 'project' && props.projectDir === '' ? 'user' : props.initialTarget,
  );
  const [plan, setPlan] = useState<TemplateSavePlanView>();
  const [planError, setPlanError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<unknown>();

  useEffect(() => {
    let cancelled = false;
    setPlan(undefined);
    setPlanError(undefined);
    setSaveError(undefined);
    call('templates:savePlan', {
      yaml: props.yaml,
      target,
      ...(target === 'project' ? { projectDir: props.projectDir } : {}),
    }).then(
      (p) => !cancelled && setPlan(p),
      (e: unknown) => !cancelled && setPlanError(e),
    );
    return () => {
      cancelled = true;
    };
  }, [props.yaml, props.projectDir, target]);

  async function save(): Promise<void> {
    if (!plan) return;
    setBusy(true);
    setSaveError(undefined);
    try {
      const r = await call('templates:save', {
        yaml: props.yaml,
        target,
        ...(target === 'project' ? { projectDir: props.projectDir } : {}),
        // replacing is only asked for when the review showed that the file exists
        ...(plan.exists ? { overwrite: true } : {}),
        confirmed: true,
      });
      props.onSaved(r);
    } catch (e) {
      setSaveError(e);
      setBusy(false);
    }
  }

  const text = props.yaml.endsWith('\n') ? props.yaml : `${props.yaml}\n`;
  const lines = plan ? diffLines(plan.current ?? '', text) : [];
  const unchanged = plan?.exists === true && !hasChanges(lines);
  const projectDisabled = props.projectDir === '';

  return (
    <Dialog
      title={t('tpl.save.title', { name: safeInline(props.name, 60) })}
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
            disabled={!plan || busy || unchanged}
            onClick={() => void save()}
          >
            {plan?.exists ? t('tpl.save.confirmReplace') : t('tpl.save.confirm')}
          </button>
        </>
      }
    >
      <fieldset className="save-target">
        <legend>{t('tpl.save.target')}</legend>
        <label className="inline">
          <input
            type="radio"
            name="save-target"
            checked={target === 'user'}
            disabled={busy}
            onChange={() => setTarget('user')}
          />
          {t('tpl.save.user')}
        </label>
        <label className="inline">
          <input
            type="radio"
            name="save-target"
            checked={target === 'project'}
            disabled={busy || projectDisabled}
            onChange={() => setTarget('project')}
          />
          {t('tpl.save.project')}
        </label>
        {projectDisabled ? <small className="muted">{t('tpl.save.projectNone')}</small> : null}
      </fieldset>

      {planError ? <ErrorBox error={planError} /> : null}
      {!plan && !planError ? <Loading /> : null}
      {plan ? (
        <div data-testid="save-review">
          <p className="plain">
            {t('tpl.save.file')}: <code className="plain">{safeText(plan.path)}</code>{' '}
            <Badge tone={plan.exists ? 'warn' : 'ok'}>
              {plan.exists ? t('tpl.save.existing') : t('tpl.save.new')}
            </Badge>
          </p>
          {plan.exists && !props.inPlace && target === 'user' ? (
            <Banner tone="warn">{t('tpl.save.replacesOther', { name: plan.name })}</Banner>
          ) : null}
          {plan.exists && target === 'project' ? (
            <Banner tone="warn">{t('tpl.save.replacesProject', { name: plan.name })}</Banner>
          ) : null}
          {plan.usedBy.count > 0 ? (
            <Banner tone="info">
              {t('tpl.save.inUse', {
                count: plan.usedBy.count,
                name: safeInline(plan.name, 60),
                names: plan.usedBy.names.map((n) => safeInline(n, 40)).join(', '),
              })}
            </Banner>
          ) : null}
          {plan.shadows.length > 0 ? (
            <Banner tone="info">{t('tpl.shadows', { name: plan.name })}</Banner>
          ) : null}
          {target === 'project' ? (
            <Banner tone="warn">{t('tpl.save.projectWarning')}</Banner>
          ) : null}
          <h3 className="h-small">{t('tpl.save.diff')}</h3>
          {unchanged ? (
            <p className="muted">{t('tpl.save.noChange')}</p>
          ) : (
            <PolicyDiff lines={lines} label={t('tpl.save.diffLabel')} />
          )}
        </div>
      ) : null}
      {saveError ? <ErrorBox error={saveError} /> : null}
    </Dialog>
  );
}
