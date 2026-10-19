import { useEffect, useRef, useState } from 'react';
import { call } from '../../api';
import { useApp } from '../../context';
import { useQuery } from '../../hooks';
import { Banner, Dialog } from '../ui';
import { AgentsStep } from './AgentsStep';
import { ApprovalsStep } from './ApprovalsStep';
import { CheckStep } from './CheckStep';
import { FoldersStep } from './FoldersStep';
import { BuildList, TemplatesStep } from './TemplatesStep';
import { useSetupBuilds } from './builds';
import type { SetupWizardState } from '../../../shared/constants';

const STEPS = ['check', 'folders', 'agents', 'templates', 'approvals'] as const;
type Step = (typeof STEPS)[number];

/**
 * First-run setup: check the machine, say where the projects are, register abox with the agents, prebuild the
 * templates, learn how approvals work. Every step is optional, nothing is written without a preview and a click, and the
 * whole wizard can be skipped for good ("Skip setup") or put off ("Later"); Settings can open it again. Always mounted,
 * so the template builds it started go on (and report through toasts) after the dialog is closed.
 */
export function SetupWizardHost() {
  const { setupOpen, setSetupOpen, info } = useApp();
  const builds = useSetupBuilds();
  const [stored, setStored] = useState<SetupWizardState | null>(info.setupWizard);
  return setupOpen ? (
    <SetupWizard
      stored={stored}
      onStored={setStored}
      onClose={() => setSetupOpen(false)}
      builds={builds}
    />
  ) : null;
}

function SetupWizard(props: {
  stored: SetupWizardState | null;
  onStored(s: SetupWizardState): void;
  onClose(): void;
  builds: ReturnType<typeof useSetupBuilds>;
}) {
  const { t, notify } = useApp();
  const [step, setStep] = useState<Step>('check');
  const [done, setDone] = useState<ReadonlySet<Step>>(new Set());
  const [folders, setFolders] = useState<string[]>([]);
  const [saved, setSaved] = useState<string[]>([]);
  const [profile, setProfile] = useState<string | undefined>();
  const heading = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);
  const index = STEPS.indexOf(step);

  // The workspace roots now, to look for projects in them when no folder was chosen here.
  const roots = useQuery(
    'setup:roots',
    { ...(profile ? { profile } : {}), folders: [] },
    { live: false },
  );
  const scanFolders = [
    ...new Set([
      ...folders,
      ...saved,
      ...(roots.data?.roots ?? []).filter((r) => r.startsWith('/') || r.startsWith('~/')),
    ]),
  ].slice(0, 20);

  // After a step change focus moves to the new step's heading (screen readers announce it; keyboard users start there).
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    heading.current?.focus();
  }, [step]);

  const mark = (s: Step) => setDone((d) => new Set(d).add(s));

  async function persist(state: SetupWizardState) {
    try {
      await call('app:settings', { setupWizard: state });
      props.onStored(state);
    } catch (e) {
      notify('error', (e as Error).message);
    }
  }
  async function skip() {
    // Skipping never turns a finished setup into a skipped one: it only closes the dialog.
    if (props.stored === null) await persist('skipped');
    props.onClose();
    notify('info', t('setup.skipped'));
  }
  async function finish() {
    await persist('completed');
    props.onClose();
    notify('ok', t('setup.finished'));
  }

  return (
    <Dialog
      title={t('setup.title')}
      onClose={props.onClose}
      wide
      footer={
        <>
          <div className="wizard-footer-left">
            <button type="button" onClick={props.onClose}>
              {t('setup.later')}
            </button>
            <button type="button" onClick={() => void skip()}>
              {t('setup.skip')}
            </button>
          </div>
          <button
            type="button"
            onClick={() => setStep(STEPS[Math.max(0, index - 1)]!)}
            disabled={index === 0}
          >
            {t('setup.back')}
          </button>
          {index < STEPS.length - 1 ? (
            <button type="button" className="primary" onClick={() => setStep(STEPS[index + 1]!)}>
              {t('setup.next')}
            </button>
          ) : (
            <button type="button" className="primary" onClick={() => void finish()}>
              {t('setup.finish')}
            </button>
          )}
        </>
      }
    >
      <ol className="steps" aria-label={t('setup.steps')}>
        {STEPS.map((s, i) => (
          <li
            key={s}
            aria-current={s === step ? 'step' : undefined}
            className={done.has(s) ? 'done' : ''}
          >
            {i + 1}. {t(`setup.step.${s}`)}
            {done.has(s) ? <span className="sr-only"> ({t('setup.stepDone')})</span> : null}
          </li>
        ))}
      </ol>
      <h3 ref={heading} tabIndex={-1} className="wizard-heading">
        {t(`setup.heading.${step}`)}
      </h3>
      {index === 0 ? <p className="muted">{t('setup.intro')}</p> : null}
      <div className="wizard-step" data-step={step}>
        {step === 'check' ? <CheckStep /> : null}
        {step === 'folders' ? (
          <FoldersStep
            folders={folders}
            setFolders={setFolders}
            profile={profile}
            setProfile={setProfile}
            onSaved={(entries) => {
              setSaved((l) => [...l, ...entries]);
              mark('folders');
            }}
          />
        ) : null}
        {step === 'agents' ? <AgentsStep onApplied={() => mark('agents')} /> : null}
        {step === 'templates' ? (
          <TemplatesStep
            scanFolders={scanFolders}
            builds={props.builds.builds}
            onBuild={(names) => {
              props.builds.start(names);
              mark('templates');
            }}
          />
        ) : null}
        {step === 'approvals' ? <ApprovalsStep /> : null}
      </div>
      {step !== 'templates' && props.builds.builds.length > 0 ? (
        <>
          <h4 className="h-small">{t('setup.templates.progress')}</h4>
          <BuildList builds={props.builds.builds} />
        </>
      ) : null}
      {step === 'approvals' ? <Banner tone="info">{t('setup.reopen')}</Banner> : null}
    </Dialog>
  );
}
