import { isUtf8 } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AboxError } from '../errors.js';
import { hashJson } from '../state/canonical.js';
import type { SandboxRecord } from '../state/sandbox-registry.js';
import type { Approval } from '../state/approval-queue.js';
import { canonicalizePath, checkHostPath, evaluateExec } from '../policy/index.js';
import type { AgentContext } from '../policy/index.js';
import { createSecretMasker } from '../secrets/mask.js';
import type { DirEntry, ExecRequest } from '../types.js';
import { exportWorkspace } from '../workspace/index.js';
import type { WorkspaceRecord } from '../workspace/index.js';
import { confirmationRequired, consumeApproval, gate } from './approvals.js';
import { NET_POLL_THROTTLE_MS, collectNetworkEvents } from './network-audit.js';
import type { Internals } from './internals.js';
import { SNAPSHOT_NAME_RE, execSchema, exportSchema, processStartSchema } from './schemas.js';
import type {
  Caller,
  ConfirmationRequired,
  ExecCallOptions,
  ExecParams,
  ExecOutcome,
  ExportParams,
  ExportSandboxResult,
  PendingApproval,
  ProcessLogsOptions,
  ProcessLogsResult,
  ProcessView,
  ReadFileResult,
  ReadLogOptions,
  StartProcessResult,
} from './types.js';
import {
  commandDisplay,
  errMessage,
  newShortId,
  parseInput,
  redactCommandText,
  shQuote,
  truncateUtf8,
} from './util.js';

/** Per-stream cap used towards the backend so the full (masked) output can go to the log file. */
const LOG_CAPTURE_BYTES = 8 * 1024 * 1024;
const HUMAN_MAX_OUTPUT = 16 * 1024 * 1024;
const AGENT_READ_MAX = 8 * 1024 * 1024;
const HUMAN_READ_MAX = 64 * 1024 * 1024;
const DEFAULT_READ = 256 * 1024;
const WRITE_MAX = 16 * 1024 * 1024;
const HUMAN_MAX_TIMEOUT = 3600_000;

type Gated =
  | { ok: true; approval?: Approval; approvalId?: string }
  | { ok: false; result: PendingApproval | ConfirmationRequired };

export function requireRunning(I: Internals, rec: SandboxRecord): void {
  if (rec.state === 'expired' || (rec.expiresAt <= I.now() && rec.state !== 'removed')) {
    throw new AboxError('conflict', `sandbox ${rec.id} has expired`, {
      hint: 'Create a new sandbox; expired sandboxes are stopped and removed by gc.',
    });
  }
  if (rec.state !== 'running') {
    throw new AboxError('conflict', `sandbox ${rec.id} is ${rec.state}, not running`, {
      hint:
        rec.state === 'stopped' || rec.state === 'created'
          ? 'Start it first (startSandbox / `abox start`).'
          : undefined,
    });
  }
}

/** Policy + approval for running a command in a sandbox (exec and background processes). */
async function authorizeCommand(
  I: Internals,
  ctx: AgentContext,
  caller: Caller,
  rec: SandboxRecord,
  display: string,
  extra: Record<string, unknown>,
  o: ExecCallOptions,
  action: string,
): Promise<Gated> {
  const ev = evaluateExec(
    ctx,
    { id: rec.id, owner: rec.owner, isolation: rec.isolation },
    {
      command: display,
      ...(ctx.kind === 'human' && caller.humanConfirmed === true ? { humanConfirmed: true } : {}),
    },
  );
  if (ev.decision === 'deny') {
    I.audit(ctx.owner, action, {
      sandboxId: rec.id,
      decision: 'deny',
      details: { reasons: ev.reasons },
    });
    throw new AboxError('policy_denied', ev.reasons.join('; '), {
      ...(ev.hint ? { hint: ev.hint } : {}),
      details: { reasons: ev.reasons },
    });
  }
  if (ev.decision === 'allow') return { ok: true };
  if (ctx.kind === 'human')
    return { ok: false, result: confirmationRequired(ev.reasons, ev.risks, ev.items) };
  const g = await gate(I, {
    ctx,
    kind: 'exec',
    sandboxId: rec.id,
    request: { ...ev.requestDigest, policy: I.policy.contentHash, extra },
    reasons: ev.reasons,
    risks: ev.risks,
    items: ev.items,
    waitMs: Math.max(0, o.waitForApprovalMs ?? I.config.limits.approvalWaitMs),
    signal: o.signal,
    action,
  });
  if (g.outcome === 'pending') return { ok: false, result: g.pending };
  return { ok: true, approval: g.approval, approvalId: g.approval.id };
}

function toExecRequest(p: {
  argv?: string[] | undefined;
  command?: string | undefined;
  cwd?: string | undefined;
  env?: Record<string, string> | undefined;
}): ExecRequest {
  return {
    ...(p.argv ? { argv: p.argv } : {}),
    ...(p.command !== undefined ? { command: p.command } : {}),
    ...(p.cwd ? { cwd: p.cwd } : {}),
    ...(p.env ? { env: p.env } : {}),
  };
}

function maskedLines(
  masker: (s: string) => string,
  argv: string[] | undefined,
  known: Iterable<string>,
): string[] | undefined {
  return argv?.map((a) => redactCommandText(masker(a), known, 512));
}

// ---------------------------------------------------------------------------
// exec
// ---------------------------------------------------------------------------

function logDir(I: Internals, short: string): string {
  return join(I.paths.logsDir, short);
}

function shortOf(id: string): string {
  return id.slice(id.indexOf('/') + 1);
}

export async function execCommand(
  I: Internals,
  caller: Caller,
  id: string,
  rawParams: ExecParams,
  o: ExecCallOptions = {},
): Promise<ExecOutcome> {
  const ctx = await I.context(caller);
  const params = parseInput(execSchema, rawParams, 'exec request');
  const rec = I.lookup(ctx, id);
  requireRunning(I, rec);

  const known = await I.secretValuesOf(rec);
  const masker = createSecretMasker(known);
  const display = redactCommandText(masker(commandDisplay(params)), known);
  const execHash = hashJson({
    argv: params.argv ?? null,
    command: params.command ?? null,
    cwd: params.cwd ?? null,
    env: params.env ?? null,
    stdin: params.stdin !== undefined ? hashJson(params.stdin) : null,
    timeoutMs: params.timeoutMs ?? null,
  });
  const auth = await authorizeCommand(
    I,
    ctx,
    caller,
    rec,
    display,
    { execHash },
    o,
    'sandbox.exec',
  );
  if (!auth.ok) return auth.result;

  const cfg = I.config.limits;
  const viewCap = Math.min(
    params.maxOutputBytes ?? cfg.execMaxOutputBytes,
    ctx.kind === 'human' ? HUMAN_MAX_OUTPUT : cfg.execMaxOutputBytes,
  );
  const timeoutMs = Math.min(
    params.timeoutMs ?? cfg.execTimeoutMs,
    ctx.kind === 'human' ? HUMAN_MAX_TIMEOUT : cfg.execTimeoutMs,
  );
  if (auth.approval) consumeApproval(I, auth.approval);

  const provider = await I.providerForRecord(rec);
  const started = Date.now();
  let res;
  try {
    res = await provider.exec(id, {
      ...toExecRequest(params),
      timeoutMs,
      ...(params.stdin !== undefined ? { stdin: params.stdin } : {}),
      maxOutputBytes: LOG_CAPTURE_BYTES,
      ...(o.signal ? { signal: o.signal } : {}),
    });
  } catch (e) {
    I.audit(ctx.owner, 'sandbox.exec', {
      sandboxId: id,
      decision: 'error',
      details: { command: display, message: errMessage(e), approvalId: auth.approvalId },
    });
    await collectNetworkEvents(I, rec);
    throw e;
  }
  const durationMs = res.durationMs ?? Date.now() - started;
  const stdoutFull = masker(res.stdout);
  const stderrFull = masker(res.stderr);
  const out = truncateUtf8(stdoutFull, viewCap);
  const err = truncateUtf8(stderrFull, viewCap);
  const truncated = res.truncated || out.truncated || err.truncated;

  // full masked output -> rotating per-sandbox log
  const file = `exec-${Date.now()}-${randomBytes(3).toString('hex')}.log`;
  const logRef = `exec:${id}:${file}`;
  try {
    const dir = logDir(I, shortOf(id));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const header =
      `# abox exec ${id} ${new Date().toISOString()} exit=${res.exitCode} durationMs=${durationMs} timedOut=${res.timedOut} captureTruncated=${res.truncated}\n` +
      `# command: ${display}\n`;
    await writeFile(
      join(dir, file),
      `${header}=== stdout ===\n${stdoutFull}\n=== stderr ===\n${stderrFull}\n`,
      { mode: 0o600 },
    );
  } catch (e) {
    I.audit('system', 'log.write_failed', {
      sandboxId: id,
      decision: 'error',
      details: { message: errMessage(e) },
    });
  }

  I.audit(ctx.owner, 'sandbox.exec', {
    sandboxId: id,
    decision: auth.approvalId ? 'approved' : 'allow',
    details: {
      ...(params.argv ? { argv: maskedLines(masker, params.argv, known) } : { command: display }),
      cwd: params.cwd,
      envKeys: params.env ? Object.keys(params.env) : undefined,
      exitCode: res.exitCode,
      durationMs,
      truncated,
      timedOut: res.timedOut,
      stdoutBytes: out.bytes,
      stderrBytes: err.bytes,
      logRef,
      approvalId: auth.approvalId,
    },
  });
  await collectNetworkEvents(I, rec);
  return {
    status: 'completed',
    exitCode: res.exitCode,
    stdout: out.text,
    stderr: err.text,
    truncated,
    timedOut: res.timedOut,
    durationMs,
    logRef,
  };
}

const LOG_REF_RE = /^exec:([a-z0-9-]+\/[A-Za-z0-9_-]+):(exec-\d+-[0-9a-f]{6}\.log)$/;

/** Read a full (masked) exec log written by {@link execCommand}. */
export async function readLog(
  I: Internals,
  caller: Caller,
  logRef: string,
  o: ReadLogOptions = {},
): Promise<{ logRef: string; content: string; truncated: boolean; size: number }> {
  const ctx = await I.context(caller);
  const m = typeof logRef === 'string' ? LOG_REF_RE.exec(logRef) : null;
  if (!m) throw new AboxError('not_found', 'log not found');
  const rec = I.lookup(ctx, m[1], { allowRemoved: true });
  const path = join(logDir(I, shortOf(rec.id)), m[2]!);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new AboxError('not_found', 'log not found (it may have been rotated away)');
  }
  const size = Buffer.byteLength(text);
  let content = text;
  if (o.tail !== undefined)
    content = text
      .split('\n')
      .slice(-Math.max(1, o.tail) - 1)
      .join('\n');
  const cap = Math.min(
    o.maxBytes ?? DEFAULT_READ,
    ctx.kind === 'human' ? HUMAN_READ_MAX : AGENT_READ_MAX,
  );
  const t = truncateUtf8(content, cap);
  return { logRef, content: t.text, truncated: t.truncated || content.length < text.length, size };
}

// ---------------------------------------------------------------------------
// background processes
// ---------------------------------------------------------------------------

const BASE_SH = `case "\${TMPDIR:-/tmp}" in */tmp) base="\${TMPDIR:-/tmp}";; *) base=/tmp;; esac; d="$base/.abox/proc"`;

const START_SCRIPT = `${BASE_SH}
id="$1"; cmd="$2"
mkdir -p "$d" || { echo "abox: cannot create $d" >&2; exit 1; }
chmod 700 "$base/.abox" "$d" 2>/dev/null
: > "$d/$id.log"
if command -v setsid >/dev/null 2>&1; then s=setsid; else s=; fi
nohup $s /bin/sh -c 'sh -c "$1"; echo $? > "$2"' abox-proc "$cmd" "$d/$id.exit" >"$d/$id.log" 2>&1 </dev/null &
pid=$!
echo "$pid" > "$d/$id.pid"
echo "ABOXPID:$pid"`;

const STOP_SCRIPT = `pid="$1"
kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
i=0
while [ $i -lt 20 ]; do
  kill -0 "$pid" 2>/dev/null || break
  s=$(sed 's/^.*) //' "/proc/$pid/stat" 2>/dev/null | cut -c1)
  [ "$s" = Z ] && break
  sleep 0.1 2>/dev/null || sleep 1
  i=$((i+1))
done
if kill -0 "$pid" 2>/dev/null; then kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null; fi
echo stopped`;

const STATUS_SCRIPT = `${BASE_SH}
pid="$1"; id="$2"
if [ -f "$d/$id.exit" ]; then echo "exited $(cat "$d/$id.exit")"; exit 0; fi
if kill -0 "$pid" 2>/dev/null; then
  s=$(sed 's/^.*) //' "/proc/$pid/stat" 2>/dev/null | cut -c1)
  if [ "$s" = Z ]; then echo gone; else echo running; fi
else
  echo gone
fi`;

const TAIL_SCRIPT = `${BASE_SH}
id="$1"; mode="$2"; n="$3"; cap="$4"; f="$d/$id.log"
size=$(wc -c < "$f" 2>/dev/null | tr -d ' ')
echo "ABOXSIZE:\${size:-0}"
case "$mode" in
  since) tail -c "+$((n+1))" "$f" 2>/dev/null | head -c "$cap" ;;
  tail) tail -n "$n" "$f" 2>/dev/null | tail -c "$cap" ;;
  last) tail -c "$cap" "$f" 2>/dev/null ;;
esac`;

function procView(p: {
  id: string;
  sandboxId: string;
  command: string;
  status: ProcessView['status'];
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
}): ProcessView {
  return {
    id: p.id,
    sandboxId: p.sandboxId,
    command: p.command,
    status: p.status,
    exitCode: p.exitCode,
    startedAt: p.startedAt,
    endedAt: p.endedAt,
  };
}

export async function startProcess(
  I: Internals,
  caller: Caller,
  id: string,
  rawParams: Pick<ExecParams, 'argv' | 'command' | 'cwd' | 'env'>,
  o: ExecCallOptions = {},
): Promise<StartProcessResult> {
  const ctx = await I.context(caller);
  const params = parseInput(processStartSchema, rawParams, 'process request');
  const rec = I.lookup(ctx, id);
  requireRunning(I, rec);
  const known = await I.secretValuesOf(rec);
  const masker = createSecretMasker(known);
  const display = redactCommandText(masker(commandDisplay(params)), known);
  const execHash = hashJson({
    argv: params.argv ?? null,
    command: params.command ?? null,
    cwd: params.cwd ?? null,
    env: params.env ?? null,
    background: true,
  });
  const auth = await authorizeCommand(
    I,
    ctx,
    caller,
    rec,
    display,
    { execHash, background: true },
    o,
    'sandbox.process_start',
  );
  if (!auth.ok) return auth.result;
  if (auth.approval) consumeApproval(I, auth.approval);

  const provider = await I.providerForRecord(rec);
  const procId = `p${newShortId()}`;
  const cmd = params.argv ? params.argv.map(shQuote).join(' ') : params.command!;
  const res = await provider.exec(id, {
    argv: ['/bin/sh', '-c', START_SCRIPT, 'abox-start', procId, cmd],
    ...(params.cwd ? { cwd: params.cwd } : {}),
    ...(params.env ? { env: params.env } : {}),
    timeoutMs: 30_000,
    maxOutputBytes: 4096,
  });
  const m = /ABOXPID:(\d+)/.exec(res.stdout);
  if (res.exitCode !== 0 || !m) {
    I.audit(ctx.owner, 'sandbox.process_start', {
      sandboxId: id,
      decision: 'error',
      details: { command: display, exitCode: res.exitCode, message: res.stderr.slice(0, 300) },
    });
    throw new AboxError(
      'backend_error',
      `could not start the background process: ${masker(res.stderr).slice(0, 300) || `exit ${res.exitCode}`}`,
    );
  }
  const rec2 = I.state.processes.create({
    id: procId,
    sandboxId: id,
    command: display,
    logPath: `/tmp/.abox/proc/${procId}.log`,
    pidInSandbox: Number(m[1]),
  });
  I.audit(ctx.owner, 'sandbox.process_start', {
    sandboxId: id,
    decision: auth.approvalId ? 'approved' : 'allow',
    details: {
      processId: procId,
      ...(params.argv ? { argv: maskedLines(masker, params.argv, known) } : { command: display }),
      cwd: params.cwd,
      pid: Number(m[1]),
      approvalId: auth.approvalId,
    },
  });
  await collectNetworkEvents(I, rec);
  return { status: 'started', process: procView(rec2) };
}

function loadProcess(
  I: Internals,
  ctx: AgentContext,
  processId: string,
): { proc: NonNullable<ReturnType<Internals['state']['processes']['get']>>; rec: SandboxRecord } {
  const proc =
    typeof processId === 'string' && /^p[0-9a-f]{8}$/.test(processId)
      ? I.state.processes.get(processId)
      : undefined;
  if (!proc)
    throw new AboxError('not_found', `process '${String(processId).slice(0, 40)}' not found`);
  let rec: SandboxRecord;
  try {
    rec = I.lookup(ctx, proc.sandboxId, { allowRemoved: true });
  } catch {
    throw new AboxError('not_found', `process '${processId}' not found`);
  }
  return { proc, rec };
}

/** Ask the sandbox whether the process still runs; updates the registry. */
async function refreshProcess(
  I: Internals,
  rec: SandboxRecord,
  procId: string,
): Promise<ProcessView> {
  const proc = I.state.processes.get(procId)!;
  if (proc.status !== 'running' || proc.pidInSandbox === null) return procView(proc);
  if (rec.state !== 'running') {
    return procView(
      I.state.processes.setStatus(procId, rec.state === 'removed' ? 'killed' : 'lost'),
    );
  }
  try {
    const provider = await I.providerForRecord(rec);
    const r = await provider.exec(rec.id, {
      argv: ['/bin/sh', '-c', STATUS_SCRIPT, 'abox-status', String(proc.pidInSandbox), procId],
      timeoutMs: 15_000,
      maxOutputBytes: 256,
    });
    const out = r.stdout.trim();
    if (out.startsWith('exited')) {
      const code = Number(out.split(/\s+/)[1] ?? 0);
      return procView(
        I.state.processes.setStatus(procId, 'exited', Number.isFinite(code) ? code : 0),
      );
    }
    if (out === 'gone') return procView(I.state.processes.setStatus(procId, 'lost'));
  } catch {
    /* sandbox not reachable: keep the last known status */
  }
  return procView(I.state.processes.get(procId)!);
}

export async function listProcesses(
  I: Internals,
  caller: Caller,
  id: string,
): Promise<ProcessView[]> {
  const ctx = await I.context(caller);
  const rec = I.lookup(ctx, id);
  const out: ProcessView[] = [];
  for (const p of I.state.processes.list(id)) out.push(await refreshProcess(I, rec, p.id));
  return out;
}

export async function processLogs(
  I: Internals,
  caller: Caller,
  processId: string,
  o: ProcessLogsOptions = {},
): Promise<ProcessLogsResult> {
  const ctx = await I.context(caller);
  const { proc, rec } = loadProcess(I, ctx, processId);
  const cap = Math.min(
    o.maxBytes ?? DEFAULT_READ,
    ctx.kind === 'human' ? HUMAN_READ_MAX : AGENT_READ_MAX,
  );
  const since = o.sinceBytes !== undefined ? Math.max(0, Math.trunc(o.sinceBytes)) : undefined;
  const tail = o.tail !== undefined ? Math.max(1, Math.trunc(o.tail)) : undefined;
  const known = await I.secretValuesOf(rec);
  const masker = createSecretMasker(known);
  const provider = await I.providerForRecord(rec);

  let size = 0;
  let content = '';
  let truncated = false;
  let nextOffset = 0;
  let viaRead = false;
  try {
    const r = await provider.readFile(rec.id, proc.logPath, cap);
    size = r.size;
    if (!r.truncated) {
      viaRead = true;
      let text = r.data.toString('utf8');
      if (since !== undefined) text = Buffer.from(text, 'utf8').subarray(since).toString('utf8');
      if (tail !== undefined) {
        const lines = text.split('\n');
        const hadNl = text.endsWith('\n');
        const kept = lines.slice(-(tail + (hadNl ? 1 : 0)));
        text = kept.join('\n');
      }
      content = text;
      nextOffset = size;
    }
  } catch (e) {
    if (!(e instanceof AboxError && e.code === 'not_found')) throw e;
  }
  if (!viaRead && rec.state === 'running') {
    const mode = since !== undefined ? 'since' : tail !== undefined ? 'tail' : 'last';
    const n = since ?? tail ?? 0;
    const r = await provider.exec(rec.id, {
      argv: ['/bin/sh', '-c', TAIL_SCRIPT, 'abox-tail', processId, mode, String(n), String(cap)],
      timeoutMs: 30_000,
      maxOutputBytes: cap + 128,
    });
    const m = /^ABOXSIZE:(\d+)\n/.exec(r.stdout);
    size = m ? Number(m[1]) : size;
    content = m ? r.stdout.slice(m[0].length) : r.stdout;
    truncated = true;
    nextOffset = since !== undefined ? Math.min(size, since + Buffer.byteLength(content)) : size;
  }
  content = masker(content);
  const t = truncateUtf8(content, cap);
  const view = await refreshProcess(I, rec, proc.id);
  I.audit(ctx.owner, 'sandbox.process_logs', {
    sandboxId: rec.id,
    decision: 'allow',
    details: { processId, bytes: Buffer.byteLength(t.text), since, tail },
  });
  await collectNetworkEvents(I, rec, { throttleMs: NET_POLL_THROTTLE_MS });
  return { process: view, content: t.text, nextOffset, size, truncated: truncated || t.truncated };
}

export async function stopProcess(
  I: Internals,
  caller: Caller,
  processId: string,
): Promise<ProcessView> {
  const ctx = await I.context(caller);
  const { proc, rec } = loadProcess(I, ctx, processId);
  if (proc.status === 'running' && proc.pidInSandbox !== null && rec.state === 'running') {
    const provider = await I.providerForRecord(rec);
    await provider.exec(rec.id, {
      argv: ['/bin/sh', '-c', STOP_SCRIPT, 'abox-stop', String(proc.pidInSandbox)],
      timeoutMs: 30_000,
      maxOutputBytes: 256,
    });
    I.state.processes.setStatus(proc.id, 'killed');
  } else if (proc.status === 'running') {
    I.state.processes.setStatus(proc.id, 'killed');
  }
  I.audit(ctx.owner, 'sandbox.process_stop', {
    sandboxId: rec.id,
    decision: 'allow',
    details: { processId },
  });
  await collectNetworkEvents(I, rec);
  return procView(I.state.processes.get(proc.id)!);
}

// ---------------------------------------------------------------------------
// files
// ---------------------------------------------------------------------------

export function sandboxPath(rec: SandboxRecord, p: unknown): string {
  if (typeof p !== 'string' || p.length === 0 || p.length > 4096 || p.includes('\0')) {
    throw new AboxError(
      'invalid_input',
      'path must be a non-empty string without NUL (max 4096 characters)',
    );
  }
  if (p.startsWith('/')) return p;
  const ws = (rec.workspace as Partial<WorkspaceRecord> | null)?.sandboxPath ?? '/workspace';
  return `${ws.replace(/\/+$/, '')}/${p}`;
}

export async function readSandboxFile(
  I: Internals,
  caller: Caller,
  id: string,
  path: string,
  o: { maxBytes?: number } = {},
): Promise<ReadFileResult> {
  const ctx = await I.context(caller);
  const rec = I.lookup(ctx, id);
  const p = sandboxPath(rec, path);
  const cap = Math.min(
    Math.max(1, Math.trunc(o.maxBytes ?? DEFAULT_READ)),
    ctx.kind === 'human' ? HUMAN_READ_MAX : AGENT_READ_MAX,
  );
  const provider = await I.providerForRecord(rec);
  const r = await provider.readFile(id, p, cap);
  let data = r.data;
  // do not return a half character at the cut
  if (r.truncated)
    for (let i = 0; i < 4 && data.length > 0 && !isUtf8(data); i++)
      data = data.subarray(0, data.length - 1);
  const text = isUtf8(data) && !data.includes(0);
  let content: string;
  if (text) {
    const known = await I.secretValuesOf(rec);
    content = createSecretMasker(known)(data.toString('utf8'));
  } else {
    content = r.data.toString('base64');
  }
  I.audit(ctx.owner, 'sandbox.read_file', {
    sandboxId: id,
    decision: 'allow',
    details: { path: p, size: r.size, returnedBytes: r.data.length, truncated: r.truncated },
  });
  await collectNetworkEvents(I, rec, { throttleMs: NET_POLL_THROTTLE_MS });
  return {
    path: p,
    size: r.size,
    truncated: r.truncated,
    encoding: text ? 'utf8' : 'base64',
    content,
  };
}

export async function writeSandboxFile(
  I: Internals,
  caller: Caller,
  id: string,
  path: string,
  content: string | Buffer,
  o: { mode?: number; encoding?: 'utf8' | 'base64' } = {},
): Promise<{ path: string; size: number }> {
  const ctx = await I.context(caller);
  const rec = I.lookup(ctx, id);
  const p = sandboxPath(rec, path);
  const data = typeof content === 'string' ? Buffer.from(content, o.encoding ?? 'utf8') : content;
  if (!Buffer.isBuffer(data))
    throw new AboxError('invalid_input', 'content must be a string or a Buffer');
  if (data.length > WRITE_MAX)
    throw new AboxError('invalid_input', `content is larger than ${WRITE_MAX} bytes`, {
      hint: 'Write large files in chunks or use exec.',
    });
  const mode = o.mode ?? 0o644;
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) {
    throw new AboxError(
      'invalid_input',
      'mode must be an integer permission mask 0..0o777 (setuid/setgid/sticky are not allowed)',
    );
  }
  const provider = await I.providerForRecord(rec);
  await provider.writeFile(id, p, data, mode);
  I.audit(ctx.owner, 'sandbox.write_file', {
    sandboxId: id,
    decision: 'allow',
    details: { path: p, size: data.length, mode },
  });
  await collectNetworkEvents(I, rec, { throttleMs: NET_POLL_THROTTLE_MS });
  return { path: p, size: data.length };
}

export async function listSandboxDir(
  I: Internals,
  caller: Caller,
  id: string,
  path = '.',
): Promise<DirEntry[]> {
  const ctx = await I.context(caller);
  const rec = I.lookup(ctx, id);
  const p = sandboxPath(
    rec,
    path === '.'
      ? ((rec.workspace as Partial<WorkspaceRecord> | null)?.sandboxPath ?? '/workspace')
      : path,
  );
  const provider = await I.providerForRecord(rec);
  const entries = await provider.listDir(id, p);
  I.audit(ctx.owner, 'sandbox.list_dir', {
    sandboxId: id,
    decision: 'allow',
    details: { path: p, entries: entries.length },
  });
  await collectNetworkEvents(I, rec, { throttleMs: NET_POLL_THROTTLE_MS });
  return entries;
}

// ---------------------------------------------------------------------------
// snapshots
// ---------------------------------------------------------------------------

export async function snapshotSandbox(
  I: Internals,
  caller: Caller,
  id: string,
  name: string,
): Promise<{ snapshotId: string }> {
  const ctx = await I.context(caller);
  const rec = I.lookup(ctx, id);
  if (typeof name !== 'string' || !SNAPSHOT_NAME_RE.test(name)) {
    throw new AboxError('invalid_input', 'invalid snapshot name (letters, digits . _ -, max 64)');
  }
  const provider = await I.providerForRecord(rec);
  if (!provider.capabilities().snapshots || !provider.snapshot) {
    throw new AboxError('unsupported', `backend '${rec.backend}' does not support snapshots`, {
      hint: 'Export the result (sandbox_export) before risky steps instead, or use a backend with snapshots.',
    });
  }
  const snapshotId = await provider.snapshot(id, name);
  I.state.snapshots.add({ sandboxId: id, snapshotId, name });
  I.audit(ctx.owner, 'sandbox.snapshot', {
    sandboxId: id,
    decision: 'allow',
    details: { name, snapshotId },
  });
  return { snapshotId };
}

export async function restoreSandbox(
  I: Internals,
  caller: Caller,
  id: string,
  snapshotId: string,
): Promise<{ restored: string }> {
  const ctx = await I.context(caller);
  const rec = I.lookup(ctx, id);
  if (typeof snapshotId !== 'string' || snapshotId.length === 0 || snapshotId.length > 200) {
    throw new AboxError('invalid_input', 'a snapshot id is required');
  }
  const provider = await I.providerForRecord(rec);
  if (!provider.capabilities().snapshots || !provider.restore) {
    throw new AboxError('unsupported', `backend '${rec.backend}' does not support snapshots`, {
      hint: 'This backend cannot restore; recreate the sandbox instead.',
    });
  }
  // `snapshotId` may also be the name given to `snapshot` (newest snapshot of that name); an exact id wins.
  const known = I.state.snapshots.list(id);
  const resolved =
    known.find((x) => x.snapshotId === snapshotId)?.snapshotId ??
    known.filter((x) => x.name === snapshotId).at(-1)?.snapshotId ??
    snapshotId;
  await provider.restore(id, resolved);
  I.audit(ctx.owner, 'sandbox.restore', {
    sandboxId: id,
    decision: 'allow',
    details: {
      snapshotId: resolved,
      ...(resolved !== snapshotId ? { requested: snapshotId } : {}),
    },
  });
  return { restored: resolved };
}

// ---------------------------------------------------------------------------
// export (never applies anything automatically)
// ---------------------------------------------------------------------------

export async function exportSandbox(
  I: Internals,
  caller: Caller,
  id: string,
  rawParams: ExportParams,
): Promise<ExportSandboxResult> {
  const ctx = await I.context(caller);
  const params = parseInput(exportSchema, rawParams, 'export request');
  const rec = I.lookup(ctx, id);
  const wsRec = rec.workspace as WorkspaceRecord | null;
  if (!wsRec || wsRec.version !== 1) {
    throw new AboxError('unsupported', `sandbox ${id} has no recorded workspace to export`, {
      hint: 'Only sandboxes created with a workspace can be exported.',
    });
  }
  if (ctx.kind === 'agent') {
    if (params.force) {
      I.audit(ctx.owner, 'sandbox.export', {
        sandboxId: id,
        decision: 'deny',
        details: { reason: 'force is human only' },
      });
      throw new AboxError(
        'policy_denied',
        'overwriting an export branch (force) is only available to a human',
      );
    }
    if (
      params.branchName !== undefined &&
      (!params.branchName.startsWith('abox/') || params.branchName.includes('..'))
    ) {
      I.audit(ctx.owner, 'sandbox.export', {
        sandboxId: id,
        decision: 'deny',
        details: { reason: 'branch name outside abox/', branchName: params.branchName },
      });
      throw new AboxError('policy_denied', 'agents may only export to branches named abox/<name>', {
        hint: 'Omit branchName for the default abox/<id>-export.',
      });
    }
  }
  let outDir: string | undefined;
  if (params.format === 'files') {
    if (params.outDir !== undefined && ctx.kind === 'agent') {
      throw new AboxError(
        'policy_denied',
        'agents cannot choose the host directory of a files export',
        {
          hint: 'Omit outDir: the files go to an abox-owned export directory and the human picks them up.',
        },
      );
    }
    if (params.outDir !== undefined) {
      outDir = canonicalizePath(params.outDir, { home: I.home, cwd: I.projectDir ?? I.home });
      const res = checkHostPath(outDir, {
        home: I.home,
        roots: ctx.workspaceRoots,
        kind: 'workspace',
        extraForbidden: I.forbiddenTrees(),
      });
      if (!res.ok)
        throw new AboxError(
          'policy_denied',
          `export directory ${outDir} is not allowed: ${res.reason}`,
        );
    } else if (ctx.kind === 'agent') {
      outDir = join(I.paths.dataDir, 'exports', shortOf(id), String(Date.now()));
    }
  }
  const provider = await I.providerForRecord(rec);
  try {
    const result = await exportWorkspace({
      record: wsRec,
      provider,
      sandboxId: id,
      format: params.format,
      ...(params.paths ? { paths: params.paths } : {}),
      tmpDir: join(I.paths.cacheDir, 'export'),
      ...(outDir ? { outDir } : {}),
      ...(params.branchName ? { branchName: params.branchName } : {}),
      ...(params.force ? { force: true } : {}),
    });
    I.audit(ctx.owner, 'sandbox.export', {
      sandboxId: id,
      decision: 'allow',
      details: {
        format: params.format,
        paths: params.paths,
        filesChanged: result.files.length,
        stats: result.stats,
        flagged: result.flagged,
        branch: result.branch,
        commit: result.commit,
        outDir,
        written: result.written?.length,
      },
    });
    return { ...result, sandboxId: id, ...(outDir && result.written ? { outDir } : {}) };
  } catch (e) {
    I.audit(ctx.owner, 'sandbox.export', {
      sandboxId: id,
      decision: 'error',
      details: { format: params.format, message: errMessage(e) },
    });
    throw e;
  }
}

// ---------------------------------------------------------------------------
// log rotation
// ---------------------------------------------------------------------------

/** Delete exec logs older than the retention. Returns what was (or with `dryRun` would be) removed. */
export async function rotateLogs(
  I: Internals,
  dryRun: boolean,
): Promise<{ files: number; bytes: number }> {
  const cutoff = I.now() - I.config.logs.retentionDays * 86_400_000;
  let files = 0;
  let bytes = 0;
  let dirs: string[];
  try {
    dirs = await readdir(I.paths.logsDir);
  } catch {
    return { files, bytes };
  }
  for (const d of dirs) {
    const dir = join(I.paths.logsDir, d);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    let left = names.length;
    for (const n of names) {
      try {
        const st = await stat(join(dir, n));
        if (st.isFile() && st.mtimeMs < cutoff) {
          files++;
          bytes += st.size;
          left--;
          if (!dryRun) await rm(join(dir, n), { force: true });
        }
      } catch {
        /* vanished */
      }
    }
    if (!dryRun && left === 0)
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  return { files, bytes };
}
