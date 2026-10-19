/**
 * What gets a desktop notification, when and with which words. Pure decision logic: the platform part (the
 * Electron `Notification`) is behind the `NotificationSink` interface, so it can be tested without a desktop.
 *
 * Rules:
 * - Three kinds (`NOTIFICATION_KINDS`), each switched on or off in Settings. A kind that is off sends nothing,
 *   also not what was queued before it was switched off.
 * - Bursts are merged: items of one kind that arrive within `mergeMs` become ONE notification ("3 new approval
 *   requests"), and one kind never shows more than one notification per `minGapMs`; what arrives in between
 *   is merged into the next one. An agent that files requests in a loop can not flood the desktop.
 * - A notification never decides anything. Approving is a human decision made in the Approvals view, which
 *   shows the exact request and goes through the same manager call (`approve` as `human`) as every other
 *   approval. Electron supports notification buttons on macOS only, and a button without the request's
 *   options (the digest the approval is bound to) would approve blind, so a click only opens the right view.
 * - The text carries what a human needs to decide whether to look right now (who asks, what kind, which
 *   template / sandbox / port), never the agent's free text, a command, environment or file content. Names
 *   an agent can influence are made safe and cut short.
 */
import type { ApprovalView } from '@abox/core';
import { kindLabelKey, portRequest, requestTemplateName } from '../shared/approval-diff';
import { formatDuration, safeInline } from '../shared/format';
import type { Locale, NotificationKind, NotificationPrefs } from '../shared/ipc';
import { mt } from './i18n';

/** Where a click on a notification leads. */
export type NotificationTarget =
  | { view: 'approvals'; approvalId?: string }
  | { view: 'detail'; sandboxId: string }
  | { view: 'sandboxes' };

export interface NotificationSpec {
  kind: NotificationKind;
  title: string;
  body: string;
  target: NotificationTarget;
}

/** The platform end: shows one notification and calls `onClick` when the user clicks it. */
export interface NotificationSink {
  show(spec: NotificationSpec, onClick: () => void): void;
}

export interface ExpiringSandbox {
  id: string;
  name: string;
  /** Epoch ms. */
  expiresAt: number;
}

export interface FailedCreate {
  sandboxId?: string;
  /** Who tried to create it: `human` or `agent:<context>`. */
  actor: string;
  template?: string;
  /** Error code of the failure (an `ERROR_CODES` value), never the message. */
  code?: string;
}

export interface NotifierDeps {
  sink: NotificationSink;
  prefs(): NotificationPrefs;
  locale(): Locale;
  /** A click on a notification. */
  open(target: NotificationTarget): void;
  /** Items of one kind arriving within this time become one notification. */
  mergeMs?: number;
  /** At least this long between two notifications of one kind. */
  minGapMs?: number;
  now?(): number;
}

const MAX_LINES = 3;

export const DEFAULT_MERGE_MS = 1500;
export const DEFAULT_MIN_GAP_MS = 10_000;

export class Notifier {
  private readonly approvals = new Map<string, ApprovalView>();
  private readonly expiring = new Map<string, ExpiringSandbox>();
  private failed: FailedCreate[] = [];
  private readonly timers = new Map<NotificationKind, NodeJS.Timeout>();
  private readonly lastShown = new Map<NotificationKind, number>();

  constructor(private readonly d: NotifierDeps) {}

  /** New pending approval requests (the caller passes only ones it has not reported before). */
  approvalsArrived(fresh: readonly ApprovalView[]): void {
    if (!this.d.prefs().approvals) return;
    for (const a of fresh) if (a.status === 'pending') this.approvals.set(a.id, a);
    if (this.approvals.size > 0) this.schedule('approvals');
  }

  /** The request was decided or expired before the notification was shown: it no longer needs a look. */
  approvalsSettled(pendingIds: ReadonlySet<string>): void {
    for (const id of this.approvals.keys()) if (!pendingIds.has(id)) this.approvals.delete(id);
  }

  sandboxesExpiring(list: readonly ExpiringSandbox[]): void {
    if (!this.d.prefs().expiring) return;
    for (const s of list) this.expiring.set(s.id, s);
    if (this.expiring.size > 0) this.schedule('expiring');
  }

  /**
   * Creations that failed after the sandbox was set up. What a human started themselves is left out: the CLI
   * or the window that started it already shows the error; this is for agents working in the background.
   */
  createsFailed(list: readonly FailedCreate[]): void {
    if (!this.d.prefs().failed) return;
    this.failed.push(...list.filter((f) => f.actor !== 'human'));
    if (this.failed.length > 0) this.schedule('failed');
  }

  /** Drops everything queued (shutdown). */
  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.approvals.clear();
    this.expiring.clear();
    this.failed = [];
  }

  private schedule(kind: NotificationKind): void {
    if (this.timers.has(kind)) return;
    const now = this.now();
    const last = this.lastShown.get(kind);
    const wait = Math.max(
      this.d.mergeMs ?? DEFAULT_MERGE_MS,
      last === undefined ? 0 : last + (this.d.minGapMs ?? DEFAULT_MIN_GAP_MS) - now,
    );
    const timer = setTimeout(() => this.flush(kind), wait);
    timer.unref();
    this.timers.set(kind, timer);
  }

  private flush(kind: NotificationKind): void {
    this.timers.delete(kind);
    const spec = this.build(kind);
    if (!spec) return;
    this.lastShown.set(kind, this.now());
    try {
      this.d.sink.show(spec, () => this.d.open(spec.target));
    } catch {
      /* no notification service: the tray and the window still show it */
    }
  }

  /** Takes the queue of `kind` and turns it into one notification; null when it is off or empty. */
  private build(kind: NotificationKind): NotificationSpec | null {
    const on = this.d.prefs()[kind];
    const locale = this.d.locale();
    switch (kind) {
      case 'approvals': {
        const items = [...this.approvals.values()];
        this.approvals.clear();
        return on && items.length > 0 ? approvalsSpec(locale, items) : null;
      }
      case 'expiring': {
        const items = [...this.expiring.values()];
        this.expiring.clear();
        return on && items.length > 0 ? expiringSpec(locale, items, this.now()) : null;
      }
      case 'failed': {
        const items = this.failed;
        this.failed = [];
        return on && items.length > 0 ? failedSpec(locale, items) : null;
      }
    }
  }

  private now(): number {
    return (this.d.now ?? Date.now)();
  }
}

// -- texts -------------------------------------------------------------------------------------------------

/** `agent:ci` becomes `ci`; always safe for one line and short. */
function agentName(actor: string): string {
  return safeInline(actor.replace(/^agent:/, ''), 40);
}

function kindLabel(locale: Locale, a: Pick<ApprovalView, 'kind' | 'request'>): string {
  const key = kindLabelKey(a.kind, a.request);
  return key === 'approvals.kind.unknown'
    ? mt(locale, key, { kind: safeInline(a.kind, 30) })
    : mt(locale, key);
}

/**
 * What the request is about, from fields the manager computed or bound into the request: the port of a forward,
 * the template or the sandbox. Not the agent's reason, not a command.
 */
export function approvalSubject(locale: Locale, a: ApprovalView): string {
  const port = portRequest(a.request);
  if (port) {
    return safeInline(
      mt(locale, 'approvals.port.queue', {
        port: port.sandboxPort,
        sandbox: safeInline(a.sandboxId ?? '', 40),
      }),
      70,
    );
  }
  return safeInline(requestTemplateName(a.request) ?? a.sandboxId ?? '', 50);
}

function approvalLine(locale: Locale, a: ApprovalView): string {
  const subject = approvalSubject(locale, a);
  const head = `${agentName(a.requester)} · ${kindLabel(locale, a)}`;
  return subject ? `${head} · ${subject}` : head;
}

function approvalsSpec(locale: Locale, items: ApprovalView[]): NotificationSpec {
  const one = items.length === 1 ? items[0]! : undefined;
  const lines = items.slice(0, MAX_LINES).map((a) => approvalLine(locale, a));
  if (items.length > MAX_LINES) {
    lines.push(mt(locale, 'main.notification.more', { count: items.length - MAX_LINES }));
  }
  lines.push(mt(locale, 'main.notification.approvals.hint'));
  return {
    kind: 'approvals',
    title: mt(
      locale,
      one ? 'main.notification.approvals.one' : 'main.notification.approvals.many',
      {
        count: items.length,
      },
    ),
    body: lines.join('\n'),
    target: one ? { view: 'approvals', approvalId: one.id } : { view: 'approvals' },
  };
}

function expiringSpec(locale: Locale, items: ExpiringSandbox[], now: number): NotificationSpec {
  const one = items.length === 1 ? items[0]! : undefined;
  const line = (s: ExpiringSandbox) =>
    mt(locale, 'main.notification.expiring.line', {
      name: safeInline(s.name || s.id, 40),
      time: formatDuration(s.expiresAt - now),
    });
  const lines = items.slice(0, MAX_LINES).map(line);
  if (items.length > MAX_LINES) {
    lines.push(mt(locale, 'main.notification.more', { count: items.length - MAX_LINES }));
  }
  lines.push(mt(locale, 'main.notification.expiring.hint'));
  return {
    kind: 'expiring',
    title: mt(locale, one ? 'main.notification.expiring.one' : 'main.notification.expiring.many', {
      count: items.length,
    }),
    body: lines.join('\n'),
    target: one ? { view: 'detail', sandboxId: one.id } : { view: 'sandboxes' },
  };
}

function failedSpec(locale: Locale, items: FailedCreate[]): NotificationSpec {
  const one = items.length === 1 ? items[0]! : undefined;
  const line = (f: FailedCreate) =>
    [
      agentName(f.actor),
      f.template ? safeInline(f.template, 40) : '',
      f.code ? safeInline(f.code, 30) : '',
    ]
      .filter((p) => p !== '')
      .join(' · ');
  const lines = items.slice(0, MAX_LINES).map(line);
  if (items.length > MAX_LINES) {
    lines.push(mt(locale, 'main.notification.more', { count: items.length - MAX_LINES }));
  }
  lines.push(mt(locale, 'main.notification.failed.hint'));
  return {
    kind: 'failed',
    title: mt(locale, one ? 'main.notification.failed.one' : 'main.notification.failed.many', {
      count: items.length,
    }),
    body: lines.join('\n'),
    target: one?.sandboxId ? { view: 'detail', sandboxId: one.sandboxId } : { view: 'sandboxes' },
  };
}
