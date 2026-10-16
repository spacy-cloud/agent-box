import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import type Docker from 'dockerode';
import { AboxError } from '@abox/core';
import type { SandboxSpec } from '@abox/core';

const MiB = 1024 * 1024;

/** Host paths that must never be bind-mounted, whatever the core decided (defence in depth). */
const FORBIDDEN_SOURCE_PREFIXES = [
  '/var/run',
  '/run',
  '/proc',
  '/sys',
  '/dev',
  '/var/lib/docker',
  '/var/lib/containers',
];
/** Sandbox paths that must never be mount targets. */
const FORBIDDEN_TARGET_PREFIXES = ['/proc', '/sys', '/dev', '/var/run/docker', '/run/docker'];

function under(p: string, prefix: string): boolean {
  return p === prefix || p.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`);
}

/** Throws when `hostPath` could expose an engine socket or host runtime state. */
export function checkBindSource(hostPath: string): void {
  if (!path.isAbsolute(hostPath)) {
    throw new AboxError('invalid_input', `Bind source must be an absolute path: ${hostPath}`);
  }
  const candidates = new Set([path.resolve(hostPath)]);
  try {
    candidates.add(realpathSync(hostPath));
  } catch {
    // not accessible locally (or remote path): the lexical check still applies
  }
  for (const p of candidates) {
    if (p === '/') throw new AboxError('policy_denied', 'Refusing to bind-mount the host root');
    if (path.basename(p).endsWith('.sock')) {
      throw new AboxError('policy_denied', `Refusing to bind-mount a socket: ${p}`, {
        hint: 'Engine sockets are never mounted into a sandbox.',
      });
    }
    for (const f of FORBIDDEN_SOURCE_PREFIXES) {
      if (under(p, f)) {
        throw new AboxError('policy_denied', `Refusing to bind-mount ${p} (under ${f})`, {
          hint: 'Sockets and runtime directories are never mounted into a sandbox.',
        });
      }
    }
  }
}

export function checkMountTarget(target: string): string {
  if (!target.startsWith('/'))
    throw new AboxError('invalid_input', `Mount target must be absolute: ${target}`);
  const norm = path.posix.normalize(target).replace(/\/+$/, '') || '/';
  if (norm === '/' || norm.split('/').includes('..'))
    throw new AboxError('invalid_input', `Invalid mount target: ${target}`);
  if (path.posix.basename(norm).endsWith('.sock'))
    throw new AboxError('policy_denied', `Refusing a socket mount target: ${target}`);
  for (const f of FORBIDDEN_TARGET_PREFIXES) {
    if (under(norm, f))
      throw new AboxError('policy_denied', `Refusing mount target ${target} (under ${f})`);
  }
  return norm;
}

export interface HostConfigInput {
  spec: SandboxSpec;
  /** Engine `NetworkMode` value: `none`, `abox-open` or an internal network name. */
  networkMode: string;
  /** Mounts (binds and anonymous volumes) computed by the caller. */
  mounts: Docker.MountSettings[];
  /** Anonymous-volume targets exist because the root filesystem is read-only. */
  readonlyRootfs: boolean;
  tmpfsBytes: number;
  diskSupported: boolean;
  runtime?: string;
}

export function tmpfsSize(memoryBytes: number, configured: number): number {
  return Math.max(16 * MiB, Math.min(configured, Math.floor(memoryBytes / 2)));
}

/** The one place where sandbox hardening is assembled. Everything here is mandatory. */
export function buildHostConfig(i: HostConfigInput): Docker.HostConfig {
  const { spec } = i;
  const r = spec.resources;
  if (!Number.isFinite(r.memoryBytes) || r.memoryBytes <= 0)
    throw new AboxError('invalid_input', 'resources.memoryBytes must be positive');
  if (!Number.isFinite(r.pids) || r.pids <= 0)
    throw new AboxError('invalid_input', 'resources.pids must be positive');
  if (!Number.isFinite(r.cpus) || r.cpus <= 0)
    throw new AboxError('invalid_input', 'resources.cpus must be positive');
  if (spec.user.uid <= 0) {
    throw new AboxError('invalid_input', 'The sandbox user must not be root (uid > 0)', {
      hint: 'Set user.uid to a non-zero value in the template.',
    });
  }
  const hc: Record<string, unknown> = {
    NetworkMode: i.networkMode,
    Mounts: i.mounts,
    Privileged: false,
    CapDrop: ['ALL'],
    SecurityOpt: ['no-new-privileges:true'],
    PidsLimit: r.pids,
    Memory: r.memoryBytes,
    MemorySwap: r.memoryBytes,
    NanoCpus: Math.round(r.cpus * 1e9),
    Init: true,
    IpcMode: 'private',
    CgroupnsMode: 'private',
    Tmpfs: { '/tmp': `rw,nosuid,nodev,size=${tmpfsSize(r.memoryBytes, i.tmpfsBytes)}` },
    ReadonlyRootfs: i.readonlyRootfs,
    RestartPolicy: { Name: 'no' },
    AutoRemove: false,
    PublishAllPorts: false,
    // Explicitly empty: no host namespaces, no devices, no extra groups.
    PidMode: '',
    UTSMode: '',
    UsernsMode: '',
    Devices: [],
    ExtraHosts: [],
    GroupAdd: [],
  };
  if (i.runtime) hc['Runtime'] = i.runtime;
  if (r.diskBytes !== undefined) {
    if (!i.diskSupported)
      throw new AboxError('unsupported', 'Disk quota is not supported by the storage driver');
    hc['StorageOpt'] = { size: String(r.diskBytes) };
  }
  return hc as Docker.HostConfig;
}

/**
 * Entrypoint that makes the container exit at its deadline, recomputed on every (re)start: the
 * later of `abox.expires` (`$1`, epoch seconds) and the number in `expiryFile` (`$2`) that
 * `extendExpiry` writes. The file is re-read every time the sleep ends, so a deadline moved while
 * the container runs is honoured without polling. A half-written file (the archive extraction
 * truncates before it writes) is given one second and a second read.
 */
export function ttlEntrypoint(expiresAtMs: number, expiryFile: string): string[] {
  return [
    '/bin/sh',
    '-c',
    [
      'd=$1',
      'while :; do',
      '  if [ -e "$2" ]; then',
      '    v=; read -r v < "$2" || :',
      '    case $v in \'\'|*[!0-9]*) sleep 1; v=; read -r v < "$2" || :;; esac',
      '    case $v in \'\'|*[!0-9]*) ;; *) [ "$v" -gt "$d" ] && d=$v;; esac',
      '  fi',
      '  rem=$(( d - $(date +%s) ))',
      '  if [ "$rem" -le 0 ]; then exit 0; fi',
      '  sleep "$rem"',
      'done',
    ].join('\n'),
    'abox-main',
    String(Math.ceil(expiresAtMs / 1000)),
    expiryFile,
  ];
}
