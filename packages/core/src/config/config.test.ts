import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isAboxError } from '../errors.js';
import { defaultConfig, loadConfig, parseConfig } from './config.js';

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('config', () => {
  it('missing file yields defaults', () => {
    const dir = mkdtempSync(join(tmpdir(), 'abox-cfg-'));
    tmp.push(dir);
    const cfg = loadConfig(join(dir, 'config.yaml'));
    expect(cfg).toEqual(defaultConfig());
    expect(cfg.limits).toEqual({
      execMaxOutputBytes: 65536,
      execTimeoutMs: 120000,
      approvalWaitMs: 30000,
      approvalTtlMs: 15 * 60_000,
    });
    expect(cfg.logs.retentionDays).toBe(3);
    expect(cfg.defaults.template).toBeUndefined();
    expect(cfg.secrets).toEqual({});
  });

  it('caches.max_age defaults to 30d and takes any duration', () => {
    expect(defaultConfig().caches).toEqual({ max_age: '30d' });
    expect(parseConfig('caches:\n  max_age: 12h\n').caches.max_age).toBe('12h');
    expect(() => parseConfig('caches:\n  max_age: soon\n')).toThrowError(/caches\.max_age/);
    expect(() => parseConfig('caches:\n  max_age: 30\n')).toThrowError(/caches/);
    expect(() => parseConfig('caches:\n  ttl: 30d\n')).toThrowError(/caches/);
  });

  it('backends.default was removed and says so', () => {
    expect(() => parseConfig('backends:\n  default: podman\n')).toThrowError(
      /backends\.default was removed/,
    );
  });

  it('empty file yields defaults', () => {
    expect(parseConfig('')).toEqual(defaultConfig());
    expect(parseConfig('# only a comment\n')).toEqual(defaultConfig());
  });

  it('parses a full file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'abox-cfg-'));
    tmp.push(dir);
    const file = join(dir, 'config.yaml');
    writeFileSync(
      file,
      `
backends:
  docker: { socket: /run/user/1000/docker.sock }
  podman: { socket: /run/user/1000/podman/podman.sock }
defaults:
  template: node-dev
limits:
  execTimeoutMs: 5000
logs:
  retentionDays: 7
secrets:
  github-token:
    scheme: basic-x-access-token
    hosts: [github.com]
  openai:
    header: Authorization
    scheme: bearer
`,
    );
    const cfg = loadConfig(file);
    expect(cfg.backends.docker.socket).toBe('/run/user/1000/docker.sock');
    expect(cfg.defaults.template).toBe('node-dev');
    expect(cfg.limits.execTimeoutMs).toBe(5000);
    expect(cfg.limits.execMaxOutputBytes).toBe(65536);
    expect(cfg.logs.retentionDays).toBe(7);
    expect(cfg.secrets['github-token']).toEqual({
      scheme: 'basic-x-access-token',
      hosts: ['github.com'],
    });
  });

  it('reports field paths for invalid values and unknown keys', () => {
    let err: unknown;
    try {
      parseConfig(
        'limits:\n  execTimeoutMs: -1\nsecrets:\n  x:\n    scheme: nope\nbogus: 1\n',
        'config.yaml',
      );
    } catch (e) {
      err = e;
    }
    expect(isAboxError(err)).toBe(true);
    if (!isAboxError(err)) return;
    expect(err.code).toBe('invalid_input');
    const paths = err.issues.map((i) => i.path);
    expect(paths).toContain('limits.execTimeoutMs');
    expect(paths).toContain('secrets.x.scheme');
    expect(err.message).toContain('limits.execTimeoutMs');
  });

  it('reports YAML syntax errors with a line', () => {
    try {
      parseConfig('a: [1, 2\nb: 3');
      expect.unreachable();
    } catch (e) {
      expect(isAboxError(e)).toBe(true);
      if (isAboxError(e)) expect(e.issues[0]?.line).toBeTypeOf('number');
    }
  });
});
