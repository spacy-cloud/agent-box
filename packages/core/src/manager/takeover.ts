import { randomUUID } from 'node:crypto';
import { AboxError } from '../errors.js';
import type { AgentContext } from '../policy/index.js';
import { HUMAN_SESSION_HEARTBEAT_MS } from '../state/human-sessions.js';
import type { SandboxRecord } from '../state/sandbox-registry.js';
import type { Internals } from './internals.js';
import { errMessage } from './util.js';

/**
 * Human takeover of an agent's sandbox (GUI-Konzept, Terminal tab: "Übernimmt der Mensch eine
 * Agentensitzung, wird die Agenteneingabe pausiert und sichtbar markiert").
 *
 * While a human holds an interactive terminal (`attach`) in a sandbox an agent owns, a row in the
 * shared state database marks it. The GUI and the MCP server are separate processes, so the database
 * is the only place both see. The holder refreshes the row every few seconds; a row without a recent
 * heartbeat (the GUI crashed or was killed) counts as gone. Meanwhile the agent's tools that run
 * code or change files in the sandbox answer `conflict` ("paused"); reading tools keep working, so
 * the agent can see what happens. The human's own commands are never blocked.
 */

export interface Takeover {
  /** Ends the marker (idempotent): deletes the row, stops the heartbeat, audits the end. */
  end(info: { exitCode?: number | null; message?: string }): void;
}

/** Does this sandbox belong to an agent (only those can be taken over)? */
export function isAgentOwned(rec: Pick<SandboxRecord, 'owner'>): boolean {
  return rec.owner.startsWith('agent:');
}

/**
 * Marks the sandbox as "human attached" for as long as the returned takeover lives. Returns
 * undefined for sandboxes the human owns (nobody to pause). Never throws: a state file that is
 * busy for a moment must not stop a terminal from opening.
 */
export function beginTakeover(
  I: Internals,
  ctx: AgentContext,
  rec: SandboxRecord,
): Takeover | undefined {
  if (!isAgentOwned(rec)) return undefined;
  const id = randomUUID();
  const started = I.now();
  try {
    I.state.humanSessions.begin({ id, sandboxId: rec.id, actor: ctx.owner, pid: process.pid });
  } catch (e) {
    I.audit('system', 'sandbox.takeover', {
      sandboxId: rec.id,
      decision: 'error',
      details: { message: errMessage(e) },
    });
    return undefined;
  }
  I.audit(ctx.owner, 'sandbox.takeover', {
    sandboxId: rec.id,
    decision: 'info',
    details: { agentOwner: rec.owner, sessionId: id },
  });
  const beat = setInterval(() => {
    try {
      if (!I.state.humanSessions.touch(id)) {
        // The row was pruned during a long stall (suspend): the terminal is still open, mark again.
        I.state.humanSessions.begin({ id, sandboxId: rec.id, actor: ctx.owner, pid: process.pid });
      }
    } catch {
      /* busy state file: the next beat retries; the row survives a few missed beats */
    }
  }, HUMAN_SESSION_HEARTBEAT_MS);
  beat.unref();
  let ended = false;
  const release = (info?: { exitCode?: number | null; message?: string }): void => {
    if (ended) return;
    ended = true;
    clearInterval(beat);
    I.takeovers.delete(release);
    try {
      I.state.humanSessions.end(id);
    } catch {
      /* the row expires on its own */
    }
    // Without `info` the manager is closing (GUI quit): the marker is dropped so the agent may
    // continue, and the database is about to close.
    if (!info || I.closed) return;
    I.audit(ctx.owner, 'sandbox.takeover.end', {
      sandboxId: rec.id,
      decision: 'info',
      details: {
        sessionId: id,
        durationMs: I.now() - started,
        exitCode: info.exitCode ?? null,
        ...(info.message ? { message: info.message } : {}),
      },
    });
  };
  I.takeovers.add(release);
  return { end: (info) => release(info) };
}

/**
 * Agents only: refuses (`conflict`, "paused") while a human holds a terminal in the sandbox.
 * Audited once per burst so a retrying agent does not flood the log.
 */
export function requireNotTakenOver(
  I: Internals,
  ctx: AgentContext,
  rec: SandboxRecord,
  action: string,
): void {
  if (ctx.kind !== 'agent') return;
  let live;
  try {
    live = I.state.humanSessions.active(rec.id);
  } catch {
    return; // cannot read the marker: do not block the agent on a busy state file
  }
  const first = live[0];
  if (!first) return;
  if (I.firstWithin(`takeover|${ctx.owner}|${rec.id}`, 10_000)) {
    I.audit(ctx.owner, action, {
      sandboxId: rec.id,
      decision: 'deny',
      details: { reason: 'human_attached', sessions: live.length, since: first.startedAt },
    });
  }
  throw new AboxError('conflict', `paused: a human is working in sandbox ${rec.id}`, {
    hint: 'A person has taken over this sandbox in a terminal. Stop sending commands, tell the user you are waiting, and retry later (reading files and logs still works).',
    details: { reason: 'human_attached', sessions: live.length, since: first.startedAt },
  });
}
