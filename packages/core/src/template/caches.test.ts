import { describe, expect, it } from 'vitest';
import { AboxError } from '../errors.js';
import type { ResolvedTemplate, TemplateSourceKind } from '../types.js';
import { TemplateCatalog } from './catalog.js';
import { parseTemplateYaml } from './parse.js';
import { renderTemplateSnapshot } from './review.js';
import { resolveTemplate, type TemplateLookup } from './resolve.js';
import { validateTemplate } from './validate.js';

const head = (backend = 'docker', base = 'base:\n  os: ubuntu:24.04\n'): string =>
  `apiVersion: 1\nname: demo\nbackend: ${backend}\n${base}`;

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

async function problems(text: string): Promise<string[]> {
  try {
    await resolve(text);
  } catch (e) {
    expect(e).toBeInstanceOf(AboxError);
    return (e as AboxError).issues.map((i) => `${i.path}: ${i.message}`);
  }
  throw new Error('expected the template to be rejected');
}

function schemaProblems(text: string): string[] {
  try {
    parseTemplateYaml(text);
  } catch (e) {
    expect(e).toBeInstanceOf(AboxError);
    return (e as AboxError).issues.map((i) => `${i.path}: ${i.message}`);
  }
  throw new Error('expected the schema to reject the template');
}

describe('caches: schema', () => {
  it('accepts name, path and env', () => {
    const t = parseTemplateYaml(
      `${head()}caches:\n  - name: pnpm-store\n    path: ~/.local/share/pnpm/store\n    env: { npm_config_store_dir: '\${path}' }\n  - name: cargo\n    path: /opt/cargo\n`,
    );
    expect(t.caches).toHaveLength(2);
    expect(t.caches?.[0]?.env).toEqual({ npm_config_store_dir: '${path}' });
  });

  it.each([
    ['unknown key', 'caches:\n  - name: a\n    path: /x\n    size: 1g\n', /size/],
    ['bad name', 'caches:\n  - name: PNPM\n    path: /x\n', /caches\[\]\.name/],
    ['relative path', 'caches:\n  - name: a\n    path: x/y\n', /absolute/],
    ['dot-dot', 'caches:\n  - name: a\n    path: /x/../etc\n', /\.\./],
    ['root', 'caches:\n  - name: a\n    path: /\n', /root/],
    ['home itself', 'caches:\n  - name: a\n    path: ~/\n', /root or the home/],
    ['non-string env', 'caches:\n  - name: a\n    path: /x\n    env: { A: 1 }\n', /string/],
    ['bad env key', 'caches:\n  - name: a\n    path: /x\n    env: { 1A: x }\n', /env keys/],
  ])('rejects %s', (_what, caches, re) => {
    expect(schemaProblems(head() + caches).join('\n')).toMatch(re);
  });

  it('allows at most 16', () => {
    const many = Array.from({ length: 17 }, (_, i) => `  - name: c${i}\n    path: /c${i}\n`).join(
      '',
    );
    expect(schemaProblems(`${head()}caches:\n${many}`).join('\n')).toMatch(/at most 16/);
  });
});

describe('caches: resolving', () => {
  it('expands ~ to the home of the template user and ${path} in the values', async () => {
    const t = await resolve(
      `${head()}user: { name: dev }\ncaches:\n  - name: store\n    path: ~/.cache/store/\n    env: { STORE: '\${path}', TWICE: '\${path}:\${path}' }\n`,
    );
    expect(t.caches).toEqual([
      {
        name: 'store',
        path: '/home/dev/.cache/store',
        env: {
          STORE: '/home/dev/.cache/store',
          TWICE: '/home/dev/.cache/store:/home/dev/.cache/store',
        },
      },
    ]);
  });

  it('is empty without the field and does not change the image hash', async () => {
    const plain = await resolve(head());
    const cached = await resolve(`${head()}caches:\n  - name: a\n    path: /var/cache/a\n`);
    expect(plain.caches).toEqual([]);
    expect(cached.hash).toBe(plain.hash);
    expect(cached.contentHash).not.toBe(plain.contentHash);
  });

  it('merges by name on extends: the child replaces the parent entry, others are inherited', async () => {
    const lookup: TemplateLookup = (name) =>
      name === 'parent'
        ? {
            spec: parseTemplateYaml(
              `apiVersion: 1\nname: parent\nbackend: docker\nbase: { os: ubuntu:24.04 }\ncaches:\n  - { name: a, path: /var/cache/a }\n  - { name: b, path: /var/cache/b }\n`,
            ),
            source: { kind: 'builtin' },
          }
        : undefined;
    const t = await resolve(
      `${head()}extends: parent\ncaches:\n  - { name: b, path: /srv/b }\n  - { name: c, path: /srv/c }\n`,
      lookup,
    );
    expect(t.caches.map((c) => [c.name, c.path])).toEqual([
      ['a', '/var/cache/a'],
      ['b', '/srv/b'],
      ['c', '/srv/c'],
    ]);
  });

  it.each([
    [
      'a name used twice',
      'caches:\n  - { name: a, path: /x }\n  - { name: a, path: /y }\n',
      /declared more than once/,
    ],
    [
      'nested caches',
      'caches:\n  - { name: a, path: /x }\n  - { name: b, path: /x/y }\n',
      /must not be nested/,
    ],
    [
      'the same path',
      'caches:\n  - { name: a, path: /x }\n  - { name: b, path: /x }\n',
      /overlaps the cache/,
    ],
    [
      'the workspace',
      'caches:\n  - { name: a, path: /workspace/.cache }\n',
      /overlaps the workspace/,
    ],
    [
      'a parent of the workspace',
      'caches:\n  - { name: a, path: / }\n',
      /root or the home|overlaps/,
    ],
    [
      'a mount target',
      'mounts:\n  - { source: /srv/data, target: /data }\ncaches:\n  - { name: a, path: /data/cache }\n',
      /overlaps the mount target/,
    ],
    [
      'the home directory',
      'caches:\n  - { name: a, path: /home/agent }\n',
      /home directory itself/,
    ],
    ['/tmp', 'caches:\n  - { name: a, path: /tmp/cache }\n', /\/tmp/],
    [
      'a secret file',
      'network: { mode: allowlist, allow: [example.org] }\nsecrets:\n  - { ref: tok, inject: file, path: /var/cache/a/token }\ncaches:\n  - { name: a, path: /var/cache/a }\n',
      /secret file/,
    ],
    [
      'two values for one variable',
      'caches:\n  - { name: a, path: /x, env: { V: one } }\n  - { name: b, path: /y, env: { V: two } }\n',
      /different values/,
    ],
  ])('rejects %s', async (_what, body, re) => {
    expect((await problems(head() + body)).join('\n')).toMatch(re);
  });

  it('refuses caches for backends without volumes', async () => {
    const proc = await problems(
      `${head('process', '')}caches:\n  - { name: a, path: /var/cache/a }\n`,
    );
    expect(proc.join('\n')).toMatch(/no volumes/);
    const vm = await problems(
      `${head('vm', 'base:\n  os: ubuntu-24.04\n')}caches:\n  - { name: a, path: /var/cache/a }\n`,
    );
    expect(vm.join('\n')).toMatch(/no volumes/);
  });

  it('allows the python backend', async () => {
    const t = await resolve(
      `${head('python', '')}python: { version: '3.13' }\ncaches:\n  - { name: uv, path: ~/.cache/uv }\n`,
    );
    expect(t.caches[0]?.path).toBe('/home/agent/.cache/uv');
  });
});

describe('caches: validation and review', () => {
  it('rejects system paths and credential-looking variables', async () => {
    const t = await resolve(
      `${head()}caches:\n  - { name: a, path: /usr/local/cache }\n  - { name: b, path: /var/cache/b, env: { API_KEY: x } }\n`,
    );
    const r = validateTemplate(t);
    const text = r.issues.map((i) => `${i.path}: ${i.message}`).join('\n');
    expect(r.ok).toBe(false);
    expect(text).toContain('caches[0].path');
    expect(text).toContain('caches[1].env.API_KEY');
  });

  it('shows the caches in the review snapshot', async () => {
    const t = await resolve(
      `${head()}caches:\n  - { name: a, path: /var/cache/a, env: { A_DIR: '\${path}' } }\n`,
    );
    const text = renderTemplateSnapshot(t);
    expect(text).toContain('caches:');
    expect(text).toContain('path: /var/cache/a');
    expect(text).toContain('A_DIR: /var/cache/a');
  });
});

describe('caches: built-in templates', () => {
  const expected: Record<string, Array<[string, string]>> = {
    'node-dev': [
      ['pnpm-store', '/home/agent/.local/share/pnpm/store'],
      ['npm-cache', '/home/agent/.npm'],
    ],
    'py-dev': [
      ['uv-cache', '/home/agent/.cache/uv'],
      ['pip-cache', '/home/agent/.cache/pip'],
    ],
    'py-uv': [['uv-cache', '/home/agent/.cache/uv']],
    'rust-dev': [
      ['cargo-registry', '/home/agent/.cargo/registry'],
      ['cargo-git', '/home/agent/.cargo/git'],
    ],
    'tauri-dev': [
      ['pnpm-store', '/home/agent/.local/share/pnpm/store'],
      ['npm-cache', '/home/agent/.npm'],
      ['cargo-registry', '/home/agent/.cargo/registry'],
      ['cargo-git', '/home/agent/.cargo/git'],
    ],
    'flutter-dev': [['pub-cache', '/opt/pub-cache']],
    'php-dev': [['composer-cache', '/home/agent/.cache/composer']],
  };

  it('declare their tool caches, and the offline templates declare none', async () => {
    const catalog = new TemplateCatalog({ projectDir: undefined });
    for (const [name, caches] of Object.entries(expected)) {
      const t = await catalog.get(name);
      expect(
        t.caches.map((c) => [c.name, c.path]),
        name,
      ).toEqual(caches);
      expect(validateTemplate(t, { strictDescription: true }).ok, name).toBe(true);
    }
    for (const name of ['alpine-min', 'host-shell', 'py-offline', 'shell-dev'])
      expect((await catalog.get(name)).caches, name).toEqual([]);
  });

  it('point the tools at the volumes where they need it', async () => {
    const catalog = new TemplateCatalog({ projectDir: undefined });
    const node = await catalog.get('node-dev');
    expect(node.caches[0]?.env).toEqual({
      npm_config_store_dir: '/home/agent/.local/share/pnpm/store',
    });
    const php = await catalog.get('php-dev');
    expect(php.caches[0]?.env).toEqual({ COMPOSER_CACHE_DIR: '/home/agent/.cache/composer' });
    // flutter keeps the pub cache outside the home; the template env already points PUB_CACHE there
    const flutter = await catalog.get('flutter-dev');
    expect(flutter.env['PUB_CACHE']).toBe(flutter.caches[0]?.path);
  });
});
