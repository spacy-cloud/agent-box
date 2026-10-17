/**
 * Shared plumbing of the e2e suites: a throw-away abox world (ABOX_HOME + fake HOME), the Docker provider
 * wired through the real manager, label based cleanup and small helpers around `docker`.
 *
 * Nothing in here touches the real home directory, the real abox configuration or the real keyring.
 */
import { execFile, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDockerProvider,
  type DockerProvider,
  type DockerProviderOptions,
} from '@abox/backend-docker';
import { createProcessProvider } from '@abox/backend-process';
import {
  Abox,
  MemorySecretStore,
  defaultConfig,
  resolvePaths,
  type AboxConfig,
  type AboxOpenOptions,
  type BackendKind,
  type Caller,
  type CreatedResult,
  type CreateResult,
  type CreateSandboxRequest,
  type ExecCompleted,
  type ExecParams,
  type HostConnection,
  type HostResolver,
  type ProviderFactory,
  type SecretStore,
} from '@abox/core';

export const DOCKER = process.env['ABOX_TEST_DOCKER'] === '1';
export const MiB = 1024 * 1024;

/**
 * Engine socket of the suite: `ABOX_TEST_ENGINE_SOCKET` (e.g. a Podman socket), else the Docker provider's
 * default (`DOCKER_HOST`, `/var/run/docker.sock`). The `docker` CLI helpers below talk to the same socket.
 */
export const ENGINE_SOCKET: string | undefined =
  process.env['ABOX_TEST_ENGINE_SOCKET'] || undefined;
/** `DockerProviderOptions.socketPath` for the engine of the suite (nothing when it is the default one). */
export const engineSocketOpts = (): { socketPath?: string } =>
  ENGINE_SOCKET ? { socketPath: ENGINE_SOCKET } : {};

/** Unique per test file / process: everything labelled with it is removed by `sweepE2E`. */
export const RUN = `e2e${randomBytes(4).toString('hex')}`;
/**
 * Resources carry `abox.test` (so a blanket `label=abox.test` cleanup finds them) but with the value `e2e`, not `1`:
 * the backend-docker and core suites run `sweepTestObjects()` on `abox.test=1` and would otherwise delete our images
 * and containers in the middle of a run (observed: "Environment image ... is missing").
 */
export const E2E_LABELS: Record<string, string> = { 'abox.test': 'e2e', 'abox.e2e': RUN };

/**
 * The `DockerProviderOptions.instanceId` of a manager instance of this run. Run-unique, so two e2e runs on the
 * same daemon (other developers!) never see each other's sandboxes, whatever the instance is called.
 */
export const instanceIdOf = (instance: string): string => `${RUN}${instance}`;

export const HUMAN: Caller = { contextId: 'human' };
export const HUMAN_YES: Caller = { contextId: 'human', humanConfirmed: true };
export const A: Caller = { contextId: 'agent-a' };
export const B: Caller = { contextId: 'agent-b' };

// ---------------------------------------------------------------------------
// docker CLI helpers
// ---------------------------------------------------------------------------

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `docker <args>`; never throws, returns the exit code. */
export function docker(
  args: string[],
  opts: { input?: string; timeoutMs?: number } = {},
): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = execFile(
      'docker',
      args,
      {
        timeout: opts.timeoutMs ?? 120_000,
        maxBuffer: 64 * MiB,
        encoding: 'utf8',
        ...(ENGINE_SOCKET
          ? { env: { ...process.env, DOCKER_HOST: `unix://${ENGINE_SOCKET}` } }
          : {}),
      },
      (err, stdout, stderr) => {
        const code = err
          ? typeof (err as { code?: unknown }).code === 'number'
            ? (err as { code: number }).code
            : 1
          : 0;
        resolve({ code, stdout, stderr });
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

/** Removes every container, network and image labelled with this run. Safe to call repeatedly. */
export async function sweepE2E(): Promise<void> {
  const filter = ['--filter', `label=abox.e2e=${RUN}`];
  const ps = await docker(['ps', '-aq', ...filter]);
  const ids = ps.stdout.split('\n').filter(Boolean);
  if (ids.length > 0) await docker(['rm', '-f', '-v', ...ids]);
  // `abox-egress` / `abox-open` are shared by every abox instance and test run on this daemon: never removed here
  const nets = (await docker(['network', 'ls', '--format', '{{.ID}} {{.Name}}', ...filter])).stdout
    .split('\n')
    .filter(Boolean);
  for (const line of nets) {
    const [id, name] = line.split(' ');
    if (name !== 'abox-egress' && name !== 'abox-open' && id) await docker(['network', 'rm', id]);
  }
  const imgs = (await docker(['images', '-q', ...filter])).stdout.split('\n').filter(Boolean);
  if (imgs.length > 0) await docker(['rmi', '-f', ...new Set(imgs)]);
}

/** All containers (running or not) with this run's label, as `name`. */
export async function e2eContainers(): Promise<string[]> {
  const r = await docker([
    'ps',
    '-a',
    '--filter',
    `label=abox.e2e=${RUN}`,
    '--format',
    '{{.Names}}',
  ]);
  return r.stdout.split('\n').filter(Boolean);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// The throw-away world
// ---------------------------------------------------------------------------

export interface Env {
  /** realpath of the temp root; everything below is removed by `cleanup`. */
  root: string;
  /** Fake `$HOME` (the manager's `home`). */
  home: string;
  /** `<home>/projects`: the workspace root of the test policy. */
  projects: string;
  /** A small project: README.md, src/a.txt. */
  app: string;
  /** `<home>/datasets`: the only mount root of the test policy. */
  datasets: string;
  aboxHome: string;
  /** Content of `~/.ssh/id_ed25519` (a unique marker that must never reach a sandbox). */
  sshMarker: string;
  env: NodeJS.ProcessEnv;
  secrets: MemorySecretStore;
  /** Controllable clock for the manager (starts at the real time; only moves forward). */
  clock: { offset: number; now(): number };
  cleanup(): void;
}

export function makeEnv(): Env {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'abox-e2e-')));
  const home = join(root, 'home');
  const projects = join(home, 'projects');
  const app = join(projects, 'app');
  const datasets = join(home, 'datasets');
  const aboxHome = join(root, 'abox');
  const sshMarker = `E2E-FAKE-SSH-PRIVATE-KEY-${randomBytes(8).toString('hex')}`;
  for (const d of [
    join(app, 'src'),
    datasets,
    join(home, '.ssh'),
    join(home, '.aws'),
    join(home, '.config'),
  ])
    mkdirSync(d, { recursive: true });
  writeFileSync(join(app, 'README.md'), 'hello from the e2e project\n');
  writeFileSync(join(app, 'src', 'a.txt'), 'a\n');
  writeFileSync(join(datasets, 'data.csv'), 'x,y\n1,2\n');
  writeFileSync(join(home, '.ssh', 'id_ed25519'), `${sshMarker}\n`, { mode: 0o600 });
  writeFileSync(
    join(home, '.aws', 'credentials'),
    `[default]\naws_secret_access_key=${sshMarker}\n`,
    { mode: 0o600 },
  );
  const clock = { offset: 0, now: () => Date.now() + clock.offset };
  return {
    root,
    home,
    projects,
    app,
    datasets,
    aboxHome,
    sshMarker,
    env: { ABOX_HOME: aboxHome, HOME: home },
    secrets: new MemorySecretStore(),
    clock,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Policy used by the suites. Contexts: agent-a, agent-b (medium), strict-agent, nomount-agent. */
export function e2ePolicy(env: Env, extra = ''): string {
  return `version: 1
profiles:
  agent:
    approval: medium
    templates: [alpine-min, e2e-net, e2e-fresh, e2e-bad, e2e-proj, e2e-evil]
    limits: { sandboxes: 8, cpus: 2, memory: 1g, ttl: 2h }
    workspace: { roots: ['${env.projects}'], modes: [copy, mount, clone, worktree, empty] }
    network: { modes: [none, allowlist], allow_presets: [], allow: [example.com] }
    mounts: { roots: ['${env.datasets}'], access: [ro] }
    secrets: { allowed: [e2e-token], inject: [proxy] }
    isolation: { min: container }
    hosts: [local]
  strict:
    extends: agent
    approval: strict
  nomount:
    extends: agent
    mounts: deny
    workspace: { roots: ['${env.projects}'], modes: [copy, empty] }
  tiny:
    extends: agent
    limits: { sandboxes: 1, cpus: 1, memory: 512m, ttl: 30m }
contexts:
  agent-a: { profile: agent }
  agent-b: { profile: agent }
  strict-agent: { profile: strict }
  nomount-agent: { profile: nomount }
  tiny-a: { profile: tiny }
  tiny-b: { profile: tiny }
  agent-hosts: { profile: agent, hosts: [local, shared-box, vault, limited, picky] }
${extra}`;
}

/** Writes `policy.yaml` below the config dir of `env` (before or after opening). */
export function writePolicy(env: Env, text = e2ePolicy(env)): void {
  const paths = resolvePaths(env.env);
  mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.policyFile, text, { mode: 0o600 });
}

/**
 * A real tool template on an image that already has curl, git, openssl, node and bash (no package installation at
 * build time: slow mirrors and apk hard-link I/O errors on containerd-snapshotter engines made installs flaky).
 * Network mode none by default.
 */
export const E2E_NET_TEMPLATE = `apiVersion: 1
name: e2e-net
description: Debian (node image) with curl, git, node and bash, used by the abox e2e tests only.
backend: docker
isolation: container
base: { os: 'node:24-bookworm' }
workspace: { mode: copy, path: /workspace, access: rw }
resources: { cpus: 1, memory: 512m, pids: 256, ttl: 30m }
network: { mode: none }
labels: { use-for: e2e tests }
`;

/** Installs `/workspace/dnsq.js` (UDP resolver probe) and `/workspace/tcp.sh` (bash /dev/tcp connect probe). */
export const TOOLS_INSTALL = String.raw`mkdir -p /workspace
cat > /workspace/dnsq.js <<'EOF'
// usage: node dnsq.js NAME [SERVER] [txt] - prints ANSWER <ips> or ERR <code>; exit 1 on error
const dns = require('node:dns');
const r = new dns.Resolver({ timeout: 2000, tries: 1 });
if (process.argv[3]) r.setServers([process.argv[3]]);
const done = (e, a) => { console.log(e ? 'ERR ' + e.code : 'ANSWER ' + a.join(',')); process.exit(e ? 1 : 0); };
if (process.argv[4] === 'txt') r.resolveTxt(process.argv[2], done); else r.resolve4(process.argv[2], done);
EOF
cat > /workspace/tcp.sh <<'EOF'
#!/bin/bash
# usage: tcp.sh HOST PORT [SECONDS] - exit 0 when a TCP connection could be opened
T=$3; [ -z "$T" ] && T=3
timeout "$T" bash -c 'exec 3<>/dev/tcp/$0/$1' "$1" "$2" 2>/dev/null
EOF
chmod +x /workspace/tcp.sh
echo tools-installed`;

export function writeUserTemplates(env: Env, extra: Record<string, string> = {}): void {
  const dir = resolvePaths(env.env).templatesDir;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'e2e-net.yaml'), E2E_NET_TEMPLATE);
  for (const [name, text] of Object.entries(extra)) writeFileSync(join(dir, `${name}.yaml`), text);
}

// ---------------------------------------------------------------------------
// Opening the manager
// ---------------------------------------------------------------------------

export interface OpenOpts {
  /** `false`: do not write a policy (built-in default policy applies). Default: `e2ePolicy(env)`. */
  policy?: string | false;
  templates?: Record<string, string>;
  secretStore?: SecretStore;
  hostResolver?: HostResolver;
  config?: Partial<AboxConfig>;
  providerOpts?: DockerProviderOptions;
  /** Extra provider factories, e.g. a different `process` backend. */
  providers?: Partial<Record<BackendKind, ProviderFactory>>;
  /**
   * Provider without an instance id (a "legacy" installation): it only sees engine objects that carry no
   * `abox.instance` label, i.e. none of this run's. Default: the provider has the id `instanceIdOf(instance)`.
   */
  unscoped?: boolean;
  /** Name of this manager instance (becomes the provider's instance id, see `instanceIdOf`); default: random. */
  instance?: string;
  reconcileOnOpen?: boolean;
  projectDir?: string;
  /** Use the controllable clock (`env.clock`). */
  fakeClock?: boolean;
}

export interface Ctx {
  abox: Abox;
  env: Env;
  /** The Docker provider the manager uses for host `local` (for `networkEvents`, `logs`, ...). */
  docker: DockerProvider;
  instance: string;
  /** Sandboxes created through `create()`; removed by `close()`. */
  created: string[];
  create(
    caller: Caller,
    req: CreateSandboxRequest,
    o?: { waitForApprovalMs?: number },
  ): Promise<CreatedResult>;
  close(): Promise<void>;
}

/**
 * The Docker provider of host `local`. With an `instance` name the provider gets the instance id
 * `instanceIdOf(instance)`: it only sees (list/inspect/remove/gcImages) the engine objects of that instance,
 * like a real installation does. The daemon is shared with other developers' test runs (and possibly a real abox)
 * and with the other manager instances of this very suite; the manager's `reconcile`/`doctor` treat every backend
 * sandbox without a registry row as an orphan (see the "two abox instances" test and the README).
 * The extra label `abox.e2e-inst=<instance>` is only for the `docker ps` based assertions and the cleanup.
 */
export function dockerProvider(
  opts: DockerProviderOptions & { instance?: string; host?: HostConnection } = {},
): DockerProvider {
  const { instance, extraLabels, host, ...rest } = opts;
  return createDockerProvider(host ?? { host: 'local', kind: 'local' }, {
    stopTimeoutSec: 1,
    ...engineSocketOpts(),
    ...(instance ? { instanceId: instanceIdOf(instance) } : {}),
    ...rest,
    extraLabels: {
      ...E2E_LABELS,
      ...(instance ? { 'abox.e2e-inst': instance } : {}),
      ...extraLabels,
    },
  });
}

export async function openAbox(env: Env, o: OpenOpts = {}): Promise<Ctx> {
  if (o.policy !== false) writePolicy(env, o.policy ?? e2ePolicy(env));
  writeUserTemplates(env, o.templates);
  const instance = o.instance ?? randomBytes(3).toString('hex');
  const shared = dockerProvider({ ...o.providerOpts, ...(o.unscoped ? {} : { instance }) });
  const base: AboxOpenOptions = {
    env: env.env,
    home: env.home,
    projectDir: o.projectDir ?? env.app,
    secretStore: o.secretStore ?? env.secrets,
    ttlCheckIntervalSec: 0,
    ...(o.fakeClock ? { now: env.clock.now } : {}),
    ...(o.hostResolver ? { hostResolver: o.hostResolver } : {}),
    config: { ...defaultConfig(), ...o.config },
    ...(o.reconcileOnOpen !== undefined ? { reconcileOnOpen: o.reconcileOnOpen } : {}),
    providers: {
      docker: (h) =>
        h.host === 'local'
          ? shared
          : createDockerProvider(h, {
              ...engineSocketOpts(),
              extraLabels: E2E_LABELS,
              ...(o.unscoped ? {} : { instanceId: instanceIdOf(instance) }),
              ...o.providerOpts,
            }),
      process: (h) => createProcessProvider(h, { dataDir: join(env.aboxHome, 'data', 'process') }),
      ...o.providers,
    },
  };
  const abox = await Abox.open(base);
  const created: string[] = [];
  const ctx: Ctx = {
    abox,
    env,
    docker: shared,
    instance,
    created,
    async create(caller, req, opts = {}) {
      const r = await abox.createSandbox(caller, req, { waitForApprovalMs: 0, ...opts });
      const c = createdOf(r);
      created.push(c.sandbox.id);
      return c;
    },
    async close() {
      for (const id of created.splice(0))
        await abox.removeSandbox(HUMAN, id).catch(() => undefined);
      abox.close();
    },
  };
  return ctx;
}

export function createdOf(r: CreateResult): CreatedResult {
  if (r.status !== 'created') {
    throw new Error(`expected status created, got ${r.status}: ${JSON.stringify(r).slice(0, 600)}`);
  }
  return r;
}

/** Create as `caller`; while the request is pending a human approves it, then the call is repeated. */
export async function createApproved(
  ctx: Ctx,
  caller: Caller,
  req: CreateSandboxRequest,
  note = 'e2e approval',
): Promise<CreatedResult> {
  for (let i = 0; i < 4; i++) {
    const r = await ctx.abox.createSandbox(caller, req, { waitForApprovalMs: 0 });
    if (r.status === 'created') {
      ctx.created.push(r.sandbox.id);
      return r;
    }
    if (r.status !== 'pending_approval') throw new Error(`unexpected status ${r.status}`);
    await ctx.abox.approve(HUMAN, r.approvalId, note);
  }
  throw new Error('still pending after approvals');
}

/** Runs a shell command in the sandbox and returns the completed outcome (throws on pending/confirmation). */
export async function sh(
  ctx: Ctx,
  caller: Caller,
  id: string,
  command: string,
  extra: Omit<ExecParams, 'command' | 'argv'> = {},
): Promise<ExecCompleted> {
  const r = await ctx.abox.exec(caller, id, { command, ...extra }, { waitForApprovalMs: 0 });
  if (r.status !== 'completed') throw new Error(`exec returned ${r.status} for: ${command}`);
  return r;
}

/** `stdout + stderr`, handy for substring assertions. */
export function out(r: ExecCompleted): string {
  return `${r.stdout}${r.stderr}`;
}

/** Captures the error of a promise (undefined when it resolved). */
export async function errorOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  return undefined;
}

/** Asserts-friendly view of an AboxError: `{code, message}` or the thrown thing. */
export function codeOf(e: unknown): string {
  return typeof e === 'object' && e !== null && 'code' in e
    ? String((e as { code: unknown }).code)
    : String(e);
}

/** Template with a unique build hash so `buildTemplate` really builds it. */
export function freshTemplate(name = 'e2e-fresh'): { name: string; yaml: string; nonce: string } {
  const nonce = randomBytes(6).toString('hex');
  return {
    name,
    nonce,
    yaml: `apiVersion: 1
name: ${name}
description: Fresh alpine template with a unique build step (e2e build test).
backend: docker
isolation: container
base: { os: 'alpine:3.22' }
setup:
  - run: echo ${nonce} > /etc/e2e-nonce
workspace: { mode: copy, path: /workspace, access: rw }
resources: { cpus: 1, memory: 256m, pids: 128, ttl: 30m }
network: { mode: none }
`,
  };
}

/** Policy additions used by the network/secret suites (profile `agent` is extended in place). */
export function e2ePolicyNet(
  env: Env,
  upstreamHost: string,
  otherHost = `other-${RUN}.e2e.test`,
  extraAllow: string[] = [],
): string {
  return e2ePolicy(env)
    .replace(
      'templates: [alpine-min, e2e-net, e2e-fresh, e2e-bad, e2e-proj, e2e-evil]',
      'templates: [alpine-min, e2e-net, e2e-fresh, e2e-bad, e2e-secret, e2e-git, e2e-env-secret, e2e-secret-forbidden]',
    )
    .replace(
      'allow: [example.com] }',
      `allow: [example.com, ${[upstreamHost, otherHost, ...extraAllow].join(', ')}] }`,
    )
    .replace(
      'secrets: { allowed: [e2e-token], inject: [proxy] }',
      'secrets: { allowed: [e2e-token, e2e-git-token], inject: [proxy] }',
    );
}

/** Create, run `fn`, always remove (also when `fn` throws). */
export async function withSandbox<T>(
  ctx: Ctx,
  caller: Caller,
  req: CreateSandboxRequest,
  fn: (id: string, created: CreatedResult) => Promise<T>,
): Promise<T> {
  const c = await ctx.create(caller, req);
  try {
    return await fn(c.sandbox.id, c);
  } finally {
    await ctx.abox.removeSandbox(HUMAN, c.sandbox.id).catch(() => undefined);
    const i = ctx.created.indexOf(c.sandbox.id);
    if (i >= 0) ctx.created.splice(i, 1);
  }
}

/** Number of docker containers (sandboxes and proxies) of this manager instance, any state. */
export async function containerCount(ctx: Ctx): Promise<number> {
  const r = await docker(['ps', '-a', '-q', '--filter', `label=abox.e2e-inst=${ctx.instance}`]);
  return r.stdout.split('\n').filter(Boolean).length;
}

/** Runs `git` on the host for fixtures (never inside a sandbox). */
export function gitHost(dir: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-C',
      dir,
      '-c',
      'user.name=e2e',
      '-c',
      'user.email=e2e@example.com',
      '-c',
      'init.defaultBranch=main',
      ...args,
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    },
  );
}

/**
 * Makes sure the egress proxy image exists before tests rely on it (the first allowlist create builds it with
 * `apk add openssl`, which fails intermittently on engines where apk hard-link installs hit I/O errors). Retries.
 */
export async function warmProxy(ctx: Ctx, attempts = 5): Promise<void> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await ctx.abox.createSandbox(
        HUMAN_YES,
        {
          template: 'alpine-min',
          workspace: { mode: 'empty' },
          overrides: { network: { mode: 'allowlist', allow: ['example.com'] } },
        },
        { waitForApprovalMs: 0 },
      );
      if (r.status === 'created') {
        await ctx.abox.removeSandbox(HUMAN, r.sandbox.id);
        return;
      }
      throw new Error(`warm-up create returned ${r.status}`);
    } catch (e) {
      last = e;
      await sleep(3000);
    }
  }
  throw last;
}
