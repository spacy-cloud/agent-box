// @ts-check
/**
 * The ONLY module of the plugin that talks to abox. It runs `abox <args> --json` as a child process
 * and nothing else: no sandbox logic lives in the plugin.
 *
 * Rules
 *  - argv only (`shell: false`); every value that ends up in argv is validated first, so a value can
 *    never be read as an option (ids/names/templates must start with an alphanumeric character) and
 *    a malicious string can never reach a shell.
 *  - hard timeout (SIGTERM, then SIGKILL) and output caps; stdin is closed.
 *  - the abox binary is configurable (bare command name resolved through PATH, or an absolute path).
 *  - the plugin NEVER passes `--yes`: confirming risky settings or approving requests is a human
 *    decision that is made in the terminal, the abox GUI or `abox approvals`, not here.
 *
 * Contract with the CLI (`docs/internal/manager-api.md`, `packages/cli`): with `--json` stdout holds
 * exactly one document, `{ok: true, data}` or `{ok: false, code, message, hint?, issues?, details?}`;
 * exit codes 0 ok, 1 internal, 2 input, 3 policy/approval, 4 backend, 5 timeout.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { setTimeout, clearTimeout } from 'node:timers';

export const DEFAULT_TIMEOUT_MS = 25_000;
/** Image builds and exports can take minutes. Orca reaps an idle worker after 5 minutes. */
export const LONG_TIMEOUT_MS = 4 * 60_000;
export const MAX_STDOUT_BYTES = 32 * 1024 * 1024;
export const MAX_STDERR_BYTES = 64 * 1024;
const KILL_GRACE_MS = 2_000;

/** Exit codes of the abox CLI (docs/architecture.md, "Error model"). */
export const EXIT_CODES = Object.freeze({
  ok: 0,
  internal: 1,
  input: 2,
  denied: 3,
  backend: 4,
  timeout: 5,
});

const EXIT_CODE_NAMES = /** @type {Record<number, string>} */ ({
  1: 'internal',
  2: 'invalid_input',
  3: 'policy_denied',
  4: 'backend_error',
  5: 'timeout',
});

/** Sandbox ids (`local/ab12cd34`), names, template names, process ids. Never starts with `-`. */
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
const DURATION_RE = /^[0-9]+(?:\.[0-9]+)?(?:ms|s|m|h|d)?$/;
const WORKSPACE_MODES = ['mount', 'clone', 'worktree', 'copy', 'empty', 'sync'];
const EXPORT_FORMATS = ['diff', 'patch', 'branch', 'files'];
const SANDBOX_STATE_FILTER_RE = /^[a-z][a-z-]{0,31}$/;

/**
 * Error for everything that can go wrong when running abox. `code` is either an abox error code
 * (`policy_denied`, `not_found`, ...) or one of the plugin's own: `abox_not_found`, `spawn_failed`,
 * `timeout`, `aborted`, `invalid_output`, `output_too_large`, `invalid_argument`.
 */
export class AboxCliError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{exitCode?: number | null, hint?: string, details?: Record<string, unknown>, issues?: unknown[], stderr?: string, cause?: unknown}} [opts]
   */
  constructor(code, message, opts = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'AboxCliError';
    this.code = code;
    this.exitCode = opts.exitCode ?? null;
    this.hint = opts.hint;
    this.details = opts.details;
    this.issues = opts.issues ?? [];
    this.stderr = opts.stderr;
  }
}

/**
 * @param {unknown} value
 * @param {string} what
 */
export function assertRef(value, what) {
  if (typeof value !== 'string' || !REF_RE.test(value) || value.includes('..')) {
    throw new AboxCliError(
      'invalid_argument',
      `invalid ${what}: ${JSON.stringify(String(value).slice(0, 60))}`,
    );
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} what
 */
function assertAbsolutePath(value, what) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 4096 ||
    !value.startsWith('/') ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new AboxCliError(
      'invalid_argument',
      `${what} must be an absolute path without control characters`,
    );
  }
  return value;
}

/**
 * Validates the configured binary: a bare command name (resolved through PATH) or an absolute path.
 * @param {unknown} bin
 */
export function assertBinary(bin) {
  if (typeof bin !== 'string' || bin.length === 0 || bin.length > 4096) {
    throw new AboxCliError('invalid_argument', 'abox binary must be a non-empty string');
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(bin)) {
    throw new AboxCliError('invalid_argument', 'abox binary contains control characters');
  }
  const bare = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(bin);
  const absolute = bin.startsWith('/') || /^[A-Za-z]:[\\/]/.test(bin);
  if (!bare && !absolute) {
    throw new AboxCliError(
      'invalid_argument',
      'abox binary must be a bare command name or an absolute path',
    );
  }
  return bin;
}

/**
 * @typedef {import('node:child_process').ChildProcess} ChildProcess
 * @typedef {(command: string, args: readonly string[], options: Record<string, unknown>) => ChildProcess} SpawnFn
 */

/**
 * Runs a process and collects its output. Settles exactly once.
 * @param {SpawnFn} spawn
 * @param {string} bin
 * @param {readonly string[]} argv
 * @param {{timeoutMs: number, env?: NodeJS.ProcessEnv, signal?: AbortSignal, maxStdout?: number, maxStderr?: number}} opts
 * @returns {Promise<{code: number | null, signal: string | null, stdout: string, stderr: string}>}
 */
export function runProcess(spawn, bin, argv, opts) {
  const maxStdout = opts.maxStdout ?? MAX_STDOUT_BYTES;
  const maxStderr = opts.maxStderr ?? MAX_STDERR_BYTES;
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new AboxCliError('aborted', 'cancelled before start'));
      return;
    }
    /** @type {ChildProcess} */
    let child;
    try {
      child = spawn(bin, argv, {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: opts.env ?? process.env,
        windowsHide: true,
      });
    } catch (cause) {
      reject(spawnError(bin, cause));
      return;
    }

    let settled = false;
    /** @type {Buffer[]} */
    const out = [];
    /** @type {Buffer[]} */
    const err = [];
    let outBytes = 0;
    let errBytes = 0;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let killTimer;

    /** @param {() => void} fn */
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const kill = () => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, KILL_GRACE_MS);
      // Do not keep the worker alive only for the kill timer.
      killTimer.unref?.();
    };
    const timer = setTimeout(() => {
      kill();
      finish(() =>
        reject(
          new AboxCliError(
            'timeout',
            `abox did not finish within ${Math.round(opts.timeoutMs / 1000)}s`,
          ),
        ),
      );
    }, opts.timeoutMs);
    const onAbort = () => {
      kill();
      finish(() => reject(new AboxCliError('aborted', 'cancelled')));
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (/** @type {Buffer | string} */ chunk) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      outBytes += buf.length;
      if (outBytes > maxStdout) {
        kill();
        finish(() =>
          reject(new AboxCliError('output_too_large', `abox output exceeds ${maxStdout} bytes`)),
        );
        return;
      }
      out.push(buf);
    });
    child.stderr?.on('data', (/** @type {Buffer | string} */ chunk) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      if (errBytes >= maxStderr) return;
      errBytes += buf.length;
      err.push(buf);
    });
    child.on('error', (cause) => finish(() => reject(spawnError(bin, cause))));
    child.on('close', (code, signal) =>
      finish(() =>
        resolve({
          code,
          signal,
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(err).toString('utf8').slice(0, maxStderr),
        }),
      ),
    );
  });
}

/**
 * @param {string} bin
 * @param {unknown} cause
 */
function spawnError(bin, cause) {
  const errno = /** @type {{code?: string}} */ (cause)?.code;
  if (errno === 'ENOENT') {
    return new AboxCliError('abox_not_found', `cannot run "${bin}": not found`, {
      hint: 'Install abox, add it to PATH, or set "aboxPath" in ~/.config/abox/orca-plugin.json.',
      cause,
    });
  }
  const msg = cause instanceof Error ? cause.message : String(cause);
  return new AboxCliError('spawn_failed', `cannot run "${bin}": ${msg}`, { cause });
}

/**
 * Parses `{ok, ...}` from stdout. Returns null when stdout is not a JSON envelope.
 * @param {string} stdout
 * @returns {{ok: true, data: unknown} | {ok: false, body: Record<string, unknown>} | null}
 */
export function parseEnvelope(stdout) {
  const text = stdout.trim();
  if (!text) return null;
  /** @type {unknown} */
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
  const rec = /** @type {Record<string, unknown>} */ (doc);
  if (rec['ok'] === true) return { ok: true, data: rec['data'] };
  if (rec['ok'] === false) return { ok: false, body: rec };
  return null;
}

/**
 * @param {string} text
 * @param {number} max
 */
function firstLine(text, max = 300) {
  const line = text.split('\n').find((l) => l.trim().length > 0) ?? '';
  return line.trim().slice(0, max);
}

/**
 * @typedef {object} AboxCliOptions
 * @property {string} [bin] abox binary (bare name or absolute path); default `abox`
 * @property {number} [timeoutMs] default timeout for quick calls
 * @property {SpawnFn} [spawn] injection point for tests
 * @property {NodeJS.ProcessEnv} [env]
 */

/**
 * @param {AboxCliOptions} [options]
 */
export function createAboxCli(options = {}) {
  const bin = assertBinary(options.bin ?? 'abox');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const spawn = options.spawn ?? /** @type {SpawnFn} */ (nodeSpawn);
  const env = { ...(options.env ?? process.env), NO_COLOR: '1', ABOX_NO_COLOR: '1' };

  /**
   * Runs `abox <args> --json` and returns `data`. Throws AboxCliError for `ok:false`, a non-zero
   * exit, a timeout, a missing binary or output that is not the documented envelope.
   * @param {readonly string[]} args
   * @param {{timeoutMs?: number, signal?: AbortSignal}} [callOpts]
   * @returns {Promise<unknown>}
   */
  async function call(args, callOpts = {}) {
    const argv = [...args, '--json'];
    const res = await runProcess(spawn, bin, argv, {
      timeoutMs: callOpts.timeoutMs ?? timeoutMs,
      env,
      ...(callOpts.signal ? { signal: callOpts.signal } : {}),
    });
    const envelope = parseEnvelope(res.stdout);
    if (envelope?.ok === true && res.code === 0) return envelope.data;
    if (envelope?.ok === false) {
      const b = envelope.body;
      const code =
        typeof b['code'] === 'string' ? b['code'] : (EXIT_CODE_NAMES[res.code ?? 1] ?? 'internal');
      throw new AboxCliError(
        code,
        typeof b['message'] === 'string' ? b['message'] : `abox failed (${code})`,
        {
          exitCode: res.code,
          ...(typeof b['hint'] === 'string' ? { hint: b['hint'] } : {}),
          ...(b['details'] && typeof b['details'] === 'object'
            ? { details: /** @type {Record<string, unknown>} */ (b['details']) }
            : {}),
          ...(Array.isArray(b['issues']) ? { issues: b['issues'] } : {}),
          stderr: res.stderr,
        },
      );
    }
    if (res.code === 0 || envelope?.ok === true) {
      throw new AboxCliError('invalid_output', 'abox did not return the documented JSON envelope', {
        exitCode: res.code,
        stderr: res.stderr,
      });
    }
    // Non-zero exit without a JSON envelope (crash, old abox without --json, ...).
    const code = res.signal ? 'aborted' : (EXIT_CODE_NAMES[res.code ?? 1] ?? 'internal');
    throw new AboxCliError(
      code,
      firstLine(res.stderr) || `abox exited with code ${res.code ?? res.signal}`,
      {
        exitCode: res.code,
        stderr: res.stderr,
      },
    );
  }

  return {
    bin,

    call,

    /** `abox doctor --json` */
    async doctor() {
      return call(['doctor']);
    },

    /**
     * `abox ls --json` -> `{sandboxes, orphans, unreachableHosts}`.
     * @param {{all?: boolean, state?: string}} [opts]
     */
    async listSandboxes(opts = {}) {
      const args = ['ls'];
      if (opts.all) args.push('--all');
      if (opts.state !== undefined) {
        if (!SANDBOX_STATE_FILTER_RE.test(opts.state))
          throw new AboxCliError('invalid_argument', 'invalid state filter');
        args.push('--state', opts.state);
      }
      return normalizeSandboxList(await call(args));
    },

    /**
     * `abox create <template> --mode ... --workspace ... --json`. The plugin does not pass `--yes`.
     * @param {{template: string, name?: string, workspace?: string, project?: string, mode?: string, ref?: string, ttl?: string, requestId?: string}} req
     * @param {{timeoutMs?: number, signal?: AbortSignal}} [callOpts]
     */
    async createSandbox(req, callOpts = {}) {
      const args = ['create', assertRef(req.template, 'template')];
      if (req.name !== undefined) args.push('--name', assertRef(req.name, 'sandbox name'));
      if (req.workspace !== undefined)
        args.push('--workspace', assertAbsolutePath(req.workspace, 'workspace'));
      // Project templates (.sandbox/*.yaml) are looked up in --project; default is the process cwd.
      if (req.project !== undefined)
        args.push('--project', assertAbsolutePath(req.project, 'project'));
      if (req.mode !== undefined) {
        if (!WORKSPACE_MODES.includes(req.mode))
          throw new AboxCliError('invalid_argument', `invalid workspace mode: ${req.mode}`);
        args.push('--mode', req.mode);
      }
      if (req.ref !== undefined) args.push('--ref', assertRef(req.ref, 'git ref'));
      if (req.ttl !== undefined) {
        if (!DURATION_RE.test(req.ttl))
          throw new AboxCliError('invalid_argument', `invalid ttl: ${req.ttl}`);
        args.push('--ttl', req.ttl);
      }
      if (req.requestId !== undefined)
        args.push('--request-id', assertRef(req.requestId, 'request id'));
      const data = /** @type {Record<string, unknown>} */ (
        asRecord(await call(args, { timeoutMs: LONG_TIMEOUT_MS, ...callOpts }))
      );
      return {
        status: typeof data['status'] === 'string' ? data['status'] : 'created',
        sandbox: normalizeSandbox(data['sandbox']),
        idempotent: data['idempotent'] === true,
        warnings: asStringArray(data['warnings']),
      };
    },

    /** @param {string} id */
    async startSandbox(id) {
      return call(['start', assertRef(id, 'sandbox id')]);
    },

    /** @param {string} id */
    async stopSandbox(id) {
      return call(['stop', assertRef(id, 'sandbox id')]);
    },

    /**
     * @param {string[]} ids
     * @param {{force?: boolean}} [opts]
     */
    async removeSandboxes(ids, opts = {}) {
      if (ids.length === 0) throw new AboxCliError('invalid_argument', 'no sandbox given');
      const args = ['rm'];
      if (opts.force) args.push('--force');
      for (const id of ids) args.push(assertRef(id, 'sandbox id'));
      return call(args);
    },

    /**
     * `abox export <id> --format diff --json`. Never applies anything to the host.
     * @param {string} id
     * @param {{format?: string, signal?: AbortSignal}} [opts]
     */
    async exportSandbox(id, opts = {}) {
      const format = opts.format ?? 'diff';
      if (!EXPORT_FORMATS.includes(format))
        throw new AboxCliError('invalid_argument', `invalid export format: ${format}`);
      const data = asRecord(
        await call(['export', assertRef(id, 'sandbox id'), '--format', format], {
          timeoutMs: LONG_TIMEOUT_MS,
          ...(opts.signal ? { signal: opts.signal } : {}),
        }),
      );
      return normalizeExport(data);
    },

    /** `abox approvals ls --json` -> pending approvals first. */
    async listApprovals() {
      return normalizeApprovals(await call(['approvals', 'ls']));
    },

    /**
     * `abox template ls --json`
     * @param {{project?: string}} [opts] worktree whose `.sandbox/` templates should be included
     */
    async listTemplates(opts = {}) {
      const args = ['template', 'ls'];
      if (opts.project !== undefined)
        args.push('--project', assertAbsolutePath(opts.project, 'project'));
      return normalizeTemplates(await call(args));
    },
  };
}

// -- normalisation: the plugin only reads the few fields it shows -------------------------------

/** @param {unknown} v @returns {Record<string, unknown>} */
function asRecord(v) {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? /** @type {Record<string, unknown>} */ (v)
    : {};
}
/** @param {unknown} v */
function asStringArray(v) {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
}
/** @param {unknown} v */
function asNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
/** @param {unknown} v @param {string} fallback */
function asString(v, fallback = '') {
  return typeof v === 'string' ? v : fallback;
}
/**
 * `data` is either the array itself or an object that holds it under `key`.
 * @param {unknown} data
 * @param {string} key
 * @returns {unknown[]}
 */
function pickArray(data, key) {
  if (Array.isArray(data)) return data;
  const v = asRecord(data)[key];
  return Array.isArray(v) ? v : [];
}

/**
 * @typedef {object} SandboxSummary
 * @property {string} id
 * @property {string} name
 * @property {string} template
 * @property {string} state
 * @property {string} host
 * @property {string} owner
 * @property {number | null} ttlRemainingMs
 * @property {number | null} expiresAt
 * @property {boolean} expired
 * @property {boolean} stale
 * @property {{mode: string, source: string | null, branch: string | null} | null} workspace
 */

/**
 * @param {unknown} raw
 * @returns {SandboxSummary | null}
 */
export function normalizeSandbox(raw) {
  const s = asRecord(raw);
  const id = s['id'];
  if (typeof id !== 'string' || !REF_RE.test(id)) return null;
  const ws = s['workspace'] && typeof s['workspace'] === 'object' ? asRecord(s['workspace']) : null;
  return {
    id,
    name: asString(s['name']),
    template: asString(s['template']),
    state: asString(s['state'], 'unknown'),
    host: asString(s['host'], 'local'),
    owner: asString(s['owner']),
    ttlRemainingMs: asNumber(s['ttlRemainingMs']),
    expiresAt: asNumber(s['expiresAt']),
    expired: s['expired'] === true,
    stale: s['stale'] === true || s['missingInBackend'] === true,
    workspace: ws
      ? {
          mode: asString(ws['mode']),
          source: typeof ws['source'] === 'string' ? ws['source'] : null,
          branch: typeof ws['branch'] === 'string' ? ws['branch'] : null,
        }
      : null,
  };
}

/** @param {unknown} data */
export function normalizeSandboxList(data) {
  const rec = asRecord(data);
  return {
    sandboxes: /** @type {SandboxSummary[]} */ (
      pickArray(data, 'sandboxes')
        .map(normalizeSandbox)
        .filter((s) => s !== null)
    ),
    orphans: pickArray(rec, 'orphans').length,
    unreachableHosts: asStringArray(rec['unreachableHosts']),
  };
}

/**
 * @typedef {object} ApprovalSummary
 * @property {string} id
 * @property {string} kind
 * @property {string} status
 * @property {string} requester
 * @property {string | null} sandboxId
 * @property {string[]} risks abox's own computed risks (trusted); the agent-written `reason` is dropped on purpose
 * @property {number | null} expiresAt
 */

/** @param {unknown} data */
export function normalizeApprovals(data) {
  /** @type {ApprovalSummary[]} */
  const all = [];
  for (const raw of pickArray(data, 'approvals')) {
    const a = asRecord(raw);
    const id = a['id'];
    if (typeof id !== 'string' || id.length === 0) continue;
    all.push({
      id,
      kind: asString(a['kind'], 'unknown'),
      status: asString(a['status'], 'pending'),
      requester: asString(a['requester']),
      sandboxId: typeof a['sandboxId'] === 'string' ? a['sandboxId'] : null,
      risks: asStringArray(a['risks']),
      expiresAt: asNumber(a['expiresAt']),
    });
  }
  return { all, pending: all.filter((a) => a.status === 'pending') };
}

/** @param {unknown} data */
export function normalizeTemplates(data) {
  /** @type {Array<{name: string, description: string, usable: boolean}>} */
  const templates = [];
  for (const raw of pickArray(data, 'templates')) {
    const t = asRecord(raw);
    const name = t['name'];
    if (typeof name !== 'string' || !REF_RE.test(name)) continue;
    templates.push({
      name,
      description: asString(t['description']),
      // `trusted`/`allowed`/`backendAvailable` are optional in the contract: absent counts as usable.
      usable: t['trusted'] !== false && t['allowed'] !== false && t['backendAvailable'] !== false,
    });
  }
  return templates;
}

/** @param {Record<string, unknown>} data */
export function normalizeExport(data) {
  const stats = asRecord(data['stats']);
  const files = Array.isArray(data['files']) ? data['files'] : [];
  const flagged = Array.isArray(data['flagged']) ? data['flagged'] : [];
  return {
    format: asString(data['format'], 'diff'),
    content: typeof data['content'] === 'string' ? data['content'] : null,
    contentLossy: data['contentLossy'] === true,
    files: asNumber(stats['filesChanged']) ?? files.length,
    flagged: flagged
      .map((f) => (typeof f === 'string' ? f : asString(asRecord(f)['path'])))
      .filter((p) => p.length > 0),
    stats: {
      additions: asNumber(stats['additions']) ?? asNumber(stats['insertions']),
      deletions: asNumber(stats['deletions']),
    },
    warnings: asStringArray(data['warnings']),
  };
}
