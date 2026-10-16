import type Docker from 'dockerode';
import { parseSandboxId } from '@abox/core';
import type { BackendKind, IsolationLevel, SandboxInfo, SandboxState } from '@abox/core';
import { LABEL, RESERVED_LABELS } from './labels.js';

export interface EngineStateFlags {
  /** `State.Error` is set (the container failed to start). */
  error?: boolean;
  oomKilled?: boolean;
}

/** Map an engine container state (+ TTL) to the backend-neutral state. */
export function mapState(
  engineState: string,
  expiresAt: number,
  now: number,
  flags: EngineStateFlags = {},
): SandboxState {
  if (engineState === 'removing') return 'removed';
  if (expiresAt > 0 && expiresAt <= now) return 'expired';
  switch (engineState) {
    case 'created':
      return flags.error ? 'failed' : 'created';
    case 'running':
    case 'paused':
    case 'restarting':
      return 'running';
    case 'exited':
      return flags.error || flags.oomKilled ? 'failed' : 'stopped';
    case 'dead':
      return 'failed';
    default:
      return 'stopped';
  }
}

function num(v: string | undefined): number {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Sandbox info derived from engine labels only (labels are the source of truth). */
export function infoFromLabels(
  labels: Record<string, string>,
  engineState: string,
  containerId: string,
  kind: BackendKind,
  now: number,
  flags?: EngineStateFlags,
): SandboxInfo {
  const id = labels[LABEL.id] ?? '';
  const userLabels: Record<string, string> = {};
  for (const [k, v] of Object.entries(labels)) {
    if (!RESERVED_LABELS.has(k)) userLabels[k] = v;
  }
  const expiresAt = num(labels[LABEL.expires]);
  return {
    id,
    host: labels[LABEL.host] ?? parseSandboxId(id).host,
    name: labels[LABEL.name] ?? '',
    state: mapState(engineState, expiresAt, now, flags),
    backend: (labels[LABEL.backend] as BackendKind | undefined) ?? kind,
    isolation: (labels[LABEL.isolation] as IsolationLevel | undefined) ?? 'container',
    template: labels[LABEL.template] ?? '',
    templateHash: labels[LABEL.templateHash] ?? '',
    owner: labels[LABEL.owner] ?? '',
    createdAt: num(labels[LABEL.created]),
    expiresAt,
    labels: userLabels,
    backendRef: containerId,
  };
}

/** The hardening that is actually applied, read back from the engine (for the audit log). */
export function effectiveFromInspect(c: Docker.ContainerInspectInfo): Record<string, unknown> {
  const hc = c.HostConfig as Docker.HostConfig & { Init?: boolean; Runtime?: string };
  const mounts = (c.Mounts ?? []).map((m) => ({
    type: m.Type,
    source: m.Source,
    target: m.Destination,
    readOnly: m.RW === false,
  }));
  return {
    image: c.Config.Image,
    user: c.Config.User,
    workingDir: c.Config.WorkingDir,
    privileged: hc.Privileged ?? false,
    capDrop: hc.CapDrop ?? [],
    capAdd: hc.CapAdd ?? [],
    securityOpt: hc.SecurityOpt ?? [],
    pidsLimit: hc.PidsLimit ?? null,
    memoryBytes: hc.Memory ?? 0,
    memorySwapBytes: hc.MemorySwap ?? 0,
    cpus: (hc.NanoCpus ?? 0) / 1e9,
    init: hc.Init ?? false,
    networkMode: hc.NetworkMode,
    ipcMode: hc.IpcMode,
    pidMode: hc.PidMode ?? '',
    utsMode: hc.UTSMode ?? '',
    readonlyRootfs: hc.ReadonlyRootfs ?? false,
    tmpfs: hc.Tmpfs ?? {},
    storageOpt: hc.StorageOpt ?? null,
    runtime: hc.Runtime ?? '',
    devices: hc.Devices ?? [],
    mounts,
    seccomp: (hc.SecurityOpt ?? []).some((o: string) => o.startsWith('seccomp='))
      ? 'custom'
      : 'engine default',
  };
}
