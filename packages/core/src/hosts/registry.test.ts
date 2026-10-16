import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isAboxError } from '../errors.js';
import { HostRegistry } from './registry.js';

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'abox-hosts-reg-'));
  file = join(dir, 'config', 'hosts.yaml');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('HostRegistry', () => {
  it('lists the implicit local host without a file', () => {
    const r = new HostRegistry({ file });
    expect(r.list().map((h) => h.id)).toEqual(['local']);
    expect(existsSync(file)).toBe(false);
    expect(r.resolve('local')).toMatchObject({
      zone: 'workstation',
      minIsolation: 'none',
      requiresApproval: false,
    });
  });

  it('adds, gets, updates, removes; file is 0600 and loadable by a second instance', () => {
    const r = new HostRegistry({ file });
    const added = r.add({
      id: 'vps',
      hostname: 'server.example.org',
      user: 'abox',
      backends: ['podman'],
      engineSocket: '/run/user/1001/podman/podman.sock',
      tags: ['internet'],
      limits: { cpus: 1, memory: '2g', sandboxes: 2 },
    });
    expect(added.zone).toBe('shared');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'config')).mode & 0o777).toBe(0o700);

    const other = new HostRegistry({ file });
    expect(other.get('vps')).toMatchObject({
      hostname: 'server.example.org',
      user: 'abox',
      tags: ['internet'],
    });
    expect(other.list().map((h) => h.id)).toEqual(['local', 'vps']);

    const u = r.update('vps', { favorite: true, zone: 'lab', tags: null, port: 2222 });
    expect(u).toMatchObject({ favorite: true, zone: 'lab', port: 2222, tags: [] });
    // `other` notices the change on disk
    expect(other.get('vps')).toMatchObject({ zone: 'lab', port: 2222 });

    expect(r.remove('vps')).toBe(true);
    expect(r.remove('vps')).toBe(false);
    expect(r.get('vps')).toBeUndefined();
    expect(
      readdirSync(join(dir, 'config')).filter((f) => f.endsWith('.tmp') || f.endsWith('.lock')),
    ).toEqual([]);
  });

  it('refuses duplicates, unknown hosts and removing local', () => {
    const r = new HostRegistry({ file });
    r.add({ id: 'a', hostname: 'a.example.org' });
    expect(() => r.add({ id: 'a', hostname: 'b.example.org' })).toThrow(/already exists/);
    expect(() => r.update('zzz', { favorite: true })).toThrow(/unknown host/);
    expect(() => r.remove('local')).toThrow(/cannot be removed/);
    expect(() => r.require('zzz')).toThrow(/unknown host/);
    try {
      r.require('zzz');
    } catch (e) {
      expect(isAboxError(e) && e.hint).toMatch(/Known hosts: local, a/);
    }
  });

  it('validates before writing and leaves the file untouched on error', () => {
    const r = new HostRegistry({ file });
    r.add({ id: 'a', hostname: 'a.example.org' });
    const before = readFileSync(file, 'utf8');
    try {
      r.add({ id: 'b', hostname: '-oProxyCommand=x' });
      throw new Error('accepted');
    } catch (e) {
      expect(isAboxError(e) && e.code === 'invalid_input').toBe(true);
    }
    expect(() => r.update('a', { user: 'a b' })).toThrow();
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('keeps comments of other hosts and never writes secrets fields', () => {
    writeFileSync(
      join(dir, 'h.yaml'),
      `# my notes\nhosts:\n  keep:\n    # about keep\n    hostname: keep.example.org\n    zone: lab\n    backends: [docker]\n`,
      { mode: 0o644 },
    );
    const r = new HostRegistry({ file: join(dir, 'h.yaml') });
    r.add({ id: 'new', hostname: 'new.example.org', identityFile: '~/.ssh/id_ed25519' });
    const text = readFileSync(join(dir, 'h.yaml'), 'utf8');
    expect(text).toContain('# my notes');
    expect(text).toContain('# about keep');
    expect(text).toContain('identity_file: ~/.ssh/id_ed25519');
    expect(text).not.toMatch(/password|passphrase|BEGIN/i);
    expect(statSync(join(dir, 'h.yaml')).mode & 0o777).toBe(0o600);
  });

  it('refuses to run on a broken file instead of overwriting it', () => {
    const f = join(dir, 'broken.yaml');
    writeFileSync(f, 'hosts: [\n');
    const r = new HostRegistry({ file: f });
    expect(() => r.list()).toThrow(/invalid hosts file/);
    expect(() => r.add({ id: 'a', hostname: 'a.example.org' })).toThrow();
    expect(readFileSync(f, 'utf8')).toBe('hosts: [\n');
  });

  it('allows overriding the implicit local host', () => {
    const r = new HostRegistry({ file });
    r.update('local', { limits: { sandboxes: 5 } });
    expect(r.resolve('local').limits).toEqual({ sandboxes: 5 });
    expect(r.get('local')?.kind).toBe('local');
  });

  it('serialises concurrent writers', async () => {
    const r1 = new HostRegistry({ file });
    const r2 = new HostRegistry({ file });
    for (let i = 0; i < 10; i++) {
      (i % 2 ? r1 : r2).add({ id: `h${i}`, hostname: `h${i}.example.org` });
    }
    expect(new HostRegistry({ file }).list()).toHaveLength(11);
  });
});

describe('zone defaults (resolve)', () => {
  it('maps zones to minimum isolation and approval', () => {
    const r = new HostRegistry({ file });
    r.add({ id: 'w', hostname: 'w.example.org', zone: 'workstation' });
    r.add({ id: 'l', hostname: 'l.example.org', zone: 'lab' });
    r.add({ id: 's', hostname: 's.example.org', zone: 'shared' });
    r.add({ id: 'x', hostname: 'x.example.org', zone: 'restricted' });
    r.add({ id: 'default-zone', hostname: 'd.example.org' });
    expect(r.resolve('w')).toMatchObject({ minIsolation: 'none', requiresApproval: false });
    expect(r.resolve('l')).toMatchObject({ minIsolation: 'none', requiresApproval: false });
    expect(r.resolve('s')).toMatchObject({ minIsolation: 'hardened', requiresApproval: true });
    expect(r.resolve('x')).toMatchObject({ minIsolation: 'vm', requiresApproval: true });
    expect(r.resolve('default-zone').zone).toBe('shared');
  });

  it('an explicit min_isolation can only raise the zone default', () => {
    const r = new HostRegistry({ file });
    r.add({ id: 'weak', hostname: 'a.example.org', zone: 'shared', minIsolation: 'container' });
    r.add({ id: 'strong', hostname: 'b.example.org', zone: 'shared', minIsolation: 'vm' });
    r.add({ id: 'lab-vm', hostname: 'c.example.org', zone: 'lab', minIsolation: 'container' });
    expect(r.resolve('weak').minIsolation).toBe('hardened');
    expect(r.resolve('strong').minIsolation).toBe('vm');
    expect(r.resolve('lab-vm').minIsolation).toBe('container');
  });

  it('resolves limits including bytes', () => {
    const r = new HostRegistry({ file });
    r.add({ id: 'h', hostname: 'h.example.org', limits: { cpus: 2, memory: '4g', sandboxes: 3 } });
    expect(r.resolve('h').limits).toEqual({
      cpus: 2,
      memory: '4g',
      memoryBytes: 4 * 1024 ** 3,
      sandboxes: 3,
    });
  });
});
