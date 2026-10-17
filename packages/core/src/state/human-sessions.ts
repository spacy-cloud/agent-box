import type { RepoContext } from './db.js';
import { num } from './json.js';
import type { Row } from './json.js';

/** Milliseconds a takeover row stays alive without a heartbeat (a crashed process cannot clear its own rows). */
export const HUMAN_SESSION_TTL_MS = 20_000;
/** How often a live holder refreshes its row; well below the TTL. */
export const HUMAN_SESSION_HEARTBEAT_MS = 5_000;

/** An interactive terminal a human holds in a sandbox. */
export interface HumanSessionRecord {
  id: string;
  sandboxId: string;
  actor: string;
  /** Process that holds the terminal (the GUI or CLI), for diagnostics. */
  pid: number;
  startedAt: number;
  heartbeatAt: number;
}

function toSession(r: Row): HumanSessionRecord {
  return {
    id: r['id'] as string,
    sandboxId: r['sandbox_id'] as string,
    actor: r['actor'] as string,
    pid: num(r['pid']),
    startedAt: num(r['started_at']),
    heartbeatAt: num(r['heartbeat_at']),
  };
}

/**
 * Takeover marker: while a human terminal is attached to a sandbox, other processes (the MCP server
 * of an agent) see a live row here and pause exec. Rows carry a heartbeat; a row older than
 * `HUMAN_SESSION_TTL_MS` is dead (crashed holder) and ignored / pruned.
 */
export class HumanSessions {
  private readonly ctx: RepoContext;

  constructor(ctx: RepoContext) {
    this.ctx = ctx;
  }

  begin(input: { id: string; sandboxId: string; actor: string; pid: number }): HumanSessionRecord {
    const now = this.ctx.now();
    this.ctx.db
      .prepare(
        `INSERT INTO human_sessions (id, sandbox_id, actor, pid, started_at, heartbeat_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(input.id, input.sandboxId, input.actor, input.pid, now, now);
    return this.get(input.id)!;
  }

  get(id: string): HumanSessionRecord | undefined {
    const row = this.ctx.db.prepare('SELECT * FROM human_sessions WHERE id = ?').get(id);
    return row ? toSession(row) : undefined;
  }

  /** Refresh the heartbeat; false when the row is gone (pruned after a long stall). */
  touch(id: string): boolean {
    const res = this.ctx.db
      .prepare('UPDATE human_sessions SET heartbeat_at = ? WHERE id = ?')
      .run(this.ctx.now(), id);
    return num(res.changes) > 0;
  }

  end(id: string): boolean {
    return num(this.ctx.db.prepare('DELETE FROM human_sessions WHERE id = ?').run(id).changes) > 0;
  }

  /** Live (recent heartbeat) sessions of a sandbox, oldest first. */
  active(sandboxId: string): HumanSessionRecord[] {
    return this.ctx.db
      .prepare(
        `SELECT * FROM human_sessions WHERE sandbox_id = ? AND heartbeat_at > ?
         ORDER BY started_at, id`,
      )
      .all(sandboxId, this.ctx.now() - HUMAN_SESSION_TTL_MS)
      .map(toSession);
  }

  /** Sandbox ids that currently have at least one live session. */
  activeSandboxIds(): Set<string> {
    const rows = this.ctx.db
      .prepare('SELECT DISTINCT sandbox_id FROM human_sessions WHERE heartbeat_at > ?')
      .all(this.ctx.now() - HUMAN_SESSION_TTL_MS);
    return new Set(rows.map((r) => r['sandbox_id'] as string));
  }

  /** Delete dead rows (holder crashed). Returns how many. */
  prune(): number {
    return num(
      this.ctx.db
        .prepare('DELETE FROM human_sessions WHERE heartbeat_at <= ?')
        .run(this.ctx.now() - HUMAN_SESSION_TTL_MS).changes,
    );
  }

  /** Forget all sessions of a sandbox (it was removed). */
  deleteAll(sandboxId: string): number {
    return num(
      this.ctx.db.prepare('DELETE FROM human_sessions WHERE sandbox_id = ?').run(sandboxId).changes,
    );
  }
}
