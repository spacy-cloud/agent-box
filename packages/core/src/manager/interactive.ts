import { lstat, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { AboxError } from '../errors.js';
import { canonicalizePath, checkHostPath } from '../policy/index.js';
import type { AgentContext } from '../policy/index.js';
import { createSecretMasker } from '../secrets/mask.js';
import type { SandboxRecord } from '../state/sandbox-registry.js';
import type { TtySession } from '../types.js';
import { requireRunning, sandboxPath } from './exec.js';
import type { Internals } from './internals.js';
import { NET_POLL_THROTTLE_MS, collectNetworkEvents } from './network-audit.js';
import type {
  AttachOptions,
  Caller,
  PolicyRevisionDetail,
  PolicyRevisionSummary,
  SandboxLogsOptions,
  SnapshotView,
} from './types.js';
import { commandDisplay, errMessage, redactCommandText, sleep, truncateUtf8 } from './util.js';

const HUMAN_LOG_MAX = 64 * 1024 * 1024;
const AGENT_LOG_MAX = 8 * 1024 * 1024;
const LOG_TAIL_MAX = 1_000_000;
const TREE_WALK_MAX = 200_000;

// ---------------------------------------------------------------------------
// attach (interactive terminal)
// ---------------------------------------------------------------------------

/** A terminal size: numbers only; "unknown" (0, negative, NaN) falls back to the default, huge values are capped. */
function terminalSize(v: unknown, what: string, fallback: number): number {
  if (typeof v !== 'number') {
    throw new AboxError('invalid_input', `${what} must be a number`);
  }
  if (!Number.isFinite(v) || v < 1) return fallback;
  return Math.min(1000, Math.trunc(v));
}

function intInRange(v: unknown, what: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new AboxError('invalid_input', `${what} must be an integer between ${min} and ${max}`);
  }
  return v;
}

/**
 * Interactive terminal in a running sandbox. Human only: an agent has exec/process tools, and a live
 * terminal bypasses the per-command approval flow. The audit log records open (`sandbox.attach`) and
 * close (`sandbox.attach.end` with duration and exit code), never what was typed or printed.
 */
export async function attachSandbox(
  I: Internals,
  caller: Caller,
  id: string,
  rawOpts: AttachOptions,
): Promise<TtySession> {
  const ctx = await I.context(caller);
  I.requireHuman(ctx, 'sandbox.attach');
  const o = (rawOpts ?? {}) as Partial<AttachOptions>;
  const cols = terminalSize(o.cols, 'cols', 80);
  const rows = terminalSize(o.rows, 'rows', 24);
  let argv: string[] | undefined;
  if (o.argv !== undefined) {
    if (
      !Array.isArray(o.argv) ||
      o.argv.length === 0 ||
      o.argv.length > 256 ||
      o.argv.some(
        (a) => typeof a !== 'string' || a.length === 0 || a.length > 4096 || a.includes('\0'),
      )
    ) {
      throw new AboxError('invalid_input', 'argv must be 1..256 non-empty strings without NUL');
    }
    argv = o.argv;
  }
  const rec = I.lookup(ctx, id);
  requireRunning(I, rec);
  const provider = await I.providerForRecord(rec);
  if (!provider.capabilities().tty) {
    throw new AboxError('unsupported', `backend '${rec.backend}' has no interactive terminal`, {
      hint: 'Use exec (`abox exec <id> -- <command>`) instead.',
    });
  }
  const known = await I.secretValuesOf(rec);
  const display = argv
    ? redactCommandText(createSecretMasker(known)(commandDisplay({ argv })), known, 300)
    : undefined;
  let session: TtySession;
  try {
    session = await provider.attach(id, { cols, rows, ...(argv ? { argv } : {}) });
  } catch (e) {
    I.audit(ctx.owner, 'sandbox.attach', {
      sandboxId: id,
      decision: 'error',
      details: { message: errMessage(e) },
    });
    throw e;
  }
  const started = Date.now();
  I.audit(ctx.owner, 'sandbox.attach', {
    sandboxId: id,
    decision: 'allow',
    details: { backend: rec.backend, cols, rows, ...(display ? { command: display } : {}) },
  });

  let ended = false;
  const finish = (exitCode: number | null, error?: string): void => {
    if (ended) return;
    ended = true;
    if (!I.closed) {
      I.audit(ctx.owner, 'sandbox.attach.end', {
        sandboxId: id,
        decision: 'info',
        details: {
          durationMs: Date.now() - started,
          exitCode,
          ...(error ? { message: error } : {}),
        },
      });
    }
    void collectNetworkEvents(I, rec).catch(() => undefined);
  };
  const waited = session.wait().then(
    (code) => {
      finish(code);
      return code;
    },
    (e: unknown) => {
      finish(null, errMessage(e));
      throw e;
    },
  );
  waited.catch(() => undefined); // the audit entry is written either way; do not leak an unhandled rejection

  return {
    stream: session.stream,
    resize: (c: number, r: number) => session.resize(c, r),
    wait: () => waited,
    async close() {
      try {
        await session.close();
      } finally {
        // give the backend a moment to report the real exit code before recording "unknown"
        await Promise.race([waited.catch(() => undefined), sleep(2000)]);
        finish(null);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// copy in / out
// ---------------------------------------------------------------------------

interface TreeSize {
  bytes: number;
  files: number;
  truncated: boolean;
}

/** Size of a file or tree without following symlinks (bounded walk). */
async function treeSize(root: string): Promise<TreeSize> {
  const out: TreeSize = { bytes: 0, files: 0, truncated: false };
  const stack = [root];
  let seen = 0;
  while (stack.length > 0) {
    const p = stack.pop()!;
    if (++seen > TREE_WALK_MAX) {
      out.truncated = true;
      break;
    }
    let st;
    try {
      st = await lstat(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      try {
        for (const n of await readdir(p)) stack.push(join(p, n));
      } catch {
        /* unreadable: counted as far as known */
      }
    } else {
      out.files++;
      out.bytes += st.size;
    }
  }
  return out;
}

function canonicalHostPath(I: Internals, p: unknown, what: string): string {
  if (typeof p !== 'string' || p.length === 0 || p.length > 4096 || p.includes('\0')) {
    throw new AboxError(
      'invalid_input',
      `${what} must be a non-empty path string without NUL (max 4096 characters)`,
    );
  }
  return canonicalizePath(p, { home: I.home, cwd: I.projectDir ?? I.home });
}

/** The forbidden-path list applies to copies too (no allowed roots: a human may copy from and to anywhere else). */
function checkCopyPath(
  I: Internals,
  canonical: string,
  extraForbidden: readonly string[],
): ReturnType<typeof checkHostPath> {
  return checkHostPath(canonical, {
    home: I.home,
    roots: ['/'],
    kind: 'workspace',
    scanSockets: false,
    extraForbidden,
  });
}

function copyAllowed(rec: SandboxRecord, direction: 'in' | 'out'): void {
  const ok =
    rec.state === 'running' ||
    rec.state === 'stopped' ||
    rec.state === 'created' ||
    (direction === 'out' && rec.state === 'expired');
  if (!ok) {
    throw new AboxError('conflict', `sandbox ${rec.id} is ${rec.state}; files cannot be copied`, {
      hint: rec.state === 'expired' ? 'Export the workspace instead (sandbox export).' : undefined,
    });
  }
}

function denyCopy(
  I: Internals,
  ctx: AgentContext,
  id: string,
  action: string,
  reason: string,
  hint: string | undefined,
  extra: Record<string, unknown>,
): never {
  I.audit(ctx.owner, action, {
    sandboxId: id,
    decision: 'deny',
    details: { reason, ...extra },
  });
  throw new AboxError('policy_denied', reason, {
    ...(hint ? { hint } : {}),
    details: { reasons: [reason] },
  });
}

/**
 * Human only. Copies a host file or directory into the sandbox. The source must exist and must not
 * be (or contain, or lie in) a protected path such as `~/.ssh`, `~/.gnupg`, a container engine socket
 * or abox's own directories.
 */
export async function copyIn(
  I: Internals,
  caller: Caller,
  id: string,
  hostPath: string,
  sandboxTarget: string,
): Promise<void> {
  const ctx = await I.context(caller);
  I.requireHuman(ctx, 'sandbox.copy_in');
  const rec = I.lookup(ctx, id);
  copyAllowed(rec, 'in');
  const source = canonicalHostPath(I, hostPath, 'hostPath');
  const target = sandboxPath(rec, sandboxTarget);
  const check = checkCopyPath(I, source, I.forbiddenTrees());
  if (!check.ok) {
    denyCopy(
      I,
      ctx,
      id,
      'sandbox.copy_in',
      `cannot copy ${source} into a sandbox: ${check.reason}`,
      check.hint ??
        'Copy files from a project directory instead of credential or system locations.',
      { hostPath: source, sandboxPath: target },
    );
  }
  const st = await stat(source).catch(() => undefined);
  if (!st) throw new AboxError('not_found', `no such file or directory: ${source}`);
  const size = await treeSize(source);
  const provider = await I.providerForRecord(rec);
  const started = Date.now();
  try {
    await provider.copyIn(id, source, target);
  } catch (e) {
    I.audit(ctx.owner, 'sandbox.copy_in', {
      sandboxId: id,
      decision: 'error',
      details: { hostPath: source, sandboxPath: target, message: errMessage(e) },
    });
    throw e;
  }
  I.audit(ctx.owner, 'sandbox.copy_in', {
    sandboxId: id,
    decision: 'allow',
    details: {
      hostPath: source,
      sandboxPath: target,
      directory: st.isDirectory(),
      files: size.files,
      bytes: size.bytes,
      ...(size.truncated ? { sizeTruncated: true } : {}),
      durationMs: Date.now() - started,
    },
  });
  await collectNetworkEvents(I, rec, { throttleMs: NET_POLL_THROTTLE_MS });
}

/**
 * Human only. Copies a file or directory out of the sandbox to the host. The destination must not be
 * inside abox's own config/data/cache/log directories, another sandbox's directory or a protected
 * path (`~/.ssh`, `/etc`, ...). The content comes from the sandbox: it is never trusted.
 */
export async function copyOut(
  I: Internals,
  caller: Caller,
  id: string,
  sandboxSource: string,
  hostPath: string,
): Promise<void> {
  const ctx = await I.context(caller);
  I.requireHuman(ctx, 'sandbox.copy_out');
  const rec = I.lookup(ctx, id);
  copyAllowed(rec, 'out');
  const source = sandboxPath(rec, sandboxSource);
  const dest = canonicalHostPath(I, hostPath, 'hostPath');
  const check = checkCopyPath(I, dest, I.forbiddenTrees());
  if (!check.ok) {
    denyCopy(
      I,
      ctx,
      id,
      'sandbox.copy_out',
      `cannot copy files from a sandbox to ${dest}: ${check.reason}`,
      check.hint ??
        'Choose a destination in a normal project or download directory (not credential, system or abox directories).',
      { hostPath: dest, sandboxPath: source },
    );
  }
  const provider = await I.providerForRecord(rec);
  const started = Date.now();
  try {
    await provider.copyOut(id, source, dest);
  } catch (e) {
    I.audit(ctx.owner, 'sandbox.copy_out', {
      sandboxId: id,
      decision: 'error',
      details: { hostPath: dest, sandboxPath: source, message: errMessage(e) },
    });
    throw e;
  }
  const st = await stat(dest).catch(() => undefined);
  const size = st ? await treeSize(dest) : undefined;
  I.audit(ctx.owner, 'sandbox.copy_out', {
    sandboxId: id,
    decision: 'allow',
    details: {
      hostPath: dest,
      sandboxPath: source,
      ...(st ? { directory: st.isDirectory() } : {}),
      ...(size
        ? {
            files: size.files,
            bytes: size.bytes,
            ...(size.truncated ? { sizeTruncated: true } : {}),
          }
        : {}),
      durationMs: Date.now() - started,
    },
  });
  await collectNetworkEvents(I, rec, { throttleMs: NET_POLL_THROTTLE_MS });
}

// ---------------------------------------------------------------------------
// logs of the sandbox's main process
// ---------------------------------------------------------------------------

/** Combined stdout/stderr of the sandbox's main process, secrets masked. Owner (or human). */
export async function sandboxLogs(
  I: Internals,
  caller: Caller,
  id: string,
  o: SandboxLogsOptions = {},
): Promise<string> {
  const ctx = await I.context(caller);
  const rec = I.lookup(ctx, id);
  const opts = (o ?? {}) as SandboxLogsOptions;
  if (opts.tail !== undefined) intInRange(opts.tail, 'tail', 1, LOG_TAIL_MAX);
  if (opts.sinceTs !== undefined) intInRange(opts.sinceTs, 'sinceTs', 0, Number.MAX_SAFE_INTEGER);
  const provider = await I.providerForRecord(rec);
  if (!provider.logs) {
    throw new AboxError('unsupported', `backend '${rec.backend}' does not provide logs`, {
      hint: 'Use process logs (`abox process logs`) for background processes started in the sandbox.',
    });
  }
  const raw = await provider.logs(id, {
    ...(opts.tail !== undefined ? { tail: opts.tail } : {}),
    ...(opts.sinceTs !== undefined ? { sinceTs: opts.sinceTs } : {}),
  });
  const known = await I.secretValuesOf(rec);
  const masked = createSecretMasker(known)(raw);
  const cap = ctx.kind === 'human' ? HUMAN_LOG_MAX : AGENT_LOG_MAX;
  let text = masked;
  let truncated = false;
  if (Buffer.byteLength(masked) > cap) {
    // newest output matters most: keep the end
    const buf = Buffer.from(masked, 'utf8');
    text = truncateUtf8(buf.subarray(buf.length - cap).toString('utf8'), cap).text;
    truncated = true;
  }
  // Polling (`logs -f`, a GUI log view) is audited once per 10 s burst, not once per poll.
  if (I.firstWithin(`logs|${ctx.owner}|${id}`, 10_000)) {
    I.audit(ctx.owner, 'sandbox.logs', {
      sandboxId: id,
      decision: 'allow',
      details: {
        bytes: Buffer.byteLength(text),
        ...(truncated ? { truncated } : {}),
        ...(opts.tail !== undefined ? { tail: opts.tail } : {}),
        ...(opts.sinceTs !== undefined ? { sinceTs: opts.sinceTs } : {}),
      },
    });
  }
  await collectNetworkEvents(I, rec, { throttleMs: NET_POLL_THROTTLE_MS });
  return text;
}

// ---------------------------------------------------------------------------
// snapshots, policy history
// ---------------------------------------------------------------------------

/** Snapshots taken through the manager, oldest first. Owner (or human). */
export async function listSnapshots(
  I: Internals,
  caller: Caller,
  id: string,
): Promise<SnapshotView[]> {
  const ctx = await I.context(caller);
  const rec = I.lookup(ctx, id);
  return I.state.snapshots
    .list(rec.id)
    .map((s) => ({ id: s.snapshotId, name: s.name, createdAt: s.createdAt }));
}

/** Revisions of policy.yaml, newest first. Human only. */
export async function listPolicyRevisions(
  I: Internals,
  caller: Caller,
): Promise<PolicyRevisionSummary[]> {
  const ctx = await I.context(caller);
  I.requireHuman(ctx, 'policy.revisions');
  return I.state.policyRevisions
    .list()
    .map((r) => ({ rev: r.rev, ts: r.createdAt, actor: r.actor, contentHash: r.contentHash }));
}

/** One revision of policy.yaml with its full text. Human only. */
export async function getPolicyRevision(
  I: Internals,
  caller: Caller,
  rev: number,
): Promise<PolicyRevisionDetail> {
  const ctx = await I.context(caller);
  I.requireHuman(ctx, 'policy.revision');
  if (typeof rev !== 'number' || !Number.isInteger(rev) || rev < 1) {
    throw new AboxError('invalid_input', 'rev must be a positive integer');
  }
  const r = I.state.policyRevisions.get(rev);
  if (!r) throw new AboxError('not_found', `policy revision ${rev} not found`);
  return {
    rev: r.rev,
    ts: r.createdAt,
    actor: r.actor,
    contentHash: r.contentHash,
    content: r.content,
  };
}
