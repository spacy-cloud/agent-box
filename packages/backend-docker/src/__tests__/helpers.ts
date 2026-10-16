import { createHash, randomBytes } from 'node:crypto';
import type { OsFamily, ResolvedTemplate, SandboxSpec } from '@abox/core';

export const MiB = 1024 * 1024;

export function makeTemplate(
  over: Partial<ResolvedTemplate> = {},
  osFamily: OsFamily = 'alpine',
): ResolvedTemplate {
  const base: ResolvedTemplate = {
    name: 'abox-test-alpine',
    description: 'test template',
    backend: 'docker',
    isolation: 'container',
    base: { os: 'alpine:3.22', osFamily },
    build: [
      { name: 'marker', script: 'echo "built by abox test" > /etc/abox-marker' },
      { name: 'quoting', script: `echo 'it'"'"'s $HOME "quoted"' > /etc/abox-quote` },
    ],
    tools: [],
    user: { name: 'dev', uid: 1000, sudo: false },
    workspace: { mode: 'empty', path: '/workspace', access: 'rw' },
    resources: { cpus: 1, memoryBytes: 256 * MiB, pids: 64, ttlMs: 3_600_000 },
    network: { mode: 'none', allow: [] },
    mounts: [],
    env: {},
    secrets: [],
    labels: {},
    source: { kind: 'builtin' },
    hash: createHash('sha256').update(randomBytes(16)).digest('hex'),
    contentHash: 'c'.repeat(64),
  };
  return { ...base, ...over };
}

export function makeSpec(
  template: ResolvedTemplate,
  imageRef: string,
  over: Partial<SandboxSpec> = {},
): SandboxSpec {
  const short = randomBytes(4).toString('hex');
  const now = Date.now();
  const spec: SandboxSpec = {
    id: `local/${short}`,
    host: 'local',
    name: `test-${short}`,
    owner: 'human',
    template,
    image: { ref: imageRef, templateHash: template.hash, cached: true },
    workspace: { kind: 'none', sandboxPath: template.workspace.path },
    mounts: [],
    resources: template.resources,
    network: { mode: 'none', allow: [], blockPrivate: true, privateExceptions: [], injections: [] },
    env: { FOO: 'bar' },
    files: [],
    user: template.user,
    createdAt: now,
    expiresAt: now + template.resources.ttlMs,
    labels: { note: 'x' },
  };
  return { ...spec, ...over };
}
