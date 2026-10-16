import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProcessProvider } from '@abox/backend-process';
import { resolvePaths } from '../../config/paths.js';
import type { ProviderFactory } from '../../provider.js';
import { MemorySecretStore } from '../../secrets/store.js';
import type { SecretStore } from '../../secrets/store.js';
import type { BackendKind } from '../../types.js';
import { Abox } from '../abox.js';
import type { AboxOpenOptions } from '../abox.js';
import type { Caller, CreateResult, CreatedResult, CreateSandboxRequest } from '../types.js';
import { FakeProvider } from './fake-provider.js';
import type { FakeOptions } from './fake-provider.js';

export const HUMAN_YES: Caller = { contextId: 'human', humanConfirmed: true };
export const HUMAN: Caller = { contextId: 'human' };
export const A: Caller = { contextId: 'agent-a' };
export const B: Caller = { contextId: 'agent-b' };

export interface TestEnv {
  root: string;
  home: string;
  projects: string;
  project: string;
  datasets: string;
  aboxHome: string;
  clock: { t: number; now: () => number };
  fakes: FakeProvider[];
  secrets: MemorySecretStore;
  env: NodeJS.ProcessEnv;
  cleanup(): void;
}

export function makeEnv(): TestEnv {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'abox-mgr-')));
  const home = join(root, 'home');
  const projects = join(home, 'projects');
  const project = join(projects, 'app');
  const datasets = join(home, 'datasets');
  const aboxHome = join(root, 'abox');
  for (const d of [project, datasets, join(home, '.ssh'), join(project, 'src')])
    mkdirSync(d, { recursive: true });
  writeFileSync(join(project, 'README.md'), 'hello\n');
  writeFileSync(join(project, 'src', 'a.txt'), 'a\n');
  writeFileSync(join(home, '.ssh', 'id_ed25519'), 'FAKE KEY');
  const clock = { t: Date.now(), now: () => clock.t };
  return {
    root,
    home,
    projects,
    project,
    datasets,
    aboxHome,
    clock,
    fakes: [],
    secrets: new MemorySecretStore({ 'github-token': 'ghp_SUPERSECRETTOKEN1234567890abcdef' }),
    env: { ABOX_HOME: aboxHome, HOME: home },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export function testPolicy(env: TestEnv): string {
  return `version: 1
profiles:
  agent:
    approval: medium
    templates: [host-shell, fake-box, fake-net, fake-secret, fake-env-secret, fake-mount, proj-tpl, proj-bad]
    limits: { sandboxes: 5, cpus: 4, memory: 8g, ttl: 4h }
    workspace: { roots: ['${env.projects}'], modes: [copy, clone, worktree, mount, empty] }
    network: { modes: [none, allowlist, open], allow_presets: [npm, github], allow: [] }
    mounts: { roots: ['${env.datasets}'], access: [ro] }
    secrets: { allowed: [github-token], inject: [proxy, env] }
    isolation: { min: none, network_open: none, mounts: none, secrets_env: none }
    hosts: [local]
  strict:
    extends: agent
    approval: strict
  open-agent:
    extends: agent
    approval: open
  nomount:
    extends: agent
    mounts: deny
  tiny:
    extends: agent
    limits: { sandboxes: 1, cpus: 1, memory: 1g, ttl: 30m }
contexts:
  agent-a: { profile: agent }
  agent-b: { profile: agent }
  strict-agent: { profile: strict }
  open-agent: { profile: open-agent }
  nomount-agent: { profile: nomount }
  tiny-agent: { profile: tiny }
`;
}

export function writePolicy(env: TestEnv, text = testPolicy(env)): void {
  const paths = resolvePaths(env.env);
  mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.policyFile, text, { mode: 0o600 });
}

const FAKE_TEMPLATES: Record<string, (env: TestEnv) => string> = {
  'fake-box': () => `apiVersion: 1
name: fake-box
description: A fake container-like template used by the manager tests (no real backend).
backend: docker
base: { os: ubuntu:24.04 }
resources: { cpus: 1, memory: 512m, ttl: 1h }
labels: { use-for: manager tests }
`,
  'fake-net': () => `apiVersion: 1
name: fake-net
description: Fake template with an npm allowlist, used by the manager tests only.
backend: docker
base: { os: ubuntu:24.04 }
network: { mode: allowlist, presets: [npm] }
resources: { cpus: 1, memory: 512m, ttl: 1h }
`,
  'fake-secret': () => `apiVersion: 1
name: fake-secret
description: Fake template that injects a GitHub token through the proxy, manager tests only.
backend: docker
base: { os: ubuntu:24.04 }
network: { mode: allowlist, allow: [github.com] }
secrets:
  - { ref: github-token, inject: proxy, hosts: [github.com] }
resources: { cpus: 1, memory: 512m, ttl: 1h }
`,
  'fake-env-secret': () => `apiVersion: 1
name: fake-env-secret
description: Fake template that exposes a token as an environment variable (manager tests).
backend: docker
base: { os: ubuntu:24.04 }
secrets:
  - { ref: github-token, inject: env }
resources: { cpus: 1, memory: 512m, ttl: 1h }
`,
  'fake-mount': (env) => `apiVersion: 1
name: fake-mount
description: Fake template with an additional read-only dataset mount (manager tests).
backend: docker
base: { os: ubuntu:24.04 }
mounts:
  - { source: ${env.datasets}, target: /data, access: ro }
resources: { cpus: 1, memory: 512m, ttl: 1h }
`,
};

export function writeUserTemplates(env: TestEnv): void {
  const dir = resolvePaths(env.env).templatesDir;
  mkdirSync(dir, { recursive: true });
  for (const [name, f] of Object.entries(FAKE_TEMPLATES))
    writeFileSync(join(dir, `${name}.yaml`), f(env));
}

export function projectTemplate(name = 'proj-tpl', extra = ''): string {
  return `apiVersion: 1
name: ${name}
description: A project template from a repository (untrusted until approved), manager tests.
backend: docker
base: { os: ubuntu:24.04 }
resources: { cpus: 1, memory: 512m, ttl: 1h }
${extra}`;
}

export function writeProjectTemplate(env: TestEnv, name = 'proj-tpl', extra = ''): string {
  const dir = join(env.project, '.sandbox');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.yaml`);
  writeFileSync(file, projectTemplate(name, extra));
  return file;
}

export interface OpenOpts extends Partial<AboxOpenOptions> {
  fake?: FakeOptions;
  secretStore?: SecretStore;
  /** Do not write the default policy and templates. */
  bare?: boolean;
}

export async function openAbox(env: TestEnv, o: OpenOpts = {}): Promise<Abox> {
  if (!o.bare) {
    writePolicy(env);
    writeUserTemplates(env);
  }
  const providers: Partial<Record<BackendKind, ProviderFactory>> = {
    docker: (host) => {
      const f = new FakeProvider(host, { now: env.clock.now, ...o.fake });
      env.fakes.push(f);
      return f;
    },
    process: (host) => createProcessProvider(host, { now: env.clock.now }),
    ...o.providers,
  };
  const { fake: _f, bare: _b, providers: _p, ...rest } = o;
  return Abox.open({
    env: env.env,
    home: env.home,
    projectDir: env.project,
    now: env.clock.now,
    secretStore: env.secrets,
    ttlCheckIntervalSec: 0,
    ...rest,
    providers,
  });
}

/** The fake backend of the most recently opened instance. */
export function fakeOf(env: TestEnv): FakeProvider {
  const f = env.fakes.at(-1);
  if (!f) throw new Error('no fake provider created yet');
  return f;
}

export function created(r: CreateResult): CreatedResult {
  if (r.status !== 'created') throw new Error(`expected created, got ${r.status}`);
  return r;
}

export const EMPTY_WS: CreateSandboxRequest['workspace'] = { mode: 'empty' };

/** Create as `caller`; while the request is pending a human approves it, then the call is repeated. */
export async function createApproved(
  abox: Abox,
  caller: Caller,
  req: CreateSandboxRequest,
  note = 'ok',
): Promise<CreatedResult> {
  for (let i = 0; i < 4; i++) {
    const r = await abox.createSandbox(caller, req, { waitForApprovalMs: 0 });
    if (r.status === 'created') return r;
    if (r.status !== 'pending_approval') throw new Error(`unexpected ${r.status}`);
    await abox.approve(HUMAN, r.approvalId, note);
  }
  throw new Error('still pending after approvals');
}
