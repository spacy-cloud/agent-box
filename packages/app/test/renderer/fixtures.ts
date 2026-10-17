import type { SandboxView } from '@abox/core';

/** A sandbox as the manager lists it (renderer tests). */
export function sb(over: Partial<SandboxView> = {}): SandboxView {
  return {
    id: 'local/aaaa1111',
    name: 'alpha',
    host: 'local',
    owner: 'human',
    template: 'node-dev',
    templateHash: 'h',
    backend: 'docker',
    isolation: 'container',
    state: 'running',
    createdAt: Date.now(),
    expiresAt: Date.now() + 3_600_000,
    ttlRemainingMs: 3_600_000,
    expired: false,
    stale: false,
    missingInBackend: false,
    hostReachable: true,
    lastSeenAt: null,
    error: null,
    workspace: {
      mode: 'copy',
      sandboxPath: '/workspace',
      access: 'rw',
      source: '/home/u/proj',
      remote: false,
    },
    network: { mode: 'none', allow: [] },
    mounts: [],
    resources: { cpus: 2, memoryBytes: 2147483648, ttlMs: 3_600_000 },
    secretRefs: [],
    effective: null,
    requestId: null,
    ...over,
  };
}

/** Characters that must never reach the screen raw: controls, bidi overrides/isolates, zero-width, BOM, line separators. */
export const HIDDEN_CHARS =
  // The control characters are the point of this test helper.
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/u;

export const RLO = '\u202e';
export const ZWSP = '\u200b';
