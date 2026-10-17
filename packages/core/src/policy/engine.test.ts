import { createServer } from 'node:net';
import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashRequestDigest } from './digest.js';
import {
  evaluateAccessRequest,
  evaluateCreate,
  evaluateExec,
  type AccessRequestSpec,
  type CreateEvaluation,
  type CreateRequest,
  type SandboxRef,
} from './engine.js';
import { resolveContext } from './context.js';
import { defaultPolicy, parsePolicy } from './load.js';
import { canonicalizePath } from './paths.js';
import {
  GIB,
  HOUR,
  humanContext,
  makeContext,
  makeEnv,
  mkReq,
  type TestEnv,
} from './__tests__/helpers.js';

let env: TestEnv;
beforeAll(() => {
  env = makeEnv();
});
afterAll(() => env.cleanup());

const MODES = ['strict', 'medium', 'open'] as const;

function run(
  overrides: Record<string, unknown> = {},
  req: Partial<CreateRequest> = {},
): CreateEvaluation {
  return evaluateCreate(mkReq(env, makeContext(env, overrides), req));
}

function denyText(r: CreateEvaluation): string {
  if (r.decision !== 'deny')
    throw new Error(`expected deny, got ${r.decision}: ${JSON.stringify(r)}`);
  return r.reasons.join(' | ');
}

function expectDeny(r: CreateEvaluation, ...parts: string[]): void {
  const text = denyText(r);
  for (const p of parts) expect(text).toContain(p);
}

function approvalKinds(r: CreateEvaluation): string[] {
  if (r.decision !== 'approval')
    throw new Error(`expected approval, got ${r.decision}: ${JSON.stringify(r)}`);
  return r.kinds;
}

/** Expected outcome of an elevated-but-in-rights item per approval mode. */
function expectElevated(
  overrides: Record<string, unknown>,
  req: Partial<CreateRequest>,
  kind: string,
): void {
  const strict = run({ ...overrides, approval: 'strict' }, req);
  expect(approvalKinds(strict)).toContain(kind);
  const medium = run({ ...overrides, approval: 'medium' }, req);
  expect(approvalKinds(medium)).toEqual([kind]);
  const open = run({ ...overrides, approval: 'open' }, req);
  expect(open.decision).toBe('allow');
}

/** Expected outcome of a security invariant: approval in every mode. */
function expectInvariant(
  overrides: Record<string, unknown>,
  req: Partial<CreateRequest>,
  kind: string,
): void {
  for (const approval of MODES) {
    const r = run({ ...overrides, approval }, req);
    expect(approvalKinds(r), `mode ${approval}`).toContain(kind);
    if (approval !== 'strict') expect(approvalKinds(r), `mode ${approval}`).toEqual([kind]);
  }
}

describe('baseline', () => {
  it('allows a normal request in medium and open', () => {
    for (const approval of ['medium', 'open']) {
      const r = run({ approval });
      expect(r.decision, approval).toBe('allow');
    }
  });
  it('strict mode: every creation needs approval', () => {
    const r = run({ approval: 'strict' });
    expect(approvalKinds(r)).toEqual(['strict_mode']);
    if (r.decision === 'approval') expect(r.reasons[0]).toContain('strict');
  });
  it('returns effective values and a request digest', () => {
    const r = run();
    expect(r.effective).toMatchObject({
      owner: 'agent:agent1',
      profile: 'p',
      template: 'node-dev',
      host: 'local',
      isolation: 'container',
      requiredIsolation: 'container',
      resources: { cpus: 2, memoryBytes: 4 * GIB, ttlMs: HOUR },
      clamped: [],
      network: { mode: 'none', allow: [], privateExceptions: [] },
    });
    expect(r.requestDigest).toMatchObject({
      kind: 'create',
      owner: 'agent:agent1',
      template: { name: 'node-dev', hash: 'hash-1' },
    });
  });
});

describe('templates', () => {
  it.each(MODES)('denies a template that is not in the profile (%s)', (approval) => {
    const r = run(
      { approval },
      { template: { name: 'rust-dev', isolation: 'container', hash: 'h', contentHash: 'c' } },
    );
    expectDeny(r, 'template "rust-dev" is not allowed for profile "p"');
    if (r.decision === 'deny') expect(r.hint).toContain('node-dev, py-dev');
  });
  it('allows any template with *', () => {
    const r = run(
      { templates: ['*'] },
      { template: { name: 'rust-dev', isolation: 'container', hash: 'h', contentHash: 'c' } },
    );
    expect(r.decision).toBe('allow');
  });
  it('explains an empty template list', () => {
    const r = run({ templates: [] });
    if (r.decision !== 'deny') throw new Error('expected deny');
    expect(r.hint).toContain('no templates');
  });
});

describe('hosts', () => {
  it('denies a host that is not in the context host list', () => {
    const r = run({}, { host: { id: 'vps', zone: 'lab' } });
    expectDeny(r, 'host "vps" is not allowed for context "agent1"', 'allowed hosts: local');
  });
  it('allows a listed host and * ', () => {
    expect(run({ hosts: ['local', 'lab1'] }, { host: { id: 'lab1', zone: 'lab' } }).decision).toBe(
      'allow',
    );
    expect(run({ hosts: ['*'] }, { host: { id: 'lab2', zone: 'lab' } }).decision).toBe('allow');
  });
  it('an empty host list denies everything', () => {
    expectDeny(run({ hosts: [] }), 'not allowed for context');
  });
});

describe('limits', () => {
  it('denies cpus over the profile limit with exact numbers and clamps the effective value', () => {
    const r = run({}, { resources: { cpus: 8, memoryBytes: 4 * GIB } });
    expectDeny(r, 'requested cpus 8 exceeds the limit of 4 set by profile "p"');
    expect(r.effective.clamped).toEqual(['cpus']);
    expect(r.effective.resources.cpus).toBe(4);
  });
  it('denies memory over the limit', () => {
    const r = run({}, { resources: { cpus: 2, memoryBytes: 16 * GIB } });
    expectDeny(r, 'requested memory 16g exceeds the limit of 8g set by profile "p"');
    expect(r.effective.resources.memoryBytes).toBe(8 * GIB);
  });
  it('denies ttl over the limit', () => {
    const r = run({}, { ttlMs: 8 * HOUR });
    expectDeny(r, 'requested ttl 8h exceeds the limit of 4h set by profile "p"');
    expect(r.effective.resources.ttlMs).toBe(4 * HOUR);
  });
  it('allows values exactly at the limits', () => {
    expect(
      run({}, { resources: { cpus: 4, memoryBytes: 8 * GIB }, ttlMs: 4 * HOUR }).decision,
    ).toBe('allow');
  });
  it('the host limit applies when stricter than the profile', () => {
    const r = run(
      {},
      {
        host: { id: 'local', zone: 'workstation', limits: { cpus: 2, memory: '2g' } },
        resources: { cpus: 3, memoryBytes: 4 * GIB },
      },
    );
    expectDeny(
      r,
      'requested cpus 3 exceeds the limit of 2 on host "local"',
      'requested memory 4g exceeds the limit of 2g on host "local"',
    );
    expect(denyText(r)).not.toContain('set by profile');
    expect(r.effective.resources).toMatchObject({ cpus: 2, memoryBytes: 2 * GIB });
  });
  it('reports both profile and host when both are exceeded; the strictest becomes effective', () => {
    const r = run(
      {},
      {
        host: { id: 'local', zone: 'workstation', limits: { cpus: 2 } },
        resources: { cpus: 6, memoryBytes: GIB },
      },
    );
    expectDeny(r, 'limit of 4 set by profile', 'limit of 2 on host');
    expect(r.effective.resources.cpus).toBe(2);
    expect(r.effective.clamped).toEqual(['cpus']);
  });
  it('accepts host memory limits as bytes', () => {
    const r = run(
      {},
      {
        host: { id: 'local', zone: 'workstation', limits: { memory: 2 * GIB } },
        resources: { cpus: 1, memoryBytes: 4 * GIB },
      },
    );
    expectDeny(r, 'exceeds the limit of 2g on host');
  });
  it('denies an unparsable host memory limit (fail closed)', () => {
    expectDeny(
      run({}, { host: { id: 'local', zone: 'workstation', limits: { memory: 'lots' } } }),
      'invalid memory limit',
    );
  });
  it('enforces the sandbox count per owner', () => {
    expectDeny(
      run({}, { currentSandboxCount: 3 }),
      'already has 3 sandbox(es)',
      'allows at most 3',
    );
    expect(run({}, { currentSandboxCount: 2 }).decision).toBe('allow');
  });
  it('enforces the sandbox count per host', () => {
    const host = { id: 'local', zone: 'workstation' as const, limits: { sandboxes: 2 } };
    expectDeny(
      run({}, { host, currentHostSandboxCount: 2 }),
      'host "local" already runs 2 sandbox(es)',
    );
    expect(run({}, { host, currentHostSandboxCount: 1 }).decision).toBe('allow');
  });
  it.each([0, -1, Number.NaN, Infinity])('rejects invalid cpus %s', (cpus) => {
    const r = run({}, { resources: { cpus, memoryBytes: GIB } });
    // Infinity is "positive" but over the limit
    expect(r.decision).toBe('deny');
  });
  it('rejects invalid memory and ttl', () => {
    expectDeny(run({}, { resources: { cpus: 1, memoryBytes: 0 } }), 'memory');
    expectDeny(run({}, { ttlMs: 0 }), 'ttl');
    expectDeny(run({}, { ttlMs: Number.NaN }), 'ttl');
  });
});

describe('workspace', () => {
  it('denies a workspace mode that is not allowed', () => {
    expectDeny(
      run({ workspace: { modes: ['empty'] } }),
      'workspace mode "worktree" is not allowed for profile "p"',
    );
  });
  it('workspace mode mount is only possible if the profile allows it', () => {
    expect(run({}, { workspace: { mode: 'mount', hostPath: env.app } }).decision).toBe('allow');
    expectDeny(
      run(
        { workspace: { modes: ['worktree'] } },
        { workspace: { mode: 'mount', hostPath: env.app } },
      ),
      '"mount" is not allowed',
    );
  });
  it('denies a workspace outside the roots', () => {
    expectDeny(
      run({}, { workspace: { mode: 'copy', hostPath: env.datasets } }),
      'outside the allowed workspace roots',
    );
  });
  it('denies a workspace path that does not exist in canonical form', () => {
    expectDeny(
      run({}, { workspace: { mode: 'copy', hostPath: `${env.app}/../app` } }),
      'not a canonical',
    );
  });
  it('denies forbidden paths even when a root covers them', () => {
    const r = run(
      { workspace: { roots: ['~'] } },
      { workspace: { mode: 'copy', hostPath: env.sshDir } },
    );
    expectDeny(r, 'protected path ~/.ssh');
    expectDeny(
      run({ workspace: { roots: ['~'] } }, { workspace: { mode: 'copy', hostPath: env.home } }),
      'protected path the home directory',
    );
    expectDeny(
      run({ workspace: { roots: ['/'] } }, { workspace: { mode: 'copy', hostPath: '/' } }),
      'protected path',
    );
  });
  it('denies a symlink in the workspace that points to ~/.ssh once canonicalized', () => {
    const link = join(env.app, 'evil-link');
    symlinkSync(env.sshDir, link);
    const canonical = canonicalizePath(link, { home: env.home, cwd: env.home });
    expectDeny(
      run({ workspace: { roots: ['~'] } }, { workspace: { mode: 'copy', hostPath: canonical } }),
      'protected path ~/.ssh',
    );
  });
  it('denies protected paths of abox itself (extraForbidden)', () => {
    const aboxData = join(env.home, 'abox-data');
    mkdirSync(join(aboxData, 'sandboxes', 'x'), { recursive: true });
    const r = run(
      { workspace: { roots: ['~'] } },
      {
        workspace: { mode: 'copy', hostPath: join(aboxData, 'sandboxes', 'x') },
        paths: { home: env.home, extraForbidden: [aboxData] },
      },
    );
    expectDeny(r, 'protected path');
  });
  it('workspace mode mount scans for sockets, copy does not', async () => {
    const dir = join(env.projects, 'with-socket');
    mkdirSync(dir);
    const server = createServer();
    await new Promise<void>((res) => server.listen(join(dir, 'x.sock'), res));
    try {
      expectDeny(run({}, { workspace: { mode: 'mount', hostPath: dir } }), 'socket file');
      expect(run({}, { workspace: { mode: 'copy', hostPath: dir } }).decision).toBe('allow');
    } finally {
      await new Promise((res) => server.close(res));
    }
  });
  it('workspace mode mount is impossible on a remote host', () => {
    const r = run(
      { hosts: ['vps'] },
      {
        host: { id: 'vps', zone: 'lab', remote: true },
        workspace: { mode: 'mount', hostPath: env.app },
      },
    );
    expectDeny(r, 'not possible on remote host "vps"');
  });
  it('mode empty needs no path; other modes need one', () => {
    expect(run({}, { workspace: { mode: 'empty' } }).decision).toBe('allow');
    expect(run({}, { workspace: undefined }).decision).toBe('allow');
    expectDeny(run({}, { workspace: { mode: 'clone' } }), 'requires a host path');
    // a stray hostPath with mode empty is ignored (and not part of the digest)
    const withPath = run({}, { workspace: { mode: 'empty', hostPath: env.sshDir } });
    expect(withPath.decision).toBe('allow');
    expect(withPath.requestDigest.workspace).toEqual({ mode: 'empty' });
  });
});

describe('workspace: built-in default policy (agents)', () => {
  const agent = (): ReturnType<typeof makeContext> =>
    resolveContext(defaultPolicy(), 'claude-code', { home: env.home });
  const create = (hostPath: string, mode: 'copy' | 'worktree' = 'copy'): CreateEvaluation =>
    evaluateCreate(
      mkReq(env, agent(), {
        template: { name: 'node-dev', isolation: 'container', hash: 'h', contentHash: 'c' },
        workspace: { mode, hostPath },
      }),
    );

  it('allows a project below ~/projects and below roots that do not exist yet', () => {
    expect(create(env.app).decision).toBe('allow');
    const later = join(env.home, 'Projekte', 'neu');
    expect(create(later).decision).toBe('allow');
    expect(create(join(env.home, 'src', 'x')).decision).toBe('allow');
  });
  it('does not allow a workspace root itself for agents, but does for humans', () => {
    const r = create(env.projects);
    expectDeny(r, 'root itself');
    if (r.decision === 'deny') expect(r.hint).toContain('inside the root');
    expectDeny(create(env.projects, 'worktree'), 'root itself');
    const human = evaluateCreate(
      mkReq(env, humanContext(env), { workspace: { mode: 'copy', hostPath: env.projects } }),
    );
    expect(human.decision).not.toBe('deny');
  });
  it('does not allow the home directory as a whole nor ordinary home folders', () => {
    expectDeny(create(env.home), 'protected path the home directory');
    expectDeny(create(env.datasets), 'outside the allowed workspace roots');
    expectDeny(create(join(env.home, 'Documents', 'taxes')), 'outside the allowed workspace roots');
  });
  it('denies a workspace outside the roots with a hint naming policy edit and workspace.roots', () => {
    const r = create(env.datasets);
    expect(r.decision).toBe('deny');
    if (r.decision === 'deny') {
      expect(r.hint).toContain('abox policy edit');
      expect(r.hint).toContain('workspace.roots');
    }
  });
  it.each(['.claude', '.codex', '.cache', '.config/abox', '.ssh', '.local/share'])(
    'denies ~/%s',
    (rel) => {
      mkdirSync(join(env.home, rel), { recursive: true });
      expectDeny(create(join(env.home, rel)));
    },
  );
  it('denies hidden home directories even with a profile root of ~', () => {
    const dir = join(env.home, '.claude', 'projects', 'x');
    mkdirSync(dir, { recursive: true });
    const r = run({ workspace: { roots: ['~'] } }, { workspace: { mode: 'copy', hostPath: dir } });
    expectDeny(r, 'hidden');
    expect(
      run(
        { workspace: { roots: ['~'] } },
        { workspace: { mode: 'copy', hostPath: join(env.home, 'datasets') } },
      ).decision,
    ).toBe('allow');
  });
  it('applies to additional mounts of agents too', () => {
    const dir = join(env.home, '.codex');
    mkdirSync(dir, { recursive: true });
    expectDeny(
      run(
        { mounts: { roots: ['~'], access: ['ro'] } },
        { mounts: [{ hostPath: dir, target: '/x', access: 'ro' }] },
      ),
      'hidden',
    );
  });
  it('does not change anything for humans', () => {
    const dir = join(env.home, '.hidden-project');
    mkdirSync(dir, { recursive: true });
    const r = evaluateCreate(
      mkReq(env, humanContext(env), {
        workspace: { mode: 'copy', hostPath: dir },
      }),
    );
    expect(r.decision).toBe('allow');
    expect(
      evaluateCreate(
        mkReq(env, humanContext(env), { workspace: { mode: 'copy', hostPath: env.datasets } }),
      ).decision,
    ).toBe('allow');
  });
});

describe('base image registries', () => {
  const tpl = (os: string | undefined, over: Record<string, unknown> = {}) => ({
    name: 'node-dev',
    isolation: 'container' as const,
    hash: 'h',
    contentHash: 'c',
    backend: 'docker' as const,
    base: { ...(os ? { os } : {}), osFamily: 'debian' as const },
    ...over,
  });
  const withImage = (os: string | undefined, overrides: Record<string, unknown> = {}) =>
    run(overrides, { template: tpl(os) });

  it('built-in agent profile: official Docker Hub images and the built-in bases pass', () => {
    expect(withImage('ubuntu:24.04').decision).toBe('allow');
    expect(withImage('debian:12-slim').decision).toBe('allow');
    expect(withImage('docker.io/library/fedora:42').decision).toBe('allow');
  });
  it('an image outside the allowlist needs approval (like destinations beyond the network allowlist)', () => {
    const r = withImage('ghcr.io/someone/tools:1');
    expect(approvalKinds(r)).toEqual(['image_registry']);
    if (r.decision === 'approval') {
      expect(r.reasons.join(' ')).toContain('base image "ghcr.io/someone/tools:1"');
      expect(r.reasons.join(' ')).toContain('images.registries');
    }
    for (const approval of MODES)
      expect(approvalKinds(withImage('myorg/app', { approval })), approval).toContain(
        'image_registry',
      );
  });
  it('a profile without any registry denies images that are not built in', () => {
    const r = withImage('debian:12', { images: { registries: [] } });
    expectDeny(r, 'no image registry allowlist');
    if (r.decision === 'deny') expect(r.hint).toContain('abox policy edit');
    expect(withImage('ubuntu:24.04', { images: { registries: [] } }).decision).toBe('allow');
  });
  it('registries can be widened to a registry or a path prefix', () => {
    const o = { images: { registries: ['docker.io/library', 'ghcr.io/my-org'] } };
    expect(withImage('ghcr.io/my-org/tools:1', o).decision).toBe('allow');
    expect(approvalKinds(withImage('ghcr.io/other/tools:1', o))).toEqual(['image_registry']);
    expect(withImage('ghcr.io/other/tools:1', { images: { registries: ['*'] } }).decision).toBe(
      'allow',
    );
  });
  it('is only for container backends and for templates that say what their base is', () => {
    expect(run({}, { template: tpl('ubuntu-24.04', { backend: 'vm' }) }).decision).toBe('allow');
    expect(run({}, { template: tpl('ghcr.io/x/y', { backend: 'process' }) }).decision).toBe(
      'allow',
    );
    expect(run({}, {}).decision).toBe('allow');
  });
  it('a Dockerfile base counts as an unchecked image unless any image is allowed', () => {
    const r = run(
      {},
      { template: tpl(undefined, { base: { dockerfile: './Dockerfile', osFamily: 'unknown' } }) },
    );
    expect(approvalKinds(r)).toEqual(['image_registry']);
    expect(
      run(
        { images: { registries: ['*'] } },
        { template: tpl(undefined, { base: { dockerfile: './Dockerfile', osFamily: 'unknown' } }) },
      ).decision,
    ).toBe('allow');
  });
  it('the request digest records the base and its registry, so an approval is bound to it', () => {
    const digest = (t: ReturnType<typeof tpl>): Record<string, unknown> =>
      (
        run({ images: { registries: ['*'] } }, { template: t }).requestDigest['template'] as {
          base: unknown;
        }
      ).base as Record<string, unknown>;
    expect(digest(tpl('ghcr.io/acme/tools:1'))).toEqual({
      os: 'ghcr.io/acme/tools:1',
      registry: 'ghcr.io',
    });
    expect(digest(tpl('ubuntu:24.04'))).toEqual({ os: 'ubuntu:24.04', registry: 'docker.io' });
    expect(
      digest(tpl(undefined, { base: { dockerfile: './Dockerfile', osFamily: 'unknown' } })),
    ).toEqual({ dockerfile: './Dockerfile' });
    // a distro name of a vm base is not an image: no registry
    expect(digest(tpl('ubuntu-24.04', { backend: 'vm' }))).toEqual({ os: 'ubuntu-24.04' });

    // same template name, hash and content hash, other base: another digest, so another approval
    const hash = (t: ReturnType<typeof tpl>): string =>
      hashRequestDigest(run({ images: { registries: ['*'] } }, { template: t }).requestDigest);
    expect(hash(tpl('ghcr.io/acme/tools:1'))).toBe(hash(tpl('ghcr.io/acme/tools:1')));
    expect(hash(tpl('ghcr.io/acme/tools:1'))).not.toBe(hash(tpl('ghcr.io/acme/tools:2')));
    expect(hash(tpl('ghcr.io/acme/tools:1'))).not.toBe(hash(tpl('docker.io/acme/tools:1')));
    expect(hash(tpl('ghcr.io/acme/tools:1'))).not.toBe(
      hash(tpl(undefined, { base: { dockerfile: './Dockerfile', osFamily: 'unknown' } })),
    );
  });
  it('a malformed image name is never allowed by a prefix', () => {
    expect(approvalKinds(withImage('docker.io/library/../evil'))).toEqual(['image_registry']);
  });
  it('humans may use any image by default; a configured human profile restricts them', () => {
    const human = (os: string): CreateEvaluation =>
      evaluateCreate(mkReq(env, humanContext(env), { template: tpl(os) }));
    expect(human('ghcr.io/someone/tools:1').decision).toBe('allow');
    const policy = parsePolicy(
      'profiles:\n  human: { images: { registries: [docker.io/library] } }\n',
      {
        kind: 'file',
        path: '/t/policy.yaml',
      },
    );
    const restricted = resolveContext(policy, 'human', { home: env.home });
    const r = evaluateCreate(mkReq(env, restricted, { template: tpl('ghcr.io/x/y') }));
    expect(approvalKinds(r)).toEqual(['image_registry']);
    expect(
      evaluateCreate(mkReq(env, restricted, { template: tpl('ghcr.io/x/y'), humanConfirmed: true }))
        .decision,
    ).toBe('allow');
  });
});

describe('mounts', () => {
  const mount = (over: Partial<CreateRequest['mounts'][number]> = {}) => ({
    hostPath: env.datasets,
    target: '/data',
    access: 'ro' as const,
    ...over,
  });

  it('denies any mount when the profile says mounts: deny (all approval modes)', () => {
    for (const approval of MODES) {
      expectDeny(
        run({ approval, mounts: 'deny' }, { mounts: [mount()] }),
        'additional mounts are denied for profile "p"',
      );
    }
  });
  it('an allowed ro mount is an elevated item: approval in strict/medium, allowed in open', () => {
    expectElevated({}, { mounts: [mount()] }, 'mount');
  });
  it('denies rw when only ro is allowed (all modes)', () => {
    for (const approval of MODES)
      expectDeny(
        run({ approval }, { mounts: [mount({ access: 'rw' })] }),
        'access "rw" is not allowed for profile "p"',
      );
  });
  it('rw is an elevated item when the profile allows it', () => {
    expectElevated(
      { mounts: { access: ['ro', 'rw'] } },
      { mounts: [mount({ access: 'rw' })] },
      'mount',
    );
  });
  it('denies mounts outside the mount roots', () => {
    expectDeny(run({}, { mounts: [mount({ hostPath: env.sshDir })] }), 'protected path ~/.ssh');
    expectDeny(
      run({ mounts: { roots: ['~/datasets'] } }, { mounts: [mount({ hostPath: env.app })] }),
      'outside the allowed mount roots',
    );
  });
  it('denies forbidden mounts even if the root covers them, and parents of forbidden paths', () => {
    const opts = { mounts: { roots: ['~'], access: ['ro', 'rw'] } };
    expectDeny(run(opts, { mounts: [mount({ hostPath: env.sshDir })] }), 'protected path ~/.ssh');
    expectDeny(run(opts, { mounts: [mount({ hostPath: env.home })] }), 'protected path');
    expectDeny(run(opts, { mounts: [mount({ hostPath: env.root })] }), 'protected path');
    expectDeny(
      run(opts, { mounts: [mount({ hostPath: join(env.home, '.config') })] }),
      'protected path ~/.config',
    );
    expectDeny(run(opts, { mounts: [mount({ hostPath: '/etc' })] }), 'protected path');
    expectDeny(
      run(opts, { mounts: [mount({ hostPath: '/var/run/docker.sock' })] }),
      'protected path',
    );
  });
  it('denies a directory containing a socket as mount', async () => {
    const dir = join(env.datasets, 'sock-dir');
    mkdirSync(dir);
    const server = createServer();
    await new Promise<void>((res) => server.listen(join(dir, 'engine.sock'), res));
    try {
      expectDeny(run({}, { mounts: [mount({ hostPath: dir })] }), 'socket file');
    } finally {
      await new Promise((res) => server.close(res));
    }
  });
  it('denies reserved or duplicate mount targets', () => {
    expectDeny(run({}, { mounts: [mount({ target: '/etc' })] }), 'shadow the system location /etc');
    expectDeny(run({}, { mounts: [mount({ target: 'relative' })] }), 'absolute');
    expectDeny(
      run(
        {},
        { mounts: [mount({ target: '/a' }), mount({ target: '/a', hostPath: env.projects })] },
      ),
      'used more than once',
    );
  });
  it('requires the profile isolation level for mounts', () => {
    expectDeny(
      run({ isolation: { mounts: 'hardened' } }, { mounts: [mount()] }),
      'below "hardened" required by profile "p" for additional mounts',
    );
    expect(
      run(
        { isolation: { mounts: 'hardened' } },
        { mounts: [mount()], providerIsolation: 'hardened' },
      ).decision,
    ).toBe('approval');
  });
  it('deny beats approval', () => {
    const r = run(
      { approval: 'strict' },
      { mounts: [mount(), mount({ hostPath: env.sshDir, target: '/x' })], templateTrusted: false },
    );
    expect(r.decision).toBe('deny');
    expect(r).not.toHaveProperty('items');
  });
});

describe('network', () => {
  const allowlist = (...allow: string[]) => ({ network: { mode: 'allowlist' as const, allow } });

  it.each(MODES)('denies a network mode that the profile does not list (%s)', (approval) => {
    const r = run({ approval }, { network: { mode: 'open', allow: [] }, providerIsolation: 'vm' });
    expectDeny(r, 'network mode "open" is not allowed for profile "p" (allowed: none, allowlist)');
  });
  it('allows destinations from presets, exact entries and wildcard entries', () => {
    const r = run(
      {},
      allowlist(
        'registry.npmjs.org',
        'pypi.org',
        'internal.example.org',
        'a.cdn.example.org',
        'DEEP.a.cdn.example.org.',
      ),
    );
    expect(r.decision).toBe('allow');
    expect(r.effective.network.allow).toEqual([
      'a.cdn.example.org',
      'deep.a.cdn.example.org',
      'internal.example.org',
      'pypi.org',
      'registry.npmjs.org',
    ]);
  });
  it('destinations in the profile do not need approval, but strict still asks', () => {
    expect(approvalKinds(run({ approval: 'strict' }, allowlist('pypi.org')))).toEqual([
      'strict_mode',
    ]);
  });
  it.each(MODES)(
    'destinations beyond the profile need approval (%s) with an actionable reason',
    (approval) => {
      const r = run({ approval }, allowlist('pypi.org', 'evil.example.com'));
      expect(approvalKinds(r)).toContain('network_domains');
      if (r.decision === 'approval') {
        expect(r.reasons.join(' ')).toContain('evil.example.com');
        expect(r.reasons.join(' ')).not.toContain('pypi.org (');
      }
    },
  );
  it('subdomains of an exact entry or the apex of a wildcard entry are beyond the profile', () => {
    expect(approvalKinds(run({}, allowlist('x.internal.example.org')))).toContain(
      'network_domains',
    );
    expect(approvalKinds(run({}, allowlist('cdn.example.org')))).toContain('network_domains');
    expect(approvalKinds(run({}, allowlist('*.example.org')))).toContain('network_domains');
  });
  it('destinations with a port: valid, and compared like the proxy does (F5)', () => {
    // the human profile allows everything ('*'): a port entry is accepted, not "not a valid domain pattern"
    expect(run({ network: { allow: ['*'] } }, allowlist('example.org:8443')).decision).toBe(
      'allow',
    );
    // plain entry covers 80/443 only
    expect(run({}, allowlist('internal.example.org:443')).decision).toBe('allow');
    expect(approvalKinds(run({}, allowlist('internal.example.org:8443')))).toContain(
      'network_domains',
    );
    // profile entry with port covers exactly that port
    const p = { network: { allow: ['api.example.org:8443'] } };
    expect(run(p, allowlist('api.example.org:8443')).decision).toBe('allow');
    expect(approvalKinds(run(p, allowlist('api.example.org:9443')))).toContain('network_domains');
    expect(approvalKinds(run(p, allowlist('api.example.org')))).toContain('network_domains');
    expectDeny(run({}, allowlist('x.example.org:99999')), 'is not a valid domain pattern');
  });
  it('denies destinations when the profile has an empty network list', () => {
    const r = run({ network: { allow_presets: [], allow: [] } }, allowlist('pypi.org'));
    expectDeny(r, 'has no network allowlist');
  });
  it('a profile allow of * covers any valid destination', () => {
    expect(run({ network: { allow: ['*'] } }, allowlist('anything.example.net')).decision).toBe(
      'allow',
    );
  });
  it.each(['http://x.org', '*', '*.com', 'localhost', 'a b.org', 'x.org/p', ''])(
    'denies invalid destination %j',
    (d) => {
      expectDeny(run({}, allowlist(d)), 'is not a valid domain pattern');
    },
  );
  it('mode none ignores stale allow entries', () => {
    const r = run({}, { network: { mode: 'none', allow: ['pypi.org', 'evil.example.com'] } });
    expect(r.decision).toBe('allow');
    expect(r.effective.network.allow).toEqual([]);
  });
  describe('mode open', () => {
    const open = { network: { modes: ['none', 'allowlist', 'open'] } };
    it('is an elevated item when the profile allows it and isolation is vm', () => {
      expectElevated(
        open,
        { network: { mode: 'open', allow: [] }, providerIsolation: 'vm' },
        'network_open',
      );
    });
    it('requires profile isolation.network_open', () => {
      expectDeny(
        run(open, { network: { mode: 'open', allow: [] }, providerIsolation: 'container' }),
        'below "vm" required by profile "p" for network mode open',
      );
      expectDeny(
        run(open, { network: { mode: 'open', allow: [] }, providerIsolation: 'hardened' }),
        'below "vm"',
      );
      expectDeny(
        run(
          { ...open, approval: 'open' },
          { network: { mode: 'open', allow: [] }, providerIsolation: 'container' },
        ),
        'below "vm"',
      );
    });
  });
  describe('mode open for the human profile', () => {
    const humanOpen = (isolation: CreateRequest['providerIsolation']): CreateEvaluation =>
      evaluateCreate(
        mkReq(env, humanContext(env), {
          network: { mode: 'open', allow: [] },
          providerIsolation: isolation,
        }),
      );
    it.each(['container'] as const)(
      'needs an explicit confirmation below hardened (%s), never silent',
      (isolation) => {
        const r = humanOpen(isolation);
        expect(r.decision).toBe('approval');
        const items = r.decision === 'approval' ? r.items : [];
        const item = items.find((i) => i.kind === 'network_open');
        expect(item?.invariant).toBe(true);
        expect(item?.reason).toBe(
          `network mode "open" needs isolation "hardened" by default; template "node-dev" runs with "${isolation}"`,
        );
        expect(item?.risk).toContain('Unrestricted internet access');
      },
    );
    it('is allowed with hardened or vm isolation', () => {
      expect(humanOpen('hardened').decision).toBe('allow');
      expect(humanOpen('vm').decision).toBe('allow');
    });
    it('is satisfied by humanConfirmed, which agents cannot use', () => {
      const req = mkReq(env, humanContext(env), {
        network: { mode: 'open', allow: [] },
        providerIsolation: 'container',
        humanConfirmed: true,
      });
      expect(evaluateCreate(req).decision).toBe('allow');
      const agent = mkReq(
        env,
        makeContext(env, { network: { modes: ['none', 'allowlist', 'open'] } }),
        {
          network: { mode: 'open', allow: [] },
          providerIsolation: 'container',
          humanConfirmed: true,
        },
      );
      expect(evaluateCreate(agent).decision).toBe('deny'); // agent rules unchanged
    });
    it('also applies when a human switches a running sandbox to open', () => {
      const sandbox: SandboxRef = {
        id: 'local/abcd1234',
        owner: 'human',
        isolation: 'container',
        network: { mode: 'none', allow: [] },
      };
      const r = evaluateAccessRequest(humanContext(env), sandbox, {
        kind: 'network',
        details: { mode: 'open' },
      });
      expect(r.decision).toBe('approval');
      const hardened = evaluateAccessRequest(
        humanContext(env),
        { ...sandbox, isolation: 'hardened' },
        { kind: 'network', details: { mode: 'open' } },
      );
      expect(hardened.decision).toBe('allow');
    });
  });
  describe('private address exceptions', () => {
    it('always need approval, in every mode', () => {
      expectInvariant(
        {},
        {
          network: { mode: 'allowlist', allow: ['pypi.org'], privateExceptions: ['192.168.1.20'] },
        },
        'private_address',
      );
      expectInvariant(
        {},
        { network: { mode: 'allowlist', allow: [], privateExceptions: ['10.0.0.0/8', 'fd00::1'] } },
        'private_address',
      );
    });
    it('are denied with network mode none and when malformed', () => {
      expectDeny(
        run({}, { network: { mode: 'none', allow: [], privateExceptions: ['192.168.1.20'] } }),
        'no effect with network mode "none"',
      );
      expectDeny(
        run({}, { network: { mode: 'allowlist', allow: [], privateExceptions: ['not-an-ip'] } }),
        'not a valid IP address or CIDR',
      );
      expectDeny(
        run({}, { network: { mode: 'allowlist', allow: [], privateExceptions: ['10.0.0.0/99'] } }),
        'not a valid',
      );
      expectDeny(
        run({}, { network: { mode: 'allowlist', allow: [], privateExceptions: ['10.0.0.1/8/9'] } }),
        'not a valid',
      );
    });
  });
});

describe('secrets', () => {
  it('allows an allowed secret injected via proxy', () => {
    expect(run({}, { secrets: [{ ref: 'github-token', inject: 'proxy' }] }).decision).toBe('allow');
  });
  it.each(MODES)('denies a secret that is not allowed (%s)', (approval) => {
    expectDeny(
      run({ approval }, { secrets: [{ ref: 'aws-prod', inject: 'proxy' }] }),
      'secret "aws-prod" is not allowed for profile "p"',
    );
  });
  it('* allows any ref', () => {
    expect(
      run({ secrets: { allowed: ['*'] } }, { secrets: [{ ref: 'whatever', inject: 'proxy' }] })
        .decision,
    ).toBe('allow');
  });
  it('denies an injection kind that the profile does not list', () => {
    const r = run({}, { secrets: [{ ref: 'github-token', inject: 'env' }] });
    expectDeny(r, 'injection "env" is not allowed for profile "p"');
    if (r.decision === 'deny') expect(r.hint).toContain('inject: proxy');
  });
  it('env and file injection need approval in every mode when the profile allows them', () => {
    const o = { secrets: { allowed: ['github-token'], inject: ['proxy', 'env', 'file'] } };
    expectInvariant(o, { secrets: [{ ref: 'github-token', inject: 'env' }] }, 'secret_env');
    expectInvariant(o, { secrets: [{ ref: 'github-token', inject: 'file' }] }, 'secret_file');
  });
  it('env/file injection requires profile isolation.secrets_env', () => {
    const o = {
      secrets: { allowed: ['github-token'], inject: ['proxy', 'env'] },
      isolation: { secrets_env: 'vm' },
    };
    expectDeny(
      run(o, { secrets: [{ ref: 'github-token', inject: 'env' }] }),
      'below "vm" required by profile "p" for env/file secret injection',
    );
    // proxy injection is not subject to it
    expect(run(o, { secrets: [{ ref: 'github-token', inject: 'proxy' }] }).decision).toBe('allow');
  });
  it('never puts anything but refs and inject kinds into the digest', () => {
    const r = run({}, { secrets: [{ ref: 'github-token', inject: 'proxy' }] });
    expect(r.requestDigest.secrets).toEqual([{ ref: 'github-token', inject: 'proxy' }]);
  });
});

describe('isolation and host zones', () => {
  it('denies a provider below the template isolation', () => {
    expectDeny(
      run(
        {},
        { template: { name: 'node-dev', isolation: 'hardened', hash: 'h', contentHash: 'c' } },
      ),
      'isolation "container" is below "hardened" required by template "node-dev"',
    );
  });
  it('denies a provider below the profile minimum', () => {
    expectDeny(
      run({ isolation: { min: 'hardened' } }),
      'below "hardened" required by profile "p" (isolation.min)',
    );
  });
  it('shared hosts: hardened required (deny), then approval in every mode', () => {
    const host = { id: 'local', zone: 'shared' as const };
    expectDeny(run({}, { host }), 'below "hardened" required by host zone "shared"');
    expectInvariant({}, { host, providerIsolation: 'hardened' }, 'host_zone');
    expectInvariant({}, { host, providerIsolation: 'vm' }, 'host_zone');
  });
  it('restricted hosts: only vm (deny otherwise), then approval in every mode', () => {
    const host = { id: 'local', zone: 'restricted' as const };
    expectDeny(
      run({}, { host, providerIsolation: 'hardened' }),
      'below "vm" required by host zone "restricted"',
    );
    expectDeny(run({}, { host, providerIsolation: 'container' }), 'host zone "restricted"');
    expectInvariant({}, { host, providerIsolation: 'vm' }, 'host_zone');
  });
  it('workstation and lab zones need nothing extra', () => {
    expect(run({}, { host: { id: 'local', zone: 'workstation' } }).decision).toBe('allow');
    expect(run({ hosts: ['local'] }, { host: { id: 'local', zone: 'lab' } }).decision).toBe(
      'allow',
    );
  });
  it('host minIsolation is enforced', () => {
    expectDeny(
      run({}, { host: { id: 'local', zone: 'lab', minIsolation: 'vm' } }),
      'below "vm" required by host "local" (min_isolation)',
    );
    expect(
      run(
        {},
        {
          host: { id: 'local', zone: 'lab', minIsolation: 'hardened' },
          providerIsolation: 'hardened',
        },
      ).decision,
    ).toBe('allow');
  });
  it('effective.requiredIsolation is the strongest requirement', () => {
    const r = run(
      { isolation: { min: 'hardened' } },
      { providerIsolation: 'vm', host: { id: 'local', zone: 'lab', minIsolation: 'vm' } },
    );
    expect(r.effective.requiredIsolation).toBe('vm');
  });
  describe('isolation none', () => {
    const noneTemplate = {
      name: 'node-dev',
      isolation: 'none' as const,
      hash: 'h',
      contentHash: 'c',
    };
    it('needs approval in every mode (profile allows none)', () => {
      expectInvariant(
        { isolation: { min: 'none' } },
        { providerIsolation: 'none', template: noneTemplate },
        'isolation_none',
      );
    });
    it('is denied when the profile minimum is higher (deny beats approval)', () => {
      const r = run({ approval: 'open' }, { providerIsolation: 'none', template: noneTemplate });
      expectDeny(r, 'isolation "none" is below "container" required by profile');
    });
    it('a human needs the explicit confirmation flag', () => {
      const ctx = humanContext(env);
      const base = mkReq(env, ctx, { providerIsolation: 'none', template: noneTemplate });
      const unconfirmed = evaluateCreate(base);
      expect(approvalKinds(unconfirmed)).toEqual(['isolation_none']);
      const confirmed = evaluateCreate({ ...base, humanConfirmed: true });
      expect(confirmed.decision).toBe('allow');
      if (confirmed.decision === 'allow')
        expect(confirmed.confirmed?.map((i) => i.kind)).toEqual(['isolation_none']);
    });
    it('the confirmation flag does nothing for agents', () => {
      const base = mkReq(env, makeContext(env, { isolation: { min: 'none' }, approval: 'open' }), {
        providerIsolation: 'none',
        template: noneTemplate,
        humanConfirmed: true,
      });
      expect(approvalKinds(evaluateCreate(base))).toEqual(['isolation_none']);
    });
    it('the confirmation flag never overrides a deny', () => {
      const ctx = humanContext(env);
      const r = evaluateCreate(
        mkReq(env, ctx, {
          humanConfirmed: true,
          mounts: [{ hostPath: env.sshDir, target: '/x', access: 'ro' }],
        }),
      );
      expectDeny(r, 'protected path ~/.ssh');
    });
  });
});

describe('template trust', () => {
  it('an untrusted project template needs approval in every mode', () => {
    expectInvariant(
      {},
      {
        templateTrusted: false,
        templateSource: { kind: 'project', path: '/p/.sandbox/node-dev.yaml' },
      },
      'template_trust',
    );
    const r = run(
      {},
      {
        templateTrusted: false,
        templateSource: { kind: 'project', path: '/p/.sandbox/node-dev.yaml' },
      },
    );
    if (r.decision === 'approval') expect(r.reasons[0]).toContain('/p/.sandbox/node-dev.yaml');
  });
  it('is denied when the template is not in the profile (deny beats approval)', () => {
    const r = run(
      {},
      {
        templateTrusted: false,
        template: { name: 'evil', isolation: 'container', hash: 'h', contentHash: 'c' },
      },
    );
    expect(r.decision).toBe('deny');
  });
  it('a human can confirm it', () => {
    const r = evaluateCreate(
      mkReq(env, humanContext(env), {
        templateTrusted: false,
        templateSource: { kind: 'project' },
        humanConfirmed: true,
      }),
    );
    expect(r.decision).toBe('allow');
  });
  it('trust is part of the digest', () => {
    const a = run({}, { templateTrusted: true });
    const b = run({ approval: 'open' }, { templateTrusted: false });
    expect(hashRequestDigest(a.requestDigest)).not.toBe(hashRequestDigest(b.requestDigest));
  });
});

describe('human context', () => {
  const ctx = (): ReturnType<typeof humanContext> => humanContext(env);
  it('is broadly allowed without approval in open mode', () => {
    const r = evaluateCreate(
      mkReq(env, ctx(), {
        template: { name: 'anything', isolation: 'container', hash: 'h', contentHash: 'c' },
        mounts: [{ hostPath: env.datasets, target: '/data', access: 'rw' }],
        network: { mode: 'allowlist', allow: ['whatever.example.net'] },
        host: { id: 'any-lab', zone: 'lab' },
        resources: { cpus: 16, memoryBytes: 32 * GIB },
        ttlMs: 24 * HOUR,
      }),
    );
    expect(r.decision).toBe('allow');
    expect(r.effective.owner).toBe('human');
  });
  it.each(['/etc', '/', '/proc', '/var/lib/docker', '/run/user/1000'])(
    'forbidden path %s stays forbidden for humans',
    (hostPath) => {
      expectDeny(
        evaluateCreate(
          mkReq(env, ctx(), {
            mounts: [{ hostPath, target: '/x', access: 'ro' }],
            humanConfirmed: true,
          }),
        ),
        'protected path',
      );
    },
  );
  it('home directory and ~/.ssh stay forbidden for humans', () => {
    expectDeny(
      evaluateCreate(
        mkReq(env, ctx(), {
          workspace: { mode: 'copy', hostPath: env.home },
          humanConfirmed: true,
        }),
      ),
      'home directory',
    );
    expectDeny(
      evaluateCreate(
        mkReq(env, ctx(), {
          mounts: [{ hostPath: join(env.home, '.SSH'), target: '/x', access: 'ro' }],
        }),
      ),
      'protected path ~/.ssh',
    );
  });
  it('shared hosts and env secrets still need a confirmation', () => {
    const r = evaluateCreate(
      mkReq(env, ctx(), {
        host: { id: 'hs', zone: 'shared' },
        providerIsolation: 'hardened',
        secrets: [{ ref: 'tok', inject: 'env' }],
      }),
    );
    expect(approvalKinds(r).sort()).toEqual(['host_zone', 'secret_env']);
  });
  it('human sandbox-count limit still applies', () => {
    expectDeny(
      evaluateCreate(mkReq(env, ctx(), { currentSandboxCount: 50 })),
      'already has 50 sandbox',
    );
  });
});

describe('deny beats approval', () => {
  it.each(MODES)(
    '(%s) a request with approval items and a deny is denied without approval info',
    (approval) => {
      const r = run(
        { approval },
        {
          template: { name: 'nope', isolation: 'container', hash: 'h', contentHash: 'c' },
          templateTrusted: false,
          host: { id: 'local', zone: 'shared' },
          providerIsolation: 'hardened',
          secrets: [{ ref: 'github-token', inject: 'env' }],
        },
      );
      expect(r.decision).toBe('deny');
      expect(r).not.toHaveProperty('kinds');
      expect(r).not.toHaveProperty('items');
    },
  );
  it('collects all deny reasons at once', () => {
    const r = run(
      {},
      {
        template: { name: 'nope', isolation: 'container', hash: 'h', contentHash: 'c' },
        resources: { cpus: 99, memoryBytes: 64 * GIB },
        currentSandboxCount: 5,
      },
    );
    if (r.decision !== 'deny') throw new Error('expected deny');
    expect(r.reasons.length).toBeGreaterThanOrEqual(4);
  });
});

describe('request digest', () => {
  const m1 = { hostPath: env?.datasets ?? '', target: '/a', access: 'ro' as const };
  const hash = (r: CreateEvaluation): string => hashRequestDigest(r.requestDigest);

  it('is stable and independent of order, counts and the confirmation flag', () => {
    const mounts = [
      { hostPath: env.datasets, target: '/b', access: 'ro' as const },
      { hostPath: env.projects, target: '/a', access: 'ro' as const },
    ];
    const a = run(
      {},
      { mounts, network: { mode: 'allowlist', allow: ['pypi.org', 'a.cdn.example.org'] } },
    );
    const b = run(
      {},
      {
        mounts: [...mounts].reverse(),
        network: { mode: 'allowlist', allow: ['A.cdn.example.org', 'pypi.org.'] },
        currentSandboxCount: 2,
        humanConfirmed: true,
      },
    );
    expect(hash(a)).toBe(hash(b));
    expect(hash(a)).toMatch(/^[0-9a-f]{64}$/);
  });
  it.each<[string, Partial<CreateRequest>]>([
    [
      'template hash',
      {
        template: {
          name: 'node-dev',
          isolation: 'container',
          hash: 'other',
          contentHash: 'content-1',
        },
      },
    ],
    [
      'template content hash',
      {
        template: {
          name: 'node-dev',
          isolation: 'container',
          hash: 'hash-1',
          contentHash: 'other',
        },
      },
    ],
    ['workspace path', { workspace: { mode: 'worktree', hostPath: env?.projects ?? '' } }],
    ['workspace mode', { workspace: { mode: 'copy', hostPath: env?.app ?? '' } }],
    ['network', { network: { mode: 'allowlist', allow: ['pypi.org'] } }],
    ['mounts', { mounts: [m1] }],
    ['secrets', { secrets: [{ ref: 'github-token', inject: 'proxy' }] }],
    ['ttl', { ttlMs: 2 * HOUR }],
    ['resources', { resources: { cpus: 3, memoryBytes: 4 * GIB } }],
    ['host', { host: { id: 'local', zone: 'lab' } }],
    ['isolation', { providerIsolation: 'hardened' }],
  ])('changes when %s changes', (_n, over) => {
    expect(hash(run({}, over))).not.toBe(hash(run({})));
  });
  it('changes with the owner', () => {
    const a = evaluateCreate(mkReq(env, makeContext(env, {}, 'agent1')));
    const b = evaluateCreate(mkReq(env, makeContext(env, {}, 'agent2')));
    expect(hash(a)).not.toBe(hash(b));
  });
});

describe('evaluateExec', () => {
  const mine: SandboxRef = { id: 'local/ab12', owner: 'agent:agent1' };
  const theirs: SandboxRef = { id: 'local/cd34', owner: 'agent:agent2' };

  it('allows exec in an own sandbox in medium and open mode', () => {
    for (const approval of ['medium', 'open'])
      expect(evaluateExec(makeContext(env, { approval }), mine).decision).toBe('allow');
  });
  it("denies exec in another context's sandbox in every mode", () => {
    for (const approval of MODES) {
      const r = evaluateExec(makeContext(env, { approval }), theirs);
      expect(r.decision).toBe('deny');
      if (r.decision === 'deny') expect(r.reasons[0]).toContain('belongs to agent:agent2');
    }
  });
  it('a human may exec in any sandbox', () => {
    expect(evaluateExec(humanContext(env), theirs).decision).toBe('allow');
  });
  it('strict mode asks for every command', () => {
    const r = evaluateExec(makeContext(env, { approval: 'strict' }), mine, { command: 'npm test' });
    expect(r.decision).toBe('approval');
    expect(r.requestDigest).toMatchObject({
      kind: 'exec',
      sandbox: 'local/ab12',
      command: 'npm test',
    });
  });
  it('exec.approval: true asks even in open mode', () => {
    const r = evaluateExec(makeContext(env, { approval: 'open', exec: { approval: true } }), mine);
    expect(r.decision).toBe('approval');
    if (r.decision === 'approval') expect(r.reasons[0]).toContain('exec.approval');
  });
  it('digest binds the command', () => {
    const ctx = makeContext(env, { approval: 'strict' });
    expect(hashRequestDigest(evaluateExec(ctx, mine, { command: 'a' }).requestDigest)).not.toBe(
      hashRequestDigest(evaluateExec(ctx, mine, { command: 'b' }).requestDigest),
    );
  });
  it('a human can confirm strict-mode exec; an agent cannot', () => {
    // the built-in human context is open mode, so force strict on a human-kind context
    const agentStrict = makeContext(env, { approval: 'strict' });
    expect(evaluateExec(agentStrict, mine, { humanConfirmed: true }).decision).toBe('approval');
    const ctx = {
      ...humanContext(env),
      profile: { ...humanContext(env).profile, approval: 'strict' as const },
    };
    expect(evaluateExec(ctx, mine).decision).toBe('approval');
    expect(evaluateExec(ctx, mine, { humanConfirmed: true }).decision).toBe('allow');
  });
});

describe('evaluateAccessRequest', () => {
  const sbx = (o: Partial<SandboxRef> = {}): SandboxRef => ({
    id: 'local/ab12',
    owner: 'agent:agent1',
    isolation: 'container',
    network: { mode: 'allowlist', allow: ['pypi.org'] },
    host: { id: 'local', zone: 'workstation' },
    ...o,
  });
  const acc = (
    overrides: Record<string, unknown>,
    request: AccessRequestSpec,
    sandbox: SandboxRef = sbx(),
  ) => evaluateAccessRequest(makeContext(env, overrides), sandbox, request);

  it('denies requests on foreign sandboxes in every mode', () => {
    for (const approval of MODES) {
      expect(
        acc({ approval }, { kind: 'ttl', details: { ttlMs: HOUR } }, sbx({ owner: 'agent:other' }))
          .decision,
      ).toBe('deny');
    }
  });

  describe('network', () => {
    it('destinations within the profile: allow in medium/open, approval in strict', () => {
      const req: AccessRequestSpec = {
        kind: 'network',
        details: { domains: ['registry.npmjs.org', 'a.cdn.example.org'] },
      };
      expect(acc({ approval: 'medium' }, req).decision).toBe('allow');
      expect(acc({ approval: 'open' }, req).decision).toBe('allow');
      expect(acc({ approval: 'strict' }, req).decision).toBe('approval');
    });
    it('destinations beyond the profile never auto-allow (also in open)', () => {
      for (const approval of MODES) {
        const r = acc(
          { approval },
          { kind: 'network', details: { domains: ['evil.example.com'] } },
        );
        expect(r.decision, approval).toBe('approval');
        if (r.decision === 'approval') {
          expect(r.kinds).toContain('network_domains');
          expect(r.reasons.join(' ')).toContain('evil.example.com');
        }
      }
    });
    it('denies destinations when the profile has no allowlist, and invalid ones', () => {
      expect(
        acc(
          { network: { allow_presets: [], allow: [] } },
          { kind: 'network', details: { domains: ['pypi.org'] } },
        ).decision,
      ).toBe('deny');
      expect(acc({}, { kind: 'network', details: { domains: ['http://x.org'] } }).decision).toBe(
        'deny',
      );
    });
    it('switching from none to allowlist is derived from the domains', () => {
      const r = acc(
        {},
        { kind: 'network', details: { domains: ['pypi.org'] } },
        sbx({ network: { mode: 'none', allow: [] } }),
      );
      expect(r.decision).toBe('allow');
    });
    it('denies modes the profile does not list', () => {
      const r = acc({}, { kind: 'network', details: { mode: 'open' } });
      expect(r.decision).toBe('deny');
    });
    it('open mode needs the profile right, vm isolation and (outside open mode) approval', () => {
      const o = { network: { modes: ['none', 'allowlist', 'open'] } };
      expect(
        acc(o, { kind: 'network', details: { mode: 'open' } }, sbx({ isolation: 'container' }))
          .decision,
      ).toBe('deny');
      expect(
        acc(o, { kind: 'network', details: { mode: 'open' } }, sbx({ isolation: undefined }))
          .decision,
      ).toBe('deny');
      expect(
        acc(
          { ...o, approval: 'medium' },
          { kind: 'network', details: { mode: 'open' } },
          sbx({ isolation: 'vm' }),
        ).decision,
      ).toBe('approval');
      expect(
        acc(
          { ...o, approval: 'open' },
          { kind: 'network', details: { mode: 'open' } },
          sbx({ isolation: 'vm' }),
        ).decision,
      ).toBe('allow');
    });
    it('private address exceptions always need approval', () => {
      for (const approval of MODES) {
        const r = acc(
          { approval },
          {
            kind: 'network',
            details: { domains: ['pypi.org'], privateExceptions: ['192.168.1.20'] },
          },
        );
        expect(r.decision).toBe('approval');
        if (r.decision === 'approval') expect(r.kinds).toContain('private_address');
      }
    });
    it('domains without allowlist mode are denied', () => {
      const r = acc({}, { kind: 'network', details: { mode: 'none', domains: ['pypi.org'] } });
      expect(r.decision).toBe('deny');
    });
  });

  describe('mount', () => {
    const details = (o: Record<string, unknown> = {}) => ({
      hostPath: env.datasets,
      target: '/data',
      access: 'ro' as const,
      paths: { home: env.home },
      ...o,
    });
    it('is an elevated item: approval in strict/medium, allow in open', () => {
      expect(acc({ approval: 'strict' }, { kind: 'mount', details: details() }).decision).toBe(
        'approval',
      );
      expect(acc({ approval: 'medium' }, { kind: 'mount', details: details() }).decision).toBe(
        'approval',
      );
      expect(acc({ approval: 'open' }, { kind: 'mount', details: details() }).decision).toBe(
        'allow',
      );
    });
    it('denies mounts: deny, forbidden and out-of-root paths and rw', () => {
      expect(acc({ mounts: 'deny' }, { kind: 'mount', details: details() }).decision).toBe('deny');
      expect(
        acc(
          { mounts: { roots: ['~'] } },
          { kind: 'mount', details: details({ hostPath: env.sshDir }) },
        ).decision,
      ).toBe('deny');
      expect(
        acc(
          {},
          { kind: 'mount', details: details({ hostPath: env.app.replace('/projects/app', '') }) },
        ).decision,
      ).toBe('deny');
      expect(
        acc({ approval: 'open' }, { kind: 'mount', details: details({ access: 'rw' }) }).decision,
      ).toBe('deny');
    });
    it('needs the profile isolation level', () => {
      expect(
        acc(
          { isolation: { mounts: 'vm' }, approval: 'open' },
          { kind: 'mount', details: details() },
        ).decision,
      ).toBe('deny');
    });
  });

  describe('resources', () => {
    it('within limits: allow in medium/open, approval in strict', () => {
      const req: AccessRequestSpec = {
        kind: 'resources',
        details: { cpus: 4, memoryBytes: 8 * GIB },
      };
      expect(acc({ approval: 'medium' }, req).decision).toBe('allow');
      expect(acc({ approval: 'open' }, req).decision).toBe('allow');
      expect(acc({ approval: 'strict' }, req).decision).toBe('approval');
    });
    it('beyond the profile or host limits: deny, with numbers, in every mode', () => {
      for (const approval of MODES) {
        const r = acc({ approval }, { kind: 'resources', details: { cpus: 8 } });
        expect(r.decision).toBe('deny');
        if (r.decision === 'deny')
          expect(r.reasons[0]).toContain('requested cpus 8 exceeds the limit of 4');
      }
      const m = acc({}, { kind: 'resources', details: { memoryBytes: 16 * GIB } });
      if (m.decision !== 'deny') throw new Error('expected deny');
      expect(m.reasons[0]).toContain('requested memory 16g exceeds the limit of 8g');
      const h = acc(
        {},
        { kind: 'resources', details: { cpus: 3 } },
        sbx({ host: { id: 'local', zone: 'workstation', limits: { cpus: 2 } } }),
      );
      if (h.decision !== 'deny') throw new Error('expected deny');
      expect(h.reasons.join(' ')).toContain('limit of 2 on host "local"');
    });
    it('denies empty and invalid requests', () => {
      expect(acc({}, { kind: 'resources', details: {} }).decision).toBe('deny');
      expect(acc({}, { kind: 'resources', details: { cpus: -1 } }).decision).toBe('deny');
    });
  });

  describe('ttl', () => {
    it('within limit: allow in medium/open, approval in strict', () => {
      expect(
        acc({ approval: 'medium' }, { kind: 'ttl', details: { ttlMs: 3 * HOUR } }).decision,
      ).toBe('allow');
      expect(
        acc({ approval: 'open' }, { kind: 'ttl', details: { ttlMs: 4 * HOUR } }).decision,
      ).toBe('allow');
      expect(acc({ approval: 'strict' }, { kind: 'ttl', details: { ttlMs: HOUR } }).decision).toBe(
        'approval',
      );
    });
    it('beyond the profile ttl: deny', () => {
      for (const approval of MODES) {
        const r = acc({ approval }, { kind: 'ttl', details: { ttlMs: 5 * HOUR } });
        expect(r.decision).toBe('deny');
        if (r.decision === 'deny')
          expect(r.reasons[0]).toContain('requested ttl 5h exceeds the limit of 4h');
      }
      expect(acc({}, { kind: 'ttl', details: { ttlMs: 0 } }).decision).toBe('deny');
    });
  });

  it('rejects unknown request kinds', () => {
    expect(
      acc({}, { kind: 'root-shell', details: {} } as unknown as AccessRequestSpec).decision,
    ).toBe('deny');
  });
  it('digest binds sandbox and request (order-insensitive for lists)', () => {
    const a = acc(
      {},
      { kind: 'network', details: { domains: ['b.example.org', 'a.example.org'] } },
    );
    const b = acc(
      {},
      { kind: 'network', details: { domains: ['a.example.org', 'b.example.org'] } },
    );
    const c = acc({}, { kind: 'network', details: { domains: ['a.example.org'] } });
    const d = acc(
      {},
      { kind: 'network', details: { domains: ['a.example.org'] } },
      sbx({ id: 'local/zz99' }),
    );
    expect(hashRequestDigest(a.requestDigest)).toBe(hashRequestDigest(b.requestDigest));
    expect(hashRequestDigest(a.requestDigest)).not.toBe(hashRequestDigest(c.requestDigest));
    expect(hashRequestDigest(c.requestDigest)).not.toBe(hashRequestDigest(d.requestDigest));
  });
});
