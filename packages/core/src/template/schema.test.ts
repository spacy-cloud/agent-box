import { describe, expect, it } from 'vitest';
import { AboxError, type ErrorIssue } from '../errors.js';
import { parseDuration, parseSize, isSafePackageName } from './schema.js';
import { annotateIssuePositions, parseTemplateYaml } from './parse.js';

const MIN = `apiVersion: 1
name: demo
backend: docker
base:
  os: alpine:3.22
`;

function issuesOf(text: string): ErrorIssue[] {
  try {
    parseTemplateYaml(text);
  } catch (e) {
    expect(e).toBeInstanceOf(AboxError);
    expect((e as AboxError).code).toBe('template_invalid');
    return (e as AboxError).issues;
  }
  throw new Error('expected parseTemplateYaml to throw');
}

describe('parseSize', () => {
  it('parses units', () => {
    expect(parseSize('512m')).toBe(512 * 1024 ** 2);
    expect(parseSize('4g')).toBe(4 * 1024 ** 3);
    expect(parseSize('1.5g')).toBe(1.5 * 1024 ** 3);
    expect(parseSize('2048K')).toBe(2048 * 1024);
    expect(parseSize('1t')).toBe(1024 ** 4);
    expect(parseSize('4GiB')).toBe(4 * 1024 ** 3);
    expect(parseSize('1000')).toBe(1000);
  });
  it.each(['', 'g', '-1g', '1.5.5g', '4 gigabytes', '0', '0g', '1x', '1e3'])('rejects %j', (s) => {
    expect(() => parseSize(s)).toThrow(RangeError);
  });
});

describe('parseDuration', () => {
  it('parses single and combined units', () => {
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('15m')).toBe(900_000);
    expect(parseDuration('2h')).toBe(7_200_000);
    expect(parseDuration('1d')).toBe(86_400_000);
    expect(parseDuration('1h30m')).toBe(5_400_000);
    expect(parseDuration('1d2h3m4s')).toBe(86_400_000 + 7_200_000 + 180_000 + 4000);
  });
  it.each(['', '2', 'h', '2x', '1h 30m', '-5m', '0s', '1.5h', 'abc'])('rejects %j', (s) => {
    expect(() => parseDuration(s)).toThrow(RangeError);
  });
});

describe('schema: accepts', () => {
  it('a minimal template', () => {
    const spec = parseTemplateYaml(MIN);
    expect(spec.name).toBe('demo');
    expect(spec.base).toEqual({ os: 'alpine:3.22' });
  });

  it('defaults base to {} so child templates can omit it', () => {
    const spec = parseTemplateYaml(
      'apiVersion: 1\nname: child\nbackend: docker\nextends: parent\n',
    );
    expect(spec.base).toEqual({});
  });

  it('a full template', () => {
    const spec = parseTemplateYaml(`
apiVersion: 1
name: full-1
description: A complete example
backend: docker
isolation: hardened
base: { os: "ubuntu:24.04" }
packages:
  apt: [git, build-essential, libssl-dev=3.0.13-0ubuntu3]
  pip: ["requests==2.32.3"]
  npm: ["@types/node", "typescript@5.6"]
tools: [node@24, pnpm@10, git, python@3.13]
setup:
  - run: corepack enable
user: { name: agent, uid: 1000, sudo: false }
workspace: { mode: worktree, path: /workspace, access: ro, ref: main }
resources: { cpus: 1.5, memory: 512m, disk: 10g, pids: 256, ttl: 1h30m }
network:
  mode: allowlist
  allow: [example.org, "*.example.org", "api.example.org:8443"]
  presets: [npm, github]
mounts:
  - { source: "~/refs/docs", target: /refs, access: ro }
env: { NODE_ENV: development }
secrets:
  - { ref: github-token, inject: proxy, hosts: [github.com] }
labels: { use-for: testing }
`);
    expect(spec.resources?.ttl).toBe('1h30m');
    expect(spec.packages?.npm).toContain('@types/node');
  });
});

describe('schema: rejects with concrete messages', () => {
  it('unknown top-level keys, with position and suggestion', () => {
    const issues = issuesOf(`${MIN}resourcs:\n  memory: 1g\n`);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ path: 'resourcs', line: 6, column: 1 });
    expect(issues[0]!.message).toContain('unknown field "resourcs"');
    expect(issues[0]!.message).toContain('did you mean "resources"');
  });

  it('unknown nested keys', () => {
    const issues = issuesOf(`${MIN}resources:\n  memroy: 1g\n`);
    expect(issues[0]).toMatchObject({ path: 'resources.memroy', line: 7, column: 3 });
    expect(issues[0]!.message).toContain('did you mean "memory"');
  });

  it('bad size with line and column of the value', () => {
    const issues = issuesOf(`${MIN}resources:\n  memory: lots\n`);
    expect(issues[0]).toMatchObject({ path: 'resources.memory', line: 7, column: 11 });
    expect(issues[0]!.message).toContain('invalid size "lots"');
  });

  it('bad duration', () => {
    const issues = issuesOf(`${MIN}resources:\n  ttl: 2 hours\n`);
    expect(issues[0]).toMatchObject({ path: 'resources.ttl', line: 7 });
    expect(issues[0]!.message).toContain('invalid duration');
  });

  it('a number where a string is required', () => {
    const issues = issuesOf(`${MIN}resources:\n  memory: 4\n`);
    expect(issues[0]).toMatchObject({ path: 'resources.memory', line: 7 });
    expect(issues[0]!.message).toContain('must be a string');
  });

  it('invalid enum values', () => {
    const issues = issuesOf(MIN.replace('docker', 'dokcer'));
    expect(issues[0]).toMatchObject({ path: 'backend', line: 3, column: 10 });
    expect(issues[0]!.message).toContain('backend must be one of');
  });

  it('missing required fields point at the enclosing node', () => {
    const issues = issuesOf('apiVersion: 1\nbackend: docker\n');
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      path: 'name',
      line: 1,
      column: 1,
      message: 'missing required field "name"',
    });
  });

  it('wrong apiVersion', () => {
    const issues = issuesOf(MIN.replace('apiVersion: 1', 'apiVersion: 2'));
    expect(issues[0]).toMatchObject({ path: 'apiVersion', line: 1, column: 13 });
    expect(issues[0]!.message).toContain('apiVersion must be 1');
  });

  it.each(['Node-Dev', '-lead', 'a_b', 'x'.repeat(64), ''])('invalid name %j', (name) => {
    const issues = issuesOf(MIN.replace('name: demo', `name: "${name}"`));
    expect(issues[0]).toMatchObject({ path: 'name', line: 2 });
  });

  it('accepts the longest and shortest valid names', () => {
    expect(() => parseTemplateYaml(MIN.replace('demo', 'a'))).not.toThrow();
    expect(() => parseTemplateYaml(MIN.replace('demo', 'a' + 'b'.repeat(62)))).not.toThrow();
  });

  it('list element positions', () => {
    const issues = issuesOf(`${MIN}tools:\n  - node@24\n  - "Node 24"\n`);
    expect(issues[0]).toMatchObject({ path: 'tools[1]', line: 8, column: 5 });
    expect(issues[0]!.message).toContain('invalid tool reference');
  });

  it('nested list positions', () => {
    const issues = issuesOf(`${MIN}mounts:\n  - source: /data\n    target: relative\n`);
    expect(issues[0]).toMatchObject({ path: 'mounts[0].target', line: 8 });
    expect(issues[0]!.message).toContain('absolute path');
  });

  it.each([
    ['*.com', true],
    ['*', true],
    ['10.0.0.1', true],
    ['example.org/path', true],
    ['http://example.org', true],
    ['exa mple.org', true],
    ['localhost', true],
    ['example.org:99999', true],
    ['-bad.example.org', true],
    ['example.org', false],
    ['*.example.org', false],
    ['api.example.org:8443', false],
    ['EXAMPLE.org', false],
  ])('domain pattern %j (rejected: %s)', (pattern, rejected) => {
    const run = () =>
      parseTemplateYaml(`${MIN}network:\n  mode: allowlist\n  allow: ["${pattern}"]\n`);
    if (rejected) expect(run).toThrow(AboxError);
    else expect(run).not.toThrow();
  });

  it('unknown network presets list the known ones', () => {
    const issues = issuesOf(`${MIN}network:\n  mode: allowlist\n  presets: [npmm]\n`);
    expect(issues[0]!.path).toBe('network.presets[0]');
    expect(issues[0]!.message).toContain('known: npm');
  });

  it('env keys and non-string values', () => {
    const issues = issuesOf(`${MIN}env:\n  bad-key: x\n  PORT: 3000\n`);
    expect(issues.map((i) => i.path)).toEqual(['env.bad-key', 'env.PORT']);
    expect(issues[0]).toMatchObject({ line: 7, column: 3 });
    expect(issues[1]!.message).toContain('must be strings');
  });

  it('mount targets must be absolute, sources absolute or ~', () => {
    expect(issuesOf(`${MIN}mounts:\n  - { source: rel/path, target: /t }\n`)[0]!.path).toBe(
      'mounts[0].source',
    );
    expect(
      issuesOf(`${MIN}mounts:\n  - { source: /a, target: /t/../etc }\n`)[0]!.message,
    ).toContain('".." segments');
  });

  it('secret refs', () => {
    const issues = issuesOf(`${MIN}secrets:\n  - ref: GitHub_Token\n`);
    expect(issues[0]).toMatchObject({ path: 'secrets[0].ref', line: 7 });
  });

  it('reserved label prefix', () => {
    const issues = issuesOf(`${MIN}labels:\n  abox.owner: me\n`);
    expect(issues[0]!.message).toContain('reserved');
  });

  it('unsafe package names are rejected at parse time', () => {
    for (const bad of ['"git; rm -rf /"', '"$(whoami)"', '"-oFoo"', '"a b"', '"`id`"', '"a|b"']) {
      const issues = issuesOf(`${MIN}packages:\n  apk: [${bad}]\n`);
      expect(issues[0]).toMatchObject({ path: 'packages.apk[0]', line: 7 });
    }
    expect(isSafePackageName('apt', 'libstdc++6')).toBe(true);
    expect(isSafePackageName('apt', 'python3=3.12.3-0ubuntu2')).toBe(true);
    expect(isSafePackageName('pip', 'a/b')).toBe(false);
    expect(isSafePackageName('npm', '@scope/pkg@1.2.3')).toBe(true);
    expect(isSafePackageName('npm', '@scope/')).toBe(false);
  });

  it('image references cannot start with a dash', () => {
    expect(issuesOf(MIN.replace('alpine:3.22', '--privileged'))[0]!.path).toBe('base.os');
  });

  it('absolute dockerfile paths', () => {
    expect(
      issuesOf('apiVersion: 1\nname: d\nbackend: docker\nbase:\n  dockerfile: /etc/passwd\n')[0]!
        .path,
    ).toBe('base.dockerfile');
  });

  it('reports every problem, not just the first', () => {
    const issues = issuesOf(`apiVersion: 1\nname: BAD\nbackend: nope\nfoo: 1\n`);
    expect(issues.map((i) => i.path).sort()).toEqual(['backend', 'foo', 'name']);
  });
});

describe('YAML level errors', () => {
  it('syntax errors carry line and column', () => {
    const issues = issuesOf('apiVersion: 1\nname: [unclosed\nbackend: docker\n');
    expect(issues[0]!.line).toBeGreaterThanOrEqual(2);
    expect(issues[0]!.column).toBeGreaterThanOrEqual(1);
    expect(issues[0]!.message.length).toBeGreaterThan(5);
  });

  it('duplicate keys are rejected with the position of the second', () => {
    const issues = issuesOf(`${MIN}name: other\n`);
    expect(issues[0]!.line).toBe(6);
    expect(issues[0]!.message.toLowerCase()).toContain('unique');
  });

  it('empty files and non-mappings', () => {
    expect(issuesOf('')[0]!.message).toContain('empty');
    expect(issuesOf('- a\n- b\n')[0]!.message).toContain('mapping');
    expect(issuesOf('just text\n')[0]!.message).toContain('mapping');
  });

  it('the error message names the file and the first problem', () => {
    try {
      parseTemplateYaml(`${MIN}resources:\n  memory: lots\n`, { path: '/tmp/x.yaml' });
      expect.unreachable();
    } catch (e) {
      const err = e as AboxError;
      expect(err.message).toContain('/tmp/x.yaml');
      expect(err.message).toContain('resources.memory (line 7, column 11)');
      expect(err.exitCode).toBe(2);
    }
  });

  it('rejects oversized files', () => {
    expect(issuesOf(`${MIN}# ${'x'.repeat(600 * 1024)}\n`)[0]!.message).toContain('larger than');
  });
});

describe('annotateIssuePositions', () => {
  it('adds line and column to path-only issues', () => {
    const text = `${MIN}network:\n  mode: allowlist\n  allow: [a.example.org]\n`;
    const out = annotateIssuePositions(text, [
      { path: 'network.mode', message: 'x' },
      { path: 'network.allow[0]', message: 'y' },
      { path: 'tools[3]', message: 'z' },
    ]);
    expect(out[0]).toMatchObject({ line: 7, column: 9 });
    expect(out[1]).toMatchObject({ line: 8 });
    expect(out[2]!.line).toBeGreaterThan(0); // falls back to the nearest existing parent
  });
});
