import { useEffect, useRef, useState } from 'react';
import type { FitEstimate } from '@abox/core';
import { call } from '../api';
import { useApp } from '../context';
import { Banner, Safe } from './ui';
import { fitBanner } from '../../shared/capacity';
import { safeInline } from '../../shared/format';

/** State of the fit estimate under "Resources and network" of the New-sandbox dialog. */
export type FitState =
  | { status: 'idle' }
  /** `previous` stays on screen while the next estimate is on its way (no flicker). */
  | { status: 'loading'; previous?: FitEstimate }
  | { status: 'ready'; estimate: FitEstimate }
  | { status: 'error'; message: string };

/** Pause after the last change of host or resources before the estimate is asked for. */
const DEBOUNCE_MS = 500;

const SIZE_RE = /^\d{1,6}(\.\d+)?[kmgt]?b?$/i;

/**
 * Asks the manager how often the planned sandbox fits on the chosen host (`capacity:estimate`, read-only). Debounced;
 * an answer for an older input is dropped. Entries that are not valid yet (a half-typed memory size) leave the
 * estimate out instead of asking.
 */
export function useFitEstimate(input: {
  enabled: boolean;
  /** Host profile id; empty = this computer. */
  host: string;
  template: string;
  cpus: string;
  memory: string;
  projectDir?: string;
  workspacePath?: string;
}): FitState {
  const [state, setState] = useState<FitState>({ status: 'idle' });
  const latest = useRef(0);
  const cpus = input.cpus.trim().replace(',', '.');
  const memory = input.memory.trim();
  const valid =
    input.enabled &&
    input.template !== '' &&
    (cpus === '' || Number(cpus) > 0) &&
    (memory === '' || SIZE_RE.test(memory));

  useEffect(() => {
    if (!valid) {
      setState({ status: 'idle' });
      return;
    }
    const mine = ++latest.current;
    setState((s) =>
      s.status === 'ready'
        ? { status: 'loading', previous: s.estimate }
        : s.status === 'loading'
          ? s
          : { status: 'loading' },
    );
    const timer = setTimeout(() => {
      call('capacity:estimate', {
        ...(input.host && input.host !== 'local' ? { host: input.host } : {}),
        template: input.template,
        ...(cpus !== '' || memory !== ''
          ? {
              overrides: {
                ...(cpus !== '' ? { cpus: Number(cpus) } : {}),
                ...(memory !== '' ? { memory } : {}),
              },
            }
          : {}),
        ...(input.projectDir ? { projectDir: input.projectDir } : {}),
        ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
      }).then(
        (estimate) => {
          if (latest.current === mine) setState({ status: 'ready', estimate });
        },
        (e: unknown) => {
          if (latest.current === mine) setState({ status: 'error', message: (e as Error).message });
        },
      );
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [valid, input.host, input.template, cpus, memory, input.projectDir, input.workspacePath]);

  return state;
}

/** True when the create would be refused because a host or profile limit would be exceeded. */
export function fitBlocksCreate(s: FitState): boolean {
  if (s.status === 'ready') return s.estimate.blocked.length > 0;
  // while the next answer is on its way the last one still counts: no flicker of an enabled "Next"
  return s.status === 'loading' && (s.previous?.blocked.length ?? 0) > 0;
}

/**
 * The banner under the resource fields: how often this sandbox fits on the host, what the host looks like with it,
 * and what a limit would refuse. Info normally, amber when memory is nearly used up or over-committed, red when a
 * host or profile limit would be exceeded (then "Next" is disabled). Says plainly that this is a ceiling.
 */
export function FitNote(props: { state: FitState; host: string }) {
  const { t } = useApp();
  const { state } = props;
  if (state.status === 'idle') return null;
  if (state.status === 'error') {
    return (
      <p className="muted small" role="status" data-testid="fit-error">
        {t('new.fit.failed', { message: safeInline(state.message, 300) })}
      </p>
    );
  }
  const estimate = state.status === 'ready' ? state.estimate : state.previous;
  if (!estimate) {
    return (
      <p className="muted small" role="status" data-testid="fit-loading">
        {t('new.fit.loading')}
      </p>
    );
  }
  const host = props.host === '' || props.host === 'local' ? t('new.fit.thisComputer') : props.host;
  const model = fitBanner(estimate, safeInline(host, 60));
  const headline = t(model.headline.key, {
    ...model.headline.params,
    ...(model.headline.by ? { by: t(model.headline.by) } : {}),
  });
  return (
    <div
      className="fit-note"
      data-testid="fit-note"
      data-tone={model.tone}
      aria-busy={state.status === 'loading'}
    >
      <Banner tone={model.tone}>
        <strong>{headline}</strong>
        {model.detail ? <p>{t(model.detail.key, model.detail.params)}</p> : null}
        {model.blocked.length > 0 ? (
          <ul data-testid="fit-blocked">
            {model.blocked.map((b, i) => (
              <li key={i}>
                <Safe text={b.reason} max={300} />
              </li>
            ))}
          </ul>
        ) : null}
        {model.warnings.length > 0 ? (
          <ul data-testid="fit-warnings">
            {model.warnings.map((w) => (
              <li key={w.code}>{t(`new.fit.warn.${w.code}`)}</li>
            ))}
          </ul>
        ) : null}
        <p className="small">{t('new.fit.note')}</p>
      </Banner>
    </div>
  );
}
