import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HostRegistry } from './registry.js';
import {
  aliasesOf,
  effectiveForAlias,
  expandGlob,
  importSshConfig,
  matchesPatterns,
  parseSshConfigFile,
  tokenize,
} from './ssh-config.js';
import { sshGForAlias } from './effective.js';

let dir: string;
let sshDir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'abox-hosts-cfg-'));
  sshDir = join(dir, '.ssh');
  mkdirSync(join(sshDir, 'config.d'), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const w = (rel: string, text: string) => writeFileSync(join(sshDir, rel), text);

const MAIN = `
# global
ServerAliveInterval 30

Include config.d/*.conf

Host vps
  HostName server.example.org
  User admin
  Port 2222
  IdentityFile ~/.ssh/id_vps
  IdentityFile ~/.ssh/id_second

Host lab-1 Lab-Two
  HostName=10.0.0.%h
  ProxyJump  jump@gw.example.org:2200

Host *.internal !secret.internal
  User internal-user

Host *
  User fallback
  IdentityFile ~/.ssh/id_default

Match host nothing exec "true"
  User from-match
`;

describe('tokenizer and patterns', () => {
  it('handles quotes, comments and =', () => {
    expect(tokenize('a "b c" d # comment')).toEqual(['a', 'b c', 'd']);
    expect(tokenize('"" x')).toEqual(['', 'x']);
  });
  it('matches ssh patterns', () => {
    expect(matchesPatterns(['*.example.org'], 'a.example.org')).toBe(true);
    expect(matchesPatterns(['*.example.org', '!secret.example.org'], 'secret.example.org')).toBe(
      false,
    );
    expect(matchesPatterns(['h?'], 'h1')).toBe(true);
    expect(matchesPatterns(['h?'], 'h12')).toBe(false);
    expect(matchesPatterns(['!x'], 'y')).toBe(false); // negation alone never matches
    expect(matchesPatterns(['VPS'], 'vps')).toBe(true);
  });
});

describe('parsing', () => {
  it('follows Include with globs relative to the config directory, in order', () => {
    w('config', MAIN);
    w('config.d/10-extra.conf', 'Host extra\n  HostName extra.example.org\n  User x\n');
    w('config.d/20-more.conf', 'Host more\n  HostName more.example.org\n');
    w('config.d/ignored.txt', 'Host ignored\n  HostName ignored.example.org\n');
    const cfg = parseSshConfigFile(join(sshDir, 'config'));
    const { aliases, skippedPatterns } = aliasesOf(cfg);
    expect(aliases).toEqual(['extra', 'more', 'vps', 'lab-1', 'Lab-Two']);
    expect(skippedPatterns).toEqual(['*.internal', '!secret.internal', '*']);
    expect(cfg.warnings.some((x) => x.includes('Match block'))).toBe(true);
  });

  it('applies the first value and merges wildcard blocks like ssh', () => {
    w('config', MAIN);
    const cfg = parseSshConfigFile(join(sshDir, 'config'));
    const vps = effectiveForAlias(cfg, 'vps');
    expect(vps['hostname']).toEqual(['server.example.org']);
    expect(vps['user']).toEqual(['admin']); // vps block before `Host *`
    expect(vps['identityfile']).toEqual(['~/.ssh/id_vps', '~/.ssh/id_second', '~/.ssh/id_default']);
    expect(vps['serveraliveinterval']).toEqual(['30']); // global section
    const lab = effectiveForAlias(cfg, 'lab-1');
    expect(lab['user']).toEqual(['fallback']);
    expect(effectiveForAlias(cfg, 'x.internal')['user']).toEqual(['internal-user']);
    expect(effectiveForAlias(cfg, 'secret.internal')['user']).toEqual(['fallback']);
  });

  it('survives include loops and missing files', () => {
    w('config', 'Include config\nInclude nothere/*\nHost a\n  HostName a.example.org\n');
    const cfg = parseSshConfigFile(join(sshDir, 'config'));
    expect(aliasesOf(cfg).aliases).toEqual(['a']);
    expect(cfg.warnings.length).toBeGreaterThan(0);
  });

  it('expandGlob returns sorted existing files', () => {
    w('config.d/b.conf', '');
    w('config.d/a.conf', '');
    expect(expandGlob(join(sshDir, 'config.d', '*.conf')).map((f) => f.split('/').pop())).toEqual([
      'a.conf',
      'b.conf',
    ]);
    expect(expandGlob(join(sshDir, 'none-*'))).toEqual([]);
  });
});

describe('importSshConfig', () => {
  it('proposes shared-zone, backend-less profiles without touching the config', async () => {
    w('config', MAIN);
    w('config.d/10-extra.conf', 'Host extra\n  HostName extra.example.org\n');
    const before = readFileSync(join(sshDir, 'config'), 'utf8');
    const mtime = statSync(join(sshDir, 'config')).mtimeMs;
    const res = await importSshConfig({ path: join(sshDir, 'config') });
    expect(res.added).toEqual([]);
    expect(res.hosts.map((h) => h.profile.id)).toEqual(['extra', 'vps', 'lab-1', 'lab-two']);

    const vps = res.hosts.find((h) => h.alias === 'vps')!;
    expect(vps.profile).toMatchObject({
      kind: 'ssh',
      sshConfigAlias: 'vps',
      hostname: 'server.example.org',
      user: 'admin',
      port: 2222,
      identityFile: '~/.ssh/id_vps',
      zone: 'shared',
      backends: [],
      tags: ['imported'],
    });
    expect(vps.warnings.join(' ')).toMatch(/several IdentityFile/);

    const lab = res.hosts.find((h) => h.alias === 'lab-1')!;
    expect(lab.profile.hostname).toBe('10.0.0.lab-1'); // %h expands to the alias
    expect(lab.profile.proxyJump).toBe('jump@gw.example.org:2200');
    expect(lab.profile.user).toBe('fallback');
    expect(res.hosts.find((h) => h.alias === 'Lab-Two')!.profile).toMatchObject({
      id: 'lab-two',
      sshConfigAlias: 'Lab-Two',
    });

    // wildcard-only patterns are skipped and reported
    expect(res.skipped.map((s) => s.pattern)).toEqual(expect.arrayContaining(['*', '*.internal']));
    // no identity content, only the path
    expect(JSON.stringify(res)).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
    // read-only
    expect(readFileSync(join(sshDir, 'config'), 'utf8')).toBe(before);
    expect(statSync(join(sshDir, 'config')).mtimeMs).toBe(mtime);
  });

  it('adds to a registry when not a dry run and avoids id collisions', async () => {
    w('config', 'Host local\n  HostName a.example.org\nHost vps\n  HostName b.example.org\n');
    const reg = new HostRegistry({ file: join(dir, 'hosts.yaml') });
    reg.add({ id: 'vps', hostname: 'old.example.org' });
    const dry = await importSshConfig({
      path: join(sshDir, 'config'),
      registry: reg,
      dryRun: true,
    });
    expect(dry.added).toEqual([]);
    expect(reg.list().map((h) => h.id)).toEqual(['local', 'vps']);
    const res = await importSshConfig({
      path: join(sshDir, 'config'),
      registry: reg,
      dryRun: false,
    });
    expect(res.added).toEqual(['local-ssh', 'vps-2']);
    expect(reg.get('vps-2')).toMatchObject({ sshConfigAlias: 'vps', zone: 'shared', backends: [] });
    expect(reg.get('vps')?.hostname).toBe('old.example.org');
  });

  it('returns a warning for a missing config and skips weird values instead of failing', async () => {
    const none = await importSshConfig({ path: join(dir, 'nope') });
    expect(none.hosts).toEqual([]);
    expect(none.warnings[0]).toMatch(/does not exist/);

    w(
      'config',
      'Host odd\n  HostName bad;name\n  ProxyJump -oProxyCommand=x\n  IdentityFile relative/key\nHost fine\n  HostName fine.example.org\n',
    );
    const res = await importSshConfig({ path: join(sshDir, 'config') });
    expect(res.hosts.map((h) => h.alias)).toEqual(['fine']);
    expect(res.skipped.some((s) => s.pattern === 'odd')).toBe(true);
  });

  it('can ask ssh -G for the effective values', async () => {
    w('config', 'Host viag\n  HostName g.example.org\n  Port 2200\n  User gu\n');
    const eff = await sshGForAlias('viag', { sshConfigFile: join(sshDir, 'config') });
    expect(eff).toMatchObject({ hostname: 'g.example.org', port: 2200, user: 'gu' });
    const res = await importSshConfig({
      path: join(sshDir, 'config'),
      useSshG: true,
      env: { sshConfigFile: join(sshDir, 'config') },
    });
    expect(res.hosts[0]!.profile).toMatchObject({
      hostname: 'g.example.org',
      port: 2200,
      user: 'gu',
    });
    expect(res.hosts[0]!.profile.identityFile).toBeUndefined(); // ssh -G default identities are not imported
  });
});
