import { AboxError, isAboxError } from '../errors.js';
import type { HostCache } from '../state/host-cache.js';
import type { BackendKind, HostConnection, HostId, IsolationLevel } from '../types.js';
import { checkHostKey } from './known-hosts.js';
import type { HostZone } from '../policy/engine.js';
import { getEngineInfo, isSystemEngineSocket, type EngineInfo } from './engine-info.js';
import { ZONE_DEFAULTS, type HostProfile, type ResolvedHostLimits } from './model.js';
import type { HostRegistry } from './registry.js';
import type { HostsEnv } from './ssh-args.js';
import type { EngineTunnel, TunnelManager } from './tunnel.js';

export interface ResolvedHostTarget {
  connection: HostConnection;
  zone: HostZone;
  minIsolation?: IsolationLevel;
  limits?: ResolvedHostLimits;
  backends: BackendKind[];
  /** Zones `shared` and `restricted` need an approval for agent use. */
  requiresApproval?: boolean;
  /** What the engine behind a forwarded socket reported (`/info`); absent for local hosts or when it did not answer. */
  engine?: EngineInfo;
}

export type HostTargetResolver = (hostId: HostId) => Promise<ResolvedHostTarget>;

export interface HostResolverOptions {
  /** Where to record the outcome of each resolution, for "stale since …" displays. */
  cache?: HostCache;
}

/** Info stored in HostCache for remote hosts. */
export interface HostCacheInfo {
  lastOkAt?: number;
  lastError?: string;
  lastErrorAt?: number;
  engineSocket?: string;
  zone?: HostZone;
  /** Last engine facts seen through the tunnel. */
  rootless?: boolean;
  runtimes?: string[];
}

/**
 * Creates the `hostResolver` the manager expects: host id -> connection + zone + limits.
 *
 * - `local` resolves without any I/O.
 * - ssh hosts: the host key must be `trusted` (unknown/changed block with `host_unreachable`
 *   and `details.reason = host_key_unknown | host_key_changed`), then the engine socket is
 *   forwarded (shared per host via `TunnelManager`); `connection.engineSocket` is the local
 *   forwarded socket.
 * - Every outcome is written to the HostCache; failures carry the last known good time.
 */
export function createHostResolver(
  registry: HostRegistry,
  tunnels: TunnelManager,
  opts: HostResolverOptions = {},
): HostTargetResolver {
  const env: HostsEnv = tunnels.env;
  const now = env.now ?? Date.now;
  return async (hostId) => {
    const resolved = registry.resolve(hostId);
    const profile = resolved.profile;
    const base = {
      zone: resolved.zone,
      minIsolation: resolved.minIsolation,
      limits: resolved.limits,
      backends: resolved.backends,
      requiresApproval: resolved.requiresApproval,
    };
    if (profile.kind === 'local') {
      const connection: HostConnection = {
        host: profile.id,
        kind: 'local',
        ...(profile.engineSocket ? { engineSocket: profile.engineSocket } : {}),
        ...(profile.dataDir ? { dataDir: profile.dataDir } : {}),
      };
      return {
        connection: withRuntimes(connection, profile),
        ...base,
      };
    }

    const wantsEngine = profile.backends.some((b) => b === 'docker' || b === 'podman');
    const prev = opts.cache?.get(hostId, Number.POSITIVE_INFINITY);
    const prevInfo = (prev?.info ?? {}) as HostCacheInfo;
    try {
      if (profile.backends.length === 0) {
        throw new AboxError('unsupported', `host "${hostId}" has no backends configured`, {
          hint: 'Set backends (docker/podman) and engine_socket in hosts.yaml; "abox host test" shows what the host offers.',
        });
      }
      let connection: HostConnection;
      let engine: EngineInfo | undefined;
      if (!wantsEngine) {
        const status = (await checkHostKey(profile, env)).status;
        assertTrusted(hostId, status);
        connection = withRuntimes(
          {
            host: profile.id,
            kind: 'ssh',
            ...(profile.dataDir ? { dataDir: profile.dataDir } : {}),
          },
          profile,
        );
      } else {
        if (!profile.engineSocket) {
          throw new AboxError('unsupported', `host "${hostId}" has no engine_socket`, {
            hint: 'Set engine_socket (e.g. /run/user/<uid>/podman/podman.sock) in hosts.yaml; "abox host test" lists candidates.',
          });
        }
        const strict = ZONE_DEFAULTS[profile.zone].requiresRootless && !profile.allowRootful;
        if (strict && isSystemEngineSocket(profile.engineSocket)) {
          throw rootfulRefused(
            profile,
            `${profile.engineSocket} is the socket of a system-wide engine`,
          );
        }
        // ssh itself enforces the host key (StrictHostKeyChecking=yes); only when it refuses do we
        // scan again to tell "unknown" from "changed". The healthy path costs no extra scan.
        let tunnel;
        try {
          tunnel = await tunnels.get(profile, { remoteSocket: profile.engineSocket });
        } catch (e) {
          if (isAboxError(e) && e.details?.['reason'] === 'host_key') {
            const status = (await checkHostKey(profile, env)).status;
            assertTrusted(hostId, status === 'trusted' ? 'changed' : status);
          }
          throw e;
        }
        connection = withRuntimes(tunnel.connection, profile);
        engine = await engineInfoOf(tunnel);
        if (strict && engine?.rootless !== true) {
          // never leave a connection to a root-equivalent engine open
          await tunnels.close(hostId).catch(() => undefined);
          throw rootfulRefused(
            profile,
            engine
              ? `the engine behind ${profile.engineSocket} is not rootless`
              : `cannot verify that the engine behind ${profile.engineSocket} is rootless (no usable answer to /info)`,
          );
        }
      }
      const info: HostCacheInfo = {
        ...prevInfo,
        lastOkAt: now(),
        engineSocket: profile.engineSocket,
        zone: profile.zone,
        ...(engine ? { rootless: engine.rootless, runtimes: engine.runtimes } : {}),
      };
      delete info.lastError;
      delete info.lastErrorAt;
      opts.cache?.put(hostId, info, true, now());
      return { connection, ...base, ...(engine ? { engine } : {}) };
    } catch (e) {
      const err = isAboxError(e)
        ? e
        : new AboxError(
            'host_unreachable',
            `host "${hostId}" is not reachable: ${(e as Error).message}`,
            { cause: e },
          );
      const info: HostCacheInfo = { ...prevInfo, lastError: err.message, lastErrorAt: now() };
      opts.cache?.put(hostId, info, false, now());
      if (err.code === 'host_unreachable') {
        const since = prevInfo.lastOkAt
          ? ` (last reachable ${new Date(prevInfo.lastOkAt).toISOString()})`
          : '';
        throw new AboxError('host_unreachable', `${err.message}${since}`, {
          hint: err.hint,
          details: { ...(err.details ?? {}), host: hostId, lastOkAt: prevInfo.lastOkAt },
          cause: err,
        });
      }
      throw err;
    }
  };
}

function withRuntimes(connection: HostConnection, profile: HostProfile): HostConnection {
  return profile.runtimes && Object.keys(profile.runtimes).length > 0
    ? { ...connection, runtimes: { ...profile.runtimes } }
    : connection;
}

const engineFacts = new WeakMap<EngineTunnel, EngineInfo>();

/** `/info` of the engine behind a tunnel, asked once per tunnel connection (forgotten when it drops). */
async function engineInfoOf(tunnel: EngineTunnel): Promise<EngineInfo | undefined> {
  const known = engineFacts.get(tunnel);
  if (known) return known;
  const info = await getEngineInfo(tunnel.localSocket);
  if (info) {
    engineFacts.set(tunnel, info);
    const forget = (s: string) => {
      if (s !== 'open') {
        engineFacts.delete(tunnel);
        tunnel.off('state', forget);
      }
    };
    tunnel.on('state', forget);
  }
  return info;
}

/**
 * Roadmap 4b.8: sandboxes on a host with its own services run on a rootless engine of a dedicated
 * user, never on the system engine whose socket is root on that machine.
 */
function rootfulRefused(profile: HostProfile, why: string): AboxError {
  return new AboxError(
    'policy_denied',
    `host "${profile.id}" (zone ${profile.zone}) must use a rootless engine: ${why}`,
    {
      hint: 'Run the sandboxes as a dedicated unprivileged user with rootless podman/docker and point engine_socket at its socket (e.g. /run/user/<uid>/podman/podman.sock). Access to a rootful engine is root-equivalent on the host; if you accept that, set allow_rootful: true for this host.',
      details: { reason: 'engine_rootful', host: profile.id, zone: profile.zone },
    },
  );
}

function assertTrusted(hostId: string, status: 'trusted' | 'unknown' | 'changed'): void {
  if (status === 'trusted') return;
  throw new AboxError(
    'host_unreachable',
    status === 'changed'
      ? `host key of "${hostId}" changed; connection blocked`
      : `host key of "${hostId}" is not trusted yet`,
    {
      hint:
        status === 'changed'
          ? 'The server presents a different key (possible man-in-the-middle, or reinstalled server). Verify the fingerprint out of band before trusting it again.'
          : 'Show the fingerprint with "abox host test" and confirm it with "abox host trust".',
      details: {
        reason: status === 'changed' ? 'host_key_changed' : 'host_key_unknown',
        host: hostId,
      },
    },
  );
}
