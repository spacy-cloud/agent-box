import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { renderScanPrelude, scanHostKey } from './known-hosts.js';
import type { HostProfile } from './model.js';
import { hostsEnvFromPaths, type HostsEnv } from './ssh-args.js';

const FAKE_SSH = fileURLToPath(new URL('./__tests__/fake-ssh.mjs', import.meta.url));

describe('renderScanPrelude', () => {
  const target = { hostname: 'behind.example.org', port: 2222 };

  it('routes the throwaway handshake the way the real connection goes', () => {
    const viaCommand = renderScanPrelude(
      'abox-scan-target',
      { ...target, user: 'abox', proxyCommand: 'nc -X 5 -x proxy.example.org:1080 %h %p' },
      '/tmp/s/known_hosts',
    );
    expect(viaCommand).toContain('Host abox-scan-target\n');
    expect(viaCommand).toContain('  HostName behind.example.org\n  Port 2222\n');
    expect(viaCommand).toContain('  ProxyCommand nc -X 5 -x proxy.example.org:1080 %h %p\n');
    expect(viaCommand).toContain('  User abox\n');
    expect(viaCommand).toContain('  PreferredAuthentications none\n');
    expect(viaCommand).toContain('  UserKnownHostsFile /tmp/s/known_hosts\n');
    expect(viaCommand).not.toContain('ProxyJump');
    const viaJump = renderScanPrelude(
      'abox-scan-target',
      { ...target, proxyJump: 'u@jump.example.org:2222' },
      '/tmp/s/known_hosts',
    );
    expect(viaJump).toContain('  ProxyJump u@jump.example.org:2222\n');
    expect(viaJump).not.toContain('ProxyCommand');
  });

  it('refuses values that could add config lines', () => {
    for (const proxyCommand of ['nc %h %p\nProxyJump evil', 'nc\u0000x', 'x'.repeat(5000)]) {
      expect(() => renderScanPrelude('a', { ...target, proxyCommand }, '/k')).toThrow(
        /ProxyCommand/,
      );
    }
    expect(() => renderScanPrelude('a', { ...target, user: 'a\nb' }, '/k')).toThrow(/user/);
    expect(() => renderScanPrelude('a', { ...target, proxyJump: '-oX=y' }, '/k')).toThrow(
      /ProxyJump/,
    );
  });
});

describe('scanHostKey behind a ProxyCommand (fake ssh)', () => {
  let root: string;
  let env: HostsEnv;
  let keyLine: string;
  let fingerprint: string;
  const profile: HostProfile = {
    id: 'behind',
    kind: 'ssh',
    hostname: 'behind.example.org',
    zone: 'shared',
    backends: [],
    tags: [],
    favorite: false,
    portForwards: [],
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'abox-kh-'));
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(root, 'k')]);
    const pub = readFileSync(join(root, 'k.pub'), 'utf8').trim().split(' ');
    keyLine = `${pub[0]} ${pub[1]}`;
    fingerprint = execFileSync('ssh-keygen', ['-lf', join(root, 'k.pub')], { encoding: 'utf8' })
      .trim()
      .split(/\s+/)[1]!;
    env = {
      ...hostsEnvFromPaths(
        { configDir: join(root, 'config'), runtimeDir: join(root, 'run') },
        { sshConfigFile: null, sshBinary: FAKE_SSH, connectTimeoutSec: 2 },
      ),
      // a direct ssh-keyscan would reach the wrong machine: prove it is not used
      sshKeyscanBinary: join(root, 'no-keyscan-here'),
    };
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  afterEach(() => {
    for (const k of ['FAKE_SSH_G', 'FAKE_SSH_CONF_COPY', 'FAKE_SSH_SCAN_KEY', 'FAKE_SSH_LOG'])
      delete process.env[k];
  });

  it('scans through the ProxyCommand of the effective config, not directly', async () => {
    process.env['FAKE_SSH_G'] =
      'hostname behind.example.org\nport 2222\nuser abox\nproxycommand nc -X 5 -x proxy.example.org:1080 %h %p\n';
    process.env['FAKE_SSH_CONF_COPY'] = join(root, 'scan.conf');
    process.env['FAKE_SSH_SCAN_KEY'] = keyLine;
    const scan = await scanHostKey(profile, env);
    expect(scan).toMatchObject({
      via: 'ssh',
      hostname: 'behind.example.org',
      port: 2222,
      hostSpec: '[behind.example.org]:2222',
    });
    expect(scan.keys.map((k) => k.fingerprint)).toEqual([fingerprint]);
    const conf = readFileSync(join(root, 'scan.conf'), 'utf8');
    expect(conf).toContain('ProxyCommand nc -X 5 -x proxy.example.org:1080 %h %p');
    // the throwaway block comes first, the hardening (strict keys for any hops) behind it
    expect(conf.indexOf('Host abox-scan-target')).toBeLessThan(conf.indexOf('Host *'));
    expect(conf).toMatch(/Host \*[\s\S]*StrictHostKeyChecking yes/);
  });

  it('does not guess a direct route when ssh -G fails on a configuration that may hold a proxy', async () => {
    const broken = { ...env, sshBinary: '/bin/false', sshConfigFile: join(root, 'user_config') };
    // ssh-keyscan is never reached (it would be backend_unavailable here)
    await expect(scanHostKey(profile, broken)).rejects.toMatchObject({ code: 'invalid_input' });
    // without a user config there is nothing ssh -G could add: the direct scan is the answer
    await expect(scanHostKey(profile, { ...broken, sshConfigFile: null })).rejects.toMatchObject({
      code: 'backend_unavailable',
    });
  });
});
