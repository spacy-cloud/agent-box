import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { call } from '../api';
import { useApp } from '../context';
import { useQuery } from '../hooks';
import {
  Badge,
  Banner,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorBox,
  IsolationBadge,
  Loading,
} from '../components/ui';
import { YamlEditor } from '../components/CodeEditor';
import { TemplateReviewPanel } from '../components/review';
import { ProjectFolderPicker } from '../components/ProjectFolder';
import { ReadinessDialog } from '../components/ReadinessCheck';
import { ListInput, SyncedInput, SyncedTextarea } from '../components/inputs';
import { osFamilyOf, FAMILY_PACKAGE_MANAGER } from '../../shared/base-images';
import {
  PACKAGE_MANAGERS,
  applyForm,
  blankTemplate,
  copyName,
  duplicateTemplate,
  groupIssues,
  parseForm,
  splitList,
  toolWarnings,
} from '../../shared/template-form';
import type {
  EnvRow,
  FieldIssue,
  FormPatch,
  PackageManager,
  TemplateForm,
} from '../../shared/template-form';
import { TEMPLATE_BACKENDS, ISOLATION_LEVELS, NETWORK_MODES } from '../../shared/constants';
import { formatDuration, safeInline, safeText } from '../../shared/format';
import type { TemplateListEntry } from '@abox/core';
import type {
  TemplateCatalogInfo,
  TemplateTestOutcome,
  TemplateValidation,
} from '../../shared/types';

interface Origin {
  name: string;
  kind: 'builtin' | 'user' | 'project';
  readOnly: boolean;
}

type Pending = (() => void) | null;

const DOCKERFILE_BACKENDS = ['docker', 'podman'];

export function TemplatesView() {
  const { t, notify, tick } = useApp();
  const [projectDir, setProjectDir] = useState('');
  const list = useQuery('templates:list', projectDir ? { projectDir } : undefined, {
    pollMs: 8000,
  });
  const catalog = useQuery('templates:catalog', undefined, { live: false });
  const [search, setSearch] = useState('');
  const [yaml, setYaml] = useState('');
  const [saved, setSaved] = useState('');
  const [origin, setOrigin] = useState<Origin | null>(null);
  const [opened, setOpened] = useState(false);
  const [validation, setValidation] = useState<TemplateValidation | null>(null);
  const [validating, setValidating] = useState(false);
  const [loadError, setLoadError] = useState<unknown>();
  const [saveError, setSaveError] = useState<unknown>();
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const [discard, setDiscard] = useState<Pending>(null);
  const [building, setBuilding] = useState(false);
  const [testing, setTesting] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [checking, setChecking] = useState(false);

  const entries = list.data?.templates ?? [];
  const dirty = opened && yaml !== saved;
  const form = useMemo(() => parseForm(yaml), [yaml]);
  const readOnly = origin?.readOnly ?? false;

  // live validation by the manager (debounced); the GUI has no template rules of its own
  useEffect(() => {
    if (!opened) return;
    let cancelled = false;
    setValidating(true);
    const id = setTimeout(() => {
      void call('templates:validate', { yaml }).then(
        (v) => {
          if (!cancelled) {
            setValidation(v);
            setValidating(false);
          }
        },
        (e: unknown) => {
          if (!cancelled) {
            setValidation({
              ok: false,
              issues: [{ message: (e as Error).message, kind: 'schema' }],
              warnings: [],
            });
            setValidating(false);
          }
        },
      );
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [yaml, opened]);

  const filtered = useMemo(() => {
    const f = search.trim().toLowerCase();
    if (!f) return entries;
    return entries.filter((e) =>
      [e.name, e.description, e.useFor, e.backend, e.source.kind]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(f),
    );
  }, [entries, search]);

  function guard(action: () => void) {
    if (dirty) setDiscard(() => action);
    else action();
  }

  function startDraft(text: string, from: Origin | null) {
    setYaml(text);
    setSaved(from ? text : '');
    setOrigin(from);
    setOpened(true);
    setValidation(null);
    setSaveError(undefined);
    setLoadError(undefined);
  }

  async function open(name: string) {
    try {
      const doc = await call('templates:source', { name, ...(projectDir ? { projectDir } : {}) });
      startDraft(doc.yaml, { name: doc.name, kind: doc.source.kind, readOnly: doc.readOnly });
    } catch (e) {
      setLoadError(e);
    }
  }

  /** Another project folder: a project template of the old one is closed, its review would name the wrong folder. */
  function changeProject(dir: string) {
    guard(() => {
      setProjectDir(dir);
      if (origin?.kind === 'project') {
        setOpened(false);
        setOrigin(null);
        setYaml('');
        setSaved('');
      }
    });
  }

  function newTemplate() {
    const taken = new Set(entries.map((e) => e.name));
    let n = 1;
    while (taken.has(n === 1 ? 'my-template' : `my-template-${n}`)) n++;
    const text = blankTemplate(n === 1 ? 'my-template' : `my-template-${n}`);
    startDraft(text, null);
  }

  function duplicate() {
    const taken = new Set(entries.map((e) => e.name));
    const name = copyName(form.name, taken);
    const text = duplicateTemplate(yaml, name);
    startDraft(text, null);
    notify('info', t('tpl.duplicated', { name }));
  }

  async function save(overwrite: boolean) {
    setSaveError(undefined);
    setConfirmOverwrite(false);
    try {
      const r = await call('templates:save', { yaml, ...(overwrite ? { overwrite: true } : {}) });
      setSaved(yaml);
      setOrigin({ name: r.name, kind: 'user', readOnly: false });
      notify('ok', t('tpl.savedAs', { name: r.name }));
      if (r.shadows.length > 0) notify('info', t('tpl.shadows', { name: r.name }));
      await list.reload();
    } catch (e) {
      if ((e as { code?: string }).code === 'conflict' && origin?.name !== form.name) {
        setConfirmOverwrite(true);
      } else if ((e as { code?: string }).code === 'conflict') {
        void save(true);
      } else {
        setSaveError(e);
      }
    }
  }

  async function exportYaml(format: 'yaml' | 'dockerfile' = 'yaml') {
    try {
      const r = await call('templates:export', {
        name: format === 'yaml' ? form.name || 'template' : (origin?.name ?? form.name),
        yaml,
        format,
      });
      if (r.saved) notify('ok', t('tpl.exported', { path: r.saved }));
    } catch (e) {
      notify('error', (e as Error).message);
    }
  }

  const isProject = origin?.kind === 'project';
  const runnable =
    origin !== null && !isProject && !dirty && entries.some((e) => e.name === origin.name);
  const runTitle = isProject
    ? t('tpl.projectNotBuilt')
    : !runnable
      ? t('tpl.needsSave')
      : undefined;
  // after a build or a save, refresh the list's derived data
  useEffect(() => {
    void list.reload();
  }, [tick]);

  return (
    <section aria-labelledby="h-templates">
      <header className="page-head">
        <div>
          <h1 id="h-templates">{t('tpl.title')}</h1>
          <p className="muted">{t('tpl.intro')}</p>
        </div>
        <div className="actions">
          <button type="button" className="primary" onClick={() => guard(newTemplate)}>
            {t('tpl.new')}
          </button>
        </div>
      </header>

      <div className="tpl-layout">
        <aside className="tpl-list" aria-label={t('tpl.list')}>
          <ProjectFolderPicker value={projectDir} onChange={changeProject} />
          <form role="search" onSubmit={(e) => e.preventDefault()}>
            <label className="field">
              <span className="sr-only">{t('tpl.search')}</span>
              <input
                type="search"
                placeholder={t('tpl.search')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                autoComplete="off"
              />
            </label>
          </form>
          {list.error ? <ErrorBox error={list.error} /> : null}
          {list.loading && !list.data ? <Loading /> : null}
          <ul className="tpl-items">
            {filtered.map((e) => (
              <li key={e.name}>
                <TemplateItem
                  entry={e}
                  selected={origin?.name === e.name}
                  onOpen={() => guard(() => void open(e.name))}
                />
              </li>
            ))}
          </ul>
          {list.data && filtered.length === 0 ? <p className="muted">{t('tpl.noMatch')}</p> : null}
          {(list.data?.problems ?? []).length > 0 ? (
            <details className="tpl-problems">
              <summary>{t('tpl.problems', { count: list.data!.problems.length })}</summary>
              <ul>
                {list.data!.problems.map((p) => (
                  <li key={p.path} className="plain small">
                    <code>{p.path}</code>: {p.message}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </aside>

        <div className="tpl-editor">
          {loadError ? <ErrorBox error={loadError} /> : null}
          {!opened ? (
            <EmptyState title={t('tpl.empty.title')} text={t('tpl.empty.text')}>
              <button type="button" className="primary" onClick={newTemplate}>
                {t('tpl.new')}
              </button>
            </EmptyState>
          ) : (
            <>
              <div className="tpl-toolbar">
                <div>
                  <h2 className="plain tpl-name">{form.name || t('tpl.unnamed')}</h2>
                  <div className="badges">
                    {origin ? (
                      <Badge tone={origin.kind === 'user' ? 'info' : 'neutral'}>
                        {t(`tpl.source.${origin.kind}`)}
                      </Badge>
                    ) : (
                      <Badge tone="warn">{t('tpl.draft')}</Badge>
                    )}
                    {dirty ? <Badge tone="warn">{t('tpl.unsaved')}</Badge> : null}
                    {readOnly ? <Badge tone="neutral">{t('tpl.readOnly')}</Badge> : null}
                  </div>
                </div>
                <div className="actions">
                  <button
                    type="button"
                    className="primary"
                    disabled={readOnly || !form.valid || form.name === '' || !dirty}
                    onClick={() => void save(false)}
                  >
                    {t('tpl.save')}
                  </button>
                  <button
                    type="button"
                    disabled={!runnable}
                    title={runTitle}
                    onClick={() => setBuilding(true)}
                  >
                    {t('tpl.build')}
                  </button>
                  <button
                    type="button"
                    disabled={!runnable}
                    title={runTitle}
                    onClick={() => setTesting(true)}
                  >
                    {t('tpl.test')}
                  </button>
                  <button
                    type="button"
                    disabled={origin === null || dirty}
                    title={origin === null || dirty ? t('tpl.needsSave') : t('tpl.check.hint')}
                    onClick={() => setChecking(true)}
                  >
                    {t('tpl.check')}
                  </button>
                  <button type="button" disabled={!form.valid} onClick={duplicate}>
                    {t('tpl.duplicate')}
                  </button>
                  {origin?.kind === 'project' ? (
                    <button type="button" onClick={() => setReviewing(true)}>
                      {t('tpl.review')}
                    </button>
                  ) : null}
                  <button type="button" onClick={() => void exportYaml()}>
                    {t('tpl.export')}
                  </button>
                  <button
                    type="button"
                    disabled={!runnable || !DOCKERFILE_BACKENDS.includes(form.backend)}
                    title={runTitle}
                    onClick={() => void exportYaml('dockerfile')}
                  >
                    {t('tpl.exportDockerfile')}
                  </button>
                </div>
              </div>
              {readOnly ? <Banner tone="info">{t('tpl.readOnlyHint')}</Banner> : null}
              {saveError ? <ErrorBox error={saveError} /> : null}
              <ValidationSummary validation={validation} validating={validating} />
              <div className="tpl-columns">
                <TemplateFormPane
                  form={form}
                  catalog={catalog.data}
                  readOnly={readOnly}
                  issues={validation?.issues ?? []}
                  onPatch={(p) => setYaml((y) => applyForm(y, p))}
                />
                <div className="tpl-yaml">
                  <h3 className="h-small">YAML</h3>
                  <YamlEditor
                    value={yaml}
                    onChange={setYaml}
                    readOnly={readOnly}
                    label={t('tpl.yamlLabel')}
                    issues={validation?.issues ?? []}
                  />
                  <IssueList issues={validation?.issues ?? []} />
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {discard ? (
        <ConfirmDialog
          title={t('tpl.discard.title')}
          confirmLabel={t('tpl.discard.confirm')}
          danger
          onClose={() => setDiscard(null)}
          onConfirm={() => {
            const a = discard;
            setDiscard(null);
            a?.();
          }}
        >
          <p>{t('tpl.discard.text')}</p>
        </ConfirmDialog>
      ) : null}
      {confirmOverwrite ? (
        <ConfirmDialog
          title={t('tpl.overwrite.title')}
          confirmLabel={t('tpl.overwrite.confirm')}
          onClose={() => setConfirmOverwrite(false)}
          onConfirm={() => void save(true)}
        >
          <p>{t('tpl.overwrite.text', { name: form.name })}</p>
        </ConfirmDialog>
      ) : null}
      {building && origin ? (
        <BuildDialog name={origin.name} onClose={() => setBuilding(false)} />
      ) : null}
      {testing && origin ? (
        <TestDialog name={origin.name} onClose={() => setTesting(false)} />
      ) : null}
      {checking && origin ? (
        <ReadinessDialog
          target={{
            kind: 'template',
            template: origin.name,
            ...(projectDir ? { projectDir } : {}),
          }}
          onClose={() => setChecking(false)}
        />
      ) : null}
      {reviewing && origin ? (
        <ReviewDialog
          name={origin.name}
          {...(projectDir ? { projectDir } : {})}
          onClose={() => setReviewing(false)}
        />
      ) : null}
    </section>
  );
}

function TemplateItem(props: { entry: TemplateListEntry; selected: boolean; onOpen(): void }) {
  const { t } = useApp();
  const e = props.entry;
  return (
    <button
      type="button"
      className="tpl-item"
      aria-current={props.selected ? 'true' : undefined}
      onClick={props.onOpen}
    >
      <span className="tpl-item-head">
        <strong className="plain">{safeInline(e.name, 80)}</strong>
        <Badge tone={e.source.kind === 'user' ? 'info' : 'neutral'}>
          {t(`tpl.source.${e.source.kind}`)}
        </Badge>
      </span>
      <span className="muted small plain tpl-item-desc">
        {safeInline(e.useFor ?? e.description, 240)}
      </span>
      <span className="badges">
        <Badge tone="neutral">{e.backend}</Badge>
        <IsolationBadge level={e.isolation} />
        <Badge tone={e.networkMode === 'open' ? 'danger' : 'neutral'}>
          {t(`network.${e.networkMode}`)}
        </Badge>
        {!e.backendAvailable ? <Badge tone="warn">{t('tpl.backendMissing')}</Badge> : null}
        {e.source.kind === 'project' ? (
          <Badge tone={e.trusted ? 'ok' : 'warn'}>
            {e.trusted ? t('tpl.trusted') : t('tpl.untrusted')}
          </Badge>
        ) : null}
      </span>
    </button>
  );
}

// -- validation output ---------------------------------------------------------------------------------------------------

function ValidationSummary(props: { validation: TemplateValidation | null; validating: boolean }) {
  const { t } = useApp();
  const v = props.validation;
  return (
    <div className="tpl-validation" aria-live="polite">
      {!v ? (
        <p className="muted" role="status">
          {t('tpl.validating')}
        </p>
      ) : (
        <>
          {v.ok ? (
            <Banner tone="ok">
              {t('tpl.valid')}
              {v.policy ? ` · ${t(`tpl.policy.${v.policy.decision}`)}` : ''}
            </Banner>
          ) : (
            <Banner tone="danger" role="alert">
              {t('tpl.invalid', { count: v.issues.length })}
            </Banner>
          )}
          {v.policy && v.policy.decision !== 'allow' ? (
            <Banner tone={v.policy.decision === 'deny' ? 'danger' : 'warn'}>
              <strong>{t(`tpl.policy.${v.policy.decision}`)}</strong>
              <ul>
                {v.policy.reasons.map((r, i) => (
                  <li key={i} className="plain">
                    {safeText(r)}
                  </li>
                ))}
              </ul>
            </Banner>
          ) : null}
          {v.warnings.length > 0 ? (
            <Banner tone="warn">
              <ul>
                {v.warnings.map((w, i) => (
                  <li key={i} className="plain">
                    {w}
                  </li>
                ))}
              </ul>
            </Banner>
          ) : null}
        </>
      )}
      {props.validating && v ? <span className="sr-only">{t('tpl.validating')}</span> : null}
    </div>
  );
}

function IssueList(props: { issues: readonly FieldIssue[] }) {
  const { t } = useApp();
  if (props.issues.length === 0) return null;
  return (
    <ul className="issue-list" aria-label={t('tpl.issues')}>
      {props.issues.map((i, n) => (
        <li key={n} className="plain">
          {i.line ? (
            <code>
              {t('tpl.line')} {i.line}
            </code>
          ) : null}{' '}
          {i.path ? <code>{i.path}</code> : null} {i.message}
        </li>
      ))}
    </ul>
  );
}

// -- the form ---------------------------------------------------------------------------------------------------------

function FormField(props: {
  id: string;
  label: string;
  hint?: string;
  errors?: FieldIssue[];
  wide?: boolean;
  children: (p: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
}) {
  const errs = props.errors ?? [];
  const errId = `${props.id}-err`;
  const hintId = `${props.id}-hint`;
  const describedBy =
    [errs.length > 0 ? errId : '', props.hint ? hintId : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className={props.wide ? 'field wide-col' : 'field'} data-field={props.id}>
      <label htmlFor={props.id}>{props.label}</label>
      {props.children({ id: props.id, describedBy, invalid: errs.length > 0 })}
      {props.hint ? (
        <small id={hintId} className="muted">
          {props.hint}
        </small>
      ) : null}
      {errs.length > 0 ? (
        <div id={errId} role="alert">
          <ul className="field-errors">
            {errs.map((e, i) => (
              <li key={i} className="plain">
                {e.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function TemplateFormPane(props: {
  form: TemplateForm;
  catalog: TemplateCatalogInfo | undefined;
  readOnly: boolean;
  issues: readonly FieldIssue[];
  onPatch(p: FormPatch): void;
}) {
  const { t } = useApp();
  const { form, catalog, readOnly } = props;
  const errors = useMemo(() => groupIssues(props.issues), [props.issues]);
  const family = osFamilyOf(form.baseOs);
  const inCatalog = catalog?.baseImages.some((b) => b.ref === form.baseOs) ?? false;
  const [custom, setCustom] = useState(false);
  const customMode = custom || (form.baseOs !== '' && !inCatalog);
  const warnings = useMemo(
    () => (catalog ? toolWarnings(form.tools, form.baseOs, catalog.tools) : []),
    [form.tools, form.baseOs, catalog],
  );
  const e = (k: string) => errors[k] ?? [];
  const patch = props.onPatch;

  if (!form.valid) {
    return (
      <div className="tpl-form">
        <h3 className="h-small">{t('tpl.form')}</h3>
        <Banner tone="danger" role="alert">
          <strong>{t('tpl.yamlBroken')}</strong>
          <div className="plain">{form.yamlError}</div>
        </Banner>
      </div>
    );
  }

  const shownManagers: PackageManager[] = PACKAGE_MANAGERS.filter((m) => {
    const own = FAMILY_PACKAGE_MANAGER[family];
    return m === 'pip' || m === 'npm' || m === own || form.packages[m].length > 0;
  });

  return (
    <fieldset className="tpl-form" disabled={readOnly}>
      <legend className="h-small">{t('tpl.form')}</legend>

      <div className="form-grid">
        <FormField
          id="f-name"
          label={t('tpl.f.name')}
          hint={t('tpl.f.nameHint')}
          errors={e('name')}
        >
          {(p) => (
            <SyncedInput
              id={p.id}
              type="text"
              value={form.name}
              onValue={(v) => patch({ name: v })}
              aria-invalid={p.invalid}
              aria-describedby={p.describedBy}
              autoComplete="off"
              spellCheck={false}
            />
          )}
        </FormField>
        <FormField id="f-backend" label={t('tpl.f.backend')} errors={e('backend')}>
          {(p) => (
            <select
              id={p.id}
              value={form.backend}
              onChange={(x) => patch({ backend: x.target.value })}
              aria-invalid={p.invalid}
              aria-describedby={p.describedBy}
            >
              {!(TEMPLATE_BACKENDS as readonly string[]).includes(form.backend) ? (
                <option value={form.backend}>{form.backend || '—'}</option>
              ) : null}
              {TEMPLATE_BACKENDS.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          )}
        </FormField>
        <FormField
          id="f-description"
          label={t('tpl.f.description')}
          hint={t('tpl.f.descriptionHint')}
          errors={e('description')}
          wide
        >
          {(p) => (
            <SyncedTextarea
              id={p.id}
              rows={3}
              value={form.description}
              onValue={(v) => patch({ description: v })}
              aria-invalid={p.invalid}
              aria-describedby={p.describedBy}
            />
          )}
        </FormField>
        <FormField
          id="f-isolation"
          label={t('tpl.f.isolation')}
          hint={t('tpl.f.isolationHint')}
          errors={e('isolation')}
        >
          {(p) => (
            <select
              id={p.id}
              value={form.isolation}
              onChange={(x) => patch({ isolation: x.target.value })}
              aria-invalid={p.invalid}
              aria-describedby={p.describedBy}
            >
              <option value="">{t('tpl.f.isolationDefault')}</option>
              {ISOLATION_LEVELS.map((l) => (
                <option key={l} value={l}>
                  {t(`isolation.${l}`)}
                </option>
              ))}
            </select>
          )}
        </FormField>
      </div>

      <h3 className="h-small">{t('tpl.f.base')}</h3>
      <div className="form-grid">
        <FormField
          id="f-baseos"
          label={t('tpl.f.baseOs')}
          hint={
            family === 'unknown'
              ? t('tpl.f.baseUnknown')
              : t('tpl.f.baseFamily', { family: t(`tpl.family.${family}`) })
          }
          errors={e('baseOs')}
        >
          {(p) => (
            <select
              id={p.id}
              value={customMode ? '__custom__' : form.baseOs}
              onChange={(x) => {
                if (x.target.value === '__custom__') {
                  setCustom(true);
                } else {
                  setCustom(false);
                  patch({ baseOs: x.target.value });
                }
              }}
              aria-invalid={p.invalid}
              aria-describedby={p.describedBy}
            >
              <option value="">{t('tpl.f.baseNone')}</option>
              {(catalog?.baseImages ?? []).map((b) => (
                <option key={b.ref} value={b.ref}>
                  {b.ref}
                  {b.note ? ` (${b.note})` : ''} - {b.backends.join('/')}
                </option>
              ))}
              <option value="__custom__">{t('tpl.f.baseCustom')}</option>
            </select>
          )}
        </FormField>
        {customMode ? (
          <FormField
            id="f-basecustom"
            label={t('tpl.f.baseCustomName')}
            hint={t('tpl.f.baseCustomHint')}
          >
            {(p) => (
              <SyncedInput
                id={p.id}
                type="text"
                value={form.baseOs}
                onValue={(v) => patch({ baseOs: v })}
                autoComplete="off"
                spellCheck={false}
              />
            )}
          </FormField>
        ) : null}
        {form.baseDockerfile !== '' ? (
          <FormField
            id="f-dockerfile"
            label={t('tpl.f.dockerfile')}
            hint={t('tpl.f.dockerfileHint')}
            errors={e('baseDockerfile')}
          >
            {(p) => (
              <SyncedInput
                id={p.id}
                type="text"
                value={form.baseDockerfile}
                onValue={(v) => patch({ baseDockerfile: v })}
                aria-invalid={p.invalid}
                aria-describedby={p.describedBy}
                spellCheck={false}
              />
            )}
          </FormField>
        ) : null}
      </div>

      <h3 className="h-small">{t('tpl.f.packages')}</h3>
      <div className="form-grid">
        {shownManagers.map((m) => (
          <FormField
            key={m}
            id={`f-pkg-${m}`}
            label={`${m}`}
            hint={t('tpl.f.packagesHint')}
            errors={e(`packages.${m}`)}
          >
            {(p) => (
              <ListInput
                id={p.id}
                type="text"
                items={form.packages[m]}
                split={splitList}
                onItems={(list) => patch({ packages: { ...form.packages, [m]: list } })}
                aria-invalid={p.invalid}
                aria-describedby={p.describedBy}
                autoComplete="off"
                spellCheck={false}
              />
            )}
          </FormField>
        ))}
      </div>

      <ToolsSection
        form={form}
        catalog={catalog}
        warnings={warnings}
        errors={e('tools')}
        patch={patch}
      />

      <h3 className="h-small">{t('tpl.f.resources')}</h3>
      <div className="form-grid">
        <FormField id="f-cpus" label={t('tpl.f.cpus')} errors={e('cpus')}>
          {(p) => (
            <SyncedInput
              id={p.id}
              type="text"
              inputMode="decimal"
              value={form.cpus}
              numeric
              onValue={(v) => patch({ cpus: v })}
              aria-invalid={p.invalid}
              aria-describedby={p.describedBy}
              autoComplete="off"
            />
          )}
        </FormField>
        <FormField
          id="f-memory"
          label={t('tpl.f.memory')}
          hint={t('tpl.f.memoryHint')}
          errors={e('memory')}
        >
          {(p) => (
            <SyncedInput
              id={p.id}
              type="text"
              value={form.memory}
              onValue={(v) => patch({ memory: v })}
              aria-invalid={p.invalid}
              aria-describedby={p.describedBy}
              autoComplete="off"
            />
          )}
        </FormField>
        <FormField id="f-disk" label={t('tpl.f.disk')} errors={e('disk')}>
          {(p) => (
            <SyncedInput
              id={p.id}
              type="text"
              value={form.disk}
              onValue={(v) => patch({ disk: v })}
              aria-invalid={p.invalid}
              aria-describedby={p.describedBy}
              autoComplete="off"
            />
          )}
        </FormField>
        <FormField id="f-pids" label={t('tpl.f.pids')} errors={e('pids')}>
          {(p) => (
            <SyncedInput
              id={p.id}
              type="text"
              inputMode="numeric"
              value={form.pids}
              numeric
              onValue={(v) => patch({ pids: v })}
              aria-invalid={p.invalid}
              aria-describedby={p.describedBy}
              autoComplete="off"
            />
          )}
        </FormField>
        <FormField id="f-ttl" label={t('tpl.f.ttl')} hint={t('tpl.f.ttlHint')} errors={e('ttl')}>
          {(p) => (
            <SyncedInput
              id={p.id}
              type="text"
              value={form.ttl}
              onValue={(v) => patch({ ttl: v })}
              aria-invalid={p.invalid}
              aria-describedby={p.describedBy}
              autoComplete="off"
            />
          )}
        </FormField>
      </div>

      <h3 className="h-small">{t('tpl.f.network')}</h3>
      <div className="form-grid">
        <FormField id="f-netmode" label={t('tpl.f.netMode')} errors={e('networkMode')}>
          {(p) => (
            <select
              id={p.id}
              value={form.networkMode}
              onChange={(x) => patch({ networkMode: x.target.value })}
              aria-invalid={p.invalid}
              aria-describedby={p.describedBy}
            >
              <option value="">{t('tpl.f.netDefault')}</option>
              {NETWORK_MODES.map((m) => (
                <option key={m} value={m}>
                  {t(`network.${m}`)}
                </option>
              ))}
            </select>
          )}
        </FormField>
        {form.networkMode === 'open' ? (
          <Banner tone="danger">{t('tpl.f.netOpenWarning')}</Banner>
        ) : null}
        <fieldset
          className="wide-col"
          aria-describedby={e('networkPresets').length ? 'f-netpresets-err' : undefined}
        >
          <legend>{t('tpl.f.netPresets')}</legend>
          {(catalog?.networkPresets ?? []).map((np) => (
            <label key={np.name} className="inline" title={np.domains.join(', ')}>
              <input
                type="checkbox"
                checked={form.networkPresets.includes(np.name)}
                onChange={(x) =>
                  patch({
                    networkPresets: x.target.checked
                      ? [...form.networkPresets, np.name]
                      : form.networkPresets.filter((n) => n !== np.name),
                  })
                }
              />
              {np.name}
            </label>
          ))}
          {e('networkPresets').length > 0 ? (
            <div id="f-netpresets-err" role="alert">
              <ul className="field-errors">
                {e('networkPresets').map((x, i) => (
                  <li key={i} className="plain">
                    {x.message}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </fieldset>
        <FormField
          id="f-netallow"
          label={t('tpl.f.netAllow')}
          hint={t('tpl.f.netAllowHint')}
          errors={e('networkAllow')}
          wide
        >
          {(p) => (
            <ListInput
              id={p.id}
              multiline
              rows={3}
              items={form.networkAllow}
              split={splitList}
              onItems={(list) => patch({ networkAllow: list })}
              aria-invalid={p.invalid}
              aria-describedby={p.describedBy}
              spellCheck={false}
            />
          )}
        </FormField>
      </div>

      <MountsSection form={form} errors={e('mounts')} patch={patch} />
      <EnvSection form={form} errors={e('env')} patch={patch} />

      {e('other').length > 0 ? (
        <>
          <h3 className="h-small">{t('tpl.f.other')}</h3>
          <div role="alert">
            <ul className="field-errors">
              {e('other').map((x, i) => (
                <li key={i} className="plain">
                  {x.path ? <code>{x.path}</code> : null} {x.message}
                </li>
              ))}
            </ul>
          </div>
        </>
      ) : null}
    </fieldset>
  );
}

function ToolsSection(props: {
  form: TemplateForm;
  catalog: TemplateCatalogInfo | undefined;
  warnings: ReturnType<typeof toolWarnings>;
  errors: FieldIssue[];
  patch(p: FormPatch): void;
}) {
  const { t } = useApp();
  const { form, catalog } = props;
  const refOf = (name: string) => form.tools.find((r) => r === name || r.startsWith(`${name}@`));
  const known = new Set((catalog?.tools ?? []).map((x) => x.name));
  const unknown = form.tools.filter((r) => !known.has(r.split('@')[0] ?? r));

  function setTool(name: string, on: boolean, version?: string) {
    const without = form.tools.filter((r) => !(r === name || r.startsWith(`${name}@`)));
    if (!on) return props.patch({ tools: without });
    // keep the position of an existing entry
    const next = version ? `${name}@${version}` : name;
    const idx = form.tools.findIndex((r) => r === name || r.startsWith(`${name}@`));
    if (idx >= 0) return props.patch({ tools: form.tools.map((r, i) => (i === idx ? next : r)) });
    return props.patch({ tools: [...without, next] });
  }

  return (
    <>
      <h3 className="h-small">{t('tpl.f.tools')}</h3>
      <p className="muted small">{t('tpl.f.toolsHint')}</p>
      {props.errors.length > 0 ? (
        <div role="alert">
          <ul className="field-errors">
            {props.errors.map((x, i) => (
              <li key={i} className="plain">
                {x.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="tool-grid">
        {(catalog?.tools ?? []).map((tool) => {
          const ref = refOf(tool.name);
          const selected = ref !== undefined;
          const version = ref?.includes('@') ? ref.slice(ref.indexOf('@') + 1) : '';
          const warn = props.warnings.find(
            (w) => w.tool === ref && w.reason === 'no-preset-for-os',
          );
          return (
            <div key={tool.name} className="tool-row" data-tool={tool.name}>
              <label className="inline">
                <input
                  type="checkbox"
                  checked={selected}
                  onChange={(x) => setTool(tool.name, x.target.checked, version || undefined)}
                />
                <strong>{tool.name}</strong>
              </label>
              <span className="muted small plain">{tool.summary}</span>
              {tool.version !== 'none' ? (
                <label className="inline small">
                  <span className="sr-only">{t('tpl.f.toolVersion', { tool: tool.name })}</span>
                  <input
                    type="text"
                    className="tool-version"
                    placeholder={
                      tool.version === 'required' ? t('tpl.f.versionRequired') : t('tpl.f.version')
                    }
                    title={tool.versionHint}
                    value={version}
                    disabled={!selected}
                    onChange={(x) => setTool(tool.name, true, x.target.value.trim() || undefined)}
                    autoComplete="off"
                    aria-label={t('tpl.f.toolVersion', { tool: tool.name })}
                  />
                </label>
              ) : null}
              {warn ? (
                <span className="warn-text small" role="note">
                  <span aria-hidden="true">⚠ </span>
                  {t('tpl.f.noPreset', { tool: tool.name, family: t(`tpl.family.${warn.family}`) })}
                </span>
              ) : null}
            </div>
          );
        })}
        {unknown.map((ref) => (
          <div key={ref} className="tool-row">
            <strong className="plain">{ref}</strong>
            <span className="warn-text small" role="note">
              <span aria-hidden="true">⚠ </span>
              {t('tpl.f.unknownTool')}
            </span>
            <button
              type="button"
              onClick={() => props.patch({ tools: form.tools.filter((r) => r !== ref) })}
            >
              {t('common.remove')}
              <span className="sr-only"> {ref}</span>
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

function MountsSection(props: {
  form: TemplateForm;
  errors: FieldIssue[];
  patch(p: FormPatch): void;
}) {
  const { t } = useApp();
  const { form } = props;
  const set = (i: number, k: 'source' | 'target' | 'access', v: string) =>
    props.patch({ mounts: form.mounts.map((m, n) => (n === i ? { ...m, [k]: v } : m)) });
  return (
    <>
      <h3 className="h-small">{t('tpl.f.mounts')}</h3>
      <p className="muted small">{t('tpl.f.mountsHint')}</p>
      {props.errors.length > 0 ? (
        <div role="alert">
          <ul className="field-errors">
            {props.errors.map((x, i) => (
              <li key={i} className="plain">
                {x.path ? <code>{x.path}</code> : null} {x.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {form.mounts.map((m, i) => (
        <div key={i} className="row-fields">
          <label className="field">
            <span>{t('tpl.f.mountSource')}</span>
            <input
              type="text"
              value={m.source}
              onChange={(x) => set(i, 'source', x.target.value)}
              spellCheck={false}
              aria-label={t('tpl.f.mountSourceN', { n: i + 1 })}
            />
          </label>
          <label className="field">
            <span>{t('tpl.f.mountTarget')}</span>
            <input
              type="text"
              value={m.target}
              onChange={(x) => set(i, 'target', x.target.value)}
              spellCheck={false}
              aria-label={t('tpl.f.mountTargetN', { n: i + 1 })}
            />
          </label>
          <label className="field">
            <span>{t('tpl.f.mountAccess')}</span>
            <select
              value={m.access}
              onChange={(x) => set(i, 'access', x.target.value)}
              aria-label={t('tpl.f.mountAccessN', { n: i + 1 })}
            >
              <option value="">{t('tpl.f.mountDefault')}</option>
              <option value="ro">ro</option>
              <option value="rw">rw</option>
            </select>
          </label>
          <button
            type="button"
            onClick={() => props.patch({ mounts: form.mounts.filter((_, n) => n !== i) })}
          >
            {t('common.remove')}
            <span className="sr-only"> {t('tpl.f.mountN', { n: i + 1 })}</span>
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() =>
          props.patch({
            mounts: [...form.mounts, { source: '~/', target: '/mnt/data', access: 'ro' }],
          })
        }
      >
        {t('tpl.f.mountAdd')}
      </button>
    </>
  );
}

function EnvSection(props: {
  form: TemplateForm;
  errors: FieldIssue[];
  patch(p: FormPatch): void;
}) {
  const { t } = useApp();
  // Rows being edited can be incomplete (empty key): they live here, and only complete rows reach the YAML.
  const [rows, setRows] = useState<EnvRow[]>(props.form.env);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  useEffect(() => {
    const complete = (r: EnvRow[]) => JSON.stringify(r.filter((x) => x.key !== ''));
    if (complete(rowsRef.current) !== complete(props.form.env)) setRows(props.form.env);
  }, [props.form.env]);
  const commit = (next: EnvRow[]) => {
    setRows(next);
    props.patch({ env: next });
  };
  const set = (i: number, k: 'key' | 'value', v: string) =>
    commit(rows.map((r, n) => (n === i ? { ...r, [k]: v } : r)));
  return (
    <>
      <h3 className="h-small">{t('tpl.f.env')}</h3>
      <p className="muted small">{t('tpl.f.envHint')}</p>
      {props.errors.length > 0 ? (
        <div role="alert">
          <ul className="field-errors">
            {props.errors.map((x, i) => (
              <li key={i} className="plain">
                {x.path ? <code>{x.path}</code> : null} {x.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {rows.map((r, i) => (
        <div key={i} className="row-fields">
          <label className="field">
            <span>{t('tpl.f.envKey')}</span>
            <input
              type="text"
              value={r.key}
              onChange={(x) => set(i, 'key', x.target.value)}
              spellCheck={false}
              aria-label={t('tpl.f.envKeyN', { n: i + 1 })}
            />
          </label>
          <label className="field">
            <span>{t('tpl.f.envValue')}</span>
            <input
              type="text"
              value={r.value}
              onChange={(x) => set(i, 'value', x.target.value)}
              spellCheck={false}
              aria-label={t('tpl.f.envValueN', { n: i + 1 })}
            />
          </label>
          <button type="button" onClick={() => commit(rows.filter((_, n) => n !== i))}>
            {t('common.remove')}
            <span className="sr-only"> {t('tpl.f.envN', { n: i + 1 })}</span>
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => commit([...rows, { key: `VAR_${rows.length + 1}`, value: '' }])}
      >
        {t('tpl.f.envAdd')}
      </button>
    </>
  );
}

// -- build and test ---------------------------------------------------------------------------------------------------

function useProgress(key: string): {
  lines: string[];
  reset(): void;
  ref: React.RefObject<HTMLPreElement | null>;
} {
  const [lines, setLines] = useState<string[]>([]);
  const ref = useRef<HTMLPreElement>(null);
  useEffect(
    () =>
      window.abox.on('evt:progress', (ev) => {
        if (ev.key === key) setLines((p) => [...p.slice(-400), ev.line]);
      }),
    [key],
  );
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [lines]);
  return { lines, reset: () => setLines([]), ref };
}

/** What a project template does, shown the way the approver sees it (risks and the resolved template as a diff). */
export function ReviewDialog(props: { name: string; projectDir?: string; onClose(): void }) {
  const { t } = useApp();
  const q = useQuery(
    'templates:review',
    { name: props.name, ...(props.projectDir ? { projectDir: props.projectDir } : {}) },
    { live: false },
  );
  return (
    <Dialog
      title={t('tpl.review.title', { name: props.name })}
      onClose={props.onClose}
      wide
      footer={
        <button type="button" onClick={props.onClose} autoFocus>
          {t('common.close')}
        </button>
      }
    >
      <p className="muted">{t('tpl.review.hint')}</p>
      {q.loading && !q.data ? <Loading /> : null}
      {q.error ? <ErrorBox error={q.error} /> : null}
      {q.data ? (
        <>
          <h3>{t('new.review.title')}</h3>
          <TemplateReviewPanel review={q.data} />
        </>
      ) : null}
    </Dialog>
  );
}

function BuildDialog(props: { name: string; onClose(): void }) {
  const { t, notify } = useApp();
  const key = useRef(`build-${Math.random().toString(36).slice(2)}`);
  const progress = useProgress(key.current);
  const [phase, setPhase] = useState<'ask' | 'running' | 'done' | 'error'>('ask');
  const [update, setUpdate] = useState(false);
  const [result, setResult] = useState<{ image: string; cached: boolean; durationMs: number }>();
  const [error, setError] = useState<unknown>();

  async function run() {
    setPhase('running');
    progress.reset();
    setError(undefined);
    try {
      const r = await call('templates:build', {
        name: props.name,
        progressKey: key.current,
        ...(update ? { update: true } : {}),
      });
      setResult({ image: r.image.ref, cached: r.cached, durationMs: r.durationMs });
      setPhase('done');
      notify('ok', t('tpl.build.done', { name: props.name }));
    } catch (e) {
      setError(e);
      setPhase('error');
    }
  }

  return (
    <Dialog
      title={t('tpl.build.title', { name: props.name })}
      onClose={() => phase !== 'running' && props.onClose()}
      wide
      footer={
        <>
          <button
            type="button"
            onClick={props.onClose}
            disabled={phase === 'running'}
            autoFocus={phase !== 'ask'}
          >
            {phase === 'done' ? t('common.close') : t('common.cancel')}
          </button>
          {phase === 'ask' || phase === 'error' ? (
            <button
              type="button"
              className="primary"
              onClick={() => void run()}
              autoFocus={phase === 'ask'}
            >
              {t('tpl.build.start')}
            </button>
          ) : null}
        </>
      }
    >
      {phase === 'ask' ? (
        <>
          <Banner tone="warn">{t('tpl.build.networkWarning')}</Banner>
          <label className="inline">
            <input type="checkbox" checked={update} onChange={(e) => setUpdate(e.target.checked)} />
            {t('tpl.build.update')}
          </label>
        </>
      ) : null}
      {phase !== 'ask' ? (
        <pre
          className="log plain"
          ref={progress.ref}
          tabIndex={0}
          aria-live="polite"
          aria-label={t('tpl.build.log')}
        >
          {progress.lines.join('\n')}
        </pre>
      ) : null}
      {phase === 'running' ? <p role="status">{t('tpl.build.running')}</p> : null}
      {phase === 'done' && result ? (
        <Banner tone="ok">
          {result.cached ? t('tpl.build.cached') : t('tpl.build.built')} ·{' '}
          <code className="plain">{result.image}</code> · {formatDuration(result.durationMs)}
        </Banner>
      ) : null}
      {phase === 'error' ? <ErrorBox error={error} /> : null}
    </Dialog>
  );
}

function TestDialog(props: { name: string; onClose(): void }) {
  const { t } = useApp();
  const key = useRef(`test-${Math.random().toString(36).slice(2)}`);
  const progress = useProgress(key.current);
  const [phase, setPhase] = useState<'running' | 'confirm' | 'done' | 'error'>('running');
  const [outcome, setOutcome] = useState<TemplateTestOutcome>();
  const [error, setError] = useState<unknown>();
  const started = useRef(false);

  async function run(confirmed: boolean) {
    setPhase('running');
    progress.reset();
    setError(undefined);
    try {
      const r = await call('templates:test', {
        name: props.name,
        progressKey: key.current,
        ...(confirmed ? { confirmed: true } : {}),
      });
      setOutcome(r);
      setPhase(r.status === 'confirmation_required' ? 'confirm' : 'done');
    } catch (e) {
      setError(e);
      setPhase('error');
    }
  }
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void run(false);
  }, []);

  const tools = outcome?.status === 'done' ? outcome.tools : [];
  const failed = tools.filter((x) => !x.ok).length;
  return (
    <Dialog
      title={t('tpl.test.title', { name: props.name })}
      onClose={() => phase !== 'running' && props.onClose()}
      wide
      footer={
        <>
          <button type="button" onClick={props.onClose} disabled={phase === 'running'} autoFocus>
            {phase === 'done' ? t('common.close') : t('common.cancel')}
          </button>
          {phase === 'confirm' ? (
            <button type="button" className="primary" onClick={() => void run(true)}>
              {t('tpl.test.confirm')}
            </button>
          ) : null}
          {phase === 'error' ? (
            <button type="button" onClick={() => void run(false)}>
              {t('common.retry')}
            </button>
          ) : null}
        </>
      }
    >
      <p className="muted">{t('tpl.test.intro')}</p>
      {phase === 'running' ? (
        <>
          <p role="status">{t('tpl.test.running')}</p>
          <pre
            className="log plain"
            ref={progress.ref}
            tabIndex={0}
            aria-label={t('tpl.build.log')}
          >
            {progress.lines.join('\n')}
          </pre>
        </>
      ) : null}
      {phase === 'confirm' && outcome?.status === 'confirmation_required' ? (
        <Banner tone="warn">
          <strong>{t('tpl.test.confirmTitle')}</strong>
          <ul>
            {[...outcome.reasons, ...outcome.risks].map((r, i) => (
              <li key={i} className="plain">
                {r}
              </li>
            ))}
          </ul>
        </Banner>
      ) : null}
      {outcome?.status === 'pending_approval' ? (
        <Banner tone="warn">
          <span className="plain">{outcome.message}</span>
        </Banner>
      ) : null}
      {phase === 'error' ? <ErrorBox error={error} /> : null}
      {outcome?.status === 'done' ? (
        <>
          <Banner tone={failed === 0 && !outcome.error ? 'ok' : 'danger'}>
            {failed === 0 && !outcome.error
              ? t('tpl.test.allOk', { count: tools.length })
              : t('tpl.test.failed', { count: failed })}
            {' · '}
            {outcome.removed ? t('tpl.test.removed') : t('tpl.test.notRemoved')}
          </Banner>
          {outcome.error ? (
            <Banner tone="danger">
              <span className="plain">{outcome.error}</span>
            </Banner>
          ) : null}
          {tools.length === 0 ? <p className="muted">{t('tpl.test.noTools')}</p> : null}
          {tools.length > 0 ? (
            <div className="table-wrap">
              <table>
                <caption className="sr-only">{t('tpl.test.table')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('tpl.test.col.tool')}</th>
                    <th scope="col">{t('tpl.test.col.check')}</th>
                    <th scope="col">{t('tpl.test.col.result')}</th>
                    <th scope="col">{t('tpl.test.col.output')}</th>
                  </tr>
                </thead>
                <tbody>
                  {tools.map((x) => (
                    <tr key={`${x.name}@${x.version ?? ''}`} className={x.ok ? '' : 'row-danger'}>
                      <th scope="row" className="plain">
                        {x.name}
                        {x.version ? `@${x.version}` : ''}
                      </th>
                      <td className="plain mono">{x.check}</td>
                      <td>
                        <Badge tone={x.ok ? 'ok' : 'danger'}>
                          {x.ok ? t('tpl.test.ok') : t('tpl.test.fail')}
                        </Badge>
                        {x.exitCode !== null ? (
                          <span className="muted small"> exit {x.exitCode}</span>
                        ) : null}
                      </td>
                      <td>
                        <pre className="log plain small-log">{x.output || '—'}</pre>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      ) : null}
    </Dialog>
  );
}
