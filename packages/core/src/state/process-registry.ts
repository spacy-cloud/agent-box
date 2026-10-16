import { AboxError } from '../errors.js';
import type { RepoContext } from './db.js';
import { num, numOrNull } from './json.js';
import type { Row } from './json.js';

export type ProcessStatus = 'running' | 'exited' | 'failed' | 'killed' | 'lost';

/** A background process started inside a sandbox. */
export interface ProcessRecord {
  id: string;
  sandboxId: string;
  command: string;
  logPath: string;
  pidInSandbox: number | null;
  status: ProcessStatus;
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
}

function toProcess(r: Row): ProcessRecord {
  return {
    id: r['id'] as string,
    sandboxId: r['sandbox_id'] as string,
    command: r['command'] as string,
    logPath: r['log_path'] as string,
    pidInSandbox: numOrNull(r['pid_in_sandbox']),
    status: r['status'] as ProcessStatus,
    exitCode: numOrNull(r['exit_code']),
    startedAt: num(r['started_at']),
    endedAt: numOrNull(r['ended_at']),
  };
}

export class ProcessRegistry {
  private readonly ctx: RepoContext;

  constructor(ctx: RepoContext) {
    this.ctx = ctx;
  }

  create(input: {
    id: string;
    sandboxId: string;
    command: string;
    logPath: string;
    pidInSandbox?: number;
  }): ProcessRecord {
    this.ctx.db
      .prepare(
        `INSERT INTO processes (id, sandbox_id, command, log_path, pid_in_sandbox, status, started_at)
         VALUES (?, ?, ?, ?, ?, 'running', ?)`,
      )
      .run(
        input.id,
        input.sandboxId,
        input.command,
        input.logPath,
        input.pidInSandbox ?? null,
        this.ctx.now(),
      );
    return this.get(input.id)!;
  }

  get(id: string): ProcessRecord | undefined {
    const row = this.ctx.db.prepare('SELECT * FROM processes WHERE id = ?').get(id);
    return row ? toProcess(row) : undefined;
  }

  /** Processes of a sandbox, oldest first. */
  list(sandboxId: string): ProcessRecord[] {
    return this.ctx.db
      .prepare('SELECT * FROM processes WHERE sandbox_id = ? ORDER BY started_at, id')
      .all(sandboxId)
      .map(toProcess);
  }

  setPid(id: string, pidInSandbox: number): void {
    this.ctx.db
      .prepare('UPDATE processes SET pid_in_sandbox = ? WHERE id = ?')
      .run(pidInSandbox, id);
  }

  setStatus(id: string, status: ProcessStatus, exitCode?: number): ProcessRecord {
    const res = this.ctx.db
      .prepare(
        `UPDATE processes SET status = ?, exit_code = ?,
           ended_at = CASE WHEN ? = 'running' THEN NULL ELSE COALESCE(ended_at, ?) END
         WHERE id = ?`,
      )
      .run(status, exitCode ?? null, status, this.ctx.now(), id);
    if (num(res.changes) === 0) throw new AboxError('not_found', `unknown process '${id}'`);
    return this.get(id)!;
  }
}
