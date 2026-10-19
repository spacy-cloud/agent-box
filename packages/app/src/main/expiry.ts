/**
 * Finds sandboxes that expire soon, for the "about to expire" notification. The manager enforces the lifetime on
 * its own (`startTtlWatcher`); this only warns in time so the human can extend the sandbox. A sandbox is reported
 * once per expiry time: extending it re-arms the warning for the new time.
 */
import type { ExpiringSandbox } from './notifier';

/** The part of a sandbox this needs. */
export interface ExpiryCandidate {
  id: string;
  name: string;
  state: string;
  /** Epoch ms. */
  expiresAt: number;
}

export interface ExpiryDeps {
  /** The sandboxes to look at (the manager's list; the lookup asks the container engines, so it is not done often). */
  list(): Promise<ExpiryCandidate[]>;
  /** False while the notification kind is off: nothing is looked up then. */
  enabled(): boolean;
  onExpiring(list: ExpiringSandbox[]): void;
  /** How long before the expiry to warn. */
  warnMs: number;
  intervalMs: number;
  now?(): number;
}

/** Sandboxes in these states have work that stops with the lifetime. */
const ACTIVE_STATES = new Set(['created', 'running']);

export const DEFAULT_EXPIRY_WARN_MS = 10 * 60_000;
export const DEFAULT_EXPIRY_CHECK_MS = 30_000;

export class ExpiryWatcher {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private readonly reported = new Set<string>();

  constructor(private readonly d: ExpiryDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.check(), this.d.intervalMs);
    this.timer.unref();
    void this.check();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async check(): Promise<void> {
    if (this.running || !this.d.enabled()) return;
    this.running = true;
    try {
      const now = (this.d.now ?? Date.now)();
      const list = await this.d.list();
      const live = new Set<string>();
      const soon: ExpiringSandbox[] = [];
      for (const s of list) {
        if (!ACTIVE_STATES.has(s.state)) continue;
        const key = `${s.id}@${s.expiresAt}`;
        live.add(key);
        const left = s.expiresAt - now;
        if (left <= 0 || left > this.d.warnMs || this.reported.has(key)) continue;
        this.reported.add(key);
        soon.push({ id: s.id, name: s.name, expiresAt: s.expiresAt });
      }
      // forget sandboxes that are gone or were extended
      for (const key of this.reported) if (!live.has(key)) this.reported.delete(key);
      if (soon.length > 0) this.d.onExpiring(soon);
    } catch {
      // The engine or the state is busy or unreachable; the next check retries.
    } finally {
      this.running = false;
    }
  }
}
