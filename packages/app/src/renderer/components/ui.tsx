import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import type { IsolationLevel } from '@abox/core';
import { call } from '../api';
import { useApp, useT } from '../context';
import type { IpcError } from '../../shared/ipc';
import { safeInline, safeText } from '../../shared/format';

// -- badges -----------------------------------------------------------------------------------------

export function Badge(props: {
  tone: 'neutral' | 'info' | 'ok' | 'warn' | 'danger' | 'strong-danger';
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={`badge badge-${props.tone}`} title={props.title}>
      {props.children}
    </span>
  );
}

const ISOLATION_TONE: Record<IsolationLevel, 'strong-danger' | 'info' | 'ok'> = {
  none: 'strong-danger',
  container: 'info',
  hardened: 'ok',
  vm: 'ok',
};

/** Isolation is security-relevant: always visible, `none` is red and spelled out (never colour alone). */
export function IsolationBadge(props: { level: IsolationLevel }) {
  const t = useT();
  return (
    <Badge tone={ISOLATION_TONE[props.level]} title={t(`isolation.${props.level}.hint`)}>
      {props.level === 'none' ? `⚠ ${t('isolation.none')}` : t(`isolation.${props.level}`)}
    </Badge>
  );
}

const STATE_TONE: Record<string, 'neutral' | 'info' | 'ok' | 'warn' | 'danger'> = {
  running: 'ok',
  stopped: 'neutral',
  created: 'info',
  preparing: 'info',
  requested: 'info',
  failed: 'danger',
  expired: 'warn',
  removed: 'neutral',
};

export function StateBadge(props: { state: string; stale?: boolean }) {
  const t = useT();
  return (
    <>
      <Badge tone={STATE_TONE[props.state] ?? 'neutral'}>{t(`state.${props.state}`)}</Badge>
      {props.stale ? (
        <Badge tone="warn" title={t('state.stale.hint')}>
          {t('state.stale')}
        </Badge>
      ) : null}
    </>
  );
}

export function OwnerBadge(props: { owner: string }) {
  const t = useT();
  if (props.owner === 'human') return <Badge tone="neutral">{t('owner.human')}</Badge>;
  if (props.owner === 'system') return <Badge tone="neutral">{t('owner.system')}</Badge>;
  return (
    <Badge tone="info" title={safeInline(props.owner, 200)}>
      {t('owner.agent')}: {safeInline(props.owner.replace(/^agent:/, ''), 80)}
    </Badge>
  );
}

// -- messages ---------------------------------------------------------------------------------------

export function Banner(props: {
  tone: 'info' | 'warn' | 'danger' | 'ok';
  children: ReactNode;
  role?: 'status' | 'alert';
}) {
  return (
    <div
      className={`banner banner-${props.tone}`}
      role={props.role ?? (props.tone === 'danger' ? 'alert' : 'status')}
    >
      {props.children}
    </div>
  );
}

/** Shows an error from the IPC layer, including the manager's hint and policy reasons. */
export function ErrorBox(props: { error: unknown }) {
  const t = useT();
  const e = props.error as Partial<IpcError> & Error;
  const reasons = (e.details as { reasons?: unknown } | undefined)?.reasons;
  return (
    <Banner tone="danger" role="alert">
      <strong>{e.code ? t(`error.${e.code}`) : t('error.internal')}</strong>
      <ScrollText text={String(e.message ?? '')} label={t('error.details')} />
      {Array.isArray(reasons) ? (
        <ul>
          {reasons.map((r, i) => (
            <li key={i} className="plain">
              {safeText(String(r))}
            </li>
          ))}
        </ul>
      ) : null}
      {e.issues && e.issues.length > 0 ? (
        <ul>
          {e.issues.map((i, n) => (
            <li key={n} className="plain">
              {i.path ? <code>{safeInline(i.path, 120)}</code> : null} {safeText(i.message)}
            </li>
          ))}
        </ul>
      ) : null}
      {e.hint ? (
        <div>
          {t('error.hint')}: <span className="plain">{safeText(e.hint)}</span>
        </div>
      ) : null}
    </Banner>
  );
}

export function EmptyState(props: { title: string; text: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h2>{props.title}</h2>
      <p>{props.text}</p>
      {props.children}
    </div>
  );
}

export function Loading() {
  const t = useT();
  return (
    <p className="muted" role="status">
      {t('common.loading')}
    </p>
  );
}

// -- dialog -----------------------------------------------------------------------------------------

/**
 * Modal dialog on the native `<dialog>` element: focus trap, inert background, Esc and focus restore
 * come from the platform.
 */
export function Dialog(props: {
  title: string;
  onClose(): void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!el.open) {
      if (typeof el.showModal === 'function') el.showModal();
      else el.setAttribute('open', '');
    }
    return () => {
      if (el.open && typeof el.close === 'function') el.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={props.wide ? 'modal wide' : 'modal'}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        props.onClose();
      }}
    >
      <h2 id={titleId}>{props.title}</h2>
      <div className="modal-body">{props.children}</div>
      {props.footer ? <div className="modal-footer">{props.footer}</div> : null}
    </dialog>
  );
}

export function ConfirmDialog(props: {
  title: string;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm(): void;
  onClose(): void;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <Dialog
      title={props.title}
      onClose={props.onClose}
      footer={
        <>
          <button type="button" onClick={props.onClose} autoFocus>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className={props.danger ? 'danger' : 'primary'}
            disabled={props.busy}
            onClick={props.onConfirm}
          >
            {props.confirmLabel}
          </button>
        </>
      }
    >
      {props.children}
    </Dialog>
  );
}

// -- tabs (WAI-ARIA tabs pattern with arrow keys) ----------------------------------------------------------------

export function Tabs(props: {
  label: string;
  tabs: Array<{ id: string; label: string }>;
  active: string;
  onChange(id: string): void;
  children: ReactNode;
}) {
  const base = useId();
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const idx = props.tabs.findIndex((x) => x.id === props.active);
    let next: number;
    if (e.key === 'ArrowRight') next = (idx + 1) % props.tabs.length;
    else if (e.key === 'ArrowLeft') next = (idx - 1 + props.tabs.length) % props.tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = props.tabs.length - 1;
    else return;
    e.preventDefault();
    const target = props.tabs[next];
    if (target) {
      props.onChange(target.id);
      requestAnimationFrame(() => document.getElementById(`${base}-tab-${target.id}`)?.focus());
    }
  };
  return (
    <div className="tabs">
      <div role="tablist" aria-label={props.label} onKeyDown={onKey}>
        {props.tabs.map((tab) => (
          <button
            key={tab.id}
            id={`${base}-tab-${tab.id}`}
            role="tab"
            type="button"
            aria-selected={tab.id === props.active}
            aria-controls={`${base}-panel`}
            tabIndex={tab.id === props.active ? 0 : -1}
            onClick={() => props.onChange(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${base}-panel`}
        aria-labelledby={`${base}-tab-${props.active}`}
        className="tabpanel"
      >
        {props.children}
      </div>
    </div>
  );
}

// -- small widgets -------------------------------------------------------------------------------------

export function CopyButton(props: { text: string; label?: string }) {
  const t = useT();
  const { notify } = useApp();
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void call('app:copy', props.text).then(
          () => {
            setDone(true);
            notify('ok', t('common.copied'));
            setTimeout(() => setDone(false), 1500);
          },
          (e: unknown) => notify('error', e instanceof Error ? e.message : String(e)),
        );
      }}
    >
      {done ? t('common.copied') : (props.label ?? t('common.copy'))}
    </button>
  );
}

export function Field(props: {
  label: string;
  hint?: string;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{props.label}</label>
      {props.children(id)}
      {props.hint ? <small className="muted">{props.hint}</small> : null}
    </div>
  );
}

/**
 * Text an agent (or a project file, or a remote host) wrote, as one line: control, bidi and zero-width
 * characters become visible escapes, newlines become spaces and the text is shortened to `max`
 * characters; the complete text is in the tooltip. Always a React text node, never markup.
 */
export function Safe(props: { text: string; max?: number; className?: string }) {
  const max = props.max ?? 200;
  const short = safeInline(props.text, max);
  const full = safeInline(props.text, 2000);
  return (
    <span
      className={`plain${props.className ? ` ${props.className}` : ''}`}
      title={full !== short ? full : undefined}
    >
      {short}
    </span>
  );
}

/** Texts longer than this (characters or lines) get a keyboard-focusable scroll box. */
const SCROLL_CHARS = 160;
const SCROLL_LINES = 4;

/**
 * Multi-line agent text in a box with a height cap (`.scroll-text`: it scrolls instead of pushing the
 * page, a long text cannot hide the buttons below it). The text is neutralised like `Safe`; once it can
 * overflow, the box is a labelled, focusable group so keyboard users can scroll it.
 */
export function ScrollText(props: {
  text: string;
  label: string;
  className?: string;
  /** Text to show when the value is empty. */
  empty?: string;
  /** Marker shown in front of the text (e.g. a change sign), inside the box. */
  prefix?: ReactNode;
}) {
  const text = safeText(props.text);
  const long = text.length > SCROLL_CHARS || text.split('\n').length > SCROLL_LINES;
  const cls = `plain scroll-text${props.className ? ` ${props.className}` : ''}`;
  if (text === '' && props.empty !== undefined) {
    return (
      <span className="plain">
        {props.prefix}
        {props.empty}
      </span>
    );
  }
  return long ? (
    <div className={cls} role="group" tabIndex={0} aria-label={props.label}>
      {props.prefix}
      {text}
    </div>
  ) : (
    <div className={cls}>
      {props.prefix}
      {text}
    </div>
  );
}

/** Agent-provided text: always plain text (React text node), neutralised, capped in height, visibly labelled, never interpreted. */
export function AgentText(props: { text: string; label: string }) {
  const capId = useId();
  const text = safeText(props.text);
  const long = text.length > SCROLL_CHARS || text.split('\n').length > SCROLL_LINES;
  return (
    <figure className="agent-text">
      <figcaption id={capId}>{props.label}</figcaption>
      <blockquote
        className="plain scroll-text"
        tabIndex={long ? 0 : undefined}
        aria-labelledby={long ? capId : undefined}
      >
        {text || '—'}
      </blockquote>
    </figure>
  );
}

export function ToastRegion() {
  const { toasts, dismissToast } = useApp();
  const t = useT();
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((x) => (
        <div
          key={x.id}
          className={`toast toast-${x.kind}`}
          role={x.kind === 'error' ? 'alert' : 'status'}
        >
          <span className="plain">{x.text}</span>
          <button
            type="button"
            className="linklike"
            onClick={() => dismissToast(x.id)}
            aria-label={t('common.close')}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
