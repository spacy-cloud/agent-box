import { join } from 'node:path';
import { AboxError, isAboxError } from '../errors.js';
import { getEngineInfo, isSystemEngineSocket, type EngineInfo } from './engine-info.js';
import { run } from './exec.js';
import { ZONE_DEFAULTS, type HostProfile } from './model.js';
import { checkHostKey, type HostKeyStatus } from './known-hosts.js';
import { buildSshArgs, sshBinary, type HostsEnv } from './ssh-args.js';
import { openEngineTunnel } from './tunnel.js';

export interface BackendProbe {
  ok: boolean;
  version?: string;
  rootless?: boolean;
  error?: string;
}

export interface HostTestResult {
  host: string;
  /** The TCP port answered and an SSH host key was received. */
  reachable: boolean;
  /** Wall-clock time of the probe command including the SSH handshake (ms). */
  latencyMs?: number;
  hostKey: HostKeyStatus | 'unavailable';
  /** SHA256 fingerprints presented by the server (for the trust dialog). */
  fingerprints: string[];
  authOk: boolean;
  remoteUser?: string;
  uid?: number;
  backends: { docker?: BackendProbe; podman?: BackendProbe };
  /** Configured `engine_socket` and whether it exists on the host. */
  engineSocket?: { path: string; exists: boolean };
  /** Rootless sockets found in the usual places (informational; never used automatically). */
  engineSocketCandidates: string[];
  /**
   * What the engine behind `engine_socket` itself reports (`/info` through a short-lived forward of
   * that socket, the same path sandboxes use). Absent when there is no usable engine socket.
   */
  engine?: EngineInfo;
  /** Is each runtime from the profile's `runtimes` known to the engine? */
  runtimes: Array<{ engine: 'docker' | 'podman'; runtime: string; available: boolean }>;
  warnings: string[];
  error?: string;
}

/**
 * The remote probe. A FIXED script: the only interpolated value is `engine_socket`, which is
 * validated against a strict path grammar (no quotes, `$`, spaces). It is sent as
 * `sh -c '<script>'` on one line without single quotes or `!` so any login shell passes it
 * through unchanged. Output lines are `abox.<key>=<value>`; other output (rc files) is ignored.
 */
export function probeScript(engineSocket?: string): string {
  const sock = engineSocket !== undefined ? `"${engineSocket}"` : undefined;
  const parts = [
    'p() { printf "abox.%s=%s\\n" "$1" "$2"; };',
    't=""; if command -v timeout >/dev/null 2>&1; then t="timeout 8"; fi;',
    'p uid "$(id -u)"; p user "$(id -un)"; p groups "$(id -Gn | tr " " ",")";',
    'u=$(id -u);',
    'for s in "/run/user/$u/docker.sock" "/run/user/$u/podman/podman.sock" /var/run/docker.sock /run/podman/podman.sock; do if [ -S "$s" ]; then p sock "$s"; fi; done;',
    ...(sock ? [`if [ -S ${sock} ]; then p engine_socket yes; else p engine_socket no; fi;`] : []),
    'if command -v docker >/dev/null 2>&1; then',
    '  p bin.docker yes;',
    `  ${sock ? `export DOCKER_HOST="unix://"${sock};` : ''}`,
    '  if v=$($t docker version --format "{{.Server.Version}}" 2>/dev/null) && [ -n "$v" ]; then p docker.version "$v";',
    '    if r=$($t docker info --format "{{.SecurityOptions}}" 2>/dev/null); then case "$r" in *rootless*) p docker.rootless 1;; *) p docker.rootless 0;; esac; fi;',
    '  else p docker.error "engine not reachable"; fi;',
    'fi;',
    'if command -v podman >/dev/null 2>&1; then',
    '  p bin.podman yes;',
    '  if v=$($t podman version --format "{{.Client.Version}}" 2>/dev/null) && [ -n "$v" ]; then p podman.version "$v";',
    '    if r=$($t podman info --format "{{.Host.Security.Rootless}}" 2>/dev/null); then case "$r" in true) p podman.rootless 1;; *) p podman.rootless 0;; esac; else p podman.error "podman info failed"; fi;',
    '  else p podman.error "podman not usable"; fi;',
    'fi;',
  ];
  return parts.join(' ');
}

export function probeCommand(engineSocket?: string): string {
  const script = probeScript(engineSocket);
  if (script.includes("'"))
    throw new AboxError('internal', 'probe script must not contain single quotes');
  return `sh -c '${script}'`;
}

export function parseProbeOutput(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    const m = /^abox\.([a-z0-9_.]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]!] ??= m[2]!;
  }
  return out;
}

function classifyFailure(stderr: string): 'auth' | 'hostkey' | 'unreachable' | 'other' {
  if (
    /Permission denied|Too many authentication failures|no mutual signature|Authentication failed/i.test(
      stderr,
    )
  )
    return 'auth';
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(stderr))
    return 'hostkey';
  if (
    /Connection refused|timed out|No route to host|Could not resolve|Network is unreachable|Connection closed by|Connection reset/i.test(
      stderr,
    )
  )
    return 'unreachable';
  return 'other';
}

/**
 * Checks reachability, host key, authentication and the container engines of an ssh host
 * with ONE ssh call running the fixed probe (`probeCommand`). Never runs caller-supplied
 * commands. The SSH login is only attempted when the host key is already trusted: unknown
 * or changed keys are reported, not connected to (use `trustHostKey` first).
 */
export async function testHost(profile: HostProfile, env: HostsEnv): Promise<HostTestResult> {
  const result: HostTestResult = {
    host: profile.id,
    reachable: false,
    hostKey: 'unavailable',
    fingerprints: [],
    authOk: false,
    backends: {},
    engineSocketCandidates: [],
    runtimes: [],
    warnings: [],
  };
  const audit = (extra: Record<string, unknown> = {}) =>
    env.audit?.('host.test', {
      host: profile.id,
      user: profile.user,
      reachable: result.reachable,
      hostKey: result.hostKey,
      authOk: result.authOk,
      latencyMs: result.latencyMs,
      ...extra,
    });

  try {
    const check = await checkHostKey(profile, env);
    result.reachable = true;
    result.hostKey = check.status;
    result.fingerprints = check.keys.map((k) => k.fingerprint);
    if (check.status === 'unknown') {
      result.warnings.push(
        'Host key is not trusted yet. Compare the fingerprint and run trust before connecting.',
      );
      audit();
      return result;
    }
    if (check.status === 'changed') {
      result.warnings.push(
        'HOST KEY CHANGED. The connection is blocked: this can be a man-in-the-middle attack or a reinstalled server.',
      );
      audit();
      return result;
    }
  } catch (e) {
    if (isAboxError(e) && e.code === 'host_unreachable') {
      result.error = e.message;
      audit();
      return result;
    }
    throw e;
  }

  const args = buildSshArgs(profile, env, {
    mode: 'batch',
    remoteCommand: probeCommand(profile.engineSocket),
  });
  const res = await run(sshBinary(env), args, {
    timeoutMs: ((env.connectTimeoutSec ?? 10) + 25) * 1000,
  });
  result.latencyMs = res.durationMs;
  const probe = parseProbeOutput(res.stdout);
  if (res.code !== 0 && probe['uid'] === undefined) {
    const kind = classifyFailure(res.stderr);
    result.error = res.timedOut
      ? 'timeout'
      : res.stderr.trim().split('\n').slice(-1)[0] || `ssh exited with ${res.code}`;
    if (kind === 'unreachable') result.reachable = false;
    if (kind === 'hostkey') {
      result.hostKey = 'changed';
      result.warnings.push('ssh refused the host key.');
    }
    if (kind === 'auth') {
      result.warnings.push(
        'Authentication failed. Check the key (identity_file / ssh-agent) and the user.',
      );
    }
    audit();
    return result;
  }

  result.authOk = true;
  result.uid = probe['uid'] !== undefined ? Number(probe['uid']) : undefined;
  result.remoteUser = probe['user'];
  const groups = (probe['groups'] ?? '').split(',').filter(Boolean);
  for (const line of res.stdout.split('\n')) {
    const m = /^abox\.sock=(.*)$/.exec(line.trim());
    if (m && !result.engineSocketCandidates.includes(m[1]!))
      result.engineSocketCandidates.push(m[1]!);
  }
  if (profile.engineSocket !== undefined) {
    result.engineSocket = { path: profile.engineSocket, exists: probe['engine_socket'] === 'yes' };
    if (!result.engineSocket.exists) {
      result.warnings.push(
        `engine_socket ${profile.engineSocket} does not exist on the host (is the user service running?).`,
      );
    }
  }
  for (const engine of ['docker', 'podman'] as const) {
    if (probe[`bin.${engine}`] !== 'yes') continue;
    const version = probe[`${engine}.version`];
    const b: BackendProbe = version
      ? { ok: true, version, rootless: probe[`${engine}.rootless`] === '1' }
      : { ok: false, error: probe[`${engine}.error`] ?? 'not usable' };
    result.backends[engine] = b;
    if (b.ok && b.rootless === false) {
      result.warnings.push(
        `${engine} on this host is not rootless: access to it is root-equivalent.`,
      );
    }
  }
  if (result.uid === 0) {
    result.warnings.push(
      'The ssh user is root. Use a dedicated unprivileged user with a rootless engine for sandboxes.',
    );
  }
  if (groups.includes('docker')) {
    result.warnings.push(
      'The ssh user is in the "docker" group, which is root-equivalent on the host. Use a rootless engine instead.',
    );
  }
  for (const wanted of profile.backends) {
    if ((wanted === 'docker' || wanted === 'podman') && !result.backends[wanted]?.ok) {
      result.warnings.push(`Backend "${wanted}" is configured but not usable on the host.`);
    }
  }
  await checkEngine(profile, env, result);
  audit();
  return result;
}

/**
 * Asks the engine itself (not the `docker`/`podman` CLI of the remote login, which may point
 * elsewhere): rootless or not, and which OCI runtimes it knows. Findings become warnings; the
 * resolver enforces them when a sandbox host is used.
 */
async function checkEngine(
  profile: HostProfile,
  env: HostsEnv,
  result: HostTestResult,
): Promise<void> {
  const engines = (['docker', 'podman'] as const).filter((e) => profile.backends.includes(e));
  const socket = profile.engineSocket;
  if (socket === undefined || engines.length === 0) return;
  const strict = ZONE_DEFAULTS[profile.zone].requiresRootless;
  if (isSystemEngineSocket(socket)) {
    result.warnings.push(
      `engine_socket ${socket} is the socket of a system-wide engine: access to it is root-equivalent on the host.${
        strict && !profile.allowRootful
          ? ` abox refuses it for zone ${profile.zone} (use a rootless engine of a dedicated user, or set allow_rootful: true).`
          : ''
      }`,
    );
  }
  if (result.engineSocket?.exists !== true) return;
  let info: EngineInfo | undefined;
  const local = join(env.runtimeDir, 'tunnels', `${profile.id}.test-${process.pid}.sock`);
  try {
    const tunnel = await openEngineTunnel(profile, env, {
      remoteSocket: socket,
      localSocket: local,
      readyTimeoutMs: 10_000,
    });
    try {
      info = await getEngineInfo(tunnel.localSocket);
    } finally {
      await tunnel.close();
    }
  } catch (e) {
    result.warnings.push(`Could not reach the engine through ${socket}: ${(e as Error).message}`);
    return;
  }
  if (!info) {
    result.warnings.push(
      `The engine behind ${socket} did not report rootless mode or runtimes (no usable /info)${
        strict && !profile.allowRootful
          ? '; abox cannot verify that it is rootless and will refuse it'
          : ''
      }.`,
    );
    return;
  }
  result.engine = info;
  if (!info.rootless) {
    result.warnings.push(
      strict && !profile.allowRootful
        ? `The engine behind ${socket} is not rootless; abox refuses it for zone ${profile.zone}. Use a rootless engine of a dedicated user, or set allow_rootful: true if root-equivalent access is acceptable.`
        : `The engine behind ${socket} is not rootless: access to it is root-equivalent on the host.`,
    );
  }
  for (const engine of engines) {
    const runtime = profile.runtimes?.[engine];
    if (runtime === undefined) continue;
    const available = info.runtimes.includes(runtime);
    result.runtimes.push({ engine, runtime, available });
    if (!available) {
      result.warnings.push(
        `Runtime "${runtime}" (runtimes.${engine}) is not installed in the engine behind ${socket} (it knows: ${info.runtimes.join(', ') || 'none'}). Sandboxes here stay at isolation "container", which zone ${profile.zone} does not accept.`,
      );
    }
  }
}
