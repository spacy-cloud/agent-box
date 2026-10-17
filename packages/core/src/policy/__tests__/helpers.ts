import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import type { AgentContext } from '../model.js';
import { parsePolicy } from '../load.js';
import { resolveContext } from '../context.js';
import type { CreateRequest } from '../engine.js';

/** Temp "machine": fake home with fake secrets, a projects dir and datasets dir. */
export interface TestEnv {
  root: string;
  home: string;
  projects: string;
  app: string;
  datasets: string;
  sshDir: string;
  cleanup(): void;
}

export function makeEnv(): TestEnv {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'abox-pol-')));
  const home = join(root, 'home');
  const projects = join(home, 'projects');
  const app = join(projects, 'app');
  const datasets = join(home, 'datasets');
  const sshDir = join(home, '.ssh');
  for (const d of [app, datasets, sshDir, join(home, '.config', 'abox')])
    mkdirSync(d, { recursive: true });
  writeFileSync(join(sshDir, 'id_ed25519'), 'FAKE PRIVATE KEY');
  writeFileSync(join(app, 'README.md'), 'hello');
  return {
    root,
    home,
    projects,
    app,
    datasets,
    sshDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export { symlinkSync };

export const BASE_PROFILE = {
  approval: 'medium',
  templates: ['node-dev', 'py-dev'],
  limits: { sandboxes: 3, cpus: 4, memory: '8g', ttl: '4h' },
  workspace: { roots: ['~/projects'], modes: ['worktree', 'clone', 'copy', 'empty', 'mount'] },
  network: {
    modes: ['none', 'allowlist'],
    allow_presets: ['npm', 'pypi', 'github'],
    allow: ['internal.example.org', '*.cdn.example.org'],
  },
  mounts: { roots: ['~/projects', '~/datasets'], access: ['ro'] },
  secrets: { allowed: ['github-token'], inject: ['proxy'] },
  isolation: {
    min: 'container',
    network_open: 'vm',
    mounts: 'container',
    secrets_env: 'container',
  },
  hosts: ['local'],
  exec: { approval: false },
};

/** Builds a profile `p` = BASE_PROFILE + `overrides` (merged like `extends`) and resolves context `agent1`. */
export function makeContext(
  env: TestEnv,
  overrides: Record<string, unknown> = {},
  contextId = 'agent1',
): AgentContext {
  const text = stringify({
    profiles: { base: BASE_PROFILE, p: { extends: 'base', ...overrides } },
    contexts: { [contextId]: { profile: 'p' } },
  });
  const policy = parsePolicy(text, { kind: 'file', path: '/test/policy.yaml' });
  return resolveContext(policy, contextId, { home: env.home });
}

export function humanContext(env: TestEnv): AgentContext {
  const policy = parsePolicy('profiles: {}\n', { kind: 'file', path: '/test/policy.yaml' });
  return resolveContext(policy, 'human', { home: env.home });
}

export const GIB = 1024 ** 3;
export const HOUR = 3_600_000;

export function mkReq(
  env: TestEnv,
  context: AgentContext,
  o: Partial<CreateRequest> = {},
): CreateRequest {
  return {
    context,
    template: {
      name: 'node-dev',
      isolation: 'container',
      hash: 'hash-1',
      contentHash: 'content-1',
    },
    templateTrusted: true,
    templateSource: { kind: 'builtin' },
    host: { id: 'local', zone: 'workstation' },
    providerIsolation: 'container',
    workspace: { mode: 'worktree', hostPath: env.app },
    mounts: [],
    network: { mode: 'none', allow: [] },
    secrets: [],
    resources: { cpus: 2, memoryBytes: 4 * GIB },
    ttlMs: HOUR,
    currentSandboxCount: 0,
    currentHostSandboxCount: 0,
    paths: { home: env.home },
    ...o,
  };
}
