/**
 * Keeps the GUI in sync with changes made by other processes (CLI, MCP server): the SQLite state is shared,
 * but `Abox.onEvent` is in-process only, so this polls cheaply (pending approvals + newest audit sequence)
 * and also reacts to in-process events. Drives the tray badge and notifications via callbacks.
 */
import type { Abox, ApprovalView, AuditEntry } from '@abox/core';
import type { ChangedEvent } from '../shared/ipc';

export interface MonitorDeps {
  abox: Abox;
  intervalMs: number;
  onChanged(ev: ChangedEvent): void;
  /** Called with all pending approvals when the set changed; `fresh` = ids not seen by an earlier poll. */
  onApprovals(pending: ApprovalView[], fresh: ApprovalView[]): void;
  /** Sandbox creations that failed since the last poll (audit `sandbox.create` with decision `error`); not called for what failed before the GUI started. */
  onCreateFailed?(entries: AuditEntry[]): void;
}

/** Audit actions that record a creation that went wrong after the sandbox was set up (a policy denial is not one). */
export const CREATE_FAILED_ACTIONS = ['sandbox.create', 'sandbox.create_interrupted'];

export class Monitor {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private fingerprint = '';
  private lastSeq: number | undefined;
  private seen = new Set<string>();
  private tick = 0;
  private off: (() => void) | undefined;
  private debounce: NodeJS.Timeout | undefined;

  constructor(private readonly d: MonitorDeps) {}

  start(): void {
    this.off = this.d.abox.onEvent(() => this.poke('event'));
    this.timer = setInterval(() => void this.poll('poll'), this.d.intervalMs);
    void this.poll('poll');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    this.off?.();
    this.timer = undefined;
    this.off = undefined;
  }

  /** The GUI itself changed something: refresh immediately. */
  poke(source: ChangedEvent['source'] = 'local'): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.poll(source, true), 50);
  }

  async poll(source: ChangedEvent['source'], force = false): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const human = { contextId: 'human' };
      // Undecided requests past their deadline count as denied; flip them so the queue stays honest.
      await this.d.abox.expireApprovals(human).catch(() => undefined);
      const [pending, last] = await Promise.all([
        this.d.abox.listApprovals(human, { status: 'pending' }),
        this.d.abox.queryAudit(human, { limit: 1, order: 'desc' }),
      ]);
      const seq = last[0]?.seq ?? 0;
      const fp = `${pending.map((p) => p.id).join(',')}|${seq}`;
      // Failed creations since the last poll. A failing query aborts the poll before `lastSeq` moves on, so the next poll retries.
      const prevSeq = this.lastSeq;
      const failed =
        this.d.onCreateFailed && prevSeq !== undefined && seq > prevSeq
          ? await this.d.abox.queryAudit(human, {
              afterSeq: prevSeq,
              action: CREATE_FAILED_ACTIONS,
              decision: 'error',
              order: 'asc',
              limit: 50,
            })
          : [];
      this.lastSeq = seq;
      const fresh = pending.filter((p) => !this.seen.has(p.id));
      const approvalsChanged =
        fresh.length > 0 || this.fingerprint.split('|')[0] !== fp.split('|')[0];
      if (fp !== this.fingerprint || force) {
        const first = this.fingerprint === '';
        this.fingerprint = fp;
        this.tick++;
        this.d.onChanged({ tick: this.tick, pendingApprovals: pending.length, source });
        if (approvalsChanged || first) this.d.onApprovals(pending, fresh);
        for (const p of pending) this.seen.add(p.id);
        if (failed.length > 0) this.d.onCreateFailed?.(failed);
      }
    } catch {
      // The state may be briefly busy (another process holds a write lock); the next poll retries.
    } finally {
      this.running = false;
    }
  }

  get lastTick(): number {
    return this.tick;
  }
}
