import { describe, expect, it } from 'vitest';
import { AboxError } from '../errors.js';
import type {
  ProviderCapabilities,
  ResolvedTemplate,
  TemplateSourceKind,
  TemplateSpec,
} from '../types.js';
import { parseTemplateYaml } from './parse.js';
import {
  detectOsFamily,
  mergeTemplateSpecs,
  resolveTemplate,
  type TemplateLookup,
} from './resolve.js';
import { assertTemplateValid, validateTemplate } from './validate.js';

function spec(
  extra: string,
  name = 'demo',
  backend = 'docker',
  base = 'base:\n  os: ubuntu:24.04\n',
): string {
  return `apiVersion: 1\nname: ${name}\nbackend: ${backend}\n${base}${extra}`;
}

async function resolve(
  text: string,
  lookup?: TemplateLookup,
  kind: TemplateSourceKind = 'user',
): Promise<ResolvedTemplate> {
  return resolveTemplate(parseTemplateYaml(text), {
    source: { kind, path: `/x/${kind}.yaml` },
    contentText: text,
    lookup,
  });
}

function mapLookup(files: Record<string, string>): TemplateLookup {
  return (name) => {
    const text = files[name];
    return text
      ? { spec: parseTemplateYaml(text), source: { kind: 'user', path: `/x/${name}.yaml` } }
      : undefined;
  };
}

async function rejects(p: Promise<unknown>): Promise<AboxError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AboxError);
    expect((e as AboxError).code).toBe('template_invalid');
    return e as AboxError;
  }
  throw new Error('expected rejection');
}

describe('workspace.gitignore', () => {
  it('is carried into the resolved template, inherited and overridden like the other workspace keys', async () => {
    const off = await resolve(spec('workspace: { gitignore: false }\n'));
    expect(off.workspace).toEqual({
      mode: 'copy',
      path: '/workspace',
      access: 'rw',
      gitignore: false,
    });
    const lookup = mapLookup({
      parent: spec('workspace: { gitignore: false, mode: copy }\n', 'parent'),
    });
    const inherited = await resolve(spec('extends: parent\n', 'child'), lookup);
    expect(inherited.workspace.gitignore).toBe(false);
    const overridden = await resolve(
      spec('extends: parent\nworkspace: { gitignore: true }\n', 'child'),
      lookup,
    );
    expect(overridden.workspace.gitignore).toBe(true);
  });

  it('must be true or false', async () => {
    await rejects(resolve(spec('workspace: { gitignore: "yes" }\n')));
  });
});

describe('restrictive defaults', () => {
  it('network none, non-root, no sudo, ttl set, copy workspace', async () => {
    const t = await resolve(spec(''));
    expect(t.network).toEqual({ mode: 'none', allow: [] });
    expect(t.user).toEqual({ name: 'agent', uid: 1000, sudo: false });
    expect(t.user.uid).not.toBe(0);
    expect(t.resources.ttlMs).toBe(2 * 3_600_000);
    expect(t.resources.memoryBytes).toBe(2 * 1024 ** 3);
    expect(t.resources.cpus).toBe(2);
    expect(t.resources.pids).toBe(512);
    expect(t.resources.diskBytes).toBeUndefined();
    expect(t.workspace).toEqual({ mode: 'copy', path: '/workspace', access: 'rw' });
    // unset stays unset: the default "on" lives in the manager
    expect(t.workspace).not.toHaveProperty('gitignore');
    expect(t.mounts).toEqual([]);
    expect(t.secrets).toEqual([]);
    expect(t.isolation).toBe('container');
    expect(t.description).toBe('');
  });

  it('extra mounts default to read-only; secrets default to proxy injection', async () => {
    const t = await resolve(
      spec(
        'mounts:\n  - { source: /data/docs, target: /docs }\nnetwork:\n  mode: allowlist\n  allow: [github.com]\nsecrets:\n  - { ref: gh, hosts: [github.com] }\n',
      ),
    );
    expect(t.mounts[0]!.access).toBe('ro');
    expect(t.secrets[0]).toMatchObject({ inject: 'proxy', hosts: ['github.com'] });
  });

  it('default isolation follows the backend', async () => {
    expect((await resolve(spec('', 'a', 'podman'))).isolation).toBe('container');
    expect((await resolve(spec('', 'a', 'process', ''))).isolation).toBe('none');
    expect((await resolve(spec('vm:\n  image: ubuntu-24.04\n', 'a', 'vm', ''))).isolation).toBe(
      'vm',
    );
    expect((await resolve(spec('python:\n  version: "3.13"\n', 'a', 'python', ''))).isolation).toBe(
      'container',
    );
    expect((await resolve(spec('isolation: hardened\n'))).isolation).toBe('hardened');
  });

  it('allow entries without allowlist mode are rejected, not ignored', async () => {
    const e = await rejects(resolve(spec('network:\n  allow: [example.org]\n')));
    expect(e.issues[0]!.path).toBe('network.mode');
  });

  it('presets expand into a sorted union with explicit entries', async () => {
    const t = await resolve(
      spec('network:\n  mode: allowlist\n  presets: [npm]\n  allow: [Example.ORG]\n'),
    );
    expect(t.network.allow).toEqual(['example.org', 'registry.npmjs.org', 'registry.yarnpkg.com']);
  });

  it('proxy secrets need hosts, file secrets need a path', async () => {
    expect((await rejects(resolve(spec('secrets:\n  - ref: a\n')))).issues[0]!.path).toBe(
      'secrets[0].hosts',
    );
    expect(
      (await rejects(resolve(spec('secrets:\n  - { ref: a, inject: file }\n')))).issues[0]!.path,
    ).toBe('secrets[0].path');
  });

  it('duplicate mount targets are rejected', async () => {
    const e = await rejects(
      resolve(spec('mounts:\n  - { source: /a, target: /m }\n  - { source: /b, target: /m }\n')),
    );
    expect(e.issues[0]!.path).toBe('mounts[1].target');
  });
});

describe('backend/base consistency', () => {
  it('container backends need a base', async () => {
    const e = await rejects(resolve(spec('', 'a', 'docker', '')));
    expect(e.issues[0]!.path).toBe('base');
  });
  it('os and dockerfile are alternatives', async () => {
    await rejects(
      resolve(spec('', 'a', 'docker', 'base:\n  os: alpine:3.22\n  dockerfile: ./Dockerfile\n')),
    );
  });
  it('the process backend cannot build anything', async () => {
    await rejects(resolve(spec('tools: [git]\n', 'a', 'process', '')));
    await rejects(resolve(spec('setup:\n  - run: echo hi\n', 'a', 'process', '')));
    await rejects(resolve(spec('', 'a', 'process')));
  });
  it('python/vm sections only fit their backend', async () => {
    await rejects(resolve(spec('python:\n  version: "3.13"\n')));
    await rejects(resolve(spec('vm:\n  image: x\n')));
    await rejects(resolve(spec('', 'a', 'python', '')));
  });
  it('the python backend derives the version from the base image', async () => {
    const t = await resolve(spec('', 'a', 'python', 'base:\n  os: python:3.13-slim-bookworm\n'));
    expect(t.python).toEqual({ version: '3.13' });
  });
});

describe('detectOsFamily', () => {
  it.each([
    ['ubuntu:24.04', 'debian'],
    ['debian:12-slim', 'debian'],
    ['docker.io/library/ubuntu:24.04', 'debian'],
    ['python:3.13-slim-bookworm', 'debian'],
    ['python:3.13', 'debian'],
    ['python:3.13-alpine', 'alpine'],
    ['node:24', 'debian'],
    ['node:24-bookworm-slim', 'debian'],
    ['node:24-alpine', 'alpine'],
    ['node:24-alpine3.22', 'alpine'],
    ['alpine:3.22', 'alpine'],
    ['alpine', 'alpine'],
    ['fedora:42', 'fedora'],
    ['archlinux:latest', 'arch'],
    ['archlinux', 'arch'],
    ['ubuntu-24.04', 'debian'],
    ['cgr.dev/chainguard/wolfi-base', 'unknown'],
    ['busybox', 'unknown'],
    ['ubuntu@sha256:abcdef', 'debian'],
    [undefined, 'unknown'],
  ])('%s -> %s', (os, fam) => {
    expect(detectOsFamily(os)).toBe(fam);
  });
});

describe('build steps', () => {
  it('renders apt with noninteractive, no-install-recommends and cleanup', async () => {
    const t = await resolve(spec('packages:\n  apt: [git, curl]\n'));
    expect(t.build).toHaveLength(1);
    expect(t.build[0]!.name).toBe('apt: git curl');
    expect(t.build[0]!.script).toContain('DEBIAN_FRONTEND=noninteractive');
    expect(t.build[0]!.script).toContain("apt-get install -y --no-install-recommends 'git' 'curl'");
    expect(t.build[0]!.script).toContain('rm -rf /var/lib/apt/lists/*');
  });

  it('renders apk, dnf, pacman, pip, npm', async () => {
    const apk = await resolve(
      spec('packages:\n  apk: [git]\n', 'a', 'docker', 'base:\n  os: alpine:3.22\n'),
    );
    expect(apk.build[0]!.script).toContain("apk add --no-cache 'git'");
    const dnf = await resolve(
      spec('packages:\n  dnf: [git]\n', 'a', 'docker', 'base:\n  os: fedora:42\n'),
    );
    expect(dnf.build[0]!.script).toContain('dnf install -y');
    const pac = await resolve(
      spec('packages:\n  pacman: [git]\n', 'a', 'docker', 'base:\n  os: archlinux\n'),
    );
    expect(pac.build[0]!.script).toContain('pacman -Sy --noconfirm');
    const pip = await resolve(
      spec('packages:\n  pip: ["requests==2.32.3"]\n  npm: ["@types/node"]\n'),
    );
    expect(pip.build.map((s) => s.name)).toEqual(['pip: requests==2.32.3', 'npm: @types/node']);
    expect(pip.build[0]!.script).toContain("install 'requests==2.32.3'");
    expect(pip.build[1]!.script).toContain("npm install -g --no-fund --no-audit '@types/node'");
  });

  it('orders OS packages, tools, language packages, setup', async () => {
    const t = await resolve(
      spec(
        'packages:\n  apt: [jq]\n  pip: [httpx]\ntools: [pnpm@10, node@24, git]\nsetup:\n  - run: echo one\n  - run: echo two\n',
      ),
    );
    expect(t.build.map((s) => s.name)).toEqual([
      'apt: jq',
      'tools: prerequisites (ca-certificates curl xz-utils)',
      'tool: node@24',
      'tool: git',
      'tool: pnpm@10',
      'pip: httpx',
      'setup #1',
      'setup #2',
    ]);
    expect(t.build.at(-1)!.script).toBe('set -eu\necho two\n');
    expect(t.tools.map((x) => x.name)).toEqual(['pnpm', 'node', 'git']);
    expect(t.tools[1]).toEqual({ name: 'node', version: '24', check: 'node --version' });
  });

  it('a package manager that does not fit the base is a clear error', async () => {
    const e = await rejects(resolve(spec('packages:\n  apk: [git]\n')));
    expect(e.message).toContain('packages.apk needs a base of the alpine family');
    expect(e.message).toContain('"ubuntu:24.04" is debian');
  });

  it('OS packages on an unknown base are rejected', async () => {
    const e = await rejects(
      resolve(spec('packages:\n  apt: [git]\n', 'a', 'docker', 'base:\n  os: busybox\n')),
    );
    expect(e.message).toContain('cannot determine the OS family');
  });

  it('tools on unsupported or unknown OS families name preset and family', async () => {
    const fedora = await rejects(
      resolve(spec('tools: [node@24]\n', 'a', 'docker', 'base:\n  os: fedora:42\n')),
    );
    expect(fedora.message).toContain('"node"');
    expect(fedora.message).toContain('"fedora"');
    expect(fedora.issues[0]!.path).toBe('tools[0]');
    const unknown = await rejects(
      resolve(spec('tools: [git]\n', 'a', 'docker', 'base:\n  os: busybox\n')),
    );
    expect(unknown.message).toContain('"unknown"');
    const alpinePw = await rejects(
      resolve(spec('tools: [playwright]\n', 'a', 'docker', 'base:\n  os: alpine:3.22\n')),
    );
    expect(alpinePw.message).toContain('"playwright"');
    expect(alpinePw.message).toContain('"alpine"');
  });

  it('setup commands are kept verbatim; packages cannot inject shell', async () => {
    const t = await resolve(spec("setup:\n  - run: |\n      echo 'a b'\n      ls | wc -l\n"));
    expect(t.build[0]!.script).toBe("set -eu\necho 'a b'\nls | wc -l\n");
    // Programmatic specs bypass the YAML parser but not the safety checks.
    const evil = {
      ...parseTemplateYaml(spec('')),
      packages: { apt: ['git; rm -rf /'] },
    } as TemplateSpec;
    await rejects(resolveTemplate(evil, { source: { kind: 'user' }, contentText: '' }));
  });

  it('duplicate tool presets are rejected', async () => {
    await rejects(resolve(spec('tools: [node@22, node@24]\n')));
  });

  it('preset env is merged below the template env', async () => {
    const t = await resolve(
      spec('tools: [python@3.13]\nenv:\n  UV_PYTHON_INSTALL_DIR: /custom\n  A: b\n'),
    );
    expect(t.env).toEqual({ UV_PYTHON_INSTALL_DIR: '/custom', A: 'b' });
    const t2 = await resolve(spec('tools: [python@3.13]\n'));
    expect(t2.env.UV_PYTHON_INSTALL_DIR).toBe('/opt/uv/python');
  });
});

describe('hashes', () => {
  it('is stable for identical input and independent of key order', async () => {
    const a = await resolve(spec('tools: [git]\nsetup:\n  - run: echo 1\n'));
    const b = await resolve(spec('tools: [git]\nsetup:\n  - run: echo 1\n'));
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.hash).toBe(b.hash);
    expect(a.contentHash).toBe(b.contentHash);
  });

  it('changes with setup, base, user and backend', async () => {
    const base = await resolve(spec('setup:\n  - run: echo 1\n'));
    expect((await resolve(spec('setup:\n  - run: echo 2\n'))).hash).not.toBe(base.hash);
    expect(
      (
        await resolve(
          spec('setup:\n  - run: echo 1\n', 'demo', 'docker', 'base:\n  os: ubuntu:22.04\n'),
        )
      ).hash,
    ).not.toBe(base.hash);
    expect((await resolve(spec('setup:\n  - run: echo 1\nuser: { uid: 1001 }\n'))).hash).not.toBe(
      base.hash,
    );
    expect((await resolve(spec('setup:\n  - run: echo 1\n', 'demo', 'podman'))).hash).not.toBe(
      base.hash,
    );
  });

  it('ignores runtime-only fields (network, resources, name, description)', async () => {
    const a = await resolve(spec(''));
    const b = await resolve(
      spec(
        'resources: { memory: 8g }\nnetwork: { mode: open }\ndescription: something else entirely\n',
        'other',
      ),
    );
    expect(b.hash).toBe(a.hash);
    expect(b.contentHash).not.toBe(a.contentHash);
  });
});

describe('extends', () => {
  const parent = spec(
    'description: parent\npackages:\n  apt: [git]\ntools: [node@22, git]\nsetup:\n  - run: echo parent\nenv: { A: "1", B: "2" }\nlabels: { use-for: parent }\n' +
      'network:\n  mode: allowlist\n  allow: [a.example.org]\n  presets: [npm]\nresources: { cpus: 4, memory: 4g }\nmounts:\n  - { source: /p, target: /m }\n',
    'parent',
  );

  it('appends lists, overrides scalars, merges env/labels, unions network', async () => {
    const child = spec(
      'extends: parent\npackages:\n  apt: [curl, git]\ntools: [node@24, gh]\nsetup:\n  - run: echo child\nenv: { B: "3", C: "4" }\nlabels: { team: x }\n' +
        'network:\n  allow: [b.example.org]\n  presets: [github]\nresources: { memory: 8g }\nmounts:\n  - { source: /c, target: /m, access: rw }\n  - { source: /d, target: /n }\n',
      'child',
      'docker',
      '',
    );
    const t = await resolve(child, mapLookup({ parent }));
    expect(t.name).toBe('child');
    expect(t.description).toBe('parent');
    expect(t.base.os).toBe('ubuntu:24.04');
    expect(t.build.find((s) => s.name.startsWith('apt'))!.name).toBe('apt: git curl');
    expect(t.tools.map((x) => `${x.name}@${x.version ?? ''}`)).toEqual(['git@', 'node@24', 'gh@']);
    expect(t.build.filter((s) => s.name.startsWith('setup')).map((s) => s.script)).toEqual([
      'set -eu\necho parent\n',
      'set -eu\necho child\n',
    ]);
    expect(t.env).toEqual({ A: '1', B: '3', C: '4' });
    expect(t.labels).toEqual({ 'use-for': 'parent', team: 'x' });
    expect(t.network.mode).toBe('allowlist');
    expect(t.network.allow).toEqual(
      expect.arrayContaining([
        'a.example.org',
        'b.example.org',
        'registry.npmjs.org',
        'github.com',
      ]),
    );
    expect(t.resources.cpus).toBe(4);
    expect(t.resources.memoryBytes).toBe(8 * 1024 ** 3);
    expect(t.mounts).toEqual([
      { source: '/c', target: '/m', access: 'rw' },
      { source: '/d', target: '/n', access: 'ro' },
    ]);
  });

  it('child network.mode overrides and drops inherited allow entries', async () => {
    const child = spec('extends: parent\nnetwork:\n  mode: none\n', 'child', 'docker', '');
    const t = await resolve(child, mapLookup({ parent }));
    expect(t.network).toEqual({ mode: 'none', allow: [] });
    const open = await resolve(
      spec('extends: parent\nnetwork:\n  mode: open\n', 'child', 'docker', ''),
      mapLookup({ parent }),
    );
    expect(open.network.mode).toBe('open');
  });

  it('a child base replaces the parent base as a whole', async () => {
    const t = await resolve(
      spec('extends: parent\n', 'child', 'docker', 'base:\n  os: alpine:3.22\n'),
      mapLookup({ parent: spec('', 'parent') }),
    );
    expect(t.base).toEqual({ os: 'alpine:3.22', osFamily: 'alpine' });
  });

  it('merged specs from mergeTemplateSpecs have no extends', () => {
    const p = parseTemplateYaml(spec('', 'p'));
    const c = parseTemplateYaml(spec('extends: p\n', 'c'));
    expect(mergeTemplateSpecs(p, c).extends).toBeUndefined();
  });

  it('supports chains up to depth 5 and rejects deeper ones', async () => {
    const files: Record<string, string> = { t0: spec('', 't0') };
    for (let i = 1; i <= 6; i++)
      files[`t${i}`] = spec(`extends: t${i - 1}\n`, `t${i}`, 'docker', '');
    const ok = await resolve(files.t5!, mapLookup(files));
    expect(ok.name).toBe('t5');
    const e = await rejects(resolve(files.t6!, mapLookup(files)));
    expect(e.message).toContain('deeper than 5');
  });

  it('detects cycles', async () => {
    const files = {
      a: spec('extends: b\n', 'a', 'docker', ''),
      b: spec('extends: c\n', 'b', 'docker', ''),
      c: spec('extends: a\n', 'c', 'docker', ''),
    };
    const e = await rejects(resolve(files.a, mapLookup(files)));
    expect(e.message).toContain('cycle');
    expect(e.message).toContain('a -> b -> c -> a');
  });

  it('unknown parents and missing lookups', async () => {
    expect(
      (await rejects(resolve(spec('extends: nope\n', 'c', 'docker', ''), mapLookup({})))).message,
    ).toContain('unknown template "nope"');
    await rejects(resolve(spec('extends: nope\n', 'c', 'docker', '')));
  });

  it('passes the child identity to the lookup', async () => {
    const calls: unknown[] = [];
    await resolve(
      spec('extends: p\n', 'c', 'docker', ''),
      (name, from) => {
        calls.push([name, from]);
        return {
          spec: parseTemplateYaml(spec('', 'p')),
          source: { kind: 'builtin', path: '/b/p.yaml' },
        };
      },
      'project',
    );
    expect(calls).toEqual([['p', { kind: 'project', name: 'c', path: '/x/project.yaml' }]]);
  });
});

describe('validateTemplate', () => {
  const caps: ProviderCapabilities = {
    isolation: 'container',
    networkModes: ['none', 'allowlist'],
    networkFilter: true,
    workspaceDelivery: ['bind', 'copy', 'none'],
    mounts: true,
    snapshots: false,
    tty: true,
    limits: { cpus: true, memory: true, pids: true, disk: false },
    nonRootUser: true,
    secretInjection: ['proxy', 'env'],
    osFamilies: ['debian', 'alpine'],
    remote: false,
  };
  const good =
    'description: A sufficiently long description for agents\nlabels: { use-for: tests }\n';
  const check = async (extra: string, c?: ProviderCapabilities, base?: string) =>
    validateTemplate(await resolve(spec(good + extra, 'demo', 'docker', base)), {
      capabilities: c,
    });

  it('accepts a clean template', async () => {
    const r = await check('', caps);
    expect(r).toEqual({ ok: true, issues: [], warnings: [] });
  });

  it('rejects root users', async () => {
    expect((await check('user: { uid: 0 }\n')).issues[0]).toMatchObject({
      path: 'user',
      kind: 'invalid',
    });
    expect((await check('user: { name: root }\n')).ok).toBe(false);
  });

  it('warns about sudo and open networks', async () => {
    const r = await check('user: { sudo: true }\nnetwork: { mode: open }\n');
    expect(r.ok).toBe(true);
    expect(r.warnings.join('\n')).toContain('sudo');
    expect(r.warnings.join('\n')).toContain('"open"');
  });

  it.each([
    '/var/run/docker.sock',
    '/run/podman/podman.sock',
    '/home/me/some.sock',
    '/proc',
    '/proc/1/root',
    '/sys',
    '/dev',
    '/dev/shm',
    '/',
    '/etc',
    '/etc/ssh',
    '/var',
    '/var/run',
    '/run',
    '/run/user/1000',
    '~',
    '~/',
    '~/.ssh',
    '~/.ssh/id_ed25519',
    '~/.aws',
    '~/.config',
    '~/.config/abox',
    '/home/someone/.ssh',
    '/data/x/.gnupg/keys',
    '/data/..',
    '/data/../etc',
    '~/projects/../../etc',
    '/root',
  ])('rejects mount source %s', async (source) => {
    const r = await check(`mounts:\n  - { source: "${source}", target: /m }\n`);
    expect(r.ok, source).toBe(false);
    expect(r.issues[0]!.path).toBe('mounts[0].source');
  });

  it.each(['/data/refs', '~/refs/docs', '/home/me/projects/x', '~/.config/myapp', '/opt/data'])(
    'allows mount source %s',
    async (source) => {
      expect((await check(`mounts:\n  - { source: "${source}", target: /m }\n`)).ok, source).toBe(
        true,
      );
    },
  );

  it.each([
    '/etc',
    '/proc/x',
    '/dev',
    '/sys/fs',
    '/usr/local/bin',
    '/var/run',
    '/bin',
    '/workspace',
  ])('rejects mount target %s', async (target) => {
    const r = await check(`mounts:\n  - { source: /data/x, target: "${target}" }\n`);
    expect(r.ok, target).toBe(false);
    expect(r.issues[0]!.path).toBe('mounts[0].target');
  });

  it('rejects secret-looking env keys and values', async () => {
    for (const key of [
      'GITHUB_TOKEN',
      'my_secret',
      'DB_PASSWORD',
      'API_KEY',
      'AWS_SECRET_ACCESS_KEY',
    ]) {
      const r = await check(`env:\n  ${key}: x\n`);
      expect(r.issues[0]!.message, key).toContain('secrets:');
    }
    expect((await check('env:\n  HARMLESS: ghp_abcdefghijklmnopqrstuvwxyz0123456789\n')).ok).toBe(
      false,
    );
    expect(
      (await check('env:\n  NODE_ENV: development\n  ABOX_X: y\n')).issues[0]!.message,
    ).toContain('reserved');
    expect((await check('env:\n  NODE_ENV: development\n')).ok).toBe(true);
  });

  it('flags short descriptions (warning, or issue when strict)', async () => {
    const t = await resolve(spec('description: short\n'));
    expect(validateTemplate(t).warnings.some((w) => w.includes('description'))).toBe(true);
    expect(validateTemplate(t).ok).toBe(true);
    const strict = validateTemplate(t, { strictDescription: true });
    expect(strict.ok).toBe(false);
    expect(strict.issues[0]!.path).toBe('description');
  });

  it('allowlist mode without entries is invalid', async () => {
    const r = await check('network: { mode: allowlist }\n', caps);
    expect(r.issues[0]!.path).toBe('network.allow');
  });

  it('proxy secret hosts must be exact host names, as sandbox_create requires', async () => {
    const r = await check(
      "network: { mode: allowlist, allow: ['*.github.com', 'api.example.org:8443'] }\nsecrets:\n  - { ref: gh, hosts: ['*.github.com', 'api.example.org:8443', github.com] }\n",
    );
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.path)).toEqual(['secrets[0].hosts[0]', 'secrets[0].hosts[1]']);
    expect(r.issues[0]!.message).toContain('invalid secret destination host');
    expect(r.issues[0]!.message).toContain('exact host names');
    // env / file secrets have no destination hosts
    expect(
      (await check('secrets:\n  - { ref: gh, inject: env, hosts: ["*.github.com"] }\n')).ok,
    ).toBe(true);
  });

  it('proxy secrets need an allowlist network', async () => {
    const r = await check('secrets:\n  - { ref: gh, hosts: [github.com] }\n');
    expect(r.issues[0]!.path).toBe('secrets[0].inject');
    const ok = await check(
      'network: { mode: allowlist, allow: ["*.github.com"] }\nsecrets:\n  - { ref: gh, hosts: [api.github.com] }\n',
    );
    expect(ok.ok).toBe(true);
    const uncovered = await check(
      'network: { mode: allowlist, allow: [example.org] }\nsecrets:\n  - { ref: gh, hosts: [github.com] }\n',
    );
    expect(uncovered.warnings.join('\n')).toContain('not covered');
    // like the egress proxy: `*.github.com` is subdomains only, the apex needs its own entry
    const apex = await check(
      'network: { mode: allowlist, allow: ["*.github.com"] }\nsecrets:\n  - { ref: gh, hosts: [github.com] }\n',
    );
    expect(apex.warnings.join('\n')).toContain('not covered');
    // a non-default port entry does not cover the default ports
    const port = await check(
      'network: { mode: allowlist, allow: ["github.com:8443"] }\nsecrets:\n  - { ref: gh, hosts: [github.com] }\n',
    );
    expect(port.warnings.join('\n')).toContain('not covered');
  });

  describe('capabilities', () => {
    it('isolation', async () => {
      const r = await check('isolation: vm\n', caps);
      expect(r.issues[0]).toMatchObject({ kind: 'unsupported', path: 'isolation' });
      expect(r.issues[0]!.message).toContain('"vm"');
      expect((await check('isolation: hardened\n', { ...caps, isolation: 'vm' })).ok).toBe(true);
    });
    it('network modes and filter', async () => {
      expect((await check('network: { mode: open }\n', caps)).issues[0]).toMatchObject({
        kind: 'unsupported',
        path: 'network.mode',
      });
      const noFilter = await check('network: { mode: allowlist, allow: [example.org] }\n', {
        ...caps,
        networkFilter: false,
      });
      expect(noFilter.issues[0]!.message).toContain('egress filter');
    });
    it('mounts, user, secrets, os family, disk, remote', async () => {
      expect(
        (await check('mounts:\n  - { source: /data/x, target: /m }\n', { ...caps, mounts: false }))
          .issues[0]!.path,
      ).toBe('mounts');
      expect((await check('', { ...caps, nonRootUser: false })).issues[0]!.path).toBe('user');
      const sec = await check(
        'network: { mode: allowlist, allow: [github.com] }\nsecrets:\n  - { ref: a, inject: file, path: /run/a }\n',
        caps,
      );
      expect(sec.issues[0]).toMatchObject({ kind: 'unsupported', path: 'secrets[0].inject' });
      expect((await check('', { ...caps, osFamilies: ['alpine'] })).issues[0]!.path).toBe(
        'base.os',
      );
      expect((await check('resources: { disk: 5g }\n', caps)).issues[0]!.path).toBe(
        'resources.disk',
      );
      expect(
        (await check('workspace: { mode: mount }\n', { ...caps, remote: true })).issues[0]!.path,
      ).toBe('workspace.mode');
    });
    it('warns about unenforced limits', async () => {
      const r = await check('', {
        ...caps,
        limits: { cpus: false, memory: true, pids: true, disk: true },
      });
      expect(r.ok).toBe(true);
      expect(r.warnings.join('\n')).toContain('resources.cpus');
    });
    it('assertTemplateValid maps to error codes', async () => {
      const t = await resolve(spec(good + 'isolation: vm\n'));
      try {
        assertTemplateValid(t, { capabilities: caps });
        expect.unreachable();
      } catch (e) {
        expect((e as AboxError).code).toBe('unsupported');
        expect((e as AboxError).exitCode).toBe(2);
      }
      const root = await resolve(spec(good + 'user: { uid: 0 }\n'));
      expect(() => assertTemplateValid(root)).toThrowError(/must not be root/);
      expect(assertTemplateValid(await resolve(spec(good)))).toEqual([]);
    });
  });
});
