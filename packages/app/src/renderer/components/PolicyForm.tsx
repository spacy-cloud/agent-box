import { useEffect, useMemo, useState } from 'react';
import type { ResolvedProfile } from '@abox/core';
import { useT } from '../context';
import { Banner, Field, IsolationBadge } from './ui';
import { ListInput, SyncedInput } from './inputs';
import {
  APPROVAL_MODES,
  FORM_CHOICES,
  readPolicyForm,
  setProfileField,
} from '../../shared/policy-form';
import type { FieldPath, ProfileFields } from '../../shared/policy-form';
import { safeInline } from '../../shared/format';
import type { IsolationLevel } from '@abox/core';

/** Words and commas separate the entries of a list field. */
const splitList = (text: string): string[] => text.split(/[\s,]+/).filter((x) => x !== '');

/**
 * Profiles and limits of `policy.yaml` as a form. The text is the only state: every change is written into it
 * (comments and layout kept), the YAML editor next to it shows the same text, and the manager validates it. An
 * empty field means "not set in this profile": it inherits from `extends` or uses the default, shown as the
 * placeholder. Mounts, secrets and workspace roots stay in the YAML.
 */
export function PolicyForm(props: {
  text: string;
  onText(text: string): void;
  /** Effective profiles of the policy in force (for the inherited / default values shown as hints). */
  resolved: Readonly<Record<string, ResolvedProfile>>;
}) {
  const t = useT();
  const parsed = useMemo(() => readPolicyForm(props.text), [props.text]);
  const names = parsed.ok ? parsed.profiles.map((p) => p.name) : [];
  const [selected, setSelected] = useState('');
  useEffect(() => {
    if (names.length > 0 && !names.includes(selected)) setSelected(names[0]!);
  }, [names.join('\0'), selected]);

  if (!parsed.ok) return <Banner tone="warn">{t('policy.form.broken')}</Banner>;
  if (parsed.profiles.length === 0) return <p className="muted">{t('policy.form.empty')}</p>;
  const profile = parsed.profiles.find((p) => p.name === selected) ?? parsed.profiles[0]!;
  const f: ProfileFields = profile.fields;
  const eff = props.resolved[profile.name];

  const put = (path: FieldPath, value: string | boolean | string[] | undefined): void =>
    props.onText(setProfileField(props.text, profile.name, path, value));

  const inherited = (v: string | number | boolean | string[] | undefined): string =>
    v === undefined ? '' : Array.isArray(v) ? v.join(', ') : String(v);

  return (
    <form
      className="policy-form"
      onSubmit={(e) => e.preventDefault()}
      aria-label={t('policy.form.label')}
    >
      <p className="muted small">{t('policy.form.hint')}</p>
      <Field label={t('policy.form.profile')}>
        {(id) => (
          <select id={id} value={profile.name} onChange={(e) => setSelected(e.target.value)}>
            {parsed.profiles.map((p) => (
              <option key={p.name} value={p.name}>
                {safeInline(p.name, 60)}
              </option>
            ))}
          </select>
        )}
      </Field>
      {profile.extends ? (
        <p className="muted small">
          {t('policy.form.extends', { name: safeInline(profile.extends, 60) })}
        </p>
      ) : null}

      <fieldset className="tpl-form">
        <legend>{t('policy.form.approval')}</legend>
        <Field label={t('policy.f.approval')} hint={t('policy.f.approvalHint')}>
          {(id) => (
            <select
              id={id}
              value={f.approval ?? ''}
              onChange={(e) => put(['approval'], e.target.value)}
            >
              <option value="">
                {t('policy.f.inheritedValue', { value: eff?.approval ?? 'medium' })}
              </option>
              {APPROVAL_MODES.map((m) => (
                <option key={m} value={m}>
                  {t(`policy.approval.${m}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={t('policy.f.execApproval')} hint={t('policy.f.execApprovalHint')}>
          {(id) => (
            <select
              id={id}
              value={f.execApproval === undefined ? '' : String(f.execApproval)}
              onChange={(e) =>
                put(
                  ['exec', 'approval'],
                  e.target.value === '' ? undefined : e.target.value === 'true',
                )
              }
            >
              <option value="">
                {t('policy.f.inheritedValue', {
                  value: eff?.exec.approval ? t('common.yes') : t('common.no'),
                })}
              </option>
              <option value="true">{t('common.yes')}</option>
              <option value="false">{t('common.no')}</option>
            </select>
          )}
        </Field>
      </fieldset>

      <fieldset className="tpl-form">
        <legend>{t('policy.limits')}</legend>
        <div className="form-grid">
          <Field label={t('policy.f.limits.sandboxes')}>
            {(id) => (
              <SyncedInput
                id={id}
                numeric
                inputMode="numeric"
                value={f.limits.sandboxes ?? ''}
                placeholder={inherited(eff?.limits.sandboxes)}
                onValue={(v) => put(['limits', 'sandboxes'], v.trim())}
              />
            )}
          </Field>
          <Field label={t('policy.f.limits.cpus')}>
            {(id) => (
              <SyncedInput
                id={id}
                numeric
                inputMode="decimal"
                value={f.limits.cpus ?? ''}
                placeholder={inherited(eff?.limits.cpus)}
                onValue={(v) => put(['limits', 'cpus'], v.trim())}
              />
            )}
          </Field>
          <Field label={t('policy.f.limits.memory')} hint={t('policy.f.limits.memoryHint')}>
            {(id) => (
              <SyncedInput
                id={id}
                spellCheck={false}
                value={f.limits.memory ?? ''}
                placeholder={inherited(eff?.limits.memory)}
                onValue={(v) => put(['limits', 'memory'], v.trim())}
              />
            )}
          </Field>
          <Field label={t('policy.f.limits.ttl')} hint={t('policy.f.limits.ttlHint')}>
            {(id) => (
              <SyncedInput
                id={id}
                spellCheck={false}
                value={f.limits.ttl ?? ''}
                placeholder={inherited(eff?.limits.ttl)}
                onValue={(v) => put(['limits', 'ttl'], v.trim())}
              />
            )}
          </Field>
        </div>
      </fieldset>

      <fieldset className="tpl-form">
        <legend>{t('policy.isolation')}</legend>
        <p className="muted small">{t('policy.f.isolationHint')}</p>
        {(['min', 'network_open', 'mounts', 'secrets_env'] as const).map((key) => {
          const value = f.isolation[key];
          const effective = eff?.isolation[key];
          const shown = (value ?? effective) as IsolationLevel | undefined;
          return (
            <Field key={key} label={t(`policy.isolation.${key}`)}>
              {(id) => (
                <span className="with-badge">
                  <select
                    id={id}
                    value={value ?? ''}
                    onChange={(e) => put(['isolation', key], e.target.value)}
                  >
                    <option value="">
                      {t('policy.f.inheritedValue', { value: effective ?? '–' })}
                    </option>
                    {FORM_CHOICES.isolation.map((l) => (
                      <option key={l} value={l}>
                        {l === 'none' ? `⚠ ${t('isolation.none')}` : t(`isolation.${l}`)}
                      </option>
                    ))}
                  </select>
                  {shown === 'none' ? <IsolationBadge level="none" /> : null}
                </span>
              )}
            </Field>
          );
        })}
      </fieldset>

      <fieldset className="tpl-form">
        <legend>{t('policy.network')}</legend>
        <ListField
          label={t('policy.f.networkModes')}
          hint={t('policy.f.listHint', { values: FORM_CHOICES.networkModes.join(', ') })}
          items={f.networkModes ?? []}
          placeholder={inherited(eff?.network.modes)}
          onItems={(v) => put(['network', 'modes'], v)}
        />
        <ListField
          label={t('policy.f.allowPresets')}
          hint={t('policy.f.listHint', { values: 'npm, pypi, github, …' })}
          items={f.allowPresets ?? []}
          placeholder={inherited(eff?.network.allow_presets)}
          onItems={(v) => put(['network', 'allow_presets'], v)}
        />
        <ListField
          label={t('policy.f.allow')}
          hint={t('policy.f.allowHint')}
          items={f.allow ?? []}
          placeholder={inherited(eff?.network.allow)}
          onItems={(v) => put(['network', 'allow'], v)}
        />
        <ListField
          label={t('policy.images')}
          hint={t('policy.f.registriesHint')}
          items={f.registries ?? []}
          placeholder={inherited(eff?.images.registries)}
          onItems={(v) => put(['images', 'registries'], v)}
        />
      </fieldset>

      <fieldset className="tpl-form">
        <legend>{t('policy.f.scope')}</legend>
        <ListField
          label={t('policy.f.workspaceModes')}
          hint={t('policy.f.listHint', { values: FORM_CHOICES.workspaceModes.join(', ') })}
          items={f.workspaceModes ?? []}
          placeholder={inherited(eff?.workspace.modes)}
          onItems={(v) => put(['workspace', 'modes'], v)}
        />
        <ListField
          label={t('policy.templates')}
          hint={t('policy.f.templatesHint')}
          items={f.templates ?? []}
          placeholder={inherited(eff?.templates)}
          onItems={(v) => put(['templates'], v)}
        />
        <ListField
          label={t('policy.hosts')}
          hint={t('policy.f.hostsHint')}
          items={f.hosts ?? []}
          placeholder={inherited(eff?.hosts)}
          onItems={(v) => put(['hosts'], v)}
        />
      </fieldset>
      <p className="muted small">{t('policy.f.yamlOnly')}</p>
    </form>
  );
}

function ListField(props: {
  label: string;
  hint: string;
  items: readonly string[];
  placeholder: string;
  onItems(v: string[]): void;
}) {
  return (
    <Field label={props.label} hint={props.hint}>
      {(id) => (
        <ListInput
          id={id}
          spellCheck={false}
          items={props.items}
          split={splitList}
          placeholder={props.placeholder}
          onItems={props.onItems}
        />
      )}
    </Field>
  );
}
