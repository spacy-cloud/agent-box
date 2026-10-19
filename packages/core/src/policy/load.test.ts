import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AboxError } from '../errors.js';
import { resolveContext } from './context.js';
import {
  BUILTIN_AGENT_CONTEXTS,
  DEFAULT_WORKSPACE_ROOTS,
  defaultPolicy,
  defaultPolicyPath,
  loadPolicy,
  parsePolicy,
  policyContentHash,
} from './load.js';

const dir = mkdtempSync(join(tmpdir(), 'abox-load-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function parse(text: string) {
  return parsePolicy(text, { kind: 'file', path: '/test/policy.yaml' });
}

function fail(text: string): AboxError {
  try {
    parse(text);
  } catch (e) {
    expect(e).toBeInstanceOf(AboxError);
    expect((e as AboxError).code).toBe('invalid_input');
    return e as AboxError;
  }
  throw new Error('expected parse to fail');
}

describe('agent contexts of a user policy', () => {
  it('a policy.yaml replaces the built-in contexts (override or drop)', () => {
    const p = parse(
      'profiles:\n  strict-one: { approval: strict, templates: [alpine-min] }\ncontexts:\n  claude-code: { profile: strict-one }\n',
    );
    expect(p.contexts['claude-code']).toEqual({ profile: 'strict-one' });
    expect(p.contexts['codex']).toBeUndefined();
    expect(resolveContext(p, 'claude-code', { home: '/home/u' }).profileName).toBe('strict-one');
    expect(() => resolveContext(p, 'codex', { home: '/home/u' })).toThrow(/unknown agent context/);
  });
});

describe('defaultPolicy', () => {
  const p = defaultPolicy();
  it('has default and human profiles and the default + human contexts', () => {
    expect(Object.keys(p.profiles).sort()).toEqual(['default', 'human']);
    expect(Object.keys(p.contexts).sort()).toEqual([
      'claude-code',
      'claude-desktop',
      'codex',
      'cursor',
      'default',
      'gemini-cli',
      'human',
      'orca',
    ]);
    for (const id of BUILTIN_AGENT_CONTEXTS) {
      if (id !== 'human') expect(p.contexts[id]).toEqual({ profile: 'default' });
    }
    expect(resolveContext(p, 'claude-code', { home: '/home/u' }).owner).toBe('agent:claude-code');
    expect(p.source).toEqual({ kind: 'default' });
  });
  it('default profile matches the concept', () => {
    const d = p.profiles.default!;
    expect(d.approval).toBe('medium');
    expect(d.templates).toEqual([
      'node-dev',
      'py-dev',
      'py-uv',
      'py-offline',
      'rust-dev',
      'tauri-dev',
      'flutter-dev',
      'php-dev',
      'shell-dev',
      'alpine-min',
    ]);
    // every built-in template except host-shell (isolation none) is usable by agents out of the box
    expect(d.network.allow_presets).toEqual([
      'npm',
      'pypi',
      'crates',
      'pub',
      'packagist',
      'github',
    ]);
    expect(d.limits).toMatchObject({
      sandboxes: 3,
      cpus: 4,
      memory: '8g',
      ttl: '4h',
      memoryBytes: 8 * 1024 ** 3,
      ttlMs: 4 * 3_600_000,
    });
    expect(d.workspace.roots).toEqual([
      '~/projects',
      '~/Projekte',
      '~/src',
      '~/code',
      '~/dev',
      '~/work',
      '~/git',
      '~/repos',
    ]);
    expect(d.workspace.roots).toEqual([...DEFAULT_WORKSPACE_ROOTS]);
    expect(d.images.registries).toEqual(['docker.io/library']);
    expect(d.workspace.modes).toEqual(['worktree', 'clone', 'copy', 'empty']);
    expect(d.network.modes).toEqual(['none', 'allowlist']);
    expect(d.mounts).toBeNull();
    expect(d.secrets.inject).toEqual(['proxy']);
    expect(d.isolation).toEqual({
      min: 'container',
      network_open: 'vm',
      mounts: 'container',
      secrets_env: 'container',
    });
    expect(d.hosts).toEqual(['local']);
  });
  it('the home directory as a whole is no root of the default profile', () => {
    const roots = p.profiles.default!.workspace.roots;
    expect(roots).not.toContain('~');
    expect(roots).not.toContain('~/');
    expect(roots.every((r) => r.startsWith('~/') && !r.startsWith('~/.'))).toBe(true);
  });
  it('human profile is broad but open-mode', () => {
    const h = p.profiles.human!;
    expect(h.workspace.roots).toEqual(['*']);
    expect(h.images.registries).toEqual(['*']);
    expect(h.approval).toBe('open');
    expect(h.templates).toEqual(['*']);
    expect(h.hosts).toEqual(['*']);
    expect(h.isolation.min).toBe('none');
  });
  it('has a stable content hash', () => {
    expect(p.contentHash).toBe(defaultPolicy().contentHash);
    expect(p.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('loadPolicy', () => {
  it('returns the default policy when the file does not exist', () => {
    const p = loadPolicy(join(dir, 'missing.yaml'));
    expect(p.source.kind).toBe('default');
  });
  it('loads a file and records path and hash', () => {
    const file = join(dir, 'policy.yaml');
    const text = 'profiles:\n  p:\n    approval: strict\ncontexts:\n  a1: { profile: p }\n';
    writeFileSync(file, text);
    const p = loadPolicy(file);
    expect(p.source).toEqual({ kind: 'file', path: file });
    expect(p.contentHash).toBe(policyContentHash(text));
    expect(p.profiles.p!.approval).toBe('strict');
  });
  it('policyContentHash is sha256 hex and changes with content', () => {
    expect(policyContentHash('a')).toBe(
      'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb',
    );
    expect(policyContentHash('a')).not.toBe(policyContentHash('a '));
  });
  it('errors on an unreadable path (directory)', () => {
    expect(() => loadPolicy(dir)).toThrow(AboxError);
  });
  it('default path honors XDG_CONFIG_HOME', () => {
    expect(defaultPolicyPath({ XDG_CONFIG_HOME: '/x/cfg' }, '/home/u')).toBe(
      '/x/cfg/abox/policy.yaml',
    );
    expect(defaultPolicyPath({}, '/home/u')).toBe('/home/u/.config/abox/policy.yaml');
    expect(defaultPolicyPath({ XDG_CONFIG_HOME: 'relative' }, '/home/u')).toBe(
      '/home/u/.config/abox/policy.yaml',
    );
  });
});

describe('schema errors', () => {
  it('reports field path and line for unknown keys (typos never pass silently)', () => {
    const e = fail(
      'profiles:\n  p:\n    approval: medium\n    network:\n      allow_preset: [npm]\n',
    );
    expect(e.issues).toHaveLength(1);
    expect(e.issues[0]).toMatchObject({ path: 'profiles.p.network.allow_preset', line: 5 });
    expect(e.issues[0]!.message).toContain('unknown key');
  });
  it('reports invalid enum values with path and line', () => {
    const e = fail('profiles:\n  p:\n    approval: sometimes\n');
    expect(e.issues[0]).toMatchObject({ path: 'profiles.p.approval', line: 3 });
  });
  it('reports invalid size, duration, preset, domain, root and cpus', () => {
    const e = fail(
      [
        'profiles:',
        '  p:',
        '    limits: { memory: lots, ttl: soon, cpus: -1 }',
        '    network: { allow_presets: [nope], allow: ["*.com"] }',
        '    workspace: { roots: [relative/dir] }',
      ].join('\n'),
    );
    const paths = e.issues.map((i) => i.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'profiles.p.limits.memory',
        'profiles.p.limits.ttl',
        'profiles.p.limits.cpus',
        'profiles.p.network.allow_presets.0',
        'profiles.p.network.allow.0',
        'profiles.p.workspace.roots.0',
      ]),
    );
    expect(e.issues.every((i) => typeof i.line === 'number')).toBe(true);
  });
  it('rejects roots with .. segments', () => {
    expect(
      fail('profiles:\n  p:\n    workspace: { roots: ["~/a/../.ssh"] }\n').issues[0]!.path,
    ).toBe('profiles.p.workspace.roots.0');
  });
  it('reports YAML syntax errors with line', () => {
    const e = fail('profiles:\n  p: [\n');
    expect(e.issues[0]!.line).toBeGreaterThan(0);
  });
  it('rejects duplicate keys (no silent override of a profile)', () => {
    const e = fail('profiles:\n  p: { approval: strict }\n  p: { approval: open }\n');
    expect(e.issues[0]!.message.toLowerCase()).toContain('unique');
  });
  it('rejects unknown top-level keys and wrong version', () => {
    expect(fail('profile: {}\n').issues[0]!.path).toBe('profile');
    expect(fail('version: 2\n').issues[0]!.path).toBe('version');
  });
  it('rejects prototype-ish profile names', () => {
    expect(() => parse('profiles:\n  __proto__: { approval: open }\n')).toThrow(AboxError);
  });
  it('treats an empty file as an empty policy (only human context)', () => {
    const p = parse('');
    expect(Object.keys(p.contexts)).toEqual(['human']);
    expect(Object.keys(p.profiles)).toEqual(['human']);
    const q = parse('# only a comment\n');
    expect(Object.keys(q.contexts)).toEqual(['human']);
  });
  it('rejects non-mapping root', () => {
    expect(() => parse('- a\n- b\n')).toThrow(AboxError);
  });
});

describe('workspace copy limits', () => {
  it('defaults to 1g / 50000 entries and accepts values per profile', () => {
    const p = parsePolicy(
      'profiles:\n  a: { workspace: { modes: [copy] } }\n  b: { extends: a, workspace: { max_copy_bytes: 8g, max_copy_entries: 1000 } }\n',
      { kind: 'file', path: '/p.yaml' },
    );
    expect(p.profiles.a!.workspace).toMatchObject({
      max_copy_bytes: '1g',
      maxCopyBytes: 1024 ** 3,
      max_copy_entries: 50_000,
    });
    expect(p.profiles.b!.workspace).toMatchObject({
      modes: ['copy'],
      max_copy_bytes: '8g',
      maxCopyBytes: 8 * 1024 ** 3,
      max_copy_entries: 1000,
    });
    expect(p.profiles.human!.workspace.maxCopyBytes).toBe(1024 ** 3);
  });

  it('rejects an invalid size or count with the field path', () => {
    expect(() =>
      parsePolicy('profiles:\n  a: { workspace: { max_copy_bytes: lots } }\n', {
        kind: 'file',
        path: '/p.yaml',
      }),
    ).toThrow(/max_copy_bytes/);
    expect(() =>
      parsePolicy('profiles:\n  a: { workspace: { max_copy_entries: 0 } }\n', {
        kind: 'file',
        path: '/p.yaml',
      }),
    ).toThrow(/max_copy_entries/);
  });
});

describe('package caches', () => {
  it('are on with a cap of 10g by default, for every profile including human', () => {
    const p = parse('profiles:\n  bare: {}\n');
    for (const name of ['bare', 'human'])
      expect(p.profiles[name]).toMatchObject({
        caches: true,
        cache_max_bytes: '10g',
        cacheMaxBytes: 10 * 1024 ** 3,
      });
    expect(defaultPolicy().profiles['default']).toMatchObject({ caches: true });
  });

  it('can be switched off and capped per profile, and are inherited like other scalars', () => {
    const p = parse(
      'profiles:\n  a: { caches: false, cache_max_bytes: 512m }\n  b: { extends: a }\n  c: { extends: a, caches: true }\n',
    );
    expect(p.profiles.a).toMatchObject({
      caches: false,
      cache_max_bytes: '512m',
      cacheMaxBytes: 512 * 1024 ** 2,
    });
    expect(p.profiles.b).toMatchObject({ caches: false, cacheMaxBytes: 512 * 1024 ** 2 });
    expect(p.profiles.c).toMatchObject({ caches: true, cacheMaxBytes: 512 * 1024 ** 2 });
  });

  it('rejects values of the wrong type with the field path and line', () => {
    const e = fail('profiles:\n  a:\n    caches: maybe\n');
    expect(e.issues[0]).toMatchObject({ path: 'profiles.a.caches', line: 3 });
    expect(fail('profiles:\n  a: { cache_max_bytes: lots }\n').message).toContain(
      'cache_max_bytes',
    );
    expect(fail('profiles:\n  a: { cache_max_bytes: 0 }\n').message).toContain('cache_max_bytes');
    expect(fail('profiles:\n  a: { cache: false }\n').message).toContain('unknown key');
  });
});

describe('ports', () => {
  it('defaults to ask with at most 3 forwards; the human profile may forward freely', () => {
    const p = parse('profiles:\n  a: { templates: [x] }\n');
    expect(p.profiles.a!.ports).toEqual({ allow: 'ask', max: 3 });
    expect(p.profiles.human!.ports).toEqual({ allow: true, max: 16 });
    expect(defaultPolicy().profiles.default!.ports).toEqual({ allow: 'ask', max: 3 });
  });

  it('accepts false, ask and true, and extends merges the keys one by one', () => {
    const p = parse(
      'profiles:\n  a: { ports: { allow: false, max: 1 } }\n  b: { extends: a, ports: { allow: true } }\n  c: { extends: b, ports: { max: 8 } }\n  d: { ports: { allow: ask } }\n',
    );
    expect(p.profiles.a!.ports).toEqual({ allow: false, max: 1 });
    expect(p.profiles.b!.ports).toEqual({ allow: true, max: 1 });
    expect(p.profiles.c!.ports).toEqual({ allow: true, max: 8 });
    expect(p.profiles.d!.ports).toEqual({ allow: 'ask', max: 3 });
  });

  it('rejects other values and unknown keys with the field path', () => {
    expect(() => parse('profiles:\n  a: { ports: { allow: maybe } }\n')).toThrow(/ports\.allow/);
    expect(() => parse('profiles:\n  a: { ports: { max: -1 } }\n')).toThrow(/ports\.max/);
    expect(() => parse('profiles:\n  a: { ports: { max: 1000 } }\n')).toThrow(/ports\.max/);
    expect(() => parse('profiles:\n  a: { ports: { bind: 0.0.0.0 } }\n')).toThrow(
      /unknown key "bind"/,
    );
  });
});

describe('profile resolution', () => {
  const policy = `
profiles:
  default:
    approval: medium
    templates: [node-dev, py-dev]
    limits: { sandboxes: 3, cpus: 4, memory: 8g, ttl: 4h }
    workspace: { roots: [~/projects], modes: [worktree, clone] }
    network: { modes: [none, allowlist], allow_presets: [npm], allow: [] }
    mounts: deny
    secrets: { allowed: [github-token], inject: [proxy] }
  trusted-project:
    extends: default
    approval: open
    workspace: { modes: [mount, worktree] }
  deeper:
    extends: trusted-project
    limits: { cpus: 8 }
    mounts: { roots: [~/data], access: [ro] }
  deepest:
    extends: deeper
    mounts: { access: [ro, rw] }
contexts:
  claude-code: { profile: default }
  trusted: { profile: trusted-project }
`;
  const p = parse(policy);
  it('inherits unspecified fields and overrides specified ones', () => {
    const t = p.profiles['trusted-project']!;
    expect(t.approval).toBe('open');
    expect(t.templates).toEqual(['node-dev', 'py-dev']);
    expect(t.workspace.roots).toEqual(['~/projects']); // inherited
    expect(t.workspace.modes).toEqual(['mount', 'worktree']); // arrays replaced, not merged
    expect(t.limits.memory).toBe('8g');
    expect(t.mounts).toBeNull();
    expect(p.profiles.default!.approval).toBe('medium'); // parent untouched
  });
  it('supports chains and merges objects one level deep', () => {
    const d = p.profiles.deeper!;
    expect(d.limits).toMatchObject({ cpus: 8, memory: '8g', sandboxes: 3 });
    expect(d.approval).toBe('open');
    expect(d.mounts).toEqual({ roots: ['~/data'], access: ['ro'] });
    expect(p.profiles.deepest!.mounts).toEqual({ roots: ['~/data'], access: ['ro', 'rw'] });
  });
  it('mounts: deny in a child overrides a parent object', () => {
    const q = parse(
      'profiles:\n  a: { mounts: { roots: [~/x], access: [ro] } }\n  b: { extends: a, mounts: deny }\n',
    );
    expect(q.profiles.b!.mounts).toBeNull();
    expect(q.profiles.a!.mounts).toEqual({ roots: ['~/x'], access: ['ro'] });
  });
  it('applies safe defaults for fields missing from the whole chain', () => {
    const q = parse('profiles:\n  bare: {}\n');
    const b = q.profiles.bare!;
    expect(b.templates).toEqual([]);
    expect(b.workspace).toMatchObject({
      roots: [],
      modes: ['empty'],
      max_copy_bytes: '1g',
      maxCopyBytes: 1024 ** 3,
      max_copy_entries: 50_000,
    });
    expect(b.network).toEqual({ modes: ['none'], allow_presets: [], allow: [] });
    expect(b.mounts).toBeNull();
    expect(b.secrets).toEqual({ allowed: [], inject: ['proxy'] });
    expect(b.isolation.min).toBe('container');
    expect(b.hosts).toEqual(['local']);
    expect(b.approval).toBe('medium');
    expect(b.exec.approval).toBe(false);
  });
  it('images.registries: defaults to the official Docker Hub images, child replaces parent, human inherits *', () => {
    const p = parse(
      [
        'profiles:',
        '  base: { approval: medium }',
        '  own: { extends: base, images: { registries: [ghcr.io/my-org, localhost:5000] } }',
        '  none: { extends: base, images: { registries: [] } }',
        'contexts:',
        '  a1: { profile: base }',
      ].join('\n'),
    );
    expect(p.profiles.base!.images.registries).toEqual(['docker.io/library']);
    expect(p.profiles.own!.images.registries).toEqual(['ghcr.io/my-org', 'localhost:5000']);
    expect(p.profiles.none!.images.registries).toEqual([]);
    expect(p.profiles.human!.images.registries).toEqual(['*']);
  });
  it('images.registries: invalid entries and unknown keys are errors with a path', () => {
    const e = fail(
      'profiles:\n  p:\n    images: { registries: [library, "https://ghcr.io"], registry: [x] }\n',
    );
    const paths = e.issues.map((i) => i.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'profiles.p.images.registries.0',
        'profiles.p.images.registries.1',
        'profiles.p.images.registry',
      ]),
    );
  });
  it('accepts min_isolation as alias of isolation (isolation wins)', () => {
    const q = parse(
      'profiles:\n  a:\n    min_isolation: { network_open: hardened, mounts: hardened }\n    isolation: { mounts: vm }\n',
    );
    expect(q.profiles.a!.isolation).toMatchObject({ network_open: 'hardened', mounts: 'vm' });
  });
  it('detects inheritance cycles with the chain and line', () => {
    const e = fail('profiles:\n  a: { extends: b }\n  b: { extends: c }\n  c: { extends: a }\n');
    expect(e.issues[0]!.message).toMatch(/cycle: [abc] -> [abc] -> [abc] -> [abc]/);
    expect(e.issues[0]!.line).toBeGreaterThan(1);
  });
  it('detects self-extends', () => {
    expect(fail('profiles:\n  a: { extends: a }\n').issues[0]!.message).toContain('cycle: a -> a');
  });
  it('rejects unknown parents', () => {
    const e = fail('profiles:\n  a: { extends: nope }\n');
    expect(e.issues[0]).toMatchObject({ path: 'profiles.a.extends', line: 2 });
    expect(e.issues[0]!.message).toContain('unknown profile "nope"');
  });
});

describe('contexts', () => {
  it('always contains human with profile human', () => {
    const q = parse('profiles: {}\n');
    expect(q.contexts.human).toEqual({ profile: 'human' });
  });
  it('rejects contexts pointing to unknown profiles', () => {
    const e = fail('profiles:\n  a: {}\ncontexts:\n  x: { profile: b }\n');
    expect(e.issues[0]).toMatchObject({ path: 'contexts.x.profile', line: 4 });
  });
  it('refuses to redefine the human context', () => {
    const e = fail('profiles:\n  a: {}\ncontexts:\n  human: { profile: a }\n');
    expect(e.issues[0]!.path).toBe('contexts.human');
  });
  it('allows a human context line that matches the built-in', () => {
    expect(() => parse('contexts:\n  human: { profile: human }\n')).not.toThrow();
  });
  it('keeps per-context host overrides', () => {
    const q = parse('profiles:\n  a: {}\ncontexts:\n  x: { profile: a, hosts: [local, lab] }\n');
    expect(q.contexts.x).toEqual({ profile: 'a', hosts: ['local', 'lab'] });
  });
  it('merges a file-defined human profile on top of the built-in one', () => {
    const q = parse('profiles:\n  human:\n    limits: { cpus: 2 }\n');
    expect(q.profiles.human!.limits.cpus).toBe(2);
    expect(q.profiles.human!.templates).toEqual(['*']);
    expect(q.profiles.human!.approval).toBe('open');
  });
  it('lets a human profile extend another profile instead of the built-in', () => {
    const q = parse('profiles:\n  tight: { approval: strict }\n  human: { extends: tight }\n');
    expect(q.profiles.human!.approval).toBe('strict');
    expect(q.profiles.human!.templates).toEqual([]);
  });
});
