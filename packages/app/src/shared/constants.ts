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
export const APPROVAL_STATUSES = ['pending', 'approved', 'denied', 'expired'] as const;
export const EXPORT_FORMATS = ['diff', 'patch', 'branch'] as const;
export const LOCALES = ['de', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const VIEWS = ['sandboxes', 'approvals', 'audit', 'policy', 'settings', 'detail'] as const;
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
}
export interface NavigateEvent {
  view: ViewName;
  approvalId?: string;
}
export interface EventPayloads {
  'evt:changed': ChangedEvent;
  'evt:progress': ProgressEvent;
  'evt:navigate': NavigateEvent;
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
