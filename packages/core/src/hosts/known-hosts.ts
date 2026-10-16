import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { AboxError } from '../errors.js';
import { getEffectiveSshConfig } from './effective.js';
import { run } from './exec.js';
import type { HostProfile } from './model.js';
import { isHostname, isProxyJump, parseJumpHop } from './schema.js';
import { optValue, renderHardenedConfig, sshBinary, type HostsEnv } from './ssh-args.js';

export type HostKeyStatus = 'trusted' | 'unknown' | 'changed';

export interface ScannedKey {
  /** `ssh-ed25519`, `ecdsa-sha2-nistp256`, `ssh-rsa`, … */
  type: string;
  /** Base64 key blob as in known_hosts. */
  key: string;
  /** `SHA256:…` (unpadded base64), the form ssh and `ssh-keygen -l` print. */
  fingerprint: string;
}

export interface HostKeyScan {
  hostname: string;
  port: number;
  /** known_hosts host field: `host` for port 22, else `[host]:port`. */
  hostSpec: string;
  keys: ScannedKey[];
  via: 'ssh-keyscan' | 'ssh';
}

export interface HostKeyCheck extends HostKeyScan {
  status: HostKeyStatus;
  /** Fingerprints stored in the abox known_hosts for this host. */
  trusted: ScannedKey[];
}

export function fingerprintOf(keyBase64: string): string {
  const digest = createHash('sha256').update(Buffer.from(keyBase64, 'base64')).digest('base64');
  return `SHA256:${digest.replace(/=+$/, '')}`;
}

export function hostSpecOf(hostname: string, port: number): string {
  return port === 22 ? hostname : `[${hostname}]:${port}`;
}

const KEYSCAN_TYPES = 'ed25519,ecdsa,rsa';

function hostUnreachable(
  message: string,
  reason: string,
  extra: Record<string, unknown> = {},
  hint?: string,
): AboxError {
  return new AboxError('host_unreachable', message, { hint, details: { reason, ...extra } });
}

function parseKeyLine(line: string): { type: string; key: string; revoked: boolean } | undefined {
  const t = line.trim();
  if (t === '' || t.startsWith('#')) return undefined;
  const f = t.split(/\s+/);
  let revoked = false;
  if (f[0]?.startsWith('@')) {
    if (f[0] === '@cert-authority') return undefined;
    revoked = f[0] === '@revoked';
    f.shift();
  }
  const [, type, key] = f;
  if (!type || !key || !/^[A-Za-z0-9+/=]+$/.test(key)) return undefined;
  return { type, key, revoked };
}

/** Resolves hostname/port the way ssh will connect (config alias, HostName, Port). */
export async function resolveTarget(
  profile: HostProfile,
  env: HostsEnv,
): Promise<{ hostname: string; port: number; proxyJump?: string }> {
  try {
    const eff = await getEffectiveSshConfig(profile, env);
    if (eff.hostname)
      return {
        hostname: eff.hostname,
        port: eff.port,
        ...(eff.proxyJump ? { proxyJump: eff.proxyJump } : {}),
      };
  } catch (e) {
    if (profile.hostname === undefined) throw e;
  }
  return {
    hostname: profile.hostname!,
    port: profile.port ?? 22,
    ...(profile.proxyJump ? { proxyJump: profile.proxyJump } : {}),
  };
}

/**
 * Fetches the host keys a server presents (nothing is trusted or stored). Direct hosts use
 * `ssh-keyscan`; hosts behind a `ProxyJump` are scanned with a throwaway ssh handshake that
 * stops before authentication - this requires the jump hosts to be trusted already.
 */
export async function scanHostKey(profile: HostProfile, env: HostsEnv): Promise<HostKeyScan> {
  const target = await resolveTarget(profile, env);
  if (!isHostname(target.hostname)) {
    throw new AboxError(
      'invalid_input',
      `unsafe host name from ssh configuration: ${JSON.stringify(target.hostname)}`,
    );
  }
  if (target.proxyJump) return scanViaSsh(profile, env, target);
  const keyscan = env.sshKeyscanBinary ?? 'ssh-keyscan';
  const timeoutS = env.connectTimeoutSec ?? 10;
  const scanWith = async (family: string[]) => {
    let res;
    try {
      res = await run(
        keyscan,
        [
          ...family,
          '-T',
          String(timeoutS),
          '-p',
          String(target.port),
          '-t',
          KEYSCAN_TYPES,
          '--',
          target.hostname,
        ],
        { timeoutMs: (timeoutS + 5) * 1000 },
      );
    } catch (e) {
      throw new AboxError(
        'backend_unavailable',
        `cannot run ssh-keyscan: ${(e as Error).message}`,
        {
          hint: 'Install the OpenSSH client.',
          cause: e,
        },
      );
    }
    const found = new Map<string, ScannedKey>();
    for (const line of res.stdout.split('\n')) {
      const k = parseKeyLine(line);
      if (k)
        found.set(`${k.type}:${k.key}`, {
          type: k.type,
          key: k.key,
          fingerprint: fingerprintOf(k.key),
        });
    }
    return { found, timedOut: res.timedOut };
  };
  let { found: keys, timedOut } = await scanWith([]);
  if (keys.size === 0) {
    // ssh-keyscan only tries the first resolved address; a dead AAAA record must not hide a
    // working A record (ssh itself falls back, so we do too).
    const [v4, v6] = await Promise.all([scanWith(['-4']), scanWith(['-6'])]);
    keys = v4.found.size > 0 ? v4.found : v6.found;
    timedOut = timedOut || v4.timedOut || v6.timedOut;
  }
  if (keys.size === 0) {
    throw hostUnreachable(
      `cannot read a host key from ${target.hostname}:${target.port}${timedOut ? ' (timeout)' : ''}`,
      'unreachable',
      { host: profile.id },
      'Check that the host is up, the port is right, and you are on the right network.',
    );
  }
  return {
    hostname: target.hostname,
    port: target.port,
    hostSpec: hostSpecOf(target.hostname, target.port),
    keys: [...keys.values()],
    via: 'ssh-keyscan',
  };
}

function jumpProfile(hop: string): HostProfile {
  const h = parseJumpHop(hop);
  return {
    id: 'jump',
    kind: 'ssh',
    sshConfigAlias: h.host,
    ...(h.user ? { user: h.user } : {}),
    ...(h.port ? { port: h.port } : {}),
    zone: 'shared',
    backends: [],
    tags: [],
    favorite: false,
    portForwards: [],
  };
}

async function scanViaSsh(
  profile: HostProfile,
  env: HostsEnv,
  target: { hostname: string; port: number; proxyJump?: string },
): Promise<HostKeyScan> {
  const jump = target.proxyJump ?? '';
  if (!isProxyJump(jump)) {
    throw new AboxError('invalid_input', 'unsupported ProxyJump value');
  }
  // Friendly pre-check; ssh enforces the same strictness for the hops itself (generated config).
  for (const hop of jump.split(',')) {
    const st = await checkHostKey(jumpProfile(hop), env);
    if (st.status !== 'trusted') {
      throw hostUnreachable(
        `jump host ${hop} is not trusted (${st.status}); trust its host key first`,
        st.status === 'changed' ? 'host_key_changed' : 'host_key_unknown',
        { host: profile.id, jump: hop },
        'Trust the jump host key (abox host trust) before scanning hosts behind it.',
      );
    }
  }
  const tmpRoot = join(env.runtimeDir, 'tmp');
  mkdirSync(tmpRoot, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(tmpRoot, 'scan-'));
  try {
    // Throwaway known_hosts for the TARGET only; the hops are checked strictly against the real
    // abox known_hosts. The handshake stops before authentication (PreferredAuthentications none).
    const scanKnown = join(dir, 'known_hosts');
    writeFileSync(scanKnown, '', { mode: 0o600 });
    const alias = 'abox-scan-target';
    const prelude = [
      `Host ${alias}`,
      `  HostName ${target.hostname}`,
      `  Port ${target.port}`,
      `  ProxyJump ${jump}`,
      '  PreferredAuthentications none',
      '  StrictHostKeyChecking accept-new',
      `  UserKnownHostsFile ${optValue(scanKnown)}`,
      '  GlobalKnownHostsFile /dev/null',
      '  CheckHostIP no',
      '  UpdateHostKeys no',
      '  VerifyHostKeyDNS no',
      '  HashKnownHosts no',
      '  BatchMode yes',
      '  LogLevel ERROR',
      '',
    ].join('\n');
    const conf = join(dir, 'ssh_config');
    writeFileSync(conf, renderHardenedConfig(env, 'batch', { prelude }), { mode: 0o600 });
    await run(
      sshBinary(env),
      [
        '-F',
        conf,
        '-a',
        '-x',
        '-T',
        '-o',
        'ClearAllForwardings=yes',
        '-o',
        'ControlMaster=no',
        '-o',
        'ControlPath=none',
        '--',
        alias,
        'true',
      ],
      { timeoutMs: ((env.connectTimeoutSec ?? 10) + 10) * 1000 },
    );
    const hostSpec = hostSpecOf(target.hostname, target.port);
    const found = await lookupKnown(target.hostname, target.port, scanKnown, env);
    if (found.length === 0) {
      throw hostUnreachable(
        `cannot read the host key of ${profile.id} through the jump host`,
        'unreachable',
        { host: profile.id },
        'Check the ProxyJump chain with an interactive ssh.',
      );
    }
    return {
      hostname: target.hostname,
      port: target.port,
      hostSpec,
      keys: found.map((k) => ({ type: k.type, key: k.key, fingerprint: fingerprintOf(k.key) })),
      via: 'ssh',
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface StoredKey {
  type: string;
  key: string;
  revoked: boolean;
}

async function keygenFind(spec: string, file: string, env: HostsEnv): Promise<StoredKey[]> {
  const res = await run(env.sshKeygenBinary ?? 'ssh-keygen', ['-F', spec, '-f', file], {
    timeoutMs: 10_000,
  });
  const out: StoredKey[] = [];
  for (const line of res.stdout.split('\n')) {
    const k = parseKeyLine(line);
    if (k) out.push(k);
  }
  return out;
}

/** known_hosts host specs ssh may consult for this target (observed with OpenSSH 10.x: a plain `host` entry also matches non-default ports). */
function specsFor(hostname: string, port: number): string[] {
  return port === 22 ? [hostname] : [hostSpecOf(hostname, port), hostname];
}

/**
 * Keys stored for a host in `file` (`ssh-keygen -F`, so hashed entries and patterns work).
 * Includes the plain-host entry for non-default ports because ssh honours it too; an entry we
 * did not write can therefore make a host `changed` (conservative) but never `trusted`.
 */
async function lookupKnown(
  hostname: string,
  port: number,
  file: string,
  env: HostsEnv,
): Promise<StoredKey[]> {
  if (!existsSync(file)) return [];
  const out: StoredKey[] = [];
  for (const spec of specsFor(hostname, port)) out.push(...(await keygenFind(spec, file, env)));
  return out;
}

/** Pure decision: `changed` when a stored key of a presented type differs or nothing matches. */
export function evaluateHostKey(
  scanned: readonly ScannedKey[],
  stored: readonly StoredKey[],
): HostKeyStatus {
  if (stored.length === 0) return 'unknown';
  const live = stored.filter((s) => !s.revoked);
  if (stored.some((s) => s.revoked && scanned.some((k) => k.key === s.key))) return 'changed';
  let match = false;
  for (const k of scanned) {
    const sameType = live.filter((s) => s.type === k.type);
    if (sameType.some((s) => s.key === k.key)) match = true;
    else if (sameType.length > 0) return 'changed';
  }
  return match ? 'trusted' : 'changed';
}

/**
 * Compares the presented host keys with abox's known_hosts.
 * `trusted`: a stored key matches and no stored key of a presented type differs.
 * `unknown`: no entry. `changed`: entry exists but the server presents another key.
 */
export async function checkHostKey(profile: HostProfile, env: HostsEnv): Promise<HostKeyCheck> {
  const scan = await scanHostKey(profile, env);
  const storedKeys = await lookupKnown(scan.hostname, scan.port, env.knownHostsFile, env);
  const status = evaluateHostKey(scan.keys, storedKeys);
  return {
    ...scan,
    status,
    trusted: storedKeys.map((s) => ({
      type: s.type,
      key: s.key,
      fingerprint: fingerprintOf(s.key),
    })),
  };
}

export function normalizeFingerprint(fp: string): string {
  const t = fp.trim();
  if (!/^(?:SHA256:)?[A-Za-z0-9+/]{43}=?$/.test(t)) {
    throw new AboxError(
      'invalid_input',
      'fingerprint must look like SHA256:<43 base64 characters>',
    );
  }
  return `SHA256:${t.replace(/^SHA256:/, '').replace(/=+$/, '')}`;
}

/**
 * Stores a host key in abox's known_hosts, but only the key(s) whose SHA256 fingerprint
 * equals `fingerprint`, the value a human confirmed after seeing `scanHostKey`/`checkHostKey`.
 * Refuses when the presented keys do not include that fingerprint, and never replaces a
 * different stored key: a changed key stays blocked until `forgetHostKey` was run on purpose.
 */
export async function trustHostKey(
  profile: HostProfile,
  fingerprint: string,
  env: HostsEnv,
): Promise<{ added: boolean; fingerprint: string; hostSpec: string }> {
  const want = normalizeFingerprint(fingerprint);
  const check = await checkHostKey(profile, env);
  if (check.status === 'changed') {
    throw hostUnreachable(
      `host key of ${profile.id} changed; refusing to trust a new key`,
      'host_key_changed',
      {
        host: profile.id,
        presented: check.keys.map((k) => k.fingerprint),
        stored: check.trusted.map((k) => k.fingerprint),
      },
      'A changed key can mean a man-in-the-middle attack or a reinstalled server. Verify the new fingerprint out of band, then run forgetHostKey and trust again.',
    );
  }
  const match = check.keys.filter((k) => k.fingerprint === want);
  if (match.length === 0) {
    throw hostUnreachable(
      `the fingerprint does not match any key presented by ${profile.id}; nothing was trusted`,
      'fingerprint_mismatch',
      { host: profile.id, expected: want, presented: check.keys.map((k) => k.fingerprint) },
      'Compare the fingerprint with the server (ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub) and retry.',
    );
  }
  if (
    check.status === 'trusted' &&
    match.every((k) => check.trusted.some((t) => t.key === k.key))
  ) {
    return { added: false, fingerprint: want, hostSpec: check.hostSpec };
  }
  mkdirSync(dirname(env.knownHostsFile), { recursive: true, mode: 0o700 });
  const fd = openSync(env.knownHostsFile, 'a', 0o600);
  closeSync(fd);
  chmodSync(env.knownHostsFile, 0o600);
  const existing = readFileSync(env.knownHostsFile, 'utf8');
  const stamp = new Date((env.now ?? Date.now)()).toISOString();
  let add = existing === '' || existing.endsWith('\n') ? '' : '\n';
  for (const k of match)
    add += `${check.hostSpec} ${k.type} ${k.key} abox:${profile.id} ${stamp}\n`;
  appendFileSync(env.knownHostsFile, add);
  env.audit?.('host.key.trust', { host: profile.id, hostSpec: check.hostSpec, fingerprint: want });
  return { added: true, fingerprint: want, hostSpec: check.hostSpec };
}

/** Removes stored keys of a host (needed after a legitimate key change). Returns whether anything was removed. */
export async function forgetHostKey(profile: HostProfile, env: HostsEnv): Promise<boolean> {
  const target = await resolveTarget(profile, env);
  let removed = false;
  for (const spec of specsFor(target.hostname, target.port)) {
    if (!existsSync(env.knownHostsFile)) break;
    if ((await keygenFind(spec, env.knownHostsFile, env)).length === 0) continue;
    const res = await run(
      env.sshKeygenBinary ?? 'ssh-keygen',
      ['-R', spec, '-f', env.knownHostsFile],
      { timeoutMs: 10_000 },
    );
    if (res.code !== 0) {
      throw new AboxError('internal', `ssh-keygen -R failed: ${res.stderr.trim()}`);
    }
    removed = true;
  }
  try {
    rmSync(`${env.knownHostsFile}.old`, { force: true });
  } catch {
    /* ignore */
  }
  if (removed) {
    env.audit?.('host.key.forget', {
      host: profile.id,
      hostSpec: hostSpecOf(target.hostname, target.port),
    });
  }
  return removed;
}
