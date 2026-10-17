import { useEffect, useRef, useState } from 'react';
import type { TemplateListEntry } from '@abox/core';
import { call } from '../api';
import { useApp } from '../context';
import { useQuery } from '../hooks';
import {
  Banner,
  Dialog,
  ErrorBox,
  Field,
  IsolationBadge,
  Loading,
  Badge,
  Safe,
} from '../components/ui';
import { safeInline, safeText } from '../../shared/format';
import { ImageUseBlock, TemplateReviewPanel } from '../components/review';
import { ProjectFolderPicker } from '../components/ProjectFolder';
import {
  WorkspaceEstimateNote,
  estimateBlocksCreate,
  useWorkspaceEstimate,
} from '../components/WorkspaceEstimate';
import { NETWORK_MODES, WORKSPACE_MODES } from '../../shared/constants';
import { describeBase } from '../../shared/image-ref';
import type { IpcInput } from '../../shared/ipc';
import type { ApprovalItem } from '@abox/core';

type Step = 'template' | 'options' | 'summary' | 'creating' | 'confirm' | 'error';
const STEPS: Step[] = ['template', 'options', 'summary'];

interface Form {
  template: string;
  name: string;
  /** Host profile id; empty = this computer. */
  host?: string;
  /** Folder whose `.sandbox/*.yaml` project templates are offered; empty = none. */
  projectDir?: string;
  workspaceMode: string;
  workspacePath: string;
  /** Exclude patterns of a copy workspace (space or comma separated). */
  exclude?: string;
  cpus: string;
  memory: string;
  ttl: string;
  networkMode: string;
  allow: string;
  presets: string[];
}

const EMPTY_FORM: Form = {
  template: '',
  name: '',
  host: '',
  projectDir: '',
  workspaceMode: '',
  workspacePath: '',
  exclude: '',
  cpus: '',
  memory: '',
  ttl: '',
  networkMode: '',
  allow: '',
  presets: [],
};

function splitList(s: string): string[] {
  return s
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

export function buildCreateInput(f: Form): IpcInput<'sandboxes:create'> {
  const workspace: NonNullable<IpcInput<'sandboxes:create'>['workspace']> = {};
  if (f.workspaceMode) workspace.mode = f.workspaceMode as (typeof WORKSPACE_MODES)[number];
  if (f.workspacePath.trim() && f.workspaceMode !== 'empty')
    workspace.path = f.workspacePath.trim();
  const exclude = splitList(f.exclude ?? '');
  if (exclude.length > 0 && !['empty', 'mount', 'clone', 'worktree'].includes(f.workspaceMode))
    workspace.exclude = exclude;
  const net: NonNullable<NonNullable<IpcInput<'sandboxes:create'>['overrides']>['network']> = {};
  if (f.networkMode) net.mode = f.networkMode as (typeof NETWORK_MODES)[number];
  const allow = splitList(f.allow);
  if (allow.length > 0) net.allow = allow;
  if (f.presets.length > 0) net.presets = f.presets;
  const overrides: NonNullable<IpcInput<'sandboxes:create'>['overrides']> = {};
  if (f.cpus.trim()) overrides.cpus = Number(f.cpus);
  if (f.memory.trim()) overrides.memory = f.memory.trim();
  if (f.ttl.trim()) overrides.ttl = f.ttl.trim();
  if (Object.keys(net).length > 0) overrides.network = net;
  return {
    template: f.template,
    ...(f.name.trim() ? { name: f.name.trim() } : {}),
    ...(f.host && f.host !== 'local' ? { host: f.host } : {}),
    ...(f.projectDir ? { projectDir: f.projectDir } : {}),
    ...(Object.keys(workspace).length > 0 ? { workspace } : {}),
    ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
  };
}

export function NewSandboxDialog(props: {
  onClose(): void;
  onCreated(id: string): void;
  /** Host profile id to preselect (the Hosts view's "new sandbox here"); default: this computer. */
  host?: string;
}) {
  const { t, notify } = useApp();
  const [step, setStep] = useState<Step>('template');
  const [form, setForm] = useState<Form>({
    ...EMPTY_FORM,
    host: props.host && props.host !== 'local' ? props.host : '',
  });
  const projectDir = form.projectDir ?? '';
  const templates = useQuery('templates:list', projectDir ? { projectDir } : undefined, {
    live: false,
  });
  const policy = useQuery('policy:get', undefined, { live: false });
  const hosts = useQuery('hosts:list', undefined, { live: false });
  const [progress, setProgress] = useState<string[]>([]);
  /** Bar of the workspace scan / copy: determinate once the total is known. */
  const [bar, setBar] = useState<{ done?: number; total?: number } | null>(null);
  const lastPhase = useRef<string | undefined>(undefined);
  const cancelled = useRef(false);
  const [cancelling, setCancelling] = useState(false);
  const [confirmation, setConfirmation] = useState<{
    reasons: string[];
    risks: string[];
    items: ApprovalItem[];
  } | null>(null);
  const [error, setError] = useState<unknown>();
  const key = useRef(`create-${Math.random().toString(36).slice(2)}`);
  const logRef = useRef<HTMLPreElement>(null);

  const profile = policy.data?.view.profile;
  const chosen: TemplateListEntry | undefined = templates.data?.templates.find(
    (x) => x.name === form.template,
  );
  const details = useQuery(
    'templates:show',
    { name: form.template, ...(projectDir ? { projectDir } : {}) },
    { enabled: form.template !== '' && step !== 'template', live: false },
  );

  // A project template is foreign input: the confirmation shows what it does before the human trusts it.
  const needsReview = step === 'confirm' && Boolean(confirmation?.items.some(isTemplateTrust));
  const workspacePath =
    form.workspacePath.trim() && form.workspaceMode !== 'empty' ? form.workspacePath.trim() : '';
  const review = useQuery(
    'templates:review',
    {
      name: form.template,
      ...(workspacePath ? { workspacePath } : {}),
      ...(projectDir ? { projectDir } : {}),
    },
    { enabled: needsReview, live: false },
  );
  const effectiveMode =
    form.workspaceMode ||
    (details.data?.template.workspace as { mode?: string } | undefined)?.mode ||
    '';
  const estimate = useWorkspaceEstimate({
    path: workspacePath,
    mode: step === 'options' || step === 'summary' ? effectiveMode : '',
    exclude: splitList(form.exclude ?? ''),
  });
  const baseImage =
    step === 'confirm' &&
    confirmation?.items.some((it) => it.kind === 'image_registry') &&
    details.data
      ? describeBase(
          details.data.template.base,
          details.data.template.backend,
          profile ? profile.images.registries : null,
        )
      : undefined;

  useEffect(() => {
    return window.abox.on('evt:progress', (ev) => {
      if (ev.key !== key.current) return;
      // scan / copy lines repeat every second: the newest replaces the previous one of the same step
      const replace = ev.phase !== undefined && ev.phase === lastPhase.current;
      lastPhase.current = ev.phase;
      setProgress((p) => (replace ? [...p.slice(-400, -1), ev.line] : [...p.slice(-400), ev.line]));
      if (ev.phase === 'scan' || ev.phase === 'deliver') setBar({});
      else if (ev.phase)
        setBar({
          ...(ev.done !== undefined ? { done: ev.done } : {}),
          ...(ev.total !== undefined ? { total: ev.total } : {}),
        });
    });
  }, []);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [progress]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  async function pickDir() {
    try {
      const dir = await call('dialog:pickDirectory');
      if (dir) set('workspacePath', dir);
    } catch (e) {
      notify('error', (e as Error).message);
    }
  }

  async function create(confirmed: boolean) {
    setStep('creating');
    setProgress([]);
    setBar(null);
    lastPhase.current = undefined;
    cancelled.current = false;
    setCancelling(false);
    setError(undefined);
    try {
      const res = await call('sandboxes:create', {
        ...buildCreateInput(form),
        confirmed,
        progressKey: key.current,
      });
      if (res.status === 'created') {
        notify('ok', t('new.created', { name: safeInline(res.sandbox.name, 60) }));
        props.onCreated(res.sandbox.id);
      } else if (res.status === 'confirmation_required') {
        setConfirmation({ reasons: res.reasons, risks: res.risks, items: res.items });
        setStep('confirm');
      } else {
        // pending_approval cannot happen for the human context; show it like a message anyway
        setError(new Error(res.message));
        setStep('error');
      }
    } catch (e) {
      if (cancelled.current) {
        // the human cancelled: back to the summary, nothing was created
        notify('info', t('new.cancelled'));
        setStep('summary');
        return;
      }
      setError(e);
      setStep('error');
    }
  }

  /** Stops the create: the main process aborts the scan / copy / image build; the manager removes what exists. */
  function cancelCreate() {
    cancelled.current = true;
    setCancelling(true);
    void call('jobs:cancel', { key: key.current }).catch(() => undefined);
  }

  const stepIndex = STEPS.indexOf(step as Step);
  const canNext =
    step === 'template'
      ? Boolean(chosen && chosen.allowed && chosen.backendAvailable)
      : step === 'options'
        ? validOptions(form) && !estimateBlocksCreate(estimate)
        : true;

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
      {step === 'options' || step === 'summary' ? (
        <button type="button" onClick={() => setStep(STEPS[stepIndex - 1] ?? 'template')}>
          {t('common.back')}
        </button>
      ) : null}
      {step === 'template' || step === 'options' ? (
        <button
          type="button"
          className="primary"
          disabled={!canNext}
          onClick={() => setStep(STEPS[stepIndex + 1] ?? 'summary')}
        >
          {t('common.next')}
        </button>
      ) : null}
      {step === 'summary' ? (
        <button
          type="button"
          className="primary"
          disabled={estimateBlocksCreate(estimate)}
          onClick={() => void create(false)}
        >
          {t('new.create')}
        </button>
      ) : null}
      {step === 'confirm' ? (
        <>
          <button type="button" onClick={() => setStep('summary')}>
            {t('common.back')}
          </button>
          <button type="button" className="primary" onClick={() => void create(true)}>
            {t('new.confirmCreate')}
          </button>
        </>
      ) : null}
      {step === 'error' ? (
        <button type="button" onClick={() => setStep('summary')}>
          {t('common.back')}
        </button>
      ) : null}
    </>
  );

  return (
    <Dialog
      title={t('new.title')}
      onClose={step === 'creating' ? () => undefined : props.onClose}
      footer={footer}
      wide
    >
      {STEPS.includes(step) ? (
        <ol className="steps" aria-label={t('new.steps')}>
          {STEPS.map((s, i) => (
            <li
              key={s}
              aria-current={s === step ? 'step' : undefined}
              className={i < stepIndex ? 'done' : ''}
            >
              {i + 1}. {t(`new.step.${s}`)}
            </li>
          ))}
        </ol>
      ) : null}

      {step === 'template' ? (
        <>
          <ProjectFolderPicker
            value={projectDir}
            onChange={(dir) => setForm((f) => ({ ...f, projectDir: dir, template: '' }))}
          />
          {templates.loading && !templates.data ? <Loading /> : null}
          {templates.error ? <ErrorBox error={templates.error} /> : null}
          {projectDir &&
          templates.data &&
          !templates.data.templates.some((x) => x.source.kind === 'project') ? (
            <p className="muted">{t('project.noTemplates')}</p>
          ) : null}
          {templates.data && templates.data.templates.length === 0 ? (
            <p>{t('new.noTemplates')}</p>
          ) : null}
          <div role="radiogroup" aria-label={t('new.step.template')} className="template-list">
            {templates.data?.templates.map((tpl) => {
              const disabled = !tpl.allowed || !tpl.backendAvailable;
              return (
                <label
                  key={`${tpl.source.kind}:${tpl.name}:${tpl.contentHash}`}
                  className={`template-card${form.template === tpl.name ? ' selected' : ''}${disabled ? ' disabled' : ''}`}
                >
                  <input
                    type="radio"
                    name="template"
                    value={tpl.name}
                    disabled={disabled}
                    checked={form.template === tpl.name}
                    onChange={() => set('template', tpl.name)}
                  />
                  <span className="template-main">
                    <strong>
                      <Safe text={tpl.name} max={80} />
                    </strong>
                    <Safe text={tpl.description} max={240} className="muted" />
                    <span className="badges">
                      <Badge tone="neutral">{tpl.backend}</Badge>
                      <IsolationBadge level={tpl.isolation} />
                      <Badge tone={tpl.networkMode === 'open' ? 'danger' : 'neutral'}>
                        {t('network.label')}: {t(`network.${tpl.networkMode}`)}
                      </Badge>
                      <Badge tone="neutral">{t(`source.${tpl.source.kind}`)}</Badge>
                      {tpl.source.kind === 'project' && tpl.trusted ? (
                        <Badge tone="ok">{t('tpl.trusted')}</Badge>
                      ) : null}
                      {!tpl.trusted ? <Badge tone="warn">{t('new.untrusted')}</Badge> : null}
                      {!tpl.allowed ? <Badge tone="danger">{t('new.notAllowed')}</Badge> : null}
                      {!tpl.backendAvailable ? (
                        <Badge tone="danger">{t('new.backendMissing')}</Badge>
                      ) : null}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </>
      ) : null}

      {step === 'options' ? (
        <div className="form-grid">
          {profile ? (
            <p className="muted wide-col">
              {t('new.policyHint', {
                profile: profile.name,
                cpus: profile.limits.cpus,
                memory: profile.limits.memory,
                ttl: profile.limits.ttl,
              })}
            </p>
          ) : null}
          <Field label={t('new.name')} hint={t('new.nameHint')}>
            {(id) => (
              <input
                id={id}
                type="text"
                value={form.name}
                onChange={(e) => set('name', e.target.value)}
                pattern="[A-Za-z0-9][A-Za-z0-9._-]*"
              />
            )}
          </Field>
          <Field label={t('new.host')} hint={t('new.hostHint')}>
            {(id) => (
              <select id={id} value={form.host ?? ''} onChange={(e) => set('host', e.target.value)}>
                <option value="">{t('hosts.thisComputer')}</option>
                {(hosts.data ?? [])
                  .filter(
                    (r) =>
                      r.profile.kind === 'ssh' &&
                      (r.profile.backends.length > 0 || r.profile.id === form.host),
                  )
                  .map((r) => (
                    <option key={r.profile.id} value={r.profile.id}>
                      {r.profile.id} ({t(`hosts.zone.${r.profile.zone}`)})
                    </option>
                  ))}
                {form.host && !(hosts.data ?? []).some((r) => r.profile.id === form.host) ? (
                  <option value={form.host}>{form.host}</option>
                ) : null}
              </select>
            )}
          </Field>
          <Field label={t('new.workspaceMode')}>
            {(id) => (
              <select
                id={id}
                value={form.workspaceMode}
                onChange={(e) => set('workspaceMode', e.target.value)}
              >
                <option value="">{t('new.templateDefault')}</option>
                {(profile?.workspace.modes ?? WORKSPACE_MODES).map((m) => (
                  <option key={m} value={m}>
                    {t(`workspace.${m}`)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {form.workspaceMode !== 'empty' ? (
            <Field label={t('new.workspacePath')} hint={t('new.workspacePathHint')}>
              {(id) => (
                <div className="with-button">
                  <input
                    id={id}
                    type="text"
                    value={form.workspacePath}
                    onChange={(e) => set('workspacePath', e.target.value)}
                  />
                  <button type="button" onClick={() => void pickDir()}>
                    {t('common.browse')}
                  </button>
                </div>
              )}
            </Field>
          ) : null}
          {form.workspaceMode !== 'empty' ? (
            <div className="wide-col">
              <WorkspaceEstimateNote
                state={estimate}
                modes={profile?.workspace.modes ?? WORKSPACE_MODES}
                onUseMode={(m) => set('workspaceMode', m)}
              />
            </div>
          ) : null}
          {form.workspaceMode !== 'empty' &&
          !['mount', 'clone', 'worktree'].includes(effectiveMode) ? (
            <Field label={t('new.exclude')} hint={t('new.excludeHint')}>
              {(id) => (
                <input
                  id={id}
                  type="text"
                  value={form.exclude ?? ''}
                  placeholder="node_modules"
                  onChange={(e) => set('exclude', e.target.value)}
                />
              )}
            </Field>
          ) : null}
          <Field label={t('new.cpus')} hint={t('new.templateDefaultHint')}>
            {(id) => (
              <input
                id={id}
                type="number"
                min="0.5"
                step="0.5"
                value={form.cpus}
                onChange={(e) => set('cpus', e.target.value)}
              />
            )}
          </Field>
          <Field label={t('new.memory')} hint="512m, 4g">
            {(id) => (
              <input
                id={id}
                type="text"
                value={form.memory}
                onChange={(e) => set('memory', e.target.value)}
              />
            )}
          </Field>
          <Field label={t('new.ttl')} hint="30m, 2h, 1d">
            {(id) => (
              <input
                id={id}
                type="text"
                value={form.ttl}
                onChange={(e) => set('ttl', e.target.value)}
              />
            )}
          </Field>
          <Field label={t('new.networkMode')}>
            {(id) => (
              <select
                id={id}
                value={form.networkMode}
                onChange={(e) => set('networkMode', e.target.value)}
              >
                <option value="">{t('new.templateDefault')}</option>
                {(profile?.network.modes ?? NETWORK_MODES).map((m) => (
                  <option key={m} value={m}>
                    {t(`network.${m}`)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {form.networkMode === 'allowlist' ||
          (form.networkMode === '' && chosen?.networkMode === 'allowlist') ? (
            <>
              <Field label={t('new.allow')} hint={t('new.allowHint')}>
                {(id) => (
                  <input
                    id={id}
                    type="text"
                    value={form.allow}
                    onChange={(e) => set('allow', e.target.value)}
                  />
                )}
              </Field>
              <fieldset className="wide-col">
                <legend>{t('new.presets')}</legend>
                {(profile?.network.allow_presets ?? []).map((p) => (
                  <label key={p} className="inline">
                    <input
                      type="checkbox"
                      checked={form.presets.includes(p)}
                      onChange={(e) =>
                        set(
                          'presets',
                          e.target.checked
                            ? [...form.presets, p]
                            : form.presets.filter((x) => x !== p),
                        )
                      }
                    />{' '}
                    {p}
                  </label>
                ))}
              </fieldset>
            </>
          ) : null}
          {form.networkMode === 'open' ? (
            <Banner tone="danger">{t('new.openNetworkWarning')}</Banner>
          ) : null}
        </div>
      ) : null}

      {step === 'summary' ? (
        <>
          <h3>{t('new.summary')}</h3>
          <dl className="summary">
            <dt>{t('new.step.template')}</dt>
            <dd>
              <span className="plain">{form.template}</span>{' '}
              {chosen ? <IsolationBadge level={chosen.isolation} /> : null}
              {chosen ? <Badge tone="neutral">{chosen.backend}</Badge> : null}
            </dd>
            <dt>{t('new.name')}</dt>
            <dd className="plain">{form.name || t('new.auto')}</dd>
            <dt>{t('new.host')}</dt>
            <dd className="plain">{form.host || t('hosts.thisComputer')}</dd>
            <dt>{t('new.workspaceMode')}</dt>
            <dd className="plain">
              {form.workspaceMode ? t(`workspace.${form.workspaceMode}`) : t('new.templateDefault')}{' '}
              {form.workspacePath}
              {splitList(form.exclude ?? '').length > 0 && effectiveMode !== 'mount'
                ? ` (− ${splitList(form.exclude ?? '').join(', ')})`
                : ''}
            </dd>
            <dt>
              {t('new.cpus')} / {t('new.memory')} / {t('new.ttl')}
            </dt>
            <dd className="plain">
              {form.cpus || t('new.templateDefault')} / {form.memory || t('new.templateDefault')} /{' '}
              {form.ttl || t('new.templateDefault')}
            </dd>
            <dt>{t('new.networkMode')}</dt>
            <dd className="plain">
              {form.networkMode ? t(`network.${form.networkMode}`) : t('new.templateDefault')}
              {splitList(form.allow).length > 0 ? ` (+ ${splitList(form.allow).join(', ')})` : ''}
              {form.presets.length > 0 ? ` [${form.presets.join(', ')}]` : ''}
            </dd>
          </dl>
          {details.data?.warnings.length ? (
            <Banner tone="warn">
              <ul>
                {details.data.warnings.map((w, i) => (
                  <li key={i} className="plain">
                    {w}
                  </li>
                ))}
              </ul>
            </Banner>
          ) : null}
          {details.data?.effectiveLimits.exceedsProfile.length ? (
            <Banner tone="warn">
              {t('new.exceedsProfile')}: {details.data.effectiveLimits.exceedsProfile.join(', ')}
            </Banner>
          ) : null}
          {chosen?.isolation === 'none' ? (
            <Banner tone="danger">{t('new.isolationNoneWarning')}</Banner>
          ) : null}
          <WorkspaceEstimateNote
            state={estimate}
            modes={profile?.workspace.modes ?? WORKSPACE_MODES}
            onUseMode={(m) => {
              set('workspaceMode', m);
              setStep('options');
            }}
          />
          <p className="muted">{t('new.summaryHint')}</p>
        </>
      ) : null}

      {step === 'creating' ? (
        <>
          <p role="status">{cancelling ? t('new.cancelling') : t('new.creating')}</p>
          {bar ? (
            <progress
              aria-label={t('new.progressBar')}
              className="progress-bar"
              {...(bar.total !== undefined && bar.done !== undefined
                ? { max: bar.total, value: Math.min(bar.done, bar.total) }
                : {})}
            />
          ) : null}
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
          {baseImage ? (
            <>
              <h3>{t('approvals.image.title')}</h3>
              <ImageUseBlock use={baseImage} />
            </>
          ) : null}
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

const isTemplateTrust = (it: ApprovalItem): boolean => it.kind === 'template_trust';

function validOptions(f: Form): boolean {
  if (f.name.trim() && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(f.name.trim())) return false;
  if (f.cpus.trim() && !(Number(f.cpus) > 0)) return false;
  if (f.memory.trim() && !/^\d{1,6}(\.\d+)?[kmgt]?b?$/i.test(f.memory.trim())) return false;
  if (f.ttl.trim() && !/^\d{1,6}(ms|s|m|h|d)$/.test(f.ttl.trim())) return false;
  return true;
}
