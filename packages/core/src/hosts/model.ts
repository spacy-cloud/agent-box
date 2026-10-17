import type { HostZone } from '../policy/engine.js';
import type { BackendKind, HostId, IsolationLevel } from '../types.js';

/**
 * Host model. A host is a place where sandboxes run: `local` or an SSH host.
 *
 * Profiles hold metadata only. Passwords, passphrases and private keys are never stored
 * (`identityFile` is a path). Agents never manage hosts: profiles are created and changed
 * through CLI/GUI only; the manager must not expose this module to MCP tools.
 */

export const HOST_ZONES = ['workstation', 'lab', 'shared', 'restricted'] as const;

export const HOST_KINDS = ['local', 'ssh'] as const;
export type HostKind = (typeof HOST_KINDS)[number];

/** Backends that can be declared on a host profile. */
/** Every backend a host profile may list (same set as `BACKEND_KINDS`). */
export const HOST_BACKEND_KINDS = ['docker', 'podman', 'process', 'python', 'vm'] as const;
export type HostBackendKind = (typeof HOST_BACKEND_KINDS)[number];

export const FORWARD_KINDS = ['local', 'remote', 'dynamic'] as const;
export type ForwardKind = (typeof FORWARD_KINDS)[number];

/**
 * A saved port forward. `listen` is `[loopback:]port` or an absolute socket path,
 * `target` is `host:port` / `[v6]:port` or an absolute socket path (absent for `dynamic`).
 * Only loopback bind addresses are accepted: a forward never listens on the network.
 */
export interface PortForward {
  name: string;
  kind: ForwardKind;
  listen: string;
  target?: string;
}

/** Hardened runtime per container engine. */
export type HostRuntimes = Partial<Record<'docker' | 'podman', string>>;

export interface HostLimits {
  cpus?: number;
  /** Size string such as `4g`, `512m`. */
  memory?: string;
  sandboxes?: number;
}

export interface HostProfile {
  /** `[a-z0-9-]+`, starts alphanumeric. */
  id: HostId;
  kind: HostKind;
  hostname?: string;
  port?: number;
  user?: string;
  /**
   * Alias from `~/.ssh/config`. When set the alias is the ssh destination (so the user's
   * `HostName`, `Include`s, ... apply); `user`, `port`, `proxyJump` and `identityFile` of the
   * profile, when present, override the config. `hostname` is then informational only.
   */
  sshConfigAlias?: string;
  /** `[user@]host[:port]`, comma separated for several hops. */
  proxyJump?: string;
  /** Path only (absolute or `~/…`), never the key contents. */
  identityFile?: string;
  zone: HostZone;
  /** Can only raise the zone default, never lower it. */
  minIsolation?: IsolationLevel;
  backends: HostBackendKind[];
  /** Absolute path of the engine socket ON THE HOST (rootless docker/podman). */
  engineSocket?: string;
  /** Working directory root on that host (process/vm backends). */
  dataDir?: string;
  /**
   * Stronger OCI runtime (`runsc`, `kata`) of the engine ON THIS HOST, per engine. The container
   * backends report isolation `hardened` for this host only when the engine lists the runtime
   * (`docker info` / `/info` `Runtimes`). `python` uses the `docker` entry. Remote hosts never
   * inherit the runtime configured for the local engine in `config.yaml`.
   */
  runtimes?: HostRuntimes;
  /**
   * Explicit opt-in to use a rootful engine on a host of a zone that requires a rootless one
   * (`shared`, `restricted`). Access to a rootful engine socket is root-equivalent on that host.
   */
  allowRootful?: boolean;
  tags: string[];
  favorite: boolean;
  limits?: HostLimits;
  portForwards: PortForward[];
}

/** What callers pass to `HostRegistry.add`: defaults are filled in. */
export type HostProfileInput = Partial<Omit<HostProfile, 'id'>> & { id: HostId };

/** Patch for `HostRegistry.update`: `undefined` keeps, `null` clears the field. */
export type HostProfilePatch = {
  [K in keyof Omit<HostProfile, 'id' | 'kind'>]?: HostProfile[K] | null;
};

export interface ResolvedHostLimits {
  cpus?: number;
  memory?: string;
  memoryBytes?: number;
  sandboxes?: number;
}

/** Zone defaults. `minIsolation` of `none` means the zone itself imposes no minimum. */
export const ZONE_DEFAULTS: Record<
  HostZone,
  { minIsolation: IsolationLevel; requiresApproval: boolean; requiresRootless: boolean }
> = {
  workstation: { minIsolation: 'none', requiresApproval: false, requiresRootless: false },
  lab: { minIsolation: 'none', requiresApproval: false, requiresRootless: false },
  // hosts with their own services or data: a rootful engine socket is root on those
  shared: { minIsolation: 'hardened', requiresApproval: true, requiresRootless: true },
  restricted: { minIsolation: 'vm', requiresApproval: true, requiresRootless: true },
};

export interface ResolvedHostProfile {
  host: HostId;
  profile: HostProfile;
  zone: HostZone;
  /** max(zone default, profile `min_isolation`). */
  minIsolation: IsolationLevel;
  /** Zones `shared` and `restricted` need an explicit approval for agent use. */
  requiresApproval: boolean;
  limits: ResolvedHostLimits;
  backends: BackendKind[];
}

/**
 * Audit hook. Called for connection opened/closed, key trust, tests, tunnels.
 * Details carry host, user, durations and fingerprints, never session content.
 */
export type HostAudit = (action: string, details: Record<string, unknown>) => void;

export const LOCAL_HOST_ID = 'local';
