import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Readable } from 'node:stream';
import { Readable as ReadableCtor } from 'node:stream';
import Docker from 'dockerode';
import { AboxError, parseSandboxId } from '@abox/core';
import type {
  BackendKind,
  BackendStatus,
  DirEntry,
  ExecEvent,
  ExecRequest,
  ExecResult,
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
import { buildImage, pullImage } from './build.js';
import { renderDockerfile } from './dockerfile.js';
import { effectiveFromInspect, infoFromLabels } from './info.js';
import { isAbortError, mapEngineError, statusOf } from './errors.js';
import { Demux, openTty, runExec, simpleExec } from './exec.js';
import { getFile, mkdirP, putArchiveStream, putFile, reownDir, sandboxPath } from './files.js';
import { buildHostConfig, checkBindSource, checkMountTarget, ttlEntrypoint } from './hostconfig.js';
import {
  CA_BUNDLE_PATH,
  CA_CERT_PATH,
  CA_DIR,
  EGRESS_NETWORK,
  LABEL,
  OPEN_NETWORK,
  PROXY_ALIAS,
  PROXY_PORT,
  TMP_STASH,
  containerName,
  imageRepoName,
  internalNetName,
  isValidHost,
  isValidInstanceId,
  isValidShort,
  proxyName,
  snapshotRepo,
} from './labels.js';
import {
  PROXY_CA_PATH,
  PROXY_CONFIG_DIR,
  PROXY_CONFIG_PATH,
  PROXY_RUN_DIR,
  PROXY_USER,
  PROXY_USER_UID,
  defaultProxyAssets,
  ensureProxyImage,
  parseProxyLine,
  proxyConfigJson,
  type ProxyAssets,
} from './proxy.js';
import { extractArchiveSafe, packHostPath, tarFromEntries, tarEntries } from './tar.js';

const MiB = 1024 * 1024;
const DEFAULT_MAX_OUTPUT = 16 * MiB;

export interface DockerProviderOptions {
  /** The container engine: `docker` (default) or `podman`. Decides the default socket and the wording. */
  kind?: 'docker' | 'podman';
  /**
   * Backend kind that is reported (`SandboxInfo.backend`), stamped as label `abox.backend` and used to
   * filter `list()` / `inspect()`: a provider only sees the sandboxes of its own backend kind, so the
   * plain docker provider does not list the sandboxes of the python backend (which is built on this
   * provider) and vice versa. Default: the engine `kind`.
   */
  backendKind?: 'docker' | 'podman' | 'python';
  /**
   * Id of the abox installation that uses this provider. It is stamped as label `abox.instance` on
   * every container, network, proxy sidecar, built image and snapshot image, and `list`, `inspect`,
   * `remove`, `gcImages` and the network cleanup only see objects carrying the same id. Two
   * installations (another `ABOX_HOME`, another user in the docker group, CI) on one engine therefore
   * never treat each other's sandboxes as orphans. Objects without the label (older versions, other
   * tools) belong to nobody: they are never listed, removed or garbage-collected, `status()` only
   * reports how many exist. Without an id the provider only sees objects that carry no instance
   * label either. `@abox/runtime` generates and persists one id per data directory.
   */
  instanceId?: string;
  /** Engine socket; overrides `host.engineSocket`. */
  socketPath?: string;
  /** Inject a pre-built client (tests). */
  docker?: Docker;
  /** Name of a stronger OCI runtime (e.g. `runsc`, `kata`); isolation becomes `hardened` only if the engine has it. */
  hardenedRuntime?: string;
  /** Labels added to every engine object abox creates (images, containers, networks). Tests use `abox.test=1`. */
  extraLabels?: Record<string, string>;
  /** Override the proxy assets (`false` disables allowlist mode). */
  proxy?: ProxyAssets | false;
  /** Upper bound for the `/tmp` tmpfs in bytes (default 256 MiB, never above half of the memory limit). */
  tmpfsBytes?: number;
  /** Seconds the engine waits after SIGTERM before SIGKILL on `stop` (default 5). */
  stopTimeoutSec?: number;
}

interface EngineFacts {
  version: string;
  apiVersion: string;
  rootless: boolean;
  storageDriver: string;
  backingFs: string;
  runtimes: string[];
  diskQuota: boolean;
  cgroupVersion: string;
  raw: Record<string, unknown>;
}

export function defaultSocketPath(kind: 'docker' | 'podman'): string {
  if (kind === 'podman') {
    const host = process.env['CONTAINER_HOST'];
    if (host?.startsWith('unix://')) return host.slice('unix://'.length);
    const runtime = process.env['XDG_RUNTIME_DIR'] ?? `/run/user/${process.getuid?.() ?? 1000}`;
    return path.join(runtime, 'podman', 'podman.sock');
  }
  const host = process.env['DOCKER_HOST'];
  if (host?.startsWith('unix://')) return host.slice('unix://'.length);
  return '/var/run/docker.sock';
}

function userIds(c: Docker.ContainerInspectInfo): { uid: number; gid: number } {
  const [u, g] = (c.Config.User ?? '').split(':');
  const uid = Number(u);
  const gid = Number(g ?? u);
  if (!Number.isInteger(uid) || uid <= 0) {
    throw new AboxError('internal', `Sandbox ${c.Name} has no numeric non-root user`);
  }
  return { uid, gid: Number.isInteger(gid) ? gid : uid };
}

function underTmp(p: string): boolean {
  return p === '/tmp' || p.startsWith('/tmp/');
}

function envArray(env: Record<string, string>): string[] {
  return Object.entries(env).map(([k, v]) => `${k}=${v}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class DockerProvider implements SandboxProvider {
  readonly kind: BackendKind;
  /** The container engine behind this provider (not the reported backend kind). */
  readonly engine: 'docker' | 'podman';
  /** Instance id stamped on and required of every engine object; `undefined` = unlabelled objects only. */
  readonly instanceId: string | undefined;
  readonly host: HostConnection;
  private currentIsolation: IsolationLevel = 'container';
  private readonly docker: Docker;
  private readonly socketPath: string;
  private readonly opts: DockerProviderOptions;
  private readonly proxyAssets: ProxyAssets | undefined;
  private facts: EngineFacts | undefined;
  private readonly inflight = new Map<string, Promise<PreparedImage>>();

  constructor(host: HostConnection, opts: DockerProviderOptions = {}) {
    this.engine = opts.kind ?? 'docker';
    this.kind = opts.backendKind ?? this.engine;
    this.host = host;
    this.opts = opts;
    if (opts.instanceId !== undefined && !isValidInstanceId(opts.instanceId))
      throw new AboxError(
        'invalid_input',
        `Invalid instance id "${opts.instanceId}" (use 1-64 characters of [A-Za-z0-9_.-])`,
      );
    this.instanceId = opts.instanceId;
    this.socketPath = opts.socketPath ?? host.engineSocket ?? defaultSocketPath(this.engine);
    this.docker = opts.docker ?? new Docker({ socketPath: this.socketPath });
    this.proxyAssets = opts.proxy === false ? undefined : (opts.proxy ?? defaultProxyAssets);
    if (!isValidHost(host.host))
      throw new AboxError('invalid_input', `Invalid host id: ${host.host}`);
  }

  get isolation(): IsolationLevel {
    return this.currentIsolation;
  }

  /** The configured stronger OCI runtime (`runsc`, `kata`, ...); isolation is `hardened` only once the engine is known to have it. */
  get hardenedRuntime(): string | undefined {
    return this.opts.hardenedRuntime;
  }

  private get remote(): boolean {
    return this.host.kind === 'ssh';
  }

  /** Labels for every engine object abox creates: the extra labels and the instance id. */
  private get extra(): Record<string, string> {
    return {
      ...(this.opts.extraLabels ?? {}),
      ...(this.instanceId !== undefined ? { [LABEL.instance]: this.instanceId } : {}),
    };
  }

  /** Does an engine object (by its labels) belong to this provider's instance? */
  private ownsInstance(labels: Record<string, string> | null | undefined): boolean {
    const v = labels?.[LABEL.instance];
    return (v === undefined || v === '' ? undefined : v) === this.instanceId;
  }

  /** Does a sandbox (by its labels) belong to this provider: same instance and same backend kind. */
  private ownsSandbox(labels: Record<string, string> | null | undefined): boolean {
    return this.ownsInstance(labels) && (labels?.[LABEL.backend] ?? this.kind) === this.kind;
  }

  // -------------------------------------------------------------------------
  // Infrastructure
  // -------------------------------------------------------------------------

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (isAbortError(e)) throw e;
      throw mapEngineError(e, this.socketPath);
    }
  }

  /**
   * Query the engine once (version, storage driver, runtimes). Called implicitly by `create`,
   * `prepare` and `status`; call it after construction if `capabilities()` must be accurate
   * (disk quota, hardened runtime) before the first of those.
   */
  async init(): Promise<void> {
    await this.guard(async () => {
      await this.engineFacts();
    });
  }

  private async engineFacts(): Promise<EngineFacts> {
    if (this.facts) return this.facts;
    const [info, version] = await Promise.all([this.docker.info(), this.docker.version()]);
    const status = (info.DriverStatus ?? []) as string[][];
    const backingFs = status.find((r) => r[0] === 'Backing Filesystem')?.[1] ?? '';
    const driver = info.Driver ?? '';
    const diskQuota =
      ['zfs', 'btrfs', 'devicemapper'].includes(driver) ||
      (driver === 'overlay2' && backingFs === 'xfs');
    const runtimes = Object.keys(
      (info as unknown as { Runtimes?: Record<string, unknown> }).Runtimes ?? {},
    );
    const secOpts = (info.SecurityOptions ?? []) as string[];
    this.facts = {
      version: String(version.Version ?? ''),
      apiVersion: String((version as unknown as { ApiVersion?: string }).ApiVersion ?? ''),
      rootless: secOpts.some((o) => o.includes('name=rootless')),
      storageDriver: driver,
      backingFs,
      runtimes,
      diskQuota,
      cgroupVersion: String((info as unknown as { CgroupVersion?: string }).CgroupVersion ?? ''),
      raw: info as unknown as Record<string, unknown>,
    };
    const rt = this.opts.hardenedRuntime;
    if (rt && runtimes.includes(rt)) this.currentIsolation = 'hardened';
    return this.facts;
  }

  capabilities(): ProviderCapabilities {
    const allowlist = this.proxyAssets !== undefined;
    return {
      isolation: this.currentIsolation,
      networkModes: allowlist ? ['none', 'allowlist', 'open'] : ['none', 'open'],
      networkFilter: allowlist,
      workspaceDelivery: this.remote ? ['none', 'copy'] : ['none', 'bind', 'copy'],
      mounts: !this.remote,
      snapshots: true,
      tty: true,
      limits: { cpus: true, memory: true, pids: true, disk: this.facts?.diskQuota ?? false },
      nonRootUser: true,
      secretInjection: ['proxy', 'env', 'file'],
      osFamilies: ['debian', 'alpine', 'fedora', 'arch'],
      remote: this.remote,
    };
  }

  async status(): Promise<BackendStatus> {
    const details: string[] = [];
    const warnings: string[] = [];
    try {
      await this.docker.ping();
    } catch (e) {
      const err = mapEngineError(e, this.socketPath);
      return {
        ok: false,
        details: [
          `${this.engine} engine unreachable at ${this.socketPath}: ${err.message}`,
          ...(err.hint ? [err.hint] : []),
        ],
        warnings,
      };
    }
    try {
      this.facts = undefined;
      const f = await this.engineFacts();
      details.push(`${this.engine} ${f.version} (API ${f.apiVersion}) at ${this.socketPath}`);
      details.push(`storage driver: ${f.storageDriver}${f.backingFs ? ` on ${f.backingFs}` : ''}`);
      details.push(`runtimes: ${f.runtimes.join(', ') || 'default'}`);
      if (f.cgroupVersion) details.push(`cgroup v${f.cgroupVersion}`);
      details.push(`disk quota (StorageOpt size): ${f.diskQuota ? 'supported' : 'not supported'}`);
      details.push(`isolation: ${this.currentIsolation}`);
      if (this.opts.hardenedRuntime && !f.runtimes.includes(this.opts.hardenedRuntime)) {
        warnings.push(
          `Configured hardened runtime "${this.opts.hardenedRuntime}" is not installed in the engine`,
        );
      }
      if (!f.rootless) {
        warnings.push(
          `The ${this.engine} daemon is rootful: access to its socket (e.g. membership of the docker group) is root-equivalent on the host. Prefer a rootless engine.`,
        );
      }
      if (!this.proxyAssets)
        warnings.push(
          'Egress proxy runtime not available: network mode "allowlist" is unsupported',
        );
      details.push(`internal networks: ${await this.probeInternalNetwork()}`);
      details.push(
        this.instanceId !== undefined
          ? `instance: ${this.instanceId}`
          : 'instance: none (only sees objects without an instance label)',
      );
      const foreign = await this.countForeignSandboxes().catch(() => 0);
      if (foreign > 0) {
        warnings.push(
          `${foreign} abox resource${foreign === 1 ? '' : 's'} (sandboxes) of another or unknown instance present on this engine: not listed and never touched by this installation`,
        );
      }
      return { ok: true, version: f.version, rootless: f.rootless, details, warnings };
    } catch (e) {
      const err = mapEngineError(e, this.socketPath);
      return { ok: false, details: [...details, err.message], warnings };
    }
  }

  /** Sandbox containers of the engine that belong to another or no instance (or another backend kind's instance). */
  private async countForeignSandboxes(): Promise<number> {
    const items = await this.docker.listContainers({
      all: true,
      filters: { label: [`${LABEL.managed}=1`, `${LABEL.role}=sandbox`] },
    });
    return items.filter((i) => !this.ownsInstance(i.Labels)).length;
  }

  private async probeInternalNetwork(): Promise<string> {
    const name = `abox-probe-${randomBytes(4).toString('hex')}`;
    try {
      const n = await this.docker.createNetwork({
        Name: name,
        Driver: 'bridge',
        Internal: true,
        Labels: { [LABEL.managed]: '1', [LABEL.role]: 'probe', ...this.extra },
      });
      await n.remove();
      return 'work';
    } catch (e) {
      return `do NOT work (${mapEngineError(e).message}); allowlist mode will fail`;
    }
  }

  // -------------------------------------------------------------------------
  // Images
  // -------------------------------------------------------------------------

  /** Absolute path of the template's own Dockerfile (templates with `base.dockerfile`). */
  private dockerfilePath(t: ResolvedTemplate): string | undefined {
    const rel = t.base.dockerfile;
    if (!rel) return undefined;
    const src = t.source.path;
    if (!src && !path.isAbsolute(rel)) {
      throw new AboxError(
        'invalid_input',
        'base.dockerfile needs template.source.path to resolve the Dockerfile',
      );
    }
    return path.isAbsolute(rel) ? rel : path.resolve(path.dirname(src as string), rel);
  }

  /**
   * Cache key of the environment image: `template.hash`, and for templates with their own
   * Dockerfile also the sha256 of that file's content (the template hash only covers its path).
   */
  private async cacheKey(t: ResolvedTemplate): Promise<string> {
    const df = this.dockerfilePath(t);
    if (!df) return t.hash.slice(0, 16);
    let content: Buffer;
    try {
      content = await fs.readFile(df);
    } catch {
      throw new AboxError('invalid_input', `Dockerfile not found: ${df}`);
    }
    return createHash('sha256')
      .update(t.hash)
      .update('\0')
      .update(content)
      .digest('hex')
      .slice(0, 16);
  }

  private imageTag(t: ResolvedTemplate, key: string): string {
    return `abox/${imageRepoName(t.name)}:${key}`;
  }

  private async imageInspect(ref: string): Promise<Docker.ImageInspectInfo | undefined> {
    try {
      return await this.docker.getImage(ref).inspect();
    } catch (e) {
      if (statusOf(e) === 404) return undefined;
      throw e;
    }
  }

  async prepare(template: ResolvedTemplate, opts: PrepareOptions = {}): Promise<PreparedImage> {
    return this.guard(async () => {
      const cacheKey = await this.cacheKey(template);
      const tag = this.imageTag(template, cacheKey);
      const key = `${tag}|${opts.update ? 'u' : ''}|${opts.pinnedBase ?? ''}`;
      const running = this.inflight.get(key);
      if (running) return running;
      const p = this.prepareImpl(template, tag, cacheKey, opts).finally(() =>
        this.inflight.delete(key),
      );
      this.inflight.set(key, p);
      return p;
    });
  }

  private async resolveDigest(ref: string): Promise<string | undefined> {
    if (ref.includes('@sha256:')) return ref;
    const img = await this.imageInspect(ref);
    const digests = img?.RepoDigests ?? [];
    if (digests.length === 0) return undefined;
    const norm = (n: string): string => n.replace(/^(docker\.io\/)?(library\/)?/, '');
    const repoOf = (r: string): string => {
      const noDigest = r.split('@')[0] ?? r;
      const slash = noDigest.lastIndexOf('/');
      const colon = noDigest.lastIndexOf(':');
      return colon > slash ? noDigest.slice(0, colon) : noDigest;
    };
    const repo = repoOf(ref);
    const match = digests.find((d) => norm(repoOf(d)) === norm(repo)) ?? digests[0];
    if (!match) return undefined;
    const digest = match.split('@')[1];
    return digest ? `${repo}@${digest}` : undefined;
  }

  private async prepareImpl(
    template: ResolvedTemplate,
    tag: string,
    cacheKey: string,
    opts: PrepareOptions,
  ): Promise<PreparedImage> {
    await this.engineFacts();
    const progress = opts.onProgress;
    const existing = await this.imageInspect(tag);
    const existingDigest = existing?.Config?.Labels?.[LABEL.baseDigest] || undefined;
    if (existing && !opts.update) {
      return {
        ref: tag,
        templateHash: template.hash,
        cached: true,
        ...(existingDigest ? { pinnedBase: existingDigest } : {}),
      };
    }

    let baseRef: string;
    let pinnedBase: string | undefined;
    if (template.base.dockerfile) {
      baseRef = await this.buildCustomBase(template, cacheKey, opts);
    } else {
      const os = template.base.os;
      if (!os)
        throw new AboxError('invalid_input', 'Template has neither base.os nor base.dockerfile');
      if (opts.pinnedBase && !opts.update) {
        if (!(await this.imageInspect(opts.pinnedBase)))
          await pullImage(this.docker, opts.pinnedBase, progress, opts.signal);
        pinnedBase = opts.pinnedBase;
        baseRef = opts.pinnedBase;
      } else {
        try {
          await pullImage(this.docker, os, progress, opts.signal);
        } catch (e) {
          if (isAbortError(e) || !(await this.imageInspect(os))) throw e;
          progress?.(`pull of ${os} failed (${mapEngineError(e).message}); using the local copy`);
        }
        pinnedBase = await this.resolveDigest(os);
        baseRef = pinnedBase ?? os;
      }
      if (existing && opts.update && pinnedBase && existingDigest === pinnedBase) {
        return { ref: tag, templateHash: template.hash, cached: true, pinnedBase };
      }
    }

    const dockerfile = renderDockerfile(template, {
      baseRef,
      ...(pinnedBase ? { baseDigest: pinnedBase } : {}),
    });
    const context = await tarFromEntries([
      { name: 'Dockerfile', data: Buffer.from(dockerfile, 'utf8') },
    ]);
    await buildImage(this.docker, ReadableCtor.from([context]), {
      tag,
      labels: { ...this.extra },
      ...(opts.update ? { nocache: true } : {}),
      ...(progress ? { onProgress: progress } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (existing && this.ownsInstance(existing.Config?.Labels)) {
      const fresh = await this.imageInspect(tag);
      if (fresh && fresh.Id !== existing.Id)
        await this.docker
          .getImage(existing.Id)
          .remove()
          .catch(() => undefined);
    }
    return {
      ref: tag,
      templateHash: template.hash,
      cached: false,
      ...(pinnedBase ? { pinnedBase } : {}),
    };
  }

  /** Templates with their own Dockerfile: build it first, our additions are layered on top. */
  private async buildCustomBase(
    template: ResolvedTemplate,
    cacheKey: string,
    opts: PrepareOptions,
  ): Promise<string> {
    const dockerfilePath = this.dockerfilePath(template) as string;
    const contextDir = path.dirname(dockerfilePath);
    const baseTag = `abox/${imageRepoName(template.name)}-base:${cacheKey}`;
    await buildImage(this.docker, packHostPath(contextDir, '', { uid: 0, gid: 0 }), {
      tag: baseTag,
      dockerfile: path.basename(dockerfilePath),
      labels: {
        [LABEL.managed]: '1',
        [LABEL.template]: template.name,
        [LABEL.templateHash]: template.hash,
        ...this.extra,
      },
      ...(opts.update ? { nocache: true } : {}),
      ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    return baseTag;
  }

  async gcImages(keep: string[]): Promise<string[]> {
    return this.guard(async () => {
      const keepSet = new Set(keep);
      const images = await this.docker.listImages({ filters: { label: [`${LABEL.managed}=1`] } });
      const containers = await this.docker.listContainers({ all: true });
      const used = new Set(containers.map((c) => c.ImageID));
      const removed: string[] = [];
      for (const img of images) {
        const labels = img.Labels ?? {};
        if (labels[LABEL.role] === 'proxy') continue;
        // Base/environment images are shared caches: only delete what this instance built.
        if (!this.ownsInstance(labels)) continue;
        const hash = labels[LABEL.templateHash];
        if (!hash || keepSet.has(hash)) continue;
        const tags = (img.RepoTags ?? []).filter(
          (t) => t.startsWith('abox/') && t !== '<none>:<none>',
        );
        if (tags.length === 0 || used.has(img.Id)) continue;
        for (const t of tags) {
          try {
            await this.docker.getImage(t).remove();
            removed.push(t);
          } catch (e) {
            if (statusOf(e) !== 404 && statusOf(e) !== 409) throw e;
          }
        }
      }
      return removed;
    });
  }

  // -------------------------------------------------------------------------
  // Lookup
  // -------------------------------------------------------------------------

  private parseId(id: SandboxId): { host: string; short: string } {
    const { host, short } = parseSandboxId(id);
    if (host !== this.host.host || !isValidShort(short)) {
      throw new AboxError('not_found', `Unknown sandbox ${id}`, {
        hint: 'Use `abox list` to see sandboxes.',
      });
    }
    return { host, short };
  }

  private async load(id: SandboxId): Promise<Docker.ContainerInspectInfo> {
    const { host, short } = this.parseId(id);
    let c: Docker.ContainerInspectInfo;
    try {
      c = await this.docker.getContainer(containerName(host, short)).inspect();
    } catch (e) {
      if (statusOf(e) === 404) {
        throw new AboxError('not_found', `Unknown sandbox ${id}`, {
          hint: 'Use `abox list` to see sandboxes.',
        });
      }
      throw e;
    }
    const l = c.Config.Labels ?? {};
    if (
      l[LABEL.managed] !== '1' ||
      l[LABEL.role] !== 'sandbox' ||
      l[LABEL.id] !== id ||
      !this.ownsSandbox(l)
    ) {
      throw new AboxError('not_found', `Unknown sandbox ${id}`);
    }
    return c;
  }

  private toInfo(c: Docker.ContainerInspectInfo): SandboxInfo {
    const info = infoFromLabels(
      c.Config.Labels ?? {},
      c.State.Status,
      c.Id,
      this.kind,
      Date.now(),
      {
        error: Boolean(c.State.Error),
        oomKilled: Boolean(c.State.OOMKilled),
      },
    );
    info.effective = effectiveFromInspect(c);
    return info;
  }

  async inspect(id: SandboxId): Promise<SandboxInfo> {
    return this.guard(async () => this.toInfo(await this.load(id)));
  }

  async list(filter: SandboxFilter = {}): Promise<SandboxInfo[]> {
    return this.guard(async () => {
      const label = [
        `${LABEL.managed}=1`,
        `${LABEL.role}=sandbox`,
        `${LABEL.host}=${this.host.host}`,
      ];
      if (filter.owner) label.push(`${LABEL.owner}=${filter.owner}`);
      if (filter.template) label.push(`${LABEL.template}=${filter.template}`);
      if (this.instanceId !== undefined) label.push(`${LABEL.instance}=${this.instanceId}`);
      const items = await this.docker.listContainers({ all: true, filters: { label } });
      const now = Date.now();
      return items
        .filter((i) => this.ownsSandbox(i.Labels))
        .map((i) => infoFromLabels(i.Labels ?? {}, i.State, i.Id, this.kind, now))
        .filter((i) => i.id !== '' && (!filter.state || i.state === filter.state))
        .sort((a, b) => a.createdAt - b.createdAt);
    });
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  private assertSupported(spec: SandboxSpec): void {
    const t = spec.template;
    const caps = this.capabilities();
    if (spec.host !== this.host.host) {
      throw new AboxError(
        'invalid_input',
        `Sandbox host "${spec.host}" does not match provider host "${this.host.host}"`,
      );
    }
    if (!caps.networkModes.includes(spec.network.mode)) {
      throw new AboxError(
        'unsupported',
        `Network mode "${spec.network.mode}" is not supported by this backend`,
        {
          hint:
            spec.network.mode === 'allowlist'
              ? 'The egress proxy runtime (@abox/proxy) is not available.'
              : undefined,
        },
      );
    }
    if (spec.network.injections.length > 0 && spec.network.mode !== 'allowlist') {
      throw new AboxError(
        'unsupported',
        'Proxy secret injection requires network mode "allowlist"',
      );
    }
    if (!caps.workspaceDelivery.includes(spec.workspace.kind)) {
      throw new AboxError(
        'unsupported',
        `Workspace delivery "${spec.workspace.kind}" is not supported on this host`,
        {
          hint: this.remote
            ? 'Remote hosts cannot bind-mount host directories; use copy.'
            : undefined,
        },
      );
    }
    if (this.remote && spec.mounts.length > 0) {
      throw new AboxError('unsupported', 'Additional mounts are not supported on remote hosts');
    }
    if (spec.resources.diskBytes !== undefined && !caps.limits.disk) {
      throw new AboxError(
        'unsupported',
        'Disk quota is not supported by the storage driver of this engine',
        {
          hint: 'Remove resources.disk or use an engine with xfs+pquota / btrfs / zfs.',
        },
      );
    }
    const wantedIso = t.isolation;
    const order: IsolationLevel[] = ['none', 'container', 'hardened', 'vm'];
    if (order.indexOf(this.currentIsolation) < order.indexOf(wantedIso)) {
      throw new AboxError(
        'unsupported',
        `Template requires isolation "${wantedIso}", this backend delivers "${this.currentIsolation}"`,
      );
    }
    if (spec.user.uid <= 0)
      throw new AboxError('invalid_input', 'The sandbox user must not be root');
    this.runAs(spec); // throws when host-user mapping is needed but impossible
    if (!isValidShort(parseSandboxId(spec.id).short))
      throw new AboxError('invalid_input', `Invalid sandbox id: ${spec.id}`);
  }

  /**
   * The numeric identity the sandbox process runs as.
   *
   * Normally that is the template user (`spec.user.uid`, group = uid). A writable host bind mount
   * (`bind` workspace with access rw, or an rw extra mount) is the exception: the files belong to
   * the host user that runs abox, and without a user namespace the engine shows the real numeric
   * owner inside the container. A sandbox user with a different uid could not write them (the
   * typical case: CI runner uid 1001, template user uid 1000). So the process runs as the host
   * user's `uid:gid` instead; it is still an unprivileged user and every hardening option is
   * unchanged. The image's home directory is handed to that uid (see `createInner`), HOME is set
   * explicitly because the uid has no passwd entry in the image.
   *
   * Never root: a host uid or gid of 0 is refused (`unsupported`), the sandbox user must not be
   * root. Not applied (identity stays the template user) when nothing writable is bind-mounted,
   * for remote engines, on non-Linux hosts (Docker Desktop translates ownership itself) and on
   * rootless engines (their user namespace maps the host user to container root; unverified).
   */
  private runAs(spec: SandboxSpec): { uid: number; gid: number; hostMapped: boolean } {
    const own = { uid: spec.user.uid, gid: spec.user.uid, hostMapped: false };
    const writableBind =
      (spec.workspace.kind === 'bind' && spec.workspace.access === 'rw') ||
      spec.mounts.some((m) => m.access === 'rw');
    if (
      !writableBind ||
      this.remote ||
      process.platform !== 'linux' ||
      typeof process.getuid !== 'function' ||
      typeof process.getgid !== 'function' ||
      this.facts?.rootless
    )
      return own;
    const uid = process.getuid();
    const gid = process.getgid();
    if (uid === 0 || gid === 0) {
      throw new AboxError(
        'unsupported',
        'Writable host bind mounts are not supported when abox runs as root (uid or gid 0): the sandbox user is never root and could not write the files',
        { hint: 'Run abox as an unprivileged user, or use workspace delivery "copy".' },
      );
    }
    if (uid === own.uid && gid === own.gid) return own;
    return { uid, gid, hostMapped: true };
  }

  private async ensureNetwork(name: string, role: string): Promise<void> {
    try {
      await this.docker.getNetwork(name).inspect();
      return;
    } catch (e) {
      if (statusOf(e) !== 404) throw e;
    }
    try {
      await this.docker.createNetwork({
        Name: name,
        Driver: 'bridge',
        CheckDuplicate: true,
        Labels: { [LABEL.managed]: '1', [LABEL.role]: role },
      });
    } catch (e) {
      if (statusOf(e) !== 409) throw e; // created concurrently
    }
  }

  async create(spec: SandboxSpec): Promise<SandboxInfo> {
    return this.guard(async () => {
      await this.engineFacts();
      this.assertSupported(spec);
      const { host, short } = parseSandboxId(spec.id);
      // An expiresAt in the past is allowed: the sandbox is created, reported as expired and
      // can not be started (its main process would exit at once anyway).
      if (!(await this.imageInspect(spec.image.ref))) {
        throw new AboxError('not_found', `Environment image ${spec.image.ref} is missing`, {
          hint: 'Run prepare() for the template first.',
        });
      }
      const name = containerName(host, short);
      try {
        await this.docker.getContainer(name).inspect();
        throw new AboxError('conflict', `Sandbox ${spec.id} already exists`);
      } catch (e) {
        if (e instanceof AboxError) throw e;
        if (statusOf(e) !== 404) throw e;
      }

      const cleanup: Array<() => Promise<void>> = [];
      try {
        return await this.createInner(spec, short, name, cleanup);
      } catch (e) {
        for (const undo of cleanup.reverse()) await undo().catch(() => undefined);
        const msg = e instanceof Error ? e.message : '';
        if (spec.resources.diskBytes !== undefined && /storage-opt|quota|pquota/i.test(msg)) {
          throw new AboxError('unsupported', `Disk quota rejected by the engine: ${msg}`, {
            cause: e,
          });
        }
        throw e;
      }
    });
  }

  private readonlyRootfs(spec: SandboxSpec): boolean {
    return (
      (spec.labels[LABEL.readonlyRootfs] ?? spec.template.labels[LABEL.readonlyRootfs]) === 'true'
    );
  }

  private buildMounts(spec: SandboxSpec, ro: boolean): Docker.MountSettings[] {
    const mounts: Docker.MountSettings[] = [];
    const targets = new Set<string>();
    const add = (m: Docker.MountSettings): void => {
      const target = checkMountTarget(m.Target);
      if (targets.has(target))
        throw new AboxError('invalid_input', `Duplicate mount target ${target}`);
      targets.add(target);
      mounts.push({ ...m, Target: target });
    };
    const bind = (source: string, target: string, readOnly: boolean): void => {
      checkBindSource(source);
      add({
        Type: 'bind',
        Source: source,
        Target: target,
        ReadOnly: readOnly,
        BindOptions: { Propagation: 'rprivate', CreateMountpoint: false },
      } as Docker.MountSettings);
    };
    const ws = spec.workspace;
    const wsPath = sandboxPath(ws.sandboxPath, 'workspace path');
    if (ws.kind === 'bind') {
      bind(ws.hostPath, wsPath, ws.access === 'ro');
    } else if (ro) {
      add({ Type: 'volume', Source: '', Target: wsPath } as Docker.MountSettings);
    }
    for (const m of spec.mounts)
      bind(m.hostPath, sandboxPath(m.sandboxPath, 'mount path'), m.access !== 'rw');
    if (ro) {
      add({ Type: 'volume', Source: '', Target: CA_DIR } as Docker.MountSettings);
      add({
        Type: 'volume',
        Source: '',
        Target: `/home/${spec.user.name}`,
      } as Docker.MountSettings);
    }
    return mounts;
  }

  /** `.git`-style paths of a bind workspace that are mounted read-only on top of it. */
  private async readonlySubmounts(spec: SandboxSpec): Promise<Docker.MountSettings[]> {
    const ws = spec.workspace;
    if (ws.kind !== 'bind' || ws.access === 'ro') return [];
    const out: Docker.MountSettings[] = [];
    const rootReal = await fs.realpath(ws.hostPath);
    for (const sub of ws.readonlySubpaths ?? []) {
      const segs = sub.split('/').filter((s) => s !== '' && s !== '.');
      if (segs.length === 0 || segs.includes('..') || path.isAbsolute(sub)) {
        throw new AboxError('invalid_input', `Invalid readonly subpath: ${sub}`);
      }
      const src = path.join(ws.hostPath, ...segs);
      let real: string;
      try {
        real = await fs.realpath(src);
      } catch {
        continue; // does not exist: nothing to protect
      }
      if (!real.startsWith(rootReal + path.sep)) {
        throw new AboxError(
          'policy_denied',
          `Readonly subpath ${sub} resolves outside the workspace`,
        );
      }
      checkBindSource(real);
      const target = checkMountTarget(path.posix.join(sandboxPath(ws.sandboxPath), ...segs));
      out.push({
        Type: 'bind',
        Source: real,
        Target: target,
        ReadOnly: true,
        BindOptions: { Propagation: 'rprivate', CreateMountpoint: false },
      } as Docker.MountSettings);
    }
    return out;
  }

  private async createInner(
    spec: SandboxSpec,
    short: string,
    name: string,
    cleanup: Array<() => Promise<void>>,
  ): Promise<SandboxInfo> {
    const t = spec.template;
    const { uid: templateUid } = spec.user;
    const run = this.runAs(spec);
    const { uid, gid } = run;
    const remapsUid = run.hostMapped && uid !== templateUid;
    const home = `/home/${spec.user.name}`;
    const ro = this.readonlyRootfs(spec);
    const mounts = this.buildMounts(spec, ro);
    for (const m of await this.readonlySubmounts(spec)) {
      if (mounts.some((x) => x.Target === m.Target))
        throw new AboxError('invalid_input', `Duplicate mount target ${m.Target}`);
      mounts.push(m);
    }

    // Files that need the container filesystem: reject what a start would hide or the engine refuses.
    const wsPath = sandboxPath(spec.workspace.sandboxPath);
    for (const f of spec.files) {
      const p = sandboxPath(f.sandboxPath, 'file path');
      if (p === '/tmp') throw new AboxError('invalid_input', 'Cannot place a file at /tmp itself');
      if (
        ro &&
        !(
          p.startsWith(`${CA_DIR}/`) ||
          p.startsWith('/tmp/') ||
          p.startsWith(`${wsPath}/`) ||
          p.startsWith(`/home/${spec.user.name}/`)
        )
      ) {
        throw new AboxError(
          'unsupported',
          `With a read-only root filesystem files can only be placed in ${CA_DIR}, /tmp, the workspace or the home directory (${p})`,
        );
      }
    }

    const hasTmpFiles = spec.files.some((f) => sandboxPath(f.sandboxPath).startsWith('/tmp/'));

    // Network wiring
    let networkMode: string;
    const netEnv: Record<string, string> = {};
    let proxyId: string | undefined;
    switch (spec.network.mode) {
      case 'none':
        networkMode = 'none';
        break;
      case 'open':
        await this.ensureNetwork(OPEN_NETWORK, 'network');
        networkMode = OPEN_NETWORK;
        break;
      case 'allowlist': {
        const w = await this.createProxy(spec, short, cleanup);
        networkMode = w.network;
        proxyId = w.proxyId;
        const url = `http://${PROXY_ALIAS}:${PROXY_PORT}`;
        Object.assign(netEnv, {
          HTTP_PROXY: url,
          HTTPS_PROXY: url,
          http_proxy: url,
          https_proxy: url,
          NO_PROXY: 'localhost,127.0.0.1',
          no_proxy: 'localhost,127.0.0.1',
        });
        if (spec.network.injections.length > 0) {
          Object.assign(netEnv, {
            SSL_CERT_FILE: CA_BUNDLE_PATH,
            GIT_SSL_CAINFO: CA_BUNDLE_PATH,
            CURL_CA_BUNDLE: CA_BUNDLE_PATH,
            REQUESTS_CA_BUNDLE: CA_BUNDLE_PATH,
            NODE_EXTRA_CA_CERTS: CA_CERT_PATH,
          });
        }
        break;
      }
    }

    const hostConfig = buildHostConfig({
      spec,
      networkMode,
      mounts,
      readonlyRootfs: ro,
      tmpfsBytes: this.opts.tmpfsBytes ?? 256 * MiB,
      diskSupported: this.facts?.diskQuota ?? false,
      ...(this.opts.hardenedRuntime && this.currentIsolation === 'hardened'
        ? { runtime: this.opts.hardenedRuntime }
        : {}),
    });

    const userLabels: Record<string, string> = {};
    for (const [k, v] of Object.entries(spec.labels))
      if (!k.startsWith('abox.') || k === LABEL.readonlyRootfs) userLabels[k] = v;
    const labels: Record<string, string> = {
      ...userLabels,
      ...this.extra,
      [LABEL.managed]: '1',
      [LABEL.role]: 'sandbox',
      [LABEL.id]: spec.id,
      [LABEL.host]: spec.host,
      [LABEL.name]: spec.name,
      [LABEL.owner]: spec.owner,
      [LABEL.template]: t.name,
      [LABEL.templateHash]: t.hash,
      [LABEL.backend]: this.kind,
      [LABEL.isolation]: this.currentIsolation,
      [LABEL.created]: String(spec.createdAt),
      [LABEL.expires]: String(spec.expiresAt),
      [LABEL.networkMode]: spec.network.mode,
      [LABEL.user]: `${spec.user.name}:${templateUid}`,
      [LABEL.workspacePath]: wsPath,
      [LABEL.workspaceKind]: spec.workspace.kind,
      ...(hasTmpFiles ? { [LABEL.tmpFiles]: '1' } : {}),
      'abox.injections': spec.network.injections.length > 0 ? '1' : '0',
    };

    const createOpts: Record<string, unknown> = {
      name,
      Image: spec.image.ref,
      Labels: labels,
      Env: envArray({
        // No passwd entry for a host-mapped uid: without this HOME would be "/". On a read-only
        // rootfs the home volume's root can not be re-owned, so /tmp (tmpfs, 1777) is used.
        ...(remapsUid ? { HOME: ro ? '/tmp' : home } : {}),
        ...spec.template.env,
        ...spec.env,
        ...netEnv,
      }),
      User: `${uid}:${gid}`,
      WorkingDir: wsPath,
      Entrypoint: ttlEntrypoint(spec.expiresAt),
      Cmd: [],
      Tty: false,
      OpenStdin: false,
      AttachStdin: false,
      AttachStdout: false,
      AttachStderr: false,
      StopTimeout: this.opts.stopTimeoutSec ?? 5,
      HostConfig: hostConfig,
    };
    const created = await this.docker.createContainer(
      createOpts as unknown as Docker.ContainerCreateOptions,
    );
    cleanup.push(() => created.remove({ force: true, v: true }));
    const c = this.docker.getContainer(created.id);

    // The image's home belongs to the template uid; a host-mapped user needs it (and what build
    // steps put there) to be writable. Done on the created container, before files are placed.
    if (remapsUid) await reownDir(c, home, uid, gid, !ro);

    // Workspace delivery
    if (spec.workspace.kind === 'copy') {
      await mkdirP(c, path.posix.dirname(wsPath), uid, gid);
      await putArchiveStream(
        c,
        packHostPath(spec.workspace.hostPath, path.posix.basename(wsPath), {
          uid,
          gid,
          ...(spec.workspace.exclude ? { exclude: spec.workspace.exclude } : {}),
        }),
        path.posix.dirname(wsPath),
      );
    } else if (spec.workspace.kind === 'none') {
      // The engine may already have created WORKDIR as root: (re)apply ownership explicitly.
      if (ro) {
        // wsPath is an anonymous volume here; its parent is on the read-only rootfs.
        await c.putArchive(
          await tarFromEntries([{ name: './', type: 'directory', uid, gid, mode: 0o755 }]),
          { path: wsPath },
        );
      } else {
        const parent = path.posix.dirname(wsPath);
        await mkdirP(c, parent, uid, gid);
        await c.putArchive(
          await tarFromEntries([
            { name: path.posix.basename(wsPath), type: 'directory', uid, gid, mode: 0o755 },
          ]),
          { path: parent },
        );
      }
    }

    // Files
    for (const f of spec.files) {
      const p = sandboxPath(f.sandboxPath, 'file path');
      if (p.startsWith('/tmp/')) {
        // /tmp is a tmpfs that only exists once the container runs: keep the file next to the
        // image and let `start` copy it over (so it is also there after a restart).
        await putFile(c, `${TMP_STASH}/${p.slice('/tmp/'.length)}`, f.content, {
          mode: f.mode,
          uid,
          gid,
        });
        continue;
      }
      const root = p.startsWith(`${CA_DIR}/`);
      await putFile(c, p, f.content, { mode: f.mode, uid: root ? 0 : uid, gid: root ? 0 : gid });
    }

    // Proxy CA
    if (proxyId && spec.network.injections.length > 0) await this.installCa(proxyId, created.id);

    return this.toInfo(await c.inspect());
  }

  // -------------------------------------------------------------------------
  // Proxy sidecar
  // -------------------------------------------------------------------------

  private async createProxy(
    spec: SandboxSpec,
    short: string,
    cleanup: Array<() => Promise<void>>,
  ): Promise<{ network: string; proxyId: string }> {
    const assets = this.proxyAssets;
    if (!assets) throw new AboxError('unsupported', 'Egress proxy runtime is not available');
    // The proxy image and the `abox-open` / `abox-egress` networks are infrastructure that every
    // instance on this engine shares: they carry no instance id (and no extra labels), and are never
    // removed by a provider.
    const image = await ensureProxyImage(this.docker, assets, {});
    await this.ensureNetwork(EGRESS_NETWORK, 'network');

    const intName = internalNetName(short);
    const labels = {
      [LABEL.managed]: '1',
      [LABEL.id]: spec.id,
      [LABEL.host]: spec.host,
      [LABEL.owner]: spec.owner,
      ...this.extra,
    };
    const net = await this.docker.createNetwork({
      Name: intName,
      Driver: 'bridge',
      Internal: true,
      CheckDuplicate: true,
      Labels: { ...labels, [LABEL.role]: 'network' },
    });
    cleanup.push(() => net.remove());

    const proxyOpts: Record<string, unknown> = {
      name: proxyName(short),
      Image: image,
      Labels: { ...labels, [LABEL.role]: 'proxy', [LABEL.expires]: String(spec.expiresAt) },
      User: PROXY_USER,
      HostConfig: {
        NetworkMode: intName,
        Privileged: false,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges:true'],
        ReadonlyRootfs: true,
        Tmpfs: {
          [PROXY_RUN_DIR]: `rw,nosuid,nodev,noexec,size=16m,uid=${PROXY_USER_UID},gid=${PROXY_USER_UID},mode=0700`,
        },
        Mounts: [{ Type: 'volume', Source: '', Target: PROXY_CONFIG_DIR }],
        Memory: 128 * MiB,
        MemorySwap: 128 * MiB,
        PidsLimit: 64,
        NanoCpus: 1e9,
        Init: true,
        IpcMode: 'private',
        RestartPolicy: { Name: 'no' },
      },
      NetworkingConfig: { EndpointsConfig: { [intName]: { Aliases: [PROXY_ALIAS] } } },
    };
    const created = await this.docker.createContainer(
      proxyOpts as unknown as Docker.ContainerCreateOptions,
    );
    cleanup.push(() => created.remove({ force: true, v: true }));
    await this.docker.getNetwork(EGRESS_NETWORK).connect({ Container: created.id });

    // Config contains secret header values: placed as a file before start, never env/labels.
    await this.writeProxyConfig(created.id, Buffer.from(proxyConfigJson(spec.network)));
    await this.startProxy(created.id);
    return { network: intName, proxyId: created.id };
  }

  /** Does the proxy's current config contain header injections (i.e. does it generate a CA)? */
  private async proxyInjects(proxyId: string): Promise<boolean> {
    const cfg = JSON.parse(
      (await getFile(this.docker.getContainer(proxyId), PROXY_CONFIG_PATH, MiB)).data.toString(
        'utf8',
      ),
    ) as { injections?: unknown[] };
    return (cfg.injections?.length ?? 0) > 0;
  }

  /** Put `config.json` into the proxy's config volume (owned by the proxy user, mode 0600). */
  private async writeProxyConfig(proxyId: string, json: Buffer): Promise<void> {
    await this.docker.getContainer(proxyId).putArchive(
      await tarFromEntries([
        {
          name: 'config.json',
          data: json,
          mode: 0o600,
          uid: PROXY_USER_UID,
          gid: PROXY_USER_UID,
        },
      ]),
      { path: PROXY_CONFIG_DIR },
    );
  }

  private async stopContainer(containerId: string, t: number): Promise<void> {
    try {
      await this.docker.getContainer(containerId).stop({ t });
    } catch (e) {
      if (statusOf(e) !== 304) throw e;
    }
  }

  /**
   * Replace the egress rules (allowlist, private exceptions, header injections) of an allowlist
   * sandbox. The proxy reads its config at startup, so the new `config.json` is written into the
   * sidecar and the sidecar is restarted; the sandbox container and its networks stay as they are
   * (open connections through the proxy are cut). When the proxy comes up with a new CA
   * (injections), the CA and the CA bundle of a running sandbox are replaced; a stopped sandbox gets
   * them on its next `start`. If the new config does not start, the old one is restored.
   * Other modes have no rules: `none`/`open` sandboxes answer `unsupported`.
   */
  async updateNetwork(id: SandboxId, network: NetworkSpec): Promise<void> {
    return this.guard(async () => {
      const c = await this.load(id);
      const labels = c.Config.Labels ?? {};
      const current = labels[LABEL.networkMode] ?? 'none';
      if (current !== 'allowlist') {
        throw new AboxError(
          'unsupported',
          `Sandbox ${id} has network mode "${current}": only the rules of an allowlist sandbox can be changed`,
          { hint: 'Create a new sandbox with the network mode you need.' },
        );
      }
      if (network.mode !== 'allowlist') {
        throw new AboxError(
          'invalid_input',
          `The network mode of a sandbox cannot change (allowlist -> ${network.mode})`,
        );
      }
      const hadInjections = labels['abox.injections'] === '1';
      if (network.injections.length > 0 && !hadInjections) {
        throw new AboxError(
          'unsupported',
          'Header injections cannot be added to a sandbox that was created without them',
          {
            hint: 'The CA environment of the sandbox is fixed at creation. Create a new sandbox with the injection.',
          },
        );
      }
      const { short } = this.parseId(id);
      const pid = await this.proxyContainerId(short);
      if (!pid) {
        throw new AboxError('backend_error', `Egress proxy of ${id} is missing`, {
          hint: 'Remove and recreate the sandbox.',
        });
      }
      const pc = this.docker.getContainer(pid);
      const old = (await getFile(pc, PROXY_CONFIG_PATH, MiB)).data;
      const next = Buffer.from(proxyConfigJson(network));
      await this.writeProxyConfig(pid, next);
      if (!(await pc.inspect()).State.Running) return; // `start` brings it up with the new config
      try {
        await this.stopContainer(pid, 2);
        await this.startProxy(pid);
      } catch (e) {
        // The new config did not start (invalid rules): put the old one back and bring the proxy up again.
        await this.stopContainer(pid, 1).catch(() => undefined);
        await this.writeProxyConfig(pid, old).catch(() => undefined);
        await this.startProxy(pid).catch(() => undefined);
        if (e instanceof AboxError && e.code === 'backend_error') {
          throw new AboxError(
            'invalid_input',
            'The egress proxy rejected the new network rules; the previous rules are active again',
            { ...(e.details ? { details: e.details } : {}), cause: e },
          );
        }
        throw e;
      }
      // A restarted proxy generated a new CA.
      if (network.injections.length > 0 && c.State.Running) await this.installCa(pid, c.Id);
    });
  }

  /** Start the proxy container (if needed) and wait for its ready line. */
  private async startProxy(proxyId: string, timeoutMs = 30_000): Promise<boolean> {
    const pc = this.docker.getContainer(proxyId);
    const info = await pc.inspect();
    if (info.State.Running) return false;
    const readyCount = (log: string): number =>
      log.split('\n').filter((l) => parseProxyLine(l)?.event === 'ready').length;
    // Logs survive restarts: wait for one more ready line than before this start.
    const before = readyCount(await this.readLogs(proxyId));
    await pc.start();
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const logs = await this.readLogs(proxyId);
      if (readyCount(logs) > before) return true;
      const st = (await pc.inspect()).State;
      if (!st.Running) {
        throw new AboxError(
          'backend_error',
          `Egress proxy exited during startup (code ${st.ExitCode})`,
          {
            details: { log: logs.slice(-2000) },
          },
        );
      }
      if (Date.now() > deadline) {
        throw new AboxError('timeout', 'Egress proxy did not become ready in time', {
          details: { log: logs.slice(-2000) },
        });
      }
      await sleep(150);
    }
  }

  private async readLogs(
    containerId: string,
    o: { tail?: number; since?: number } = {},
  ): Promise<string> {
    const buf = (await this.docker.getContainer(containerId).logs({
      stdout: true,
      stderr: true,
      follow: false,
      ...(o.tail !== undefined ? { tail: o.tail } : {}),
      ...(o.since !== undefined ? { since: o.since } : {}),
    })) as unknown as Buffer;
    const out: Buffer[] = [];
    const demux = new Demux((_k, d) => out.push(d));
    await new Promise<void>((res, rej) => {
      demux.once('finish', res);
      demux.once('error', rej);
      demux.end(buf);
    });
    return Buffer.concat(out).toString('utf8');
  }

  /** Copy the proxy CA into the sandbox and rebuild the CA bundle (system bundle + abox CA). */
  private async installCa(proxyId: string, sandboxId: string): Promise<void> {
    // docker cp cannot read tmpfs mounts: fetch the CA with exec (it exists once `ready` was logged).
    const caRes = await simpleExec(this.docker, proxyId, ['cat', PROXY_CA_PATH]);
    if (caRes.exitCode !== 0 || !caRes.stdout.toString('utf8').includes('BEGIN CERTIFICATE')) {
      throw new AboxError(
        'backend_error',
        `Proxy did not provide a CA certificate: ${caRes.stderr.toString('utf8').trim()}`,
      );
    }
    const ca = { data: caRes.stdout };
    const sb = this.docker.getContainer(sandboxId);
    const candidates = [
      '/etc/ssl/certs/ca-certificates.crt',
      '/etc/pki/tls/certs/ca-bundle.crt',
      '/etc/ca-certificates/extracted/tls-ca-bundle.pem',
      '/etc/ssl/cert.pem',
    ];
    let system: Buffer = Buffer.alloc(0);
    for (const cand of candidates) {
      try {
        system = (await getFile(sb, cand, 8 * MiB)).data;
        if (system.length > 0) break;
      } catch (e) {
        if (!(e instanceof AboxError) || (e.code !== 'not_found' && e.code !== 'invalid_input'))
          throw e;
      }
    }
    const nl = Buffer.from('\n');
    await putFile(sb, CA_CERT_PATH, ca.data, { mode: 0o644, uid: 0, gid: 0 });
    await putFile(
      sb,
      CA_BUNDLE_PATH,
      Buffer.concat([system, system.length ? nl : Buffer.alloc(0), ca.data, nl]),
      {
        mode: 0o644,
        uid: 0,
        gid: 0,
      },
    );
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  private async proxyContainerId(short: string): Promise<string | undefined> {
    try {
      const p = await this.docker.getContainer(proxyName(short)).inspect();
      const l = p.Config.Labels ?? {};
      return l[LABEL.managed] === '1' && this.ownsInstance(l) ? p.Id : undefined;
    } catch (e) {
      if (statusOf(e) === 404) return undefined;
      throw e;
    }
  }

  async start(id: SandboxId): Promise<void> {
    return this.guard(async () => {
      const c = await this.load(id);
      const labels = c.Config.Labels ?? {};
      const expires = Number(labels[LABEL.expires] ?? 0);
      if (expires > 0 && expires <= Date.now()) {
        throw new AboxError('conflict', `Sandbox ${id} has expired and cannot be started`, {
          hint: 'Remove it (`abox gc` / `abox rm`) and create a new one.',
        });
      }
      const { short } = this.parseId(id);
      if (labels[LABEL.networkMode] === 'allowlist') {
        const pid = await this.proxyContainerId(short);
        if (!pid)
          throw new AboxError('backend_error', `Egress proxy of ${id} is missing`, {
            hint: 'Remove and recreate the sandbox.',
          });
        const restarted = await this.startProxy(pid);
        // A restarted proxy generates a new CA.
        // (`updateNetwork` may have removed the injections: then there is no CA to install.)
        if (restarted && labels['abox.injections'] === '1' && (await this.proxyInjects(pid)))
          await this.installCa(pid, c.Id);
      }
      if (c.State.Running) return;
      try {
        await this.docker.getContainer(c.Id).start();
      } catch (e) {
        if (statusOf(e) !== 304) throw e;
      }
      if (labels[LABEL.tmpFiles] === '1') await this.restoreTmpFiles(c.Id);
    });
  }

  /** Copy the spec files destined for the /tmp tmpfs into it (it is empty after every start). */
  private async restoreTmpFiles(containerId: string): Promise<void> {
    // Entry by entry: `cp -pR dir/. /tmp/` also tries to set the times of /tmp itself, which GNU cp
    // (Debian-based images) reports as an error because /tmp is not owned by the sandbox user.
    const res = await simpleExec(this.docker, containerId, [
      '/bin/sh',
      '-c',
      'cd -- "$1" && find . -mindepth 1 -maxdepth 1 -exec cp -pR {} /tmp/ \\;',
      'abox-restore-tmp',
      TMP_STASH,
    ]);
    if (res.exitCode !== 0) {
      await this.docker
        .getContainer(containerId)
        .stop({ t: 1 })
        .catch(() => undefined);
      throw new AboxError('backend_error', 'Could not place the spec files under /tmp', {
        details: { stderr: res.stderr.toString('utf8').slice(0, 500) },
      });
    }
  }

  async stop(id: SandboxId): Promise<void> {
    return this.guard(async () => {
      const c = await this.load(id);
      const { short } = this.parseId(id);
      try {
        await this.docker.getContainer(c.Id).stop({ t: this.opts.stopTimeoutSec ?? 5 });
      } catch (e) {
        if (statusOf(e) !== 304) throw e;
      }
      if (c.Config.Labels?.[LABEL.networkMode] === 'allowlist') {
        const pid = await this.proxyContainerId(short);
        if (pid) {
          try {
            await this.docker.getContainer(pid).stop({ t: 2 });
          } catch (e) {
            if (statusOf(e) !== 304) throw e;
          }
        }
      }
    });
  }

  async remove(id: SandboxId): Promise<void> {
    return this.guard(async () => {
      const { host, short } = parseSandboxId(id);
      if (host !== this.host.host || !isValidShort(short)) return;
      const ignore = (e: unknown): void => {
        const s = statusOf(e);
        if (s !== 404 && s !== 409) throw e;
      };
      // Sandbox container (only if it really is one of ours: same instance, same backend kind).
      // A sandbox of another instance is refused, nothing of it is touched.
      try {
        const c = await this.docker.getContainer(containerName(host, short)).inspect();
        const l = c.Config.Labels ?? {};
        if (l[LABEL.managed] === '1' && l[LABEL.id] === id) {
          if (!this.ownsSandbox(l)) throw new AboxError('not_found', `Unknown sandbox ${id}`);
          await this.docker.getContainer(c.Id).remove({ force: true, v: true });
        }
      } catch (e) {
        if (e instanceof AboxError) throw e;
        ignore(e);
      }
      // Proxy sidecar.
      try {
        const p = await this.docker.getContainer(proxyName(short)).inspect();
        const l = p.Config.Labels ?? {};
        if (l[LABEL.managed] === '1' && l[LABEL.id] === id && this.ownsInstance(l)) {
          await this.docker.getContainer(p.Id).remove({ force: true, v: true });
        }
      } catch (e) {
        ignore(e);
      }
      // Internal network.
      try {
        const n = this.docker.getNetwork(internalNetName(short));
        const info = await n.inspect();
        const l = info.Labels ?? {};
        if (l[LABEL.managed] === '1' && l[LABEL.id] === id && this.ownsInstance(l))
          await n.remove();
      } catch (e) {
        ignore(e);
      }
      // Snapshot images.
      try {
        const imgs = await this.docker.listImages({
          filters: { reference: [`${snapshotRepo(short)}:*`] },
        });
        for (const i of imgs) {
          const l = i.Labels ?? {};
          if (l[LABEL.snapshotOf] !== id || !this.ownsInstance(l)) continue;
          for (const t of i.RepoTags ?? []) await this.docker.getImage(t).remove().catch(ignore);
        }
      } catch (e) {
        ignore(e);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Exec
  // -------------------------------------------------------------------------

  private async running(id: SandboxId): Promise<Docker.ContainerInspectInfo> {
    const c = await this.load(id);
    if (!c.State.Running) {
      throw new AboxError('conflict', `Sandbox ${id} is not running`, { hint: 'Start it first.' });
    }
    return c;
  }

  async exec(id: SandboxId, req: ExecRequest): Promise<ExecResult> {
    return this.guard(async () => {
      const c = await this.running(id);
      const cap = req.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let outLen = 0;
      let errLen = 0;
      let truncated = false;
      const take = (chunks: Buffer[], len: number, d: Buffer): number => {
        if (len >= cap) {
          truncated = true;
          return len;
        }
        const piece = d.length + len > cap ? d.subarray(0, cap - len) : d;
        if (piece.length < d.length) truncated = true;
        chunks.push(piece);
        return len + piece.length;
      };
      const t0 = Date.now();
      const r = await runExec(this.docker, c.Id, req, {
        onStdout: (d) => (outLen = take(out, outLen, d)),
        onStderr: (d) => (errLen = take(err, errLen, d)),
      });
      return {
        exitCode: r.exitCode,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        truncated,
        timedOut: r.timedOut,
        durationMs: Date.now() - t0,
      };
    });
  }

  async *spawn(id: SandboxId, req: ExecRequest): AsyncIterable<ExecEvent> {
    const c = await this.guard(() => this.running(id));
    const queue: ExecEvent[] = [];
    let wake: (() => void) | undefined;
    let finished = false;
    let failure: unknown;
    const push = (e: ExecEvent): void => {
      queue.push(e);
      wake?.();
    };
    const run = runExec(this.docker, c.Id, req, {
      onStdout: (data) => push({ type: 'stdout', data }),
      onStderr: (data) => push({ type: 'stderr', data }),
    })
      .then((r) => push({ type: 'exit', exitCode: r.exitCode, timedOut: r.timedOut }))
      .catch((e: unknown) => {
        failure = e;
      })
      .finally(() => {
        finished = true;
        wake?.();
      });
    try {
      for (;;) {
        const ev = queue.shift();
        if (ev) {
          yield ev;
          if (ev.type === 'exit') return;
          continue;
        }
        if (finished) break;
        await new Promise<void>((r) => (wake = r));
        wake = undefined;
      }
      if (failure !== undefined)
        throw isAbortError(failure) ? failure : mapEngineError(failure, this.socketPath);
    } finally {
      await run;
    }
  }

  async attach(id: SandboxId, tty: TtyOptions): Promise<TtySession> {
    return this.guard(async () => {
      const c = await this.running(id);
      return openTty(this.docker, c.Id, tty);
    });
  }

  // -------------------------------------------------------------------------
  // Files
  // -------------------------------------------------------------------------

  async copyIn(id: SandboxId, hostPath: string, sandboxDest: string): Promise<void> {
    return this.guard(async () => {
      const c = await this.load(id);
      const dest = sandboxPath(sandboxDest, 'destination');
      if (dest === '/') throw new AboxError('invalid_input', 'Cannot copy onto /');
      const { uid, gid } = userIds(c);
      const dir = path.posix.dirname(dest);
      const ct = this.docker.getContainer(c.Id);
      await mkdirP(ct, dir, uid, gid);
      await putArchiveStream(
        ct,
        packHostPath(path.resolve(hostPath), path.posix.basename(dest), { uid, gid }),
        dir,
      );
    });
  }

  async copyOut(id: SandboxId, sandboxSrc: string, hostPath: string): Promise<void> {
    return this.guard(async () => {
      const c = await this.load(id);
      const src = sandboxPath(sandboxSrc, 'source');
      if (src === '/') throw new AboxError('invalid_input', 'Cannot copy out /');
      const stream = (await this.docker
        .getContainer(c.Id)
        .getArchive({ path: src })) as unknown as Readable;
      await extractArchiveSafe(stream, hostPath);
    });
  }

  async readFile(
    id: SandboxId,
    sandboxFile: string,
    maxBytes: number,
  ): Promise<{ data: Buffer; truncated: boolean; size: number }> {
    return this.guard(async () => {
      const c = await this.load(id);
      const p = sandboxPath(sandboxFile, 'file');
      // /tmp is a tmpfs: the archive API only sees the (hidden) image directory behind it.
      if (c.State.Running && underTmp(p)) return this.readTmpFile(c.Id, p, maxBytes);
      return getFile(this.docker.getContainer(c.Id), p, maxBytes);
    });
  }

  async writeFile(id: SandboxId, sandboxFile: string, data: Buffer, mode = 0o644): Promise<void> {
    return this.guard(async () => {
      const c = await this.load(id);
      const p = sandboxPath(sandboxFile, 'file');
      if (p === '/') throw new AboxError('invalid_input', 'Invalid file path');
      if (c.State.Running && underTmp(p)) {
        await this.writeTmpFile(c.Id, p, data, mode & 0o777);
        return;
      }
      const { uid, gid } = userIds(c);
      const root = p.startsWith(`${CA_DIR}/`);
      await putFile(this.docker.getContainer(c.Id), p, data, {
        mode: mode & 0o777,
        uid: root ? 0 : uid,
        gid: root ? 0 : gid,
      });
    });
  }

  /** Read a file of the /tmp tmpfs of a running sandbox through the container (as its user). */
  private async readTmpFile(
    containerId: string,
    file: string,
    maxBytes: number,
  ): Promise<{ data: Buffer; truncated: boolean; size: number }> {
    const script =
      '[ -e "$1" ] || exit 3; [ -f "$1" ] || exit 4; stat -c %s -- "$1" || exit 5; head -c "$2" -- "$1"';
    const r = await simpleExec(this.docker, containerId, [
      '/bin/sh',
      '-c',
      script,
      'abox-read',
      file,
      String(Math.max(0, Math.floor(maxBytes))),
    ]);
    if (r.exitCode === 3) throw new AboxError('not_found', `No such file: ${file}`);
    if (r.exitCode === 4) throw new AboxError('invalid_input', `Not a regular file: ${file}`);
    if (r.exitCode !== 0)
      throw new AboxError('backend_error', `Cannot read ${file}`, {
        details: { stderr: r.stderr.toString('utf8').slice(0, 500) },
      });
    const nl = r.stdout.indexOf(0x0a);
    const size = Number(r.stdout.subarray(0, nl).toString('utf8'));
    const data = r.stdout.subarray(nl + 1);
    return { data: Buffer.from(data), truncated: size > data.length, size };
  }

  /** Write a file into the /tmp tmpfs of a running sandbox (content on stdin, never in argv). */
  private async writeTmpFile(
    containerId: string,
    file: string,
    data: Buffer,
    mode: number,
  ): Promise<void> {
    const script =
      'umask 077; mkdir -p -- "$(dirname -- "$1")" && cat > "$1.abox-tmp" && chmod "$2" "$1.abox-tmp" && mv -f -- "$1.abox-tmp" "$1"';
    const r = await simpleExec(
      this.docker,
      containerId,
      ['/bin/sh', '-c', script, 'abox-write', file, mode.toString(8)],
      { stdin: data },
    );
    if (r.exitCode !== 0)
      throw new AboxError('backend_error', `Cannot write ${file}`, {
        details: { stderr: r.stderr.toString('utf8').slice(0, 500) },
      });
  }

  async listDir(id: SandboxId, dir: string): Promise<DirEntry[]> {
    return this.guard(async () => {
      const c = await this.load(id);
      const p = sandboxPath(dir, 'directory');
      if (!c.State.Running) return this.listDirArchive(c.Id, p);
      const script =
        'cd -- "$1" || exit 3; find . -mindepth 1 -maxdepth 1 -exec stat -c "%Y %a %s %F %n" {} +';
      const r = await simpleExec(this.docker, c.Id, ['/bin/sh', '-c', script, 'abox-ls', p]);
      if (r.exitCode !== 0) {
        const msg = r.stderr.toString('utf8').trim() || `cannot list ${p}`;
        throw new AboxError(
          /no such|not a dir|can't cd|cannot cd/i.test(msg) || r.exitCode === 3
            ? 'not_found'
            : 'backend_error',
          msg,
        );
      }
      const entries: DirEntry[] = [];
      for (const line of r.stdout.toString('utf8').split('\n')) {
        const m = /^(\d+) ([0-7]+) (\d+) (.+?) \.\/(.+)$/.exec(line);
        if (!m) continue;
        const kind = m[4] as string;
        entries.push({
          name: m[5] as string,
          type: kind.includes('regular')
            ? 'file'
            : kind === 'directory'
              ? 'dir'
              : kind.includes('symbolic')
                ? 'symlink'
                : 'other',
          size: Number(m[3]),
          mode: parseInt(m[2] as string, 8),
          mtimeMs: Number(m[1]) * 1000,
        });
      }
      return entries.sort((a, b) => a.name.localeCompare(b.name));
    });
  }

  private async listDirArchive(containerId: string, dir: string): Promise<DirEntry[]> {
    const stream = (await this.docker
      .getContainer(containerId)
      .getArchive({ path: dir })) as unknown as Readable;
    const out: DirEntry[] = [];
    for await (const entry of tarEntries(stream)) {
      const segs = entry.header.name.split('/').filter((s) => s !== '' && s !== '.');
      if (segs.length === 2) {
        const h = entry.header;
        out.push({
          name: segs[1] as string,
          type:
            h.type === 'directory'
              ? 'dir'
              : h.type === 'symlink'
                ? 'symlink'
                : h.type === 'file'
                  ? 'file'
                  : 'other',
          size: h.size ?? 0,
          mode: (h.mode ?? 0) & 0o7777,
          mtimeMs: (h.mtime ?? new Date(0)).getTime(),
        });
      }
      entry.resume();
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  // -------------------------------------------------------------------------
  // Snapshots
  //
  // Decision: implemented with `commit` (see README of the decision in the package docs):
  // the container filesystem layer is committed to `abox-snap/<short>:<name>`; restore recreates
  // the container from that image with the *engine-reported* config of the current container
  // (HostConfig, env, labels, entrypoint), so hardening and TTL are identical and no spec/secret
  // has to be persisted in a label. Volumes, tmpfs and bind mounts are not part of a snapshot,
  // therefore snapshots are refused for read-only-rootfs sandboxes (their workspace is a volume).
  // -------------------------------------------------------------------------

  async snapshot(id: SandboxId, name: string): Promise<string> {
    return this.guard(async () => {
      const c = await this.load(id);
      const { short } = this.parseId(id);
      if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(name)) {
        throw new AboxError('invalid_input', `Invalid snapshot name "${name}" (use [a-z0-9_.-])`);
      }
      if (c.Config.Labels?.[LABEL.readonlyRootfs] === 'true') {
        throw new AboxError(
          'unsupported',
          'Snapshots are not supported for sandboxes with a read-only root filesystem',
        );
      }
      const extraChanges = Object.entries(this.extra).map(
        ([k, v]) => `LABEL ${k}=${JSON.stringify(v)}`,
      );
      await this.docker.getContainer(c.Id).commit({
        repo: snapshotRepo(short),
        tag: name,
        comment: `abox snapshot ${name}`,
        pause: true,
        changes: [
          `LABEL ${LABEL.managed}=0`,
          `LABEL ${LABEL.role}=snapshot`,
          `LABEL ${LABEL.snapshotOf}=${JSON.stringify(id)}`,
          `LABEL ${LABEL.snapshotName}=${JSON.stringify(name)}`,
          ...extraChanges,
        ].join('\n'),
      } as unknown as unknown as { repo: string });
      return `${snapshotRepo(short)}:${name}`;
    });
  }

  async restore(id: SandboxId, snapshotId: string): Promise<void> {
    return this.guard(async () => {
      const c = await this.load(id);
      const { short } = this.parseId(id);
      if (!snapshotId.startsWith(`${snapshotRepo(short)}:`)) {
        throw new AboxError('not_found', `Snapshot ${snapshotId} does not belong to ${id}`);
      }
      const img = await this.imageInspect(snapshotId);
      if (
        !img ||
        img.Config.Labels?.[LABEL.snapshotOf] !== id ||
        !this.ownsInstance(img.Config.Labels)
      ) {
        throw new AboxError('not_found', `Unknown snapshot ${snapshotId}`);
      }
      const wasRunning = c.State.Running;
      const oldName = c.Name.replace(/^\//, '');
      const old = this.docker.getContainer(c.Id);
      if (wasRunning)
        await old.stop({ t: this.opts.stopTimeoutSec ?? 5 }).catch((e: unknown) => {
          if (statusOf(e) !== 304) throw e;
        });
      const tmpName = `${oldName}-old-${randomBytes(3).toString('hex')}`;
      await old.rename({ name: tmpName });
      const networks = c.NetworkSettings.Networks ?? {};
      const endpoints: Record<string, { Aliases?: string[] }> = {};
      for (const [n, ep] of Object.entries(networks)) {
        if (['none', 'bridge', 'host'].includes(n)) continue;
        endpoints[n] = { Aliases: (ep.Aliases ?? []).filter((a: string) => !c.Id.startsWith(a)) };
      }
      let created: Docker.Container;
      try {
        created = await this.docker.createContainer({
          name: oldName,
          Image: snapshotId,
          Labels: c.Config.Labels,
          Env: c.Config.Env,
          User: c.Config.User,
          WorkingDir: c.Config.WorkingDir,
          Entrypoint: c.Config.Entrypoint,
          Cmd: c.Config.Cmd,
          Tty: false,
          StopTimeout: (c.Config as unknown as { StopTimeout?: number }).StopTimeout,
          HostConfig: c.HostConfig,
          ...(Object.keys(endpoints).length
            ? { NetworkingConfig: { EndpointsConfig: endpoints } }
            : {}),
        } as unknown as Docker.ContainerCreateOptions);
      } catch (e) {
        await old.rename({ name: oldName }).catch(() => undefined);
        throw e;
      }
      await old.remove({ force: true, v: true });
      void created;
      if (wasRunning) await this.start(id);
    });
  }

  // -------------------------------------------------------------------------
  // Logs / events
  // -------------------------------------------------------------------------

  async logs(id: SandboxId, opts: { tail?: number; sinceTs?: number } = {}): Promise<string> {
    return this.guard(async () => {
      const c = await this.load(id);
      return this.readLogs(c.Id, {
        ...(opts.tail !== undefined ? { tail: opts.tail } : {}),
        ...(opts.sinceTs !== undefined ? { since: Math.floor(opts.sinceTs / 1000) } : {}),
      });
    });
  }

  async networkEvents(id: SandboxId, sinceTs = 0): Promise<NetworkEvent[]> {
    return this.guard(async () => {
      const c = await this.load(id);
      if (c.Config.Labels?.[LABEL.networkMode] !== 'allowlist') return [];
      const { short } = this.parseId(id);
      const pid = await this.proxyContainerId(short);
      if (!pid) return [];
      const text = await this.readLogs(pid, { since: Math.floor(sinceTs / 1000) });
      const events: NetworkEvent[] = [];
      for (const line of text.split('\n')) {
        const o = parseProxyLine(line);
        if (!o || o.event !== 'request' || typeof o.ts !== 'number' || o.ts < sinceTs) continue;
        if (
          typeof o.host !== 'string' ||
          typeof o.port !== 'number' ||
          (o.decision !== 'allow' && o.decision !== 'deny')
        )
          continue;
        events.push({
          ts: o.ts,
          host: o.host,
          port: o.port,
          method: o.method ?? '',
          decision: o.decision,
          ...(o.ip ? { ip: o.ip } : {}),
          ...(o.reason ? { reason: o.reason } : {}),
        });
      }
      return events;
    });
  }
}

export function createDockerProvider(
  host: HostConnection,
  opts: DockerProviderOptions = {},
): DockerProvider {
  return new DockerProvider(host, { ...opts, kind: 'docker' });
}

export function createPodmanProvider(
  host: HostConnection,
  opts: DockerProviderOptions = {},
): DockerProvider {
  return new DockerProvider(host, { ...opts, kind: 'podman' });
}
