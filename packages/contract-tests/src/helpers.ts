import { createHash, randomBytes } from 'node:crypto';
import {
  makeSandboxId,
  type ResolvedTemplate,
  type SandboxInfo,
  type SandboxProvider,
  type SandboxSpec,
} from '@abox/core';

/** Random lowercase-hex identifier with a prefix, e.g. `ct1a2b3c4d`. Valid as a sandbox short id. */
export function randomId(prefix = 'ct', bytes = 4): string {
  return `${prefix}${randomBytes(bytes).toString('hex')}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls `cond` until it returns true or `timeoutMs` elapses; returns the last result. */
export async function waitFor(
  cond: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 50,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * A minimal valid `ResolvedTemplate` that does not need the template module.
 * Backends adapt it through `overrides` (e.g. `backend`, `base`, `isolation`).
 * The hash is derived from the build-relevant fields (like the real resolver does)
 * unless `overrides.hash` is given.
 */
export function makeTestTemplate(overrides: Partial<ResolvedTemplate> = {}): ResolvedTemplate {
  const base: ResolvedTemplate = {
    name: 'contract-test',
    description: 'Template used by the abox provider contract tests',
    backend: 'process',
    isolation: 'none',
    base: { osFamily: 'unknown' },
    build: [],
    tools: [],
    user: { name: 'agent', uid: 1000, sudo: false },
    workspace: { mode: 'empty', path: '/workspace', access: 'rw' },
    resources: { cpus: 1, memoryBytes: 512 * 1024 * 1024, pids: 256, ttlMs: 60 * 60 * 1000 },
    network: { mode: 'none', allow: [] },
    mounts: [],
    env: {},
    secrets: [],
    labels: {},
    source: { kind: 'builtin' },
    hash: '',
    contentHash: '',
  };
  const merged: ResolvedTemplate = { ...base, ...overrides };
  if (overrides.hash === undefined) {
    merged.hash = sha256({ base: merged.base, build: merged.build, user: merged.user });
  }
  if (overrides.contentHash === undefined) {
    merged.contentHash = sha256({ ...merged, hash: undefined, contentHash: undefined });
  }
  return merged;
}

/**
 * Builds a valid `SandboxSpec` for `provider`:
 * - unique id `<host>/ct<random>`, owner `agent:contract-test`, workspace delivery `none`
 * - network mode the provider supports best (`none` if possible, else the first supported one)
 * - image from `provider.prepare(template)` unless `overrides.image` is given
 */
export async function makeTestSpec(
  provider: SandboxProvider,
  template: ResolvedTemplate,
  overrides: Partial<SandboxSpec> = {},
): Promise<SandboxSpec> {
  const caps = provider.capabilities();
  const mode = caps.networkModes.includes('none') ? 'none' : (caps.networkModes[0] ?? 'none');
  const image = overrides.image ?? (await provider.prepare(template));
  const host = overrides.host ?? provider.host.host;
  const short = randomId('ct');
  const now = Date.now();
  const spec: SandboxSpec = {
    id: makeSandboxId(host, short),
    host,
    name: `contract-${short}`,
    owner: 'agent:contract-test',
    template,
    image,
    workspace: { kind: 'none', sandboxPath: template.workspace.path },
    mounts: [],
    resources: template.resources,
    network: { mode, allow: [], blockPrivate: true, privateExceptions: [], injections: [] },
    env: {},
    files: [],
    user: template.user,
    createdAt: now,
    expiresAt: now + (template.resources.ttlMs > 0 ? template.resources.ttlMs : 60 * 60 * 1000),
    labels: {},
  };
  return { ...spec, ...overrides };
}

/** Best-effort stop + remove; never throws. */
export async function cleanupSandbox(provider: SandboxProvider, id: string): Promise<void> {
  try {
    await provider.stop(id);
  } catch {
    /* already stopped, never created or unsupported */
  }
  try {
    await provider.remove(id);
  } catch {
    /* best effort */
  }
}

/**
 * Creates (and by default starts) a sandbox from `spec`, runs `fn`, and always
 * stops and removes it afterwards, also when `fn` or `create` throws.
 */
export async function withSandbox<T>(
  provider: SandboxProvider,
  spec: SandboxSpec,
  fn: (info: SandboxInfo) => Promise<T> | T,
  opts: { start?: boolean } = {},
): Promise<T> {
  try {
    const info = await provider.create(spec);
    if (opts.start !== false) await provider.start(spec.id);
    return await fn(info);
  } finally {
    await cleanupSandbox(provider, spec.id);
  }
}
