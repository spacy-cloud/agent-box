import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { call } from '../api';
import { useApp } from '../context';
import type { TtyDataEvent, TtyExitEvent } from '../../shared/constants';
import type { IpcError } from '../../shared/ipc';
import { ErrorBox } from './ui';

export type TerminalTarget = { kind: 'sandbox'; id: string } | { kind: 'ssh'; host: string };

export type TerminalState =
  | { kind: 'connecting' }
  | { kind: 'open' }
  | { kind: 'ended'; code: number | null; reason?: string }
  | { kind: 'error'; error: unknown };

const THEME = {
  background: '#0d1117',
  foreground: '#e6edf3',
  cursor: '#e6edf3',
  selectionBackground: '#264f78',
};

/**
 * One terminal bound to one session in the main process.
 *
 * - Output arrives as bytes and goes into the emulator only (no HTML, no links, no clipboard access).
 * - The session is closed when this component unmounts (tab switch, window close).
 * - After the process ended a "Reconnect" button opens a fresh session.
 * - Shift+Esc leaves the terminal (keyboard users must not get trapped in it).
 */
export function TerminalPane(props: {
  target: TerminalTarget;
  /** False while hidden (display: none): no fitting, no resize messages. */
  visible?: boolean;
  /** Border / header colour; the label next to it says what the terminal is. */
  accent?: string;
  title: string;
  /** Short text before the title, e.g. "SSH" or "Sandbox". Never colour alone. */
  kindLabel: string;
  subtitle?: string;
  onState?(s: TerminalState): void;
}) {
  const { t } = useApp();
  const { target, visible = true, onState } = props;
  const targetKey = JSON.stringify(target);
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<string | null>(null);
  const sizeRef = useRef({ cols: 0, rows: 0 });
  const reconnectRef = useRef<HTMLButtonElement>(null);
  const hintRef = useRef<HTMLParagraphElement>(null);
  const [state, setState] = useState<TerminalState>({ kind: 'connecting' });
  const [attempt, setAttempt] = useState(0);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const tRef = useRef(t);
  tRef.current = t;

  const update = useCallback(
    (s: TerminalState) => {
      setState(s);
      onState?.(s);
    },
    [onState],
  );

  const fitAndReport = useCallback(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    const host = hostRef.current;
    if (!term || !fit || !host || !visibleRef.current) return;
    if (host.clientWidth < 20 || host.clientHeight < 20) return;
    try {
      fit.fit();
    } catch {
      return;
    }
    const { cols, rows } = term;
    if (cols === sizeRef.current.cols && rows === sizeRef.current.rows) return;
    sizeRef.current = { cols, rows };
    const id = sessionRef.current;
    if (id) void call('tty:resize', { sessionId: id, cols, rows }).catch(() => undefined);
  }, []);

  // The emulator lives as long as the component.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      cursorBlink: true,
      scrollback: 5000,
      fontFamily: "ui-monospace, 'JetBrains Mono', 'DejaVu Sans Mono', Menlo, monospace",
      fontSize: 13,
      theme: THEME,
      allowProposedApi: false,
      // Links in terminal output are never made clickable: output is data, not navigation.
      linkHandler: null,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    term.textarea?.setAttribute('aria-label', tRef.current('terminal.input'));
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown') return true;
      if (ev.key === 'Escape' && ev.shiftKey) {
        hintRef.current?.focus();
        return false;
      }
      if (ev.key === 'C' && ev.ctrlKey && ev.shiftKey) {
        const sel = term.getSelection();
        if (sel) void call('app:copy', sel.slice(0, 20_000)).catch(() => undefined);
        return false;
      }
      return true;
    });
    termRef.current = term;
    fitRef.current = fit;
    const sub = term.onData((data) => {
      const id = sessionRef.current;
      if (id) void call('tty:input', { sessionId: id, data }).catch(() => undefined);
    });
    const ro = new ResizeObserver(() => fitAndReport());
    ro.observe(host);
    fitAndReport();
    return () => {
      ro.disconnect();
      sub.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [fitAndReport]);

  useEffect(() => {
    if (visible) requestAnimationFrame(fitAndReport);
  }, [visible, fitAndReport]);

  // One session per attempt.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    let cancelled = false;
    let id: string | null = null;
    const buffered: Array<TtyDataEvent | TtyExitEvent> = [];
    sessionRef.current = null;
    sizeRef.current = { cols: 0, rows: 0 };
    update({ kind: 'connecting' });

    const handle = (ev: TtyDataEvent | TtyExitEvent): void => {
      if (cancelled) return;
      if ('data' in ev) {
        term.write(ev.data);
        return;
      }
      sessionRef.current = null;
      id = null;
      term.write(
        `\r\n\x1b[2m[${tRef.current('terminal.ended', { code: ev.code ?? '-' })}]\x1b[0m\r\n`,
      );
      update({ kind: 'ended', code: ev.code, ...(ev.reason ? { reason: ev.reason } : {}) });
    };
    const onEvent = (ev: TtyDataEvent | TtyExitEvent): void => {
      if (id === null) {
        buffered.push(ev); // events can overtake the answer of tty:open
        return;
      }
      if (ev.sessionId === id) handle(ev);
    };
    const offData = window.abox.on('evt:tty-data', onEvent);
    const offExit = window.abox.on('evt:tty-exit', onEvent);

    requestAnimationFrame(() => {
      if (cancelled) return;
      fitRef.current?.fit();
      const cols = Math.max(term.cols, 2);
      const rows = Math.max(term.rows, 2);
      sizeRef.current = { cols, rows };
      call('tty:open', { ...target, cols, rows }).then(
        (res) => {
          if (cancelled) {
            void call('tty:close', { sessionId: res.sessionId }).catch(() => undefined);
            return;
          }
          id = res.sessionId;
          sessionRef.current = id;
          update({ kind: 'open' });
          for (const ev of buffered.splice(0)) if (ev.sessionId === id) handle(ev);
          if (visibleRef.current) term.focus();
          fitAndReport();
        },
        (e: unknown) => {
          if (cancelled) return;
          update({ kind: 'error', error: e });
        },
      );
    });

    return () => {
      cancelled = true;
      offData();
      offExit();
      const open = sessionRef.current;
      sessionRef.current = null;
      if (open) void call('tty:close', { sessionId: open }).catch(() => undefined);
    };
    // The target is part of the key; `update` is stable per prop identity.
  }, [attempt, targetKey, fitAndReport]);

  // The process ended: the terminal takes no more input, so focus moves to "Reconnect".
  useEffect(() => {
    if (state.kind === 'ended') reconnectRef.current?.focus();
  }, [state.kind]);

  const reconnect = (): void => {
    termRef.current?.write('\r\n');
    setAttempt((n) => n + 1);
  };

  const live = state.kind === 'open' || state.kind === 'connecting';
  return (
    <div
      className="term"
      data-kind={props.target.kind}
      style={props.accent ? ({ '--term-accent': props.accent } as CSSProperties) : undefined}
    >
      <div className="term-head">
        <span className="term-kind">{props.kindLabel}</span>
        <strong className="plain">{props.title}</strong>
        {props.subtitle ? <span className="plain term-sub">{props.subtitle}</span> : null}
        <span className="term-status" role="status">
          {state.kind === 'connecting' ? t('terminal.connecting') : null}
          {state.kind === 'open' ? t('terminal.connected') : null}
          {state.kind === 'ended' ? t('terminal.endedShort') : null}
          {state.kind === 'error' ? t('terminal.failed') : null}
        </span>
        <div className="term-tools">
          <button
            type="button"
            ref={reconnectRef}
            onClick={reconnect}
            disabled={live}
            className={live ? '' : 'primary'}
          >
            {t('terminal.reconnect')}
          </button>
        </div>
      </div>
      {state.kind === 'error' ? <ErrorBox error={state.error as IpcError} /> : null}
      <div
        className="term-screen"
        ref={hostRef}
        role="group"
        aria-label={t('terminal.label', { title: props.title })}
      />
      <p className="muted small term-hint" ref={hintRef} tabIndex={-1}>
        {t('terminal.hint')}
      </p>
    </div>
  );
}

/** Stable colour per host id so a server terminal never looks like a local one (label text says it too). */
export function hostColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 65% 28%)`;
}
