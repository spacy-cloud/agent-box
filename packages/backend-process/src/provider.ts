import {
  chmod,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  stat,
  lstat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { access, constants as fsConstants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  AboxError,
  SKILLS_DIR_ENV,
  isolationAtLeast,
  type BackendStatus,
  type DirEntry,
  type ExecEvent,
  type ExecRequest,
  type ExecResult,
  type HostConnection,
  type PreparedImage,
  type PrepareOptions,
  type ProviderCapabilities,
  type ProviderFactory,
  type ProviderSnapshot,
  type ResolvedTemplate,
  type SandboxFilter,
  type SandboxId,
  type SandboxInfo,
  type SandboxProvider,
  type SandboxSpec,
  type SandboxState,
  type TtyOptions,
  type TtySession,
} from '@abox/core';
import {
  copyTree,
  errno,
  makeExcludeFilter,
  mapFsError,
  randomSuffix,
  rmTree,
  treeBytes,
  writeFileAtomic,
} from './fsutil.js';
import { confine, normalizeSandboxPath } from './paths.js';
import { killTracked, runProcess } from './run.js';
import {
  IMAGE_HASH_RE,
  KeyedMutex,
  Layout,
  SNAPSHOT_NAME_RE,
  USER_RE,
  type SandboxMeta,
  type StoredState,
} from './store.js';

/** Default per-stream output cap of `exec` when the request sets none. */
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
/** Grace period between SIGTERM and SIGKILL in `stop()`. */
const STOP_GRACE_MS = 1000;

export interface ProcessProviderOptions {
  /** Root for all backend data. Defaults to `host.dataDir`. One of the two is required. */
  dataDir?: string;
  /** Clock, injectable for tests. */
  now?: () => number;
}

const NO_ISOLATION =
  'The process backend runs plain host processes (isolation level "none"); use a container backend for this.';

function unsupported(message: string, hint = NO_ISOLATION): AboxError {
  return new AboxError('unsupported', message, { hint });
}

/** Collects one output stream up to a byte cap. */
class CappedBuffer {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  truncated = false;

  constructor(private readonly cap: number) {}

  push(data: Buffer): void {
    const room = this.cap - this.bytes;
    if (data.length > room) {
      if (room > 0) {
        this.chunks.push(data.subarray(0, room));
        this.bytes += room;
      }
      this.truncated = true;
      return;
    }
    this.chunks.push(data);
    this.bytes += data.length;
  }

  toString(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

interface Loaded {
  short: string;
  meta: SandboxMeta;
}

interface RunPlan {
  short: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  runDir: string;
}

/**
 * Reference backend: a sandbox is a directory plus host processes. Isolation level
 * `none`: nothing restricts what a command can do. See README/doc comments in
 * `paths.ts` and `run.ts` for what is and is not guaranteed.
 */
export class ProcessProvider implements SandboxProvider {
  readonly kind = 'process' as const;
  readonly isolation = 'none' as const;
  readonly host: HostConnection;

  private readonly layout: Layout;
  private readonly now: () => number;
  private readonly mutex = new KeyedMutex();

  constructor(host: HostConnection, opts: ProcessProviderOptions = {}) {
    const dataDir = opts.dataDir ?? host.dataDir;
    if (!dataDir) {
      throw new AboxError(
        'invalid_input',
        'process backend needs a data directory (HostConnection.dataDir or options.dataDir)',
      );
    }
    if (host.kind !== 'local') {
      throw unsupported(
        `process backend runs on the local host only (host '${host.host}' is ${host.kind})`,
      );
    }
    this.host = host;
    this.layout = new Layout(dataDir);
    this.now = opts.now ?? Date.now;
  }

  // -- capabilities / status -----------------------------------------------------------------

  capabilities(): ProviderCapabilities {
    return {
      isolation: 'none',
      // Only 'open' is truthful: nothing can restrict the network of a host process.
      networkModes: ['open'],
      networkFilter: false,
      // 'bind' is deliberately unsupported, see create().
      workspaceDelivery: ['none', 'copy'],
      mounts: false,
      snapshots: true,
      tty: false,
      extendExpiry: true,
      limits: { cpus: false, memory: false, pids: false, disk: false },
      // Commands run as the host user; there is no way to switch to another (non-root) user.
      nonRootUser: false,
      secretInjection: ['env', 'file'],
      // The process backend cannot prepare any particular OS: it uses whatever the host is.
      // 'unknown' = "no base OS selected"; templates naming a distro family are rejected.
      osFamilies: ['unknown'],
      remote: false,
    };
  }

  async status(): Promise<BackendStatus> {
    const details: string[] = [
      `data directory: ${this.layout.base}`,
      `node ${process.version} on ${process.platform}`,
    ];
    const warnings: string[] = [
      'isolation level "none": commands run as the host user with full access to the host (file APIs are confined, commands are not)',
      'network cannot be restricted; resource limits are not enforced',
    ];
    let ok = true;
    try {
      await this.layout.ensureBase();
      const probe = join(this.layout.base, `.probe-${randomSuffix()}`);
      await writeFile(probe, 'ok');
      await unlink(probe);
      details.push('data directory is writable');
    } catch (e) {
      ok = false;
      details.push(`data directory is not usable: ${e instanceof Error ? e.message : String(e)}`);
    }
    const shOk = await new Promise<boolean>((r) =>
      access('/bin/sh', fsConstants.X_OK, (err) => r(!err)),
    );
    if (!shOk) {
      ok = false;
      details.push('/bin/sh is missing or not executable');
    }
    return { ok, version: `node ${process.version}`, details, warnings, advisories: [...warnings] };
  }

  // -- images ----------------------------------------------------------------------------------

  async prepare(template: ResolvedTemplate, opts: PrepareOptions = {}): Promise<PreparedImage> {
    if (!IMAGE_HASH_RE.test(template.hash)) {
      throw new AboxError('invalid_input', `invalid template hash '${template.hash}'`);
    }
    if (template.backend !== 'process') {
      throw new AboxError(
        'invalid_input',
        `template '${template.name}' is for backend '${template.backend}', not 'process'`,
      );
    }
    if (!isolationAtLeast('none', template.isolation)) {
      throw unsupported(
        `template '${template.name}' requires isolation '${template.isolation}', this backend delivers 'none'`,
      );
    }
    if (template.build.length > 0) {
      throw unsupported(
        `template '${template.name}' has ${template.build.length} build step(s) (packages, tools or setup); the process backend cannot install packages on the host`,
        'Remove packages/tools/setup from the template or use a container backend. Build steps are never run on the host.',
      );
    }
    if (template.base.dockerfile) {
      throw unsupported(
        `template '${template.name}' uses a Dockerfile; the process backend has no environment images`,
      );
    }
    if (template.base.osFamily !== 'unknown') {
      throw unsupported(
        `template '${template.name}' selects OS family '${template.base.osFamily}'; the process backend always uses the host OS`,
      );
    }
    await this.layout.ensureBase();
    const marker = join(this.layout.imagesDir, template.hash);
    const content =
      JSON.stringify({ hash: template.hash, template: template.name, createdAt: this.now() }) +
      '\n';
    let cached = false;
    try {
      await writeFile(marker, content, { flag: opts.update ? 'w' : 'wx', mode: 0o600 });
    } catch (e) {
      if (errno(e) !== 'EEXIST') throw mapFsError(e, 'image marker');
      cached = true;
    }
    // Nothing is built; the "image" is only the marker that this template was prepared.
    return { ref: `process:${template.hash}`, templateHash: template.hash, cached };
  }

  async gcImages(keep: string[]): Promise<string[]> {
    const keepSet = new Set(keep);
    let names: string[];
    try {
      names = await readdir(this.layout.imagesDir);
    } catch (e) {
      if (errno(e) === 'ENOENT') return [];
      throw mapFsError(e, 'images directory');
    }
    const removed: string[] = [];
    for (const name of names.sort()) {
      if (!IMAGE_HASH_RE.test(name) || keepSet.has(name)) continue;
      await unlink(join(this.layout.imagesDir, name)).catch(() => undefined);
      removed.push(`process:${name}`);
    }
    return removed;
  }

  // -- lifecycle -------------------------------------------------------------------------------

  async create(spec: SandboxSpec): Promise<SandboxInfo> {
    // 1. Validate everything before touching the disk. Nothing is created on rejection.
    const short = this.layout.shortOf(spec.id, this.host.host);
    if (short === undefined) {
      throw new AboxError(
        'invalid_input',
        `invalid sandbox id '${spec.id}' for host '${this.host.host}'`,
        {
          hint: `Expected '${this.host.host}/<short>' with <short> matching [A-Za-z0-9][A-Za-z0-9_-]*.`,
        },
      );
    }
    if (spec.network.mode !== 'open') {
      throw unsupported(
        `network mode '${spec.network.mode}' is not supported: the process backend cannot restrict network access`,
        'Use network mode "open", or a container backend for "none" and "allowlist".',
      );
    }
    if (spec.network.injections.length > 0) {
      throw unsupported(
        'proxy header injection is not supported: there is no egress proxy in the process backend',
      );
    }
    if (spec.mounts.length > 0) {
      throw unsupported('additional mounts are not supported by the process backend');
    }
    if (!isolationAtLeast('none', spec.template.isolation)) {
      throw unsupported(
        `template requires isolation '${spec.template.isolation}', this backend delivers 'none'`,
      );
    }
    if (!USER_RE.test(spec.user.name)) {
      throw new AboxError('invalid_input', `invalid sandbox user name '${spec.user.name}'`);
    }
    const workspace = spec.workspace;
    if (workspace.kind === 'bind') {
      // Decision: bind is unsupported. A bind would mean either a symlink root/workspace -> host
      // directory (the sandbox path would silently alias a host path and the "copy-free" semantics
      // would leak writes) or running with cwd = host path (the sandbox path would then not map to
      // anything). Neither is a sandbox mapping; `copy` + `copyOut` is the honest equivalent.
      throw unsupported(
        'workspace delivery "bind" is not supported by the process backend',
        'Use delivery "copy" (and copyOut to get results back) or a container backend.',
      );
    }
    if (workspace.kind !== 'none' && workspace.kind !== 'copy') {
      throw new AboxError(
        'invalid_input',
        `unknown workspace delivery kind '${String((workspace as { kind: unknown }).kind)}'`,
      );
    }
    const wsPath = normalizeSandboxPath(workspace.sandboxPath);
    for (const f of spec.files) normalizeSandboxPath(f.sandboxPath, wsPath);

    let copySource: string | undefined;
    if (workspace.kind === 'copy') {
      try {
        copySource = await realpath(workspace.hostPath);
        if (!(await stat(copySource)).isDirectory()) {
          throw new AboxError(
            'invalid_input',
            `workspace source '${workspace.hostPath}' is not a directory`,
          );
        }
      } catch (e) {
        throw mapFsError(e, `workspace source '${workspace.hostPath}'`);
      }
    }

    // 2. Create the directory; `meta.json` is written last, so a half-built sandbox is invisible to list().
    await this.layout.ensureBase();
    const dir = this.layout.sandboxDir(short);
    this.layout.assertWithinSandboxes(dir);
    try {
      await mkdir(dir, { mode: 0o700 });
    } catch (e) {
      if (errno(e) === 'EEXIST') {
        throw new AboxError('conflict', `sandbox '${spec.id}' already exists`);
      }
      throw mapFsError(e, 'sandbox directory');
    }

    const rootDir = this.layout.rootDir(short);
    const meta: SandboxMeta = {
      version: 1,
      id: spec.id,
      host: spec.host,
      short,
      name: spec.name,
      owner: spec.owner,
      template: spec.template.name,
      templateHash: spec.template.hash,
      createdAt: spec.createdAt,
      expiresAt: spec.expiresAt,
      labels: { ...spec.labels },
      state: 'created',
      user: { ...spec.user },
      workspacePath: wsPath,
      workspaceKind: workspace.kind,
    };
    try {
      await mkdir(rootDir, { mode: 0o755 });
      await mkdir(join(rootDir, 'tmp'), { mode: 0o1777 });
      await chmod(join(rootDir, 'tmp'), 0o1777);
      await mkdir(join(rootDir, 'home', spec.user.name), { recursive: true, mode: 0o755 });
      const wsHost = join(rootDir, ...wsPath.split('/').filter(Boolean));
      if (workspace.kind === 'copy' && copySource) {
        await mkdir(dirname(wsHost), { recursive: true });
        // Symlinks in the source are preserved as symlinks and never followed.
        await copyTree(copySource, wsHost, makeExcludeFilter(workspace.exclude, copySource));
      } else {
        await mkdir(wsHost, { recursive: true });
      }
      for (const f of spec.files) {
        const target = await confine(rootDir, f.sandboxPath, wsPath, 'create');
        await mkdir(dirname(target.hostPath), { recursive: true });
        await writeFile(target.hostPath, f.content, { mode: f.mode });
        await chmod(target.hostPath, f.mode);
      }
      await mkdir(this.layout.runDir(short), { mode: 0o700 });
      // env may contain approved `inject: env` secrets: private file, never part of meta/inspect.
      await writeFileAtomic(this.layout.envFile(short), JSON.stringify(spec.env), 0o600);
      await this.layout.writeMeta(meta);
    } catch (e) {
      await rmTree(dir).catch(() => undefined);
      throw mapFsError(e, `creating sandbox '${spec.id}'`);
    }
    return this.toInfo(meta);
  }

  async start(id: SandboxId): Promise<void> {
    const { short } = await this.load(id);
    await this.mutex.run(short, async () => {
      const meta = await this.requireMeta(id, short);
      if (this.isExpired(meta)) {
        throw new AboxError('conflict', `sandbox '${id}' has expired and cannot be started`);
      }
      if (meta.state !== 'running') await this.setState(meta, 'running');
    });
  }

  /** The expiry is `meta.expiresAt` (state and every check derive from it): moving it is the whole job. */
  async extendExpiry(id: SandboxId, expiresAt: number): Promise<void> {
    const { short } = await this.load(id);
    await this.mutex.run(short, async () => {
      const meta = await this.requireMeta(id, short);
      if (this.isExpired(meta)) {
        throw new AboxError('conflict', `sandbox '${id}' has expired and cannot be extended`);
      }
      if (!Number.isFinite(expiresAt) || expiresAt < meta.expiresAt) {
        throw new AboxError(
          'invalid_input',
          `the new expiry must not be earlier than the current one (${new Date(meta.expiresAt).toISOString()})`,
        );
      }
      if (expiresAt > meta.expiresAt) await this.layout.writeMeta({ ...meta, expiresAt });
    });
  }

  async stop(id: SandboxId): Promise<void> {
    const { short } = await this.load(id);
    await this.mutex.run(short, async () => {
      const meta = await this.requireMeta(id, short);
      if (meta.state !== 'stopped') await this.setState(meta, 'stopped');
    });
    await killTracked(this.layout.runDir(short), STOP_GRACE_MS);
  }

  async remove(id: SandboxId): Promise<void> {
    const short = this.layout.shortOf(id, this.host.host);
    if (short === undefined) return; // cannot exist
    const dir = this.layout.sandboxDir(short);
    this.layout.assertWithinSandboxes(dir);
    if (
      !(await lstat(dir).then(
        () => true,
        () => false,
      ))
    )
      return;
    await this.mutex.run(short, async () => {
      await killTracked(this.layout.runDir(short), 0);
      try {
        await rmTree(dir);
      } catch (e) {
        throw mapFsError(e, `removing sandbox '${id}'`);
      }
    });
  }

  // -- exec ------------------------------------------------------------------------------------

  async exec(id: SandboxId, req: ExecRequest): Promise<ExecResult> {
    const plan = await this.planRun(id, req);
    const cap = this.outputCap(req);
    const out = new CappedBuffer(cap);
    const err = new CappedBuffer(cap);
    const started = Date.now();
    const outcome = await runProcess({
      argv: plan.argv,
      cwd: plan.cwd,
      env: plan.env,
      ...(req.stdin !== undefined ? { stdin: req.stdin } : {}),
      ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
      ...(req.signal ? { signal: req.signal } : {}),
      runDir: plan.runDir,
      onStdout: (d) => out.push(d),
      onStderr: (d) => err.push(d),
    });
    if (outcome.aborted) {
      throw req.signal?.reason instanceof Error
        ? req.signal.reason
        : new AboxError('internal', 'exec aborted');
    }
    return {
      exitCode: outcome.exitCode,
      stdout: out.toString(),
      stderr: err.toString(),
      truncated: out.truncated || err.truncated,
      timedOut: outcome.timedOut,
      durationMs: Date.now() - started,
    };
  }

  /**
   * Streaming execution. Starts on the first `next()`. `maxOutputBytes` is not applied here: a
   * stream has no truncation flag, the consumer decides how much to read. Leaving the loop
   * early kills the command's process group.
   */
  async *spawn(id: SandboxId, req: ExecRequest): AsyncIterable<ExecEvent> {
    const plan = await this.planRun(id, req);
    const queue: ExecEvent[] = [];
    let wake: (() => void) | undefined;
    const push = (ev: ExecEvent): void => {
      queue.push(ev);
      wake?.();
    };
    const consumerGone = new AbortController();
    const signal = req.signal
      ? AbortSignal.any([req.signal, consumerGone.signal])
      : consumerGone.signal;
    let finished = false;
    const running = runProcess({
      argv: plan.argv,
      cwd: plan.cwd,
      env: plan.env,
      ...(req.stdin !== undefined ? { stdin: req.stdin } : {}),
      ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
      signal,
      runDir: plan.runDir,
      onStdout: (data) => push({ type: 'stdout', data }),
      onStderr: (data) => push({ type: 'stderr', data }),
    }).then((o) => {
      finished = true;
      push({ type: 'exit', exitCode: o.exitCode, timedOut: o.timedOut });
    });
    try {
      for (;;) {
        while (queue.length > 0) {
          const ev = queue.shift() as ExecEvent;
          yield ev;
          if (ev.type === 'exit') return;
        }
        await new Promise<void>((resolveWake) => {
          wake = resolveWake;
        });
        wake = undefined;
      }
    } finally {
      if (!finished) {
        consumerGone.abort();
        await running;
      }
    }
  }

  async attach(_id: SandboxId, _tty: TtyOptions): Promise<TtySession> {
    throw unsupported(
      'interactive terminals are not supported by the process backend (no pty available)',
      'Use exec/spawn, or a container backend for attach.',
    );
  }

  // -- files -----------------------------------------------------------------------------------

  async copyIn(id: SandboxId, hostPath: string, sandboxPath: string): Promise<void> {
    const { short, meta } = await this.load(id);
    let src: string;
    try {
      src = await realpath(resolve(hostPath));
    } catch (e) {
      throw mapFsError(e, `host path '${hostPath}'`);
    }
    const target = await confine(
      this.layout.rootDir(short),
      sandboxPath,
      meta.workspacePath,
      'create',
    );
    try {
      await mkdir(dirname(target.hostPath), { recursive: true });
      await copyTree(src, target.hostPath);
    } catch (e) {
      throw mapFsError(e, `copyIn '${hostPath}' -> '${target.sandboxPath}'`);
    }
  }

  async copyOut(id: SandboxId, sandboxPath: string, hostPath: string): Promise<void> {
    const { short, meta } = await this.load(id);
    const source = await confine(
      this.layout.rootDir(short),
      sandboxPath,
      meta.workspacePath,
      'existing',
    );
    const dest = resolve(hostPath);
    try {
      await mkdir(dirname(dest), { recursive: true });
      // Symlinks inside the tree are copied as symlinks, never followed.
      await copyTree(source.hostPath, dest);
    } catch (e) {
      throw mapFsError(e, `copyOut '${source.sandboxPath}' -> '${hostPath}'`);
    }
  }

  async readFile(
    id: SandboxId,
    sandboxPath: string,
    maxBytes: number,
  ): Promise<{ data: Buffer; truncated: boolean; size: number }> {
    if (!Number.isInteger(maxBytes) || maxBytes < 0) {
      throw new AboxError(
        'invalid_input',
        `maxBytes must be a non-negative integer, got ${maxBytes}`,
      );
    }
    const { short, meta } = await this.load(id);
    const target = await confine(
      this.layout.rootDir(short),
      sandboxPath,
      meta.workspacePath,
      'existing',
    );
    try {
      const st = await stat(target.hostPath);
      if (!st.isFile()) {
        throw new AboxError('invalid_input', `'${target.sandboxPath}' is not a regular file`);
      }
      const fh = await open(target.hostPath, 'r');
      try {
        const size = (await fh.stat()).size;
        const want = Math.min(size, maxBytes);
        const data = Buffer.alloc(want);
        let off = 0;
        while (off < want) {
          const { bytesRead } = await fh.read(data, off, want - off, off);
          if (bytesRead === 0) break;
          off += bytesRead;
        }
        return { data: data.subarray(0, off), truncated: size > maxBytes, size };
      } finally {
        await fh.close();
      }
    } catch (e) {
      throw mapFsError(e, `reading '${target.sandboxPath}'`);
    }
  }

  async writeFile(id: SandboxId, sandboxPath: string, data: Buffer, mode?: number): Promise<void> {
    const { short, meta } = await this.load(id);
    const target = await confine(
      this.layout.rootDir(short),
      sandboxPath,
      meta.workspacePath,
      'create',
    );
    if (target.sandboxPath === '/')
      throw new AboxError('invalid_input', 'cannot write to the sandbox root');
    try {
      await mkdir(dirname(target.hostPath), { recursive: true });
      await writeFile(target.hostPath, data, { mode: mode ?? 0o644 });
      if (mode !== undefined) await chmod(target.hostPath, mode); // creation mode is subject to umask
    } catch (e) {
      throw mapFsError(e, `writing '${target.sandboxPath}'`);
    }
  }

  async listDir(id: SandboxId, sandboxPath: string): Promise<DirEntry[]> {
    const { short, meta } = await this.load(id);
    const target = await confine(
      this.layout.rootDir(short),
      sandboxPath,
      meta.workspacePath,
      'existing',
    );
    try {
      const names = (await readdir(target.hostPath)).sort();
      const entries: DirEntry[] = [];
      for (const name of names) {
        const st = await lstat(join(target.hostPath, name)).catch(() => undefined);
        if (!st) continue; // vanished while listing
        entries.push({
          name,
          type: st.isFile()
            ? 'file'
            : st.isDirectory()
              ? 'dir'
              : st.isSymbolicLink()
                ? 'symlink'
                : 'other',
          size: st.size,
          mode: st.mode & 0o7777,
          mtimeMs: st.mtimeMs,
        });
      }
      return entries;
    } catch (e) {
      throw mapFsError(e, `listing '${target.sandboxPath}'`);
    }
  }

  // -- snapshots -------------------------------------------------------------------------------

  /** Copies `root/` to `snapshots/<name>/`. The snapshot id is the name. Env and metadata are not part of it. */
  async snapshot(id: SandboxId, name: string): Promise<string> {
    const { short } = await this.load(id);
    if (!SNAPSHOT_NAME_RE.test(name)) {
      throw new AboxError(
        'invalid_input',
        `invalid snapshot name '${name}' (allowed: letters, digits, '.', '_', '-')`,
      );
    }
    return this.mutex.run(short, async () => {
      const snapDir = join(this.layout.snapshotsDir(short), name);
      if (
        await lstat(snapDir).then(
          () => true,
          () => false,
        )
      ) {
        throw new AboxError('conflict', `snapshot '${name}' already exists for '${id}'`);
      }
      const tmp = join(this.layout.snapshotsDir(short), `.tmp-${randomSuffix()}`);
      try {
        await mkdir(this.layout.snapshotsDir(short), { recursive: true, mode: 0o700 });
        await copyTree(this.layout.rootDir(short), tmp);
        await rename(tmp, snapDir);
      } catch (e) {
        await rmTree(tmp).catch(() => undefined);
        throw mapFsError(e, `snapshot '${name}'`);
      }
      return name;
    });
  }

  /** Replaces `root/` with the snapshot. Processes started by the sandbox are killed first. */
  async restore(id: SandboxId, snapshotId: string): Promise<void> {
    const { short } = await this.load(id);
    if (!SNAPSHOT_NAME_RE.test(snapshotId)) {
      throw new AboxError('not_found', `snapshot '${snapshotId}' not found for '${id}'`);
    }
    await this.mutex.run(short, async () => {
      const snapDir = join(this.layout.snapshotsDir(short), snapshotId);
      if (
        !(await lstat(snapDir).then(
          (s) => s.isDirectory(),
          () => false,
        ))
      ) {
        throw new AboxError('not_found', `snapshot '${snapshotId}' not found for '${id}'`);
      }
      await killTracked(this.layout.runDir(short), 0);
      const rootDir = this.layout.rootDir(short);
      const fresh = `${rootDir}.new-${randomSuffix()}`;
      const old = `${rootDir}.old-${randomSuffix()}`;
      try {
        await copyTree(snapDir, fresh);
        await rename(rootDir, old);
        try {
          await rename(fresh, rootDir);
        } catch (e) {
          await rename(old, rootDir).catch(() => undefined);
          throw e;
        }
      } catch (e) {
        await rmTree(fresh).catch(() => undefined);
        throw mapFsError(e, `restore '${snapshotId}'`);
      }
      await rmTree(old).catch(() => undefined);
    });
  }

  /** Sizes of the snapshot directories by `<short>/<name>/<created>`: a snapshot never changes. */
  private readonly snapshotSizes = new Map<string, number | undefined>();

  /**
   * The snapshots of the sandboxes of this host (the directories below `snapshots/`; their id is the
   * name), with the bytes of the copy. They go with the sandbox, so none outlives it.
   */
  async listSnapshots(opts: { sandboxId?: SandboxId } = {}): Promise<ProviderSnapshot[]> {
    const shorts =
      opts.sandboxId === undefined
        ? await this.layout.listShorts()
        : [this.layout.shortOf(opts.sandboxId, this.host.host)].filter(
            (s): s is string => s !== undefined,
          );
    const out: ProviderSnapshot[] = [];
    for (const short of shorts) {
      const meta = await this.layout.readMeta(short).catch(() => undefined);
      if (!meta) continue;
      const dir = this.layout.snapshotsDir(short);
      for (const name of await readdir(dir).catch(() => [] as string[])) {
        if (!SNAPSHOT_NAME_RE.test(name)) continue; // `.tmp-…`: a snapshot still being copied
        const st = await lstat(join(dir, name)).catch(() => undefined);
        if (!st?.isDirectory()) continue;
        // the copy keeps the timestamps of the files, so the directory's own mtime is the sandbox's
        const createdAt = Math.round(st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs);
        const key = `${short}/${name}/${createdAt}`;
        if (!this.snapshotSizes.has(key)) {
          this.snapshotSizes.set(key, await treeBytes(join(dir, name)));
        }
        const sizeBytes = this.snapshotSizes.get(key);
        out.push({
          snapshotId: name,
          sandboxId: meta.id,
          name,
          createdAt,
          ...(sizeBytes !== undefined ? { sizeBytes } : {}),
          template: meta.template,
        });
      }
    }
    return out.sort((a, b) => a.createdAt - b.createdAt || (a.name < b.name ? -1 : 1));
  }

  /** Removes `snapshots/<name>/` of the sandbox; a snapshot that is not there is already gone. */
  async deleteSnapshot(id: SandboxId, snapshotId: string): Promise<void> {
    const { short } = await this.load(id);
    if (!SNAPSHOT_NAME_RE.test(snapshotId)) {
      throw new AboxError('not_found', `snapshot '${snapshotId}' not found for '${id}'`);
    }
    await this.mutex.run(short, async () => {
      const snapDir = join(this.layout.snapshotsDir(short), snapshotId);
      const st = await lstat(snapDir).catch(() => undefined);
      if (!st) return;
      if (!st.isDirectory()) {
        throw new AboxError('not_found', `snapshot '${snapshotId}' not found for '${id}'`);
      }
      this.layout.assertWithinSandboxes(snapDir);
      try {
        await rmTree(snapDir);
      } catch (e) {
        throw mapFsError(e, `delete snapshot '${snapshotId}'`);
      }
      this.snapshotSizes.clear();
    });
  }

  // -- inspect / list --------------------------------------------------------------------------

  async inspect(id: SandboxId): Promise<SandboxInfo> {
    const { meta } = await this.load(id);
    return this.toInfo(meta);
  }

  async list(filter: SandboxFilter = {}): Promise<SandboxInfo[]> {
    const infos: SandboxInfo[] = [];
    for (const short of await this.layout.listShorts()) {
      const meta = await this.layout.readMeta(short).catch(() => undefined);
      if (!meta) continue; // half-built or foreign directory: not a sandbox
      const info = this.toInfo(meta);
      if (filter.owner !== undefined && info.owner !== filter.owner) continue;
      if (filter.state !== undefined && info.state !== filter.state) continue;
      if (filter.template !== undefined && info.template !== filter.template) continue;
      infos.push(info);
    }
    return infos.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  // -- internals -------------------------------------------------------------------------------

  private isExpired(meta: SandboxMeta): boolean {
    return meta.expiresAt < this.now();
  }

  private effectiveState(meta: SandboxMeta): SandboxState {
    return this.isExpired(meta) ? 'expired' : meta.state;
  }

  private toInfo(meta: SandboxMeta): SandboxInfo {
    return {
      id: meta.id,
      host: meta.host,
      name: meta.name,
      state: this.effectiveState(meta),
      backend: 'process',
      isolation: 'none',
      template: meta.template,
      templateHash: meta.templateHash,
      owner: meta.owner,
      createdAt: meta.createdAt,
      expiresAt: meta.expiresAt,
      labels: { ...meta.labels },
      backendRef: this.layout.sandboxDir(meta.short),
      effective: {
        isolation: 'none',
        network: 'open',
        workspace: { kind: meta.workspaceKind, path: meta.workspacePath },
        root: this.layout.rootDir(meta.short),
        user: meta.user.name,
        limitsEnforced: false,
      },
    };
  }

  private async load(id: SandboxId): Promise<Loaded> {
    const short = this.layout.shortOf(id, this.host.host);
    if (short === undefined) throw new AboxError('not_found', `sandbox '${id}' not found`);
    const meta = await this.requireMeta(id, short);
    return { short, meta };
  }

  private async requireMeta(id: SandboxId, short: string): Promise<SandboxMeta> {
    const meta = await this.layout.readMeta(short);
    if (!meta) throw new AboxError('not_found', `sandbox '${id}' not found`);
    return meta;
  }

  private async setState(meta: SandboxMeta, state: StoredState): Promise<void> {
    await this.layout.writeMeta({ ...meta, state });
  }

  private outputCap(req: ExecRequest): number {
    const cap = req.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    if (!Number.isInteger(cap) || cap < 0) {
      throw new AboxError(
        'invalid_input',
        `maxOutputBytes must be a non-negative integer, got ${cap}`,
      );
    }
    return cap;
  }

  /** Validates an exec/spawn request and turns it into a concrete host command. */
  private async planRun(id: SandboxId, req: ExecRequest): Promise<RunPlan> {
    const { short, meta } = await this.load(id);
    const state = this.effectiveState(meta);
    if (state !== 'running') {
      throw new AboxError('conflict', `sandbox '${id}' is ${state}, not running`, {
        hint: `Start it first: abox start ${id}`,
      });
    }
    if (req.signal?.aborted) {
      throw req.signal.reason instanceof Error
        ? req.signal.reason
        : new AboxError('internal', 'exec aborted');
    }
    let argv: string[];
    if (req.argv !== undefined && req.command !== undefined) {
      throw new AboxError(
        'invalid_input',
        'exec request must set either argv or command, not both',
      );
    } else if (req.argv !== undefined) {
      if (req.argv.length === 0 || typeof req.argv[0] !== 'string' || req.argv[0] === '') {
        throw new AboxError('invalid_input', 'exec argv must contain at least the program name');
      }
      argv = req.argv;
    } else if (req.command !== undefined) {
      argv = ['/bin/sh', '-c', req.command];
    } else {
      throw new AboxError('invalid_input', 'exec request needs argv or command');
    }
    if (req.user !== undefined && req.user !== meta.user.name) {
      throw unsupported(
        `running as user '${req.user}' is not supported: commands run as the host user`,
      );
    }
    const rootDir = this.layout.rootDir(short);
    const cwd = await confine(
      rootDir,
      req.cwd ?? meta.workspacePath,
      meta.workspacePath,
      'existing',
    );
    if (!(await stat(cwd.hostPath)).isDirectory()) {
      throw new AboxError('invalid_input', `cwd '${cwd.sandboxPath}' is not a directory`);
    }
    const rootReal = await realpath(rootDir);
    // Environment hygiene, NOT isolation: the host environment (tokens, API keys, ...) is not
    // handed down by accident. PATH/LANG come from the host so that host tools keep working.
    // HOME and TMPDIR point into the sandbox root so that tools write there.
    const env: Record<string, string> = {
      PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: join(rootReal, 'home', meta.user.name),
      TMPDIR: join(rootReal, 'tmp'),
      USER: meta.user.name,
      LOGNAME: meta.user.name,
      SHELL: '/bin/sh',
      LANG: process.env['LANG'] ?? 'C.UTF-8',
      ...(await this.layout.readEnv(short)),
      ...req.env,
    };
    // The skills directory is a sandbox path; a host process finds it inside the sandbox root.
    const skillsDir = env[SKILLS_DIR_ENV];
    if (skillsDir?.startsWith('/'))
      env[SKILLS_DIR_ENV] = join(rootReal, ...normalizeSandboxPath(skillsDir).split('/'));
    return { short, argv, cwd: cwd.hostPath, env, runDir: this.layout.runDir(short) };
  }
}

export function createProcessProvider(
  host: HostConnection,
  opts: ProcessProviderOptions = {},
): ProcessProvider {
  return new ProcessProvider(host, opts);
}

/** Provider factory for registries: `dataDir` comes from the host connection. */
export const processProviderFactory: ProviderFactory = (host) => createProcessProvider(host);
