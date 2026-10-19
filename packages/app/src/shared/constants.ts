/**
 * Constants, event payloads and the error class shared by main, preload and renderer (no Zod: the renderer bundle stays small).
 * The complete IPC surface between renderer and main process.
 *
 * Every request channel has a Zod schema for its input; the main process validates every call
 * against it (`safeParse`, strict objects) before any manager method is invoked. The renderer
 * can only reach channels listed here (the preload script exposes `invoke` for exactly these names).
 *
 * The GUI contains no business logic: each channel maps to one manager (`Abox`) operation, called as
 * the context `human`. Policy, approvals, audit and secret masking stay in `@abox/core`.
 */
import { EVENT_CHANNELS } from './channels';

// Keep in sync with @abox/core (a unit test compares them): the renderer must not import core at runtime.
export const SANDBOX_STATES = [
  'requested',
  'preparing',
  'created',
  'running',
  'stopped',
  'failed',
  'expired',
  'removed',
] as const;
export const ISOLATION_LEVELS = ['none', 'container', 'hardened', 'vm'] as const;
export const NETWORK_MODES = ['none', 'allowlist', 'open'] as const;
export const WORKSPACE_MODES = ['mount', 'clone', 'worktree', 'copy', 'empty', 'sync'] as const;
export const AUDIT_DECISIONS = [
  'allow',
  'deny',
  'approval',
  'approved',
  'denied',
  'error',
  'info',
] as const;
export const APPROVAL_MODES = ['strict', 'medium', 'open'] as const;
export const APPROVAL_STATUSES = ['pending', 'approved', 'denied', 'expired'] as const;
export const EXPORT_FORMATS = ['diff', 'patch', 'branch'] as const;
export const ACTIVITY_KINDS = ['exec', 'file', 'network', 'approval', 'lifecycle'] as const;
export const LOCALES = ['de', 'en'] as const;
export const HOST_ZONES = ['workstation', 'lab', 'shared', 'restricted'] as const;
export const HOST_BACKENDS = ['docker', 'podman', 'process', 'vm'] as const;
export const FORWARD_KINDS = ['local', 'remote', 'dynamic'] as const;
export const TEMPLATE_BACKENDS = ['docker', 'podman', 'process', 'python', 'vm'] as const;
export const TEMPLATE_SOURCES = ['builtin', 'user', 'project'] as const;
/** Port forwards of a sandbox (keep in sync with @abox/core: a unit test compares them). */
export const PORT_FORWARD_MIN_HOST_PORT = 1024;
export const PORT_FORWARD_MAX_PORT = 65_535;
/** The only address a forward is bound to; the preview is only ever opened there. */
export const PORT_FORWARD_HOST_ADDRESS = '127.0.0.1';
export const TTY_MAX_COLS = 500;
export const TTY_MAX_ROWS = 300;
export const TTY_MAX_INPUT = 65_536;
export type Locale = (typeof LOCALES)[number];
/** Kinds of desktop notification the user can switch on and off (Settings). */
export const NOTIFICATION_KINDS = ['approvals', 'expiring', 'failed'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
export type NotificationPrefs = Record<NotificationKind, boolean>;
/** All kinds are on until the user turns one off. */
export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  approvals: true,
  expiring: true,
  failed: true,
};
export const VIEWS = [
  'overview',
  'sandboxes',
  'templates',
  'hosts',
  'approvals',
  'audit',
  'policy',
  'settings',
  'detail',
] as const;
export type ViewName = (typeof VIEWS)[number];

export { EVENT_CHANNELS };
export type EventChannel = (typeof EVENT_CHANNELS)[number];

/** Events pushed from main to renderer (no input from the renderer, so no schemas needed). */

export interface ChangedEvent {
  /** Monotonic counter: the renderer refetches whatever it shows when this changes. */
  tick: number;
  pendingApprovals: number;
  /** Why (for tests/diagnostics): `poll` (other process), `event` (this process), `local`. */
  source: 'poll' | 'event' | 'local';
}
export interface ProgressEvent {
  key: string;
  line: string;
  /** Workspace scan / copy lines: which step, and the bytes behind the line (a bar when `total` is known). */
  phase?: 'scan' | 'copy' | 'baseline' | 'deliver';
  done?: number;
  total?: number;
}
export interface NavigateEvent {
  view: ViewName;
  approvalId?: string;
  /** `detail` view: the sandbox to open. */
  sandboxId?: string;
}
/** Terminal output. Always bytes, always treated as data by the renderer (never as markup or commands). */
export interface TtyDataEvent {
  sessionId: string;
  data: Uint8Array;
}
export interface TtyExitEvent {
  sessionId: string;
  /** Exit code of the shell / ssh process; `null` when it was killed or is unknown. */
  code: number | null;
  /** Set when the session ended because of an error on abox's side. */
  reason?: string;
}
/** A passphrase / PIN prompt of an ssh session, to be answered in a dialog (`askpass:answer`). */
export interface AskpassEvent {
  id: string;
  /** Label of the ssh session (`user@host:port`). */
  session: string;
  /** The prompt text as ssh printed it. May come from the server: shown as neutralised text. */
  prompt: string;
  /** `secret`: input expected; `confirm`: yes / no; `info`: a notice (touch the key); `refused`: not relayed. */
  mode: 'secret' | 'confirm' | 'info' | 'refused';
}
/** The prompt with this id is gone (answered elsewhere, ssh stopped waiting, window reloaded). */
export interface AskpassEndEvent {
  id: string;
}
export interface EventPayloads {
  'evt:changed': ChangedEvent;
  'evt:progress': ProgressEvent;
  'evt:navigate': NavigateEvent;
  'evt:tty-data': TtyDataEvent;
  'evt:tty-exit': TtyExitEvent;
  'evt:askpass': AskpassEvent;
  'evt:askpass-end': AskpassEndEvent;
}

/** Errors cross the boundary as plain data. */
export interface IpcErrorData {
  code: string;
  message: string;
  hint?: string;
  issues?: Array<{ path?: string; message: string }>;
  details?: unknown;
}
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: IpcErrorData };

export class IpcError extends Error {
  readonly code: string;
  readonly hint: string | undefined;
  readonly issues: IpcErrorData['issues'];
  readonly details: unknown;
  constructor(e: IpcErrorData) {
    super(e.message);
    this.name = 'IpcError';
    this.code = e.code;
    this.hint = e.hint;
    this.issues = e.issues;
    this.details = e.details;
  }
}
