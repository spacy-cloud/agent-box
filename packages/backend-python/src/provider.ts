import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { AboxError, isAboxError } from '@abox/core';
import type {
  BackendKind,
  BackendStatus,
  DirEntry,
  ExecEvent,
  ExecRequest,
  ExecResult,
  ForeignResource,
  HostConnection,
  IsolationLevel,
  NetworkEvent,
  NetworkSpec,
  PreparedImage,
  PrepareOptions,
  ProviderCapabilities,
  ResolvedTemplate,
  SandboxFilter,
  SandboxId,
  SandboxInfo,
  SandboxProvider,
  SandboxSpec,
  TtyOptions,
  TtySession,
} from '@abox/core';
import {
  DockerProvider,
  defaultSocketPath,
  type DockerProviderOptions,
} from '@abox/backend-docker';
import { ProcessProvider } from '@abox/backend-process';
import { loadProject, type LoadProjectOptions } from './project.js';
import {
  BASE_DOCKERFILE_NAME,
  PROJECT_PATH,
  SYNCED_MARKER,
  translateTemplate,
} from './translate.js';
import { PINNED_UV_VERSION } from './uv.js';
import {
  hostUvVersion,
  setupVenv,
  venvEnv,
  venvLayout,
  type VenvLayout,
  type VenvShared,
} from './venv.js';

const MINUTE = 60_000;

/**
 * WARNING text shown by `status()` and in the docs: venv mode is NOT a sandbox.
 */
export const VENV_MODE_WARNING =
  "venv mode (templates with isolation: none) runs plain host processes with the host uv and the host user's rights: NO security boundary, no network restriction, no resource limits. Use it only when a container is impossible; the core requires approval for it.";

export interface PythonProviderOptions {
  /** Container engine behind the default (container) mode. Default `docker`. */
  engine?: 'docker' | 'podman';
  /** Options for the wrapped Docker/Podman provider (socket, extra labels, hardened runtime, proxy, ...). */
  docker?: Omit<DockerProviderOptions, 'kind' | 'backendKind'>;
  /**
   * Data directory of the venv mode (sandbox roots, shared uv cache). Default: `host.dataDir`.
   * Without it venv mode is unavailable and templates with `isolation: none` are rejected.
   */
  dataDir?: string;
  /** Host `uv` binary for venv mode. Default `uv` from PATH. */
  uvBinary?: string;
  /** Base directory for a relative `python.project` of templates without a source path. Default: cwd. */
  projectBase?: string;
  /** Time limit for `uv` runs (venv setup, dependency sync at first start). Default 15 minutes. */
  syncTimeoutMs?: number;
  /** Clock (tests). */
  now?: () => number;
}

type Mode = 'container' | 'venv';

interface Routed {
  mode: Mode;
  provider: SandboxProvider;
}

function unsupported(message: string, hint?: string): AboxError {
  return new AboxError('unsupported', message, hint ? { hint } : {});
}

/**
 * `SandboxProvider` for Python environments.
 *
 * - **Container mode** (default, isolation `container` or better): composes the Docker/Podman
 *   provider. The template is translated into a `python:<version>-slim-bookworm` (or `base.os`)
 *   environment image with a pinned `uv`, an optional project virtualenv with installed
 *   dependencies, and the uv package cache baked into the image. `capabilities()` are those of
 *   the container provider.
 * - **venv mode** (template says `isolation: none`): composes the process provider and creates a
 *   venv with the host's `uv`. **This is NOT a sandbox**: see {@link VENV_MODE_WARNING}.
 *
 * Which mode a sandbox uses is decided per template (`template.isolation === 'none'`); both
 * kinds can coexist. `info.backend` is `python` for both, `info.isolation` tells them apart.
 */
export class PythonProvider implements SandboxProvider {
  readonly kind: BackendKind = 'python';
  readonly host: HostConnection;

  private readonly engine: 'docker' | 'podman';
  private readonly container: DockerProvider;
  private readonly venv: ProcessProvider | undefined;
  private readonly venvShared: VenvShared | undefined;
  private readonly uvBinary: string;
  private readonly projectOpts: LoadProjectOptions;
  private readonly syncTimeoutMs: number;
  private readonly modes = new Map<SandboxId, Mode>();
  private readonly venvLayouts = new Map<SandboxId, VenvLayout>();
  /** Container sandboxes whose first-start dependency check already ran in this process. */
  private readonly depsChecked = new Set<SandboxId>();

  constructor(host: HostConnection, opts: PythonProviderOptions = {}) {
    this.host = host;
    this.engine = opts.engine ?? 'docker';
    const socketPath =
      opts.docker?.socketPath ?? host.engineSocket ?? defaultSocketPath(this.engine);
    // The wrapped provider labels sandboxes with `abox.backend=python` and only lists / inspects /
    // removes sandboxes with that label, so python sandboxes and plain docker/podman sandboxes
    // (same engine, same instance) never see each other.
    this.container = new DockerProvider(host, {
      ...opts.docker,
      socketPath,
      kind: this.engine,
      backendKind: 'python',
    });
    const dataDir = opts.dataDir ?? host.dataDir;
    if (dataDir && host.kind === 'local') {
      const base = path.join(dataDir, 'python');
      this.venv = new ProcessProvider(host, {
        dataDir: base,
        ...(opts.now ? { now: opts.now } : {}),
      });
      this.venvShared = {
        cacheDir: path.join(base, 'uv', 'cache'),
        pythonDir: path.join(base, 'uv', 'python'),
      };
    }
    this.uvBinary = opts.uvBinary ?? 'uv';
    this.projectOpts = opts.projectBase ? { projectBase: opts.projectBase } : {};
    this.syncTimeoutMs = opts.syncTimeoutMs ?? 15 * MINUTE;
  }

  /** Instance id stamped on the engine objects of the container mode (see `DockerProviderOptions.instanceId`). */
  get instanceId(): string | undefined {
    return this.container.instanceId;
  }

  /** The configured hardened OCI runtime of the container mode, if any. */
  get hardenedRuntime(): string | undefined {
    return this.container.hardenedRuntime;
  }

  /** Isolation of the default (container) mode. Venv sandboxes report `none` in their `SandboxInfo`. */
  get isolation(): IsolationLevel {
    return this.container.isolation;
  }

  /** Query the engine so `capabilities()` is accurate (disk quota, hardened runtime). */
  async init(): Promise<void> {
    await this.container.init();
  }

  /**
   * Capabilities of the container mode (= those of the Docker/Podman provider).
   * Venv mode is a different, much weaker animal: see {@link venvCapabilities}.
   */
  capabilities(): ProviderCapabilities {
    return this.container.capabilities();
  }

  /**
   * Capabilities of venv mode (isolation `none`: network `open` only, no limits, no non-root
   * user, no TTY), or undefined when venv mode is not configured.
   */
  venvCapabilities(): ProviderCapabilities | undefined {
    return this.venv?.capabilities();
  }

  /**
   * Health of both modes. `ok` is the health of the default (container) mode, i.e. of the engine;
   * the details also say whether venv mode is available (host uv) and the warnings carry the
   * venv-mode warning when it is.
   */
  async status(): Promise<BackendStatus> {
    const eng = await this.container.status();
    const details = [...eng.details];
    const warnings = [...eng.warnings];
    details.push(
      `container mode: sandboxes use a python image with uv ${PINNED_UV_VERSION} (pinned, sha256 verified), engine ${eng.ok ? 'reachable' : 'NOT reachable'}`,
    );
    const venv = await this.venvStatus();
    details.push(...venv.details);
    warnings.push(...venv.warnings);
    return {
      ok: eng.ok,
      ...(eng.version !== undefined ? { version: eng.version } : {}),
      ...(eng.rootless !== undefined ? { rootless: eng.rootless } : {}),
      details,
      warnings,
    };
  }

  /**
   * Health of venv mode alone: `ok` when it is configured and the host has uv. Always carries the
   * big warning (venv mode is not a sandbox) when it is usable.
   */
  async venvStatus(): Promise<BackendStatus> {
    if (!this.venv) {
      return {
        ok: false,
        details: [
          'venv mode: not configured (no data directory); templates with isolation: none are rejected',
        ],
        warnings: [],
      };
    }
    const v = await hostUvVersion(this.uvBinary);
    if (v === undefined) {
      return {
        ok: false,
        details: [`venv mode: unavailable, host uv ("${this.uvBinary}") not found`],
        warnings: [],
      };
    }
    const base = await this.venv.status();
    return {
      ok: base.ok,
      version: `uv ${v}`,
      details: [`venv mode: available with host uv ${v}`, ...base.details],
      warnings: [`WARNING: ${VENV_MODE_WARNING}`, ...base.warnings],
    };
  }

  // -------------------------------------------------------------------------
  // Images
  // -------------------------------------------------------------------------

  private modeOf(t: ResolvedTemplate): Mode {
    return t.isolation === 'none' ? 'venv' : 'container';
  }

  private requireVenv(): ProcessProvider {
    if (!this.venv || !this.venvShared) {
      throw unsupported(
        'venv mode (isolation: none) is not configured: the python backend has no data directory',
        'Pass dataDir to createPythonProvider (or set the host data dir), or use a container template.',
      );
    }
    return this.venv;
  }

  private async requireHostUv(): Promise<string> {
    const v = await hostUvVersion(this.uvBinary);
    if (v === undefined) {
      throw new AboxError(
        'backend_unavailable',
        `venv mode needs uv on the host, but "${this.uvBinary}" was not found`,
        {
          hint: 'Install uv (https://docs.astral.sh/uv/) or use a container template (drop isolation: none).',
        },
      );
    }
    return v;
  }

  private checkVenvTemplate(t: ResolvedTemplate): void {
    if (t.build.length > 0) {
      throw unsupported(
        `template "${t.name}" has ${t.build.length} build step(s) (packages, tools or setup); venv mode never installs anything on the host except Python dependencies`,
        'Remove packages/tools/setup, or use a container template.',
      );
    }
    if (t.base.os !== undefined || t.base.dockerfile !== undefined) {
      throw unsupported(
        `template "${t.name}" selects a base image; venv mode uses the host OS`,
        'Remove base, or use a container template.',
      );
    }
    if (t.network.mode !== 'open') {
      throw unsupported(
        `template "${t.name}": venv mode cannot restrict the network (network.mode "${t.network.mode}")`,
        'Set network.mode: open (venv mode has no isolation), or use a container template.',
      );
    }
  }

  async prepare(template: ResolvedTemplate, opts: PrepareOptions = {}): Promise<PreparedImage> {
    this.assertPython(template);
    if (this.modeOf(template) === 'venv') {
      const venv = this.requireVenv();
      this.checkVenvTemplate(template);
      await this.requireHostUv();
      // The process backend only records "prepared" for this hash; the venv itself is per sandbox.
      return venv.prepare(this.processTemplate(template), opts);
    }
    const project = await loadProject(template, this.projectOpts);
    const tr = translateTemplate(template, project);
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'abox-python-'));
    try {
      const dockerfile = path.join(dir, BASE_DOCKERFILE_NAME);
      await fs.writeFile(dockerfile, tr.dockerfile);
      for (const f of tr.contextFiles) await fs.writeFile(path.join(dir, f.name), f.data);
      // The container provider builds `base.dockerfile` first (context = this directory) and layers
      // the user and the build steps on top. Its image cache key covers the Dockerfile text, which
      // contains the sha256 of pyproject.toml / uv.lock: a new lock file means a new image.
      const t: ResolvedTemplate = {
        ...tr.template,
        base: { dockerfile, osFamily: tr.template.base.osFamily },
      };
      return await this.container.prepare(t, opts);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * Removes cached images not in `keep`. Environment images are labelled with the template hash
   * unchanged, so the keep list of the core applies as it is. Images built from older versions of
   * a project's lock file share the template hash and stay until the template goes (see README).
   */
  async gcImages(keep: string[]): Promise<string[]> {
    const removed: string[] = [];
    try {
      removed.push(...(await this.container.gcImages(keep)));
    } catch (e) {
      if (!(isAboxError(e) && e.code === 'backend_unavailable')) throw e;
    }
    if (this.venv) removed.push(...(await this.venv.gcImages(keep)));
    return removed;
  }

  private assertPython(t: ResolvedTemplate): void {
    if (t.backend !== 'python') {
      throw new AboxError(
        'invalid_input',
        `template "${t.name}" is for backend "${t.backend}", not "python"`,
      );
    }
  }

  private processTemplate(t: ResolvedTemplate): ResolvedTemplate {
    const { python: _python, ...rest } = t;
    return { ...rest, backend: 'process', base: { osFamily: 'unknown' }, build: [], tools: [] };
  }

  // -------------------------------------------------------------------------
  // Routing
  // -------------------------------------------------------------------------

  private async route(id: SandboxId): Promise<Routed> {
    const known = this.modes.get(id);
    if (known === 'container') return { mode: 'container', provider: this.container };
    if (known === 'venv' && this.venv) return { mode: 'venv', provider: this.venv };
    if (this.venv) {
      try {
        await this.venv.inspect(id);
        this.modes.set(id, 'venv');
        return { mode: 'venv', provider: this.venv };
      } catch (e) {
        if (!(isAboxError(e) && e.code === 'not_found')) throw e;
      }
    }
    // Not a venv sandbox: either ours in a container, or unknown (the container provider says so).
    let info: SandboxInfo;
    try {
      info = await this.container.inspect(id);
    } catch (e) {
      if (this.venv && isAboxError(e) && e.code === 'backend_unavailable') {
        // Venv-only setups have no engine; an id that is not a venv sandbox is simply unknown.
        throw new AboxError('not_found', `Unknown sandbox ${id}`, {
          hint: `The container engine is not reachable (${e.message}), so only venv sandboxes could be checked.`,
        });
      }
      throw e;
    }
    if (info.backend !== 'python')
      throw new AboxError('not_found', `Unknown sandbox ${id}`, {
        hint: 'Use `abox list` to see sandboxes.',
      });
    this.modes.set(id, 'container');
    return { mode: 'container', provider: this.container };
  }

  private mapInfo(info: SandboxInfo, mode: Mode): SandboxInfo {
    if (mode === 'container') return info;
    const layout = this.venvLayouts.get(info.id);
    return {
      ...info,
      backend: 'python',
      isolation: 'none',
      effective: {
        ...info.effective,
        mode: 'venv',
        warning: VENV_MODE_WARNING,
        ...(layout ? { venv: layout.venv } : {}),
      },
    };
  }

  private async venvLayoutOf(id: SandboxId): Promise<VenvLayout> {
    const have = this.venvLayouts.get(id);
    if (have) return have;
    const info = await this.requireVenv().inspect(id);
    const root = info.effective?.['root'];
    if (typeof root !== 'string')
      throw new AboxError('internal', `venv sandbox ${id} has no root directory`);
    const layout = venvLayout(root);
    this.venvLayouts.set(id, layout);
    return layout;
  }

  private async withVenvEnv(id: SandboxId, req: ExecRequest): Promise<ExecRequest> {
    const layout = await this.venvLayoutOf(id);
    return { ...req, env: { ...venvEnv(layout, this.venvShared as VenvShared), ...req.env } };
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async create(spec: SandboxSpec): Promise<SandboxInfo> {
    this.assertPython(spec.template);
    if (this.modeOf(spec.template) === 'venv') return this.createVenv(spec);
    const { template } = translateTemplate(spec.template);
    const info = await this.container.create({ ...spec, template });
    this.modes.set(spec.id, 'container');
    return this.mapInfo(info, 'container');
  }

  private async createVenv(spec: SandboxSpec): Promise<SandboxInfo> {
    const venv = this.requireVenv();
    const t = spec.template;
    this.checkVenvTemplate(t);
    const uv = this.uvBinary;
    await this.requireHostUv();
    const project = await loadProject(t, this.projectOpts);
    // Template env first, like the container mode does (the process backend only uses spec.env).
    await venv.create({
      ...spec,
      template: this.processTemplate(t),
      env: { ...t.env, ...spec.env },
    });
    try {
      const layout = await this.venvLayoutOf(spec.id);
      await setupVenv({
        uv,
        layout,
        shared: this.venvShared as VenvShared,
        home: path.join(layout.root, 'home', spec.user.name),
        pythonVersion: t.python?.version ?? '3',
        ...(project ? { project } : {}),
        timeoutMs: this.syncTimeoutMs,
      });
    } catch (e) {
      await venv.remove(spec.id).catch(() => undefined);
      this.venvLayouts.delete(spec.id);
      throw e;
    }
    this.modes.set(spec.id, 'venv');
    return this.mapInfo(await venv.inspect(spec.id), 'venv');
  }

  async start(id: SandboxId): Promise<void> {
    const r = await this.route(id);
    await r.provider.start(id);
    if (r.mode === 'container') await this.ensureDeps(id);
  }

  /**
   * Templates with a `pyproject.toml` but no `uv.lock` could not install dependencies at prepare
   * time. On the first start the dependencies are resolved and installed inside the sandbox
   * (as the sandbox user, with the network the sandbox has: it fails clearly with `network: none`).
   */
  private async ensureDeps(id: SandboxId): Promise<void> {
    if (this.depsChecked.has(id)) return;
    const probe = await this.container.exec(id, {
      command: `test -f ${PROJECT_PATH}/pyproject.toml && ! test -e ${SYNCED_MARKER}`,
      timeoutMs: 30_000,
    });
    if (probe.exitCode !== 0) {
      this.depsChecked.add(id);
      return;
    }
    const sync = await this.container.exec(id, {
      command: `uv sync --no-install-project --project ${PROJECT_PATH} && touch ${SYNCED_MARKER}`,
      timeoutMs: this.syncTimeoutMs,
    });
    if (sync.exitCode !== 0 || sync.timedOut) {
      await this.container.stop(id).catch(() => undefined);
      const tail = `${sync.stdout}${sync.stderr}`.slice(-4000);
      throw new AboxError(
        'backend_error',
        `Installing the project dependencies failed${sync.timedOut ? ' (timed out)' : ''}`,
        {
          details: { log: tail },
          hint: 'The template has pyproject.toml but no uv.lock, so dependencies are installed on first start and need network access (allowlist with the pypi preset, or open). Add uv.lock to install them at prepare time.',
        },
      );
    }
    this.depsChecked.add(id);
  }

  async stop(id: SandboxId): Promise<void> {
    await (await this.route(id)).provider.stop(id);
  }

  async remove(id: SandboxId): Promise<void> {
    let routed: Routed | undefined;
    try {
      routed = await this.route(id);
    } catch (e) {
      if (!(isAboxError(e) && e.code === 'not_found')) throw e;
    }
    // Unknown ids: removal is idempotent, but let the container provider clean up leftovers of a failed create.
    try {
      await (routed?.provider ?? this.container).remove(id);
    } catch (e) {
      if (!(this.venv && !routed && isAboxError(e) && e.code === 'backend_unavailable')) throw e;
    }
    this.modes.delete(id);
    this.venvLayouts.delete(id);
    this.depsChecked.delete(id);
  }

  // -------------------------------------------------------------------------
  // Exec and files
  // -------------------------------------------------------------------------

  async exec(id: SandboxId, req: ExecRequest): Promise<ExecResult> {
    const r = await this.route(id);
    return r.provider.exec(id, r.mode === 'venv' ? await this.withVenvEnv(id, req) : req);
  }

  async *spawn(id: SandboxId, req: ExecRequest): AsyncIterable<ExecEvent> {
    const r = await this.route(id);
    yield* r.provider.spawn(id, r.mode === 'venv' ? await this.withVenvEnv(id, req) : req);
  }

  async attach(id: SandboxId, tty: TtyOptions): Promise<TtySession> {
    const r = await this.route(id);
    return r.provider.attach(
      id,
      r.mode === 'venv'
        ? {
            ...tty,
            env: {
              ...venvEnv(await this.venvLayoutOf(id), this.venvShared as VenvShared),
              ...tty.env,
            },
          }
        : tty,
    );
  }

  async copyIn(id: SandboxId, hostPath: string, sandboxPath: string): Promise<void> {
    const r = await this.route(id);
    // Say "not found" for a missing source instead of leaking a filesystem error as an engine error.
    await fs.lstat(hostPath).catch((e: NodeJS.ErrnoException) => {
      throw e.code === 'ENOENT'
        ? new AboxError('not_found', `Host path not found: ${hostPath}`)
        : e;
    });
    await r.provider.copyIn(id, hostPath, sandboxPath);
  }

  async copyOut(id: SandboxId, sandboxPath: string, hostPath: string): Promise<void> {
    await (await this.route(id)).provider.copyOut(id, sandboxPath, hostPath);
  }

  async readFile(
    id: SandboxId,
    sandboxPath: string,
    maxBytes: number,
  ): Promise<{ data: Buffer; truncated: boolean; size: number }> {
    return (await this.route(id)).provider.readFile(id, sandboxPath, maxBytes);
  }

  async writeFile(id: SandboxId, sandboxPath: string, data: Buffer, mode?: number): Promise<void> {
    await (await this.route(id)).provider.writeFile(id, sandboxPath, data, mode);
  }

  async listDir(id: SandboxId, sandboxPath: string): Promise<DirEntry[]> {
    return (await this.route(id)).provider.listDir(id, sandboxPath);
  }

  // -------------------------------------------------------------------------
  // Optional capabilities: delegated, `unsupported` where the underlying provider has none
  // -------------------------------------------------------------------------

  async snapshot(id: SandboxId, name: string): Promise<string> {
    const { provider } = await this.route(id);
    if (!provider.snapshot) throw unsupported('snapshots are not supported by this sandbox');
    return provider.snapshot(id, name);
  }

  async restore(id: SandboxId, snapshotId: string): Promise<void> {
    const { provider } = await this.route(id);
    if (!provider.restore) throw unsupported('snapshots are not supported by this sandbox');
    await provider.restore(id, snapshotId);
  }

  async updateNetwork(id: SandboxId, network: NetworkSpec): Promise<void> {
    const { provider } = await this.route(id);
    if (!provider.updateNetwork)
      throw unsupported('updating the network of a running sandbox is not supported');
    await provider.updateNetwork(id, network);
  }

  async networkEvents(id: SandboxId, sinceTs?: number): Promise<NetworkEvent[]> {
    const { provider } = await this.route(id);
    return provider.networkEvents ? provider.networkEvents(id, sinceTs) : [];
  }

  async logs(id: SandboxId, opts?: { tail?: number; sinceTs?: number }): Promise<string> {
    const { provider } = await this.route(id);
    return provider.logs ? provider.logs(id, opts) : '';
  }

  // -------------------------------------------------------------------------
  // Inspection
  // -------------------------------------------------------------------------

  async inspect(id: SandboxId): Promise<SandboxInfo> {
    const r = await this.route(id);
    if (r.mode === 'venv') await this.venvLayoutOf(id);
    return this.mapInfo(await r.provider.inspect(id), r.mode);
  }

  async list(filter?: SandboxFilter): Promise<SandboxInfo[]> {
    const out: SandboxInfo[] = [];
    try {
      const all = await this.container.list(filter);
      out.push(
        ...all.filter((i) => i.backend === 'python').map((i) => this.mapInfo(i, 'container')),
      );
    } catch (e) {
      // Without an engine only venv sandboxes can exist here.
      if (!(isAboxError(e) && e.code === 'backend_unavailable') || !this.venv) throw e;
    }
    if (this.venv) {
      for (const i of await this.venv.list(filter)) {
        await this.venvLayoutOf(i.id).catch(() => undefined);
        out.push(this.mapInfo(i, 'venv'));
      }
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Foreign engine objects of the container mode (the venv mode keeps nothing on an engine). */
  async listForeign(): Promise<ForeignResource[]> {
    try {
      return await this.container.listForeign();
    } catch (e) {
      if (isAboxError(e) && e.code === 'backend_unavailable') return [];
      throw e;
    }
  }

  removeForeign(resource: ForeignResource): Promise<void> {
    return this.container.removeForeign(resource);
  }
}

export function createPythonProvider(
  host: HostConnection,
  opts: PythonProviderOptions = {},
): PythonProvider {
  return new PythonProvider(host, opts);
}
