import { useEffect, useRef, useState } from 'react';
import type { WorkspaceEstimate } from '@abox/core';
import { call } from '../api';
import { useApp } from '../context';
import { Banner } from './ui';
import { formatBytes, safeInline } from '../../shared/format';

/** Folder size check state of the New-sandbox dialog. */
export type EstimateState =
  | { status: 'idle' }
  | { status: 'scanning'; line?: string }
  | { status: 'ready'; estimate: WorkspaceEstimate }
  | { status: 'error'; message: string };

/** Pause after the last keystroke before the folder is measured. */
const DEBOUNCE_MS = 400;

const fmtCount = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

/**
 * Measures the picked workspace folder with the manager's fast read-only pre-scan (`workspace:estimate`).
 * Debounced; a newer folder (or leaving the dialog) cancels the scan that is still running, and an
 * answer for an older folder is dropped. Only copy / sync workspaces are measured.
 */
export function useWorkspaceEstimate(input: {
  path: string;
  /** Effective workspace mode (the form's choice, else the template's). */
  mode: string;
  exclude: string[];
}): EstimateState {
  const [state, setState] = useState<EstimateState>({ status: 'idle' });
  const key = useRef(`estimate-${Math.random().toString(36).slice(2)}`);
  const excludeKey = JSON.stringify(input.exclude);
  const wanted = input.path.startsWith('/') && (input.mode === 'copy' || input.mode === 'sync');

  useEffect(() => {
    if (!wanted) {
      setState({ status: 'idle' });
      return;
    }
    let live = true;
    let started = false;
    setState({ status: 'scanning' });
    const off = window.abox.on('evt:progress', (ev) => {
      if (live && ev.key === key.current) setState({ status: 'scanning', line: ev.line });
    });
    const timer = setTimeout(() => {
      started = true;
      call('workspace:estimate', {
        path: input.path,
        mode: input.mode as 'copy' | 'sync',
        ...(input.exclude.length > 0 ? { exclude: input.exclude } : {}),
        progressKey: key.current,
      }).then(
        (estimate) => {
          if (live) setState({ status: 'ready', estimate });
        },
        (e: unknown) => {
          if (live) setState({ status: 'error', message: (e as Error).message });
        },
      );
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
      off();
      if (started) void call('jobs:cancel', { key: key.current }).catch(() => undefined);
    };
  }, [wanted, input.path, input.mode, excludeKey]);

  return state;
}

/** True when a create of this folder in a copy mode is refused (larger than the hard copy limit). */
export function estimateBlocksCreate(s: EstimateState): boolean {
  return s.status === 'ready' && s.estimate.applicable && s.estimate.overHardLimit;
}

/**
 * The size note under the folder field: size and file count, a warning for a large folder (with the
 * better modes one click away) and an error for one beyond the copy limit.
 */
export function WorkspaceEstimateNote(props: {
  state: EstimateState;
  /** Modes the profile offers (to suggest `mount` / `clone` inline). */
  modes: readonly string[];
  onUseMode?(mode: string): void;
  compact?: boolean;
}) {
  const { t } = useApp();
  const { state } = props;
  if (state.status === 'idle') return null;
  if (state.status === 'scanning') {
    return (
      <p className="muted small" role="status" data-testid="estimate-scanning">
        {t('new.estimate.scanning')}
        {state.line ? <span className="plain"> {safeInline(state.line, 200)}</span> : null}
      </p>
    );
  }
  if (state.status === 'error') {
    return (
      <p className="muted small" role="status" data-testid="estimate-error">
        {t('new.estimate.failed', { message: safeInline(state.message, 300) })}
      </p>
    );
  }
  const e = state.estimate;
  if (!e.applicable) return null;
  const size = `${e.truncated ? '≥ ' : '≈ '}${formatBytes(e.bytes)}`;
  const files = fmtCount(e.files);
  const summary = t('new.estimate.summary', { size, files });
  const alternatives = (['mount', 'clone'] as const).filter((m) => props.modes.includes(m));
  const suggest =
    props.onUseMode && !props.compact && alternatives.length > 0 ? (
      <span className="actions">
        {alternatives.map((m) => (
          <button key={m} type="button" onClick={() => props.onUseMode?.(m)}>
            {t('new.estimate.useMode', { mode: t(`workspace.${m}`) })}
          </button>
        ))}
      </span>
    ) : null;
  if (e.overHardLimit) {
    return (
      <Banner tone="danger">
        <strong data-testid="estimate-too-large">
          {t('new.estimate.tooLarge', {
            size: formatBytes(e.hard.bytes),
            entries: fmtCount(e.hard.entries),
          })}
        </strong>
        <p>{summary}</p>
        <p>{t('new.estimate.advice')}</p>
        {suggest}
      </Banner>
    );
  }
  if (e.overSoftLimit) {
    return (
      <Banner tone="warn">
        <strong data-testid="estimate-large">{t('new.estimate.large', { summary })}</strong>
        <p>{t('new.estimate.advice')}</p>
        {suggest}
      </Banner>
    );
  }
  return (
    <p className="muted small" role="status" data-testid="estimate-ok">
      {summary}
    </p>
  );
}
