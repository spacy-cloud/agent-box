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
  resolvePaths,
  type AboxConfig,
  type AboxPaths,
  type BackendKind,
  type Caller,
  type HostConnection,
  type HostResolver,
  type HostTargetResolver,
  type ProviderFactory,
  type HostsEnv,
  type SandboxProvider,
  type SecretStore,
} from '@abox/core';
import { readFileSync } from 'node:fs';
import { configuredRuntime, providerFactories } from './providers.js';

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
  });
  const tunnels = new TunnelManager(hostsEnv);

  const factories = providerFactories({ env, paths, config });
  let hostResolver: HostResolver | undefined;
  let resolveTarget: ((hostId: string) => Promise<HostConnection>) | undefined;
  if (opts.hosts !== false) {
    const inner = createHostResolver(hostRegistry, tunnels, { cache: state.hosts });
    // Unless hosts.yaml defines `local` itself, every registered backend is available on this
    // machine (the schema default only lists docker and process, but podman, python and vm are
    // registered too). An explicit `local:` entry stays authoritative.
    const localDefined = localIsDefined(paths.hostsFile);
    const registered = Object.keys(factories) as BackendKind[];
    const resolver: HostTargetResolver = async (hostId) => {
      const target = await inner(hostId);
      if (hostId !== 'local' || localDefined) return target;
      return { ...target, backends: [...new Set([...target.backends, ...registered])] };
    };
    hostResolver = resolver;
    resolveTarget = async (hostId) => (await resolver(hostId)).connection;
  }

  await initHardenedProviders(factories, config, resolveTarget);

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
 * anything else touches the engine. A configured hardened runtime (runsc, kata) is only known to be
 * present after asking the engine, so those providers are built and initialised up front (once, for
 * the local host) and the factory hands out that instance. Without a configured runtime nothing
 * connects to an engine here. An unreachable engine is not an error: isolation stays `container`.
 */
async function initHardenedProviders(
  factories: Partial<Record<BackendKind, ProviderFactory>>,
  config: AboxConfig,
  resolveTarget: ((hostId: string) => Promise<HostConnection>) | undefined,
): Promise<void> {
  const wanted = (['docker', 'podman', 'python'] as const).filter(
    (k) => factories[k] && configuredRuntime(k === 'podman' ? 'podman' : 'docker', config),
  );
  if (wanted.length === 0) return;
  const local = resolveTarget
    ? await resolveTarget('local').catch(() => undefined)
    : ({ host: 'local', kind: 'local' } as HostConnection);
  if (!local) return;
  for (const kind of wanted) {
    const factory = factories[kind] as ProviderFactory;
    const ready = factory(local) as SandboxProvider & { init?: () => Promise<void> };
    await ready.init?.().catch(() => undefined);
    factories[kind] = (h) => (h.host === local.host ? ready : factory(h));
  }
}
