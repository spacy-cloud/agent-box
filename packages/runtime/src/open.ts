import {
  Abox,
  AboxError,
  HostRegistry,
  type HostCache,
  LibsecretStore,
  StateStore,
  TunnelManager,
  createHostResolver,
  ensureDirs,
  hostsEnvFromPaths,
  loadConfig,
  readLocalLive,
  readRemoteLive,
  resolvePaths,
  type AboxConfig,
  type AboxPaths,
  type BackendKind,
  type Caller,
  type HostConnection,
  type HostLiveSource,
  type HostResolver,
  type HostTargetResolver,
  type ProviderFactory,
  type HostsEnv,
  type SandboxProvider,
  type SecretStore,
} from '@abox/core';
import { readFileSync } from 'node:fs';
import { hardenedRuntimeFor, providerFactories } from './providers.js';

export interface OpenAboxOptions {
  /** Environment for path resolution (default `process.env`; `ABOX_HOME=<dir>` isolates everything). */
  env?: NodeJS.ProcessEnv;
  /** Calling context: `human` (default) or an agent context id (MCP). */
  contextId?: string;
  /** Directory with `.sandbox/*.yaml` project templates; default: nothing (the manager uses the workspace). */
  projectDir?: string;
  /** Resolve hosts from `hosts.yaml` (ssh hosts with forwarded engine sockets). Default true. */
  hosts?: boolean;
  /** Override the keyring (tests). */
  secretStore?: SecretStore;
  /** Overrides for the ssh helpers, e.g. another `sshBinary` or `sshConfigFile: null` (tests). */
  hostsEnv?: Partial<HostsEnv>;
  /** Home directory for `~` expansion in the manager (tests). */
  home?: string;
  now?: () => number;
  ttlCheckIntervalSec?: number;
  reconcileOnOpen?: boolean;
  /** Use this policy text instead of `policy.yaml` (tests). */
  policyText?: string;
  /** Called with host audit events when the runtime itself records them (default: write to the audit log). */
  onHostAudit?: (action: string, details: Record<string, unknown>) => void;
}

export interface AboxRuntime {
  abox: Abox;
  caller: Caller;
  paths: AboxPaths;
  config: AboxConfig;
  env: NodeJS.ProcessEnv;
  secretStore: SecretStore;
  /** Host profiles (`hosts.yaml`). Human surfaces only; never expose to agents. */
  hostRegistry: HostRegistry;
  /** Last known reachability of remote hosts. */
  hostCache: HostCache;
  /** Forwarded engine sockets of ssh hosts. */
  tunnels: TunnelManager;
  /** Environment for the ssh helpers (known_hosts, runtime dir, audit hook). */
  hostsEnv: HostsEnv;
  /**
   * The backend provider of a host, for operations the manager does not offer (interactive
   * `attach`, recursive `copyIn`/`copyOut`, backend `logs`). Human surfaces only: it bypasses the
   * manager's policy layer, so use it after the manager authorised access (e.g. `inspectSandbox`).
   */
  providerFor(hostId: string, backend: BackendKind): Promise<SandboxProvider>;
  /** Appends an entry to the audit log (actor `human`) for operations done outside the manager. */
  audit(action: string, details?: Record<string, unknown>, sandboxId?: string): void;
  /** Closes the manager, the tunnels and the runtime's own state connection. Idempotent. */
  close(): Promise<void>;
}

/**
 * Wires everything an abox surface needs: paths, config, providers, host resolver, keyring.
 * One call per process; the SQLite state is shared with other processes (CLI, MCP, GUI).
 */
export async function openAbox(opts: OpenAboxOptions = {}): Promise<AboxRuntime> {
  const env = opts.env ?? process.env;
  const paths = ensureDirs(resolvePaths(env));
  const config = loadConfig(paths.configFile);
  const contextId = opts.contextId ?? 'human';
  const now = opts.now ?? Date.now;
  const secretStore = opts.secretStore ?? new LibsecretStore();

  // The runtime keeps its own connection for the host cache and for audit entries of
  // operations outside the manager (WAL: safe next to the manager's connection).
  const state = StateStore.open(paths.stateDb, { now });
  const audit = (action: string, details: Record<string, unknown> = {}, sandboxId?: string) => {
    try {
      state.audit.append({
        actor: contextId === 'human' ? 'human' : `agent:${contextId}`,
        action,
        ...(sandboxId ? { sandboxId } : {}),
        details,
      });
    } catch {
      // auditing must never take the operation down
    }
  };

  const hostRegistry = HostRegistry.fromPaths(paths);
  const hostsEnv = hostsEnvFromPaths(paths, {
    now,
    audit: (action, details) => {
      audit(action, details);
      opts.onHostAudit?.(action, details);
    },
    ...opts.hostsEnv,
  });
  const tunnels = new TunnelManager(hostsEnv);

  const factories = providerFactories({ env, paths, config });
  const hardened = hardenedProviders(factories, config, audit);
  let hostResolver: HostResolver | undefined;
  let resolveTarget: ((hostId: string) => Promise<HostConnection>) | undefined;
  let localTarget: Promise<HostConnection | undefined> | undefined;
  if (opts.hosts !== false) {
    const inner = createHostResolver(hostRegistry, tunnels, { cache: state.hosts });
    // Unless hosts.yaml defines `local` itself, every registered backend is available on this
    // machine (the schema default only lists docker and process, but podman, python and vm are
    // registered too). An explicit `local:` entry stays authoritative.
    const localDefined = localIsDefined(paths.hostsFile);
    const registered = Object.keys(factories) as BackendKind[];
    const resolver: HostTargetResolver = async (hostId) => {
      const target = await inner(hostId);
      const out =
        hostId !== 'local' || localDefined
          ? target
          : { ...target, backends: [...new Set([...target.backends, ...registered])] };
      // `capabilities()` is synchronous: a remote engine's hardened runtime must be known before
      // the manager asks the provider of this host for its isolation (it always resolves first)
      if (hostId !== 'local') await hardened.prepare(out);
      return out;
    };
    hostResolver = resolver;
    resolveTarget = async (hostId) => (await resolver(hostId)).connection;
    localTarget = resolveTarget('local').catch(() => undefined);
  } else {
    localTarget = Promise.resolve({ host: 'local', kind: 'local' } as HostConnection);
  }

  // The local engine is checked up front (cheap when no runtime is configured: nothing connects)
  const local = await localTarget;
  if (local) await hardened.prepare({ connection: local });

  // Live utilisation of a host for hostCapacity / estimateFit: /proc numbers only, read directly on this
  // machine and over the hardened ssh connection (one fixed command) for ssh hosts.
  const hostLive: HostLiveSource = async (hostId) => {
    const profile = hostRegistry.get(hostId);
    if (!profile) return { ok: false, reason: 'unknown host' };
    if (profile.kind === 'local') return readLocalLive({ now });
    if (opts.hosts === false) return { ok: false, reason: 'remote hosts are disabled' };
    return readRemoteLive(profile, hostsEnv);
  };

  let abox: Abox;
  try {
    abox = await Abox.open({
      env,
      paths,
      providers: factories,
      secretStore,
      now,
      ...(opts.projectDir !== undefined ? { projectDir: opts.projectDir } : {}),
      ...(opts.home !== undefined ? { home: opts.home } : {}),
      ...(opts.ttlCheckIntervalSec !== undefined
        ? { ttlCheckIntervalSec: opts.ttlCheckIntervalSec }
        : {}),
      ...(opts.reconcileOnOpen !== undefined ? { reconcileOnOpen: opts.reconcileOnOpen } : {}),
      ...(opts.policyText !== undefined ? { policyText: opts.policyText } : {}),
      ...(hostResolver ? { hostResolver } : {}),
      hostLive,
      config,
    });
  } catch (e) {
    state.close();
    await tunnels.closeAll().catch(() => undefined);
    throw e;
  }

  const providerCache = new Map<string, SandboxProvider>();
  let closed = false;

  return {
    abox,
    caller: { contextId },
    paths,
    config,
    env,
    secretStore,
    hostRegistry,
    hostCache: state.hosts,
    tunnels,
    hostsEnv,
    audit,
    async providerFor(hostId, backend) {
      const key = `${hostId}\0${backend}`;
      const cached = providerCache.get(key);
      if (cached) return cached;
      const factory = factories[backend];
      if (!factory) {
        throw new AboxError('backend_unavailable', `backend "${backend}" is not available`, {
          hint: 'Run "abox doctor" to see which backends are installed.',
        });
      }
      const connection: HostConnection = resolveTarget
        ? await resolveTarget(hostId)
        : { host: hostId, kind: 'local' };
      const provider = factory(connection);
      providerCache.set(key, provider);
      return provider;
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        abox.close();
      } finally {
        try {
          await tunnels.closeAll();
        } finally {
          state.close();
        }
      }
    },
  };
}

/** True when `hosts.yaml` has its own `local:` entry (then its `backends` are authoritative). */
function localIsDefined(hostsFile: string): boolean {
  try {
    return /^[ \t]*local[ \t]*:/m.test(readFileSync(hostsFile, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * `capabilities()` is synchronous and the manager checks a template's isolation against it before
 * anything else touches the engine. A configured hardened runtime (runsc, kata) is only known to
 * be present after asking the engine, so those providers are built and initialised first and the
 * factory hands out that instance for the host. The runtime comes from the host: `runtimes` in
 * its hosts.yaml entry, and for the local host from `config.yaml`. Without a configured runtime
 * nothing connects to an engine here. An unreachable engine is not an error: isolation stays
 * `container`.
 *
 * Remote hosts are prepared by the host resolver, once their engine tunnel is up: a runtime the
 * engine does not list is audited (`host.runtime_missing`) so that "isolation container is below
 * hardened" has a visible cause.
 */
function hardenedProviders(
  factories: Partial<Record<BackendKind, ProviderFactory>>,
  config: AboxConfig,
  audit: (action: string, details?: Record<string, unknown>) => void,
): {
  prepare(target: {
    connection: HostConnection;
    backends?: readonly BackendKind[];
    engine?: { runtimes: string[] };
  }): Promise<void>;
} {
  const kinds = ['docker', 'podman', 'python'] as const;
  const engineOf = (k: (typeof kinds)[number]) => (k === 'podman' ? 'podman' : 'docker');
  const make: Partial<Record<BackendKind, ProviderFactory>> = { ...factories };
  const ready = new Map<string, SandboxProvider>();
  const keyOf = (c: HostConnection, kind: (typeof kinds)[number]): string | undefined => {
    const rt = hardenedRuntimeFor(engineOf(kind), config, c);
    return rt === undefined ? undefined : [c.host, kind, c.engineSocket ?? '', rt].join('\0');
  };
  for (const kind of kinds) {
    const factory = make[kind];
    if (!factory) continue;
    factories[kind] = (c) => {
      const key = keyOf(c, kind);
      return (key !== undefined ? ready.get(key) : undefined) ?? factory(c);
    };
  }
  const preparing = new Map<string, Promise<void>>();
  return {
    async prepare({ connection, backends, engine }) {
      for (const kind of kinds) {
        const factory = make[kind];
        const key = keyOf(connection, kind);
        if (!factory || key === undefined || ready.has(key)) continue;
        if (backends && !backends.includes(kind)) continue; // an engine the host does not offer
        // concurrent resolutions of one host (GUI polling) prepare and report once
        let job = preparing.get(key);
        if (!job) {
          job = (async () => {
            const provider = factory(connection) as SandboxProvider & {
              init?: () => Promise<void>;
            };
            try {
              await provider.init?.();
            } catch {
              // local: the unreachable engine is reported by doctor; isolation stays "container"
              if (connection.kind === 'local') ready.set(key, provider);
              return;
            }
            ready.set(key, provider);
            if (connection.kind === 'ssh' && provider.capabilities().isolation !== 'hardened') {
              audit('host.runtime_missing', {
                host: connection.host,
                backend: kind,
                runtime: hardenedRuntimeFor(engineOf(kind), config, connection),
                ...(engine ? { engineRuntimes: engine.runtimes } : {}),
              });
            }
          })().finally(() => preparing.delete(key));
          preparing.set(key, job);
        }
        await job;
      }
    },
  };
}
