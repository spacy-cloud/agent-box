import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { isAboxError } from '../errors.js';
import type { HostProfile, PortForward } from './model.js';
import {
  buildSshArgs,
  controlPathFits,
  hostsEnvFromPaths,
  portForwardArgs,
  sshSessionArgs,
  type HostsEnv,
} from './ssh-args.js';
import { parseSshG } from './effective.js';
import { run } from './exec.js';
import { probeCommand } from './test-host.js';

const root = mkdtempSync(join(tmpdir(), 'abox-args-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const env: HostsEnv = hostsEnvFromPaths(
  { configDir: '/home/u/.config/abox', runtimeDir: join(root, 'run') },
  { sshConfigFile: '/home/u/.ssh/config' },
);

function profile(over: Partial<HostProfile> = {}): HostProfile {
  return {
    id: 'vps',
    kind: 'ssh',
    hostname: 'server.example.org',
    zone: 'shared',
    backends: [],
    tags: [],
    favorite: false,
    portForwards: [],
    ...over,
  };
}

/** Value of the `-o Key=…` option, if present. */
function opt(args: string[], key: string): string | undefined {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '-o' && args[i + 1]!.startsWith(`${key}=`))
      return args[i + 1]!.slice(key.length + 1);
  }
  return undefined;
}

describe('buildSshArgs (batch)', () => {
  const args = buildSshArgs(profile({ user: 'abox', port: 2222, identityFile: '/keys/k' }), env, {
    mode: 'batch',
  });

  it('has the hardening options', () => {
    expect(opt(args, 'BatchMode')).toBe('yes');
    expect(opt(args, 'StrictHostKeyChecking')).toBe('yes');
    expect(opt(args, 'UserKnownHostsFile')).toBe('/home/u/.config/abox/known_hosts');
    expect(opt(args, 'GlobalKnownHostsFile')).toBe('/dev/null');
    expect(opt(args, 'ForwardAgent')).toBe('no');
    expect(opt(args, 'ForwardX11')).toBe('no');
    expect(opt(args, 'ClearAllForwardings')).toBe('yes');
    expect(opt(args, 'PermitLocalCommand')).toBe('no');
    expect(opt(args, 'UpdateHostKeys')).toBe('no');
    expect(opt(args, 'CheckHostIP')).toBe('no');
    expect(opt(args, 'ControlMaster')).toBe('auto');
    expect(opt(args, 'ControlPath')).toBe(
      `${join(root, 'run')}/ssh/${opt(args, 'ControlPath')!.split('/').at(-1)}`,
    );
    expect(opt(args, 'ControlPath')).toMatch(/\/ssh\/[0-9a-f]{8}-%C$/);
    expect(opt(args, 'ControlPersist')).toBe('60');
    expect(opt(args, 'ServerAliveInterval')).toBe('15');
    expect(opt(args, 'ConnectTimeout')).toBe('10');
    expect(opt(args, 'IdentitiesOnly')).toBe('yes');
    expect(opt(args, 'PasswordAuthentication')).toBe('no');
    expect(args).toContain('-a');
    expect(args).toContain('-x');
    expect(args).toContain('-T');
  });

  it('passes a generated, hardened -F config that also covers jump hosts and includes the user config last', () => {
    const f = args[args.indexOf('-F') + 1]!;
    expect(f).toMatch(/\/ssh\/abox-batch-[0-9a-f]{12}\.conf$/);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    const text = readFileSync(f, 'utf8');
    for (const line of [
      'Host *',
      'ForwardAgent no',
      'StrictHostKeyChecking yes',
      'UserKnownHostsFile /home/u/.config/abox/known_hosts',
      'GlobalKnownHostsFile /dev/null',
      'BatchMode yes',
      'PermitLocalCommand no',
    ]) {
      expect(text).toContain(line);
    }
    expect(text.indexOf('Host *')).toBeLessThan(text.indexOf('Include /home/u/.ssh/config'));
    expect(text).toMatch(/Match all\nInclude /);
    // the interactive variant has no BatchMode
    const ia = sshSessionArgs(profile(), env);
    expect(readFileSync(ia[ia.indexOf('-F') + 1]!, 'utf8')).not.toContain('BatchMode');
    // same input -> same file
    expect(buildSshArgs(profile(), env, { mode: 'batch' })[1]).toBe(f);
  });

  it('puts overrides before and the destination after `--`', () => {
    const dd = args.indexOf('--');
    expect(args.slice(dd)).toEqual(['--', 'server.example.org']);
    expect(args.slice(0, dd)).toEqual(
      expect.arrayContaining(['-l', 'abox', '-p', '2222', '-i', '/keys/k']),
    );
    // never `-o StrictHostKeyChecking=no/accept-new` for normal use
    expect(args.join(' ')).not.toMatch(/StrictHostKeyChecking=(no|accept-new)/);
  });

  it('never enables agent forwarding anywhere', () => {
    for (const mode of ['batch', 'interactive', 'tunnel'] as const) {
      const a = buildSshArgs(profile(), env, { mode });
      expect(a.join(' ')).not.toMatch(/ForwardAgent=yes|\s-A(\s|$)/);
      expect(opt(a, 'ForwardAgent')).toBe('no');
    }
  });

  it('uses the ssh_config alias as destination and lets the profile override', () => {
    const a = buildSshArgs(
      profile({ hostname: undefined, sshConfigAlias: 'lab-1', user: 'abox' }),
      env,
      { mode: 'batch' },
    );
    expect(a.slice(a.indexOf('--'))).toEqual(['--', 'lab-1']);
    expect(a).toContain('abox');
  });

  it('passes a fixed remote command as ONE argument after the destination', () => {
    const a = buildSshArgs(profile(), env, {
      mode: 'batch',
      remoteCommand: probeCommand('/run/user/1001/podman/podman.sock'),
    });
    const dd = a.indexOf('--');
    expect(a).toHaveLength(dd + 3);
    expect(a[dd + 2]).toMatch(/^sh -c '/);
  });

  it('supports an extra read-only user known_hosts, no user config, and proxy jump', () => {
    const a = buildSshArgs(
      profile({ proxyJump: 'u@jump.example.org:2222' }),
      { ...env, sshConfigFile: null, userKnownHostsFile: '/home/u/.ssh/known_hosts' },
      { mode: 'batch' },
    );
    expect(readFileSync(a[1]!, 'utf8')).not.toContain('Include');
    expect(readFileSync(a[1]!, 'utf8')).toContain(
      'UserKnownHostsFile /home/u/.config/abox/known_hosts /home/u/.ssh/known_hosts',
    );
    expect(a).toEqual(expect.arrayContaining(['-J', 'u@jump.example.org:2222']));
    expect(opt(a, 'UserKnownHostsFile')).toBe(
      '/home/u/.config/abox/known_hosts /home/u/.ssh/known_hosts',
    );
  });

  it('quotes paths with spaces and escapes % for ssh', () => {
    const a = buildSshArgs(
      profile(),
      { ...env, knownHostsFile: '/tmp/a b/known_hosts', runtimeDir: join(root, '100%', 'run') },
      { mode: 'batch' },
    );
    expect(opt(a, 'UserKnownHostsFile')).toBe('"/tmp/a b/known_hosts"');
    expect(opt(a, 'ControlPath')).toBe(
      `${join(root, '100%%', 'run')}/ssh/${opt(a, 'ControlPath')!.split('/').at(-1)}`,
    );
    expect(readFileSync(a[1]!, 'utf8')).toContain('UserKnownHostsFile "/tmp/a b/known_hosts"');
  });

  it('drops multiplexing when the control path would not fit sun_path', () => {
    const long = { ...env, runtimeDir: join(root, 'x'.repeat(80)) };
    expect(controlPathFits(long.runtimeDir)).toBe(false);
    const a = buildSshArgs(profile(), long, { mode: 'batch' });
    expect(opt(a, 'ControlMaster')).toBe('no');
    expect(opt(a, 'ControlPath')).toBe('none');
  });

  it('can disable multiplexing', () => {
    const a = buildSshArgs(profile(), { ...env, multiplex: false }, { mode: 'batch' });
    expect(opt(a, 'ControlMaster')).toBe('no');
  });
});

describe('interactive and forward modes', () => {
  it('sshSessionArgs: no BatchMode, still strict and agent-free', () => {
    const a = sshSessionArgs(profile(), env);
    expect(opt(a, 'BatchMode')).toBe('no');
    expect(a).not.toContain('-T');
    expect(a).not.toContain('-N');
    expect(opt(a, 'StrictHostKeyChecking')).toBe('yes');
    expect(opt(a, 'ForwardAgent')).toBe('no');
  });

  it('session forwards keep ClearAllForwardings off and bind loopback explicitly', () => {
    const f: PortForward[] = [
      { name: 'web', kind: 'local', listen: '8080', target: 'localhost:80' },
      { name: 'rev', kind: 'remote', listen: '127.0.0.1:9000', target: 'localhost:9000' },
      { name: 'socks', kind: 'dynamic', listen: '1080' },
    ];
    const a = sshSessionArgs(profile(), env, { forwardings: f });
    expect(opt(a, 'ClearAllForwardings')).toBeUndefined();
    expect(a).toEqual(
      expect.arrayContaining([
        '-L',
        '127.0.0.1:8080:localhost:80',
        '-R',
        '127.0.0.1:9000:localhost:9000',
        '-D',
        '127.0.0.1:1080',
      ]),
    );
  });

  it('portForwardArgs: -N, ExitOnForwardFailure, no mux, by name', () => {
    const p = profile({
      portForwards: [{ name: 'web', kind: 'local', listen: '8080', target: 'db:5432' }],
    });
    const a = portForwardArgs(p, env, 'web');
    expect(a).toContain('-N');
    expect(opt(a, 'ExitOnForwardFailure')).toBe('yes');
    expect(opt(a, 'ControlMaster')).toBe('no');
    expect(opt(a, 'BatchMode')).toBe('yes');
    expect(() => portForwardArgs(p, env, 'nope')).toThrow(/no port forward/);
  });
});

describe('injection resistance', () => {
  const evil = [
    '-oProxyCommand=touch /tmp/pwned',
    '-o ProxyCommand=id',
    'host;rm -rf /',
    'host\nProxyCommand id',
    'host`id`',
    '$(id)',
    'host && id',
    "host' ; id #",
    'host|id',
    '--help',
    '-',
    'a b',
    '',
  ];

  it('rejects dangerous hostnames', () => {
    for (const h of evil) {
      expect(
        () => buildSshArgs(profile({ hostname: h }), env, { mode: 'batch' }),
        JSON.stringify(h),
      ).toThrow();
    }
  });

  it('rejects dangerous aliases, users, jump hosts and key paths', () => {
    for (const h of evil) {
      expect(
        () =>
          buildSshArgs(profile({ hostname: undefined, sshConfigAlias: h }), env, { mode: 'batch' }),
        `alias ${JSON.stringify(h)}`,
      ).toThrow();
      expect(
        () => buildSshArgs(profile({ user: h }), env, { mode: 'batch' }),
        `user ${JSON.stringify(h)}`,
      ).toThrow();
      expect(
        () => buildSshArgs(profile({ proxyJump: h }), env, { mode: 'batch' }),
        `jump ${JSON.stringify(h)}`,
      ).toThrow();
    }
    for (const k of ['-oProxyCommand=x', 'relative', '/k\n/ey', '/k"ey', '/k%d']) {
      expect(() => buildSshArgs(profile({ identityFile: k }), env, { mode: 'batch' }), k).toThrow();
    }
  });

  it('reports invalid_input with a field path', () => {
    try {
      buildSshArgs(profile({ hostname: '-oProxyCommand=x' }), env, { mode: 'batch' });
      throw new Error('accepted');
    } catch (e) {
      expect(isAboxError(e) && e.code).toBe('invalid_input');
      expect(isAboxError(e) && e.issues[0]?.path).toBe('hostname');
    }
  });

  it('a valid hostname never produces an argument that looks like an option after `--`', () => {
    const a = buildSshArgs(profile({ hostname: 'a-b.example.org' }), env, { mode: 'batch' });
    const dd = a.indexOf('--');
    expect(a.slice(dd + 1).every((x) => !x.startsWith('-'))).toBe(true);
  });

  it('refuses non-ssh profiles', () => {
    expect(() =>
      buildSshArgs({ ...profile(), id: 'local', kind: 'local' }, env, { mode: 'batch' }),
    ).toThrow(/not an ssh host/);
  });

  it('the remote probe cannot be influenced through engine_socket', () => {
    for (const s of ["/x'; id; '", '/x";id;"', '/x$(id)', '/x`id`', '/x y']) {
      expect(() => buildSshArgs(profile({ engineSocket: s }), env, { mode: 'batch' }), s).toThrow();
    }
    const cmd = probeCommand('/run/user/1001/podman/podman.sock');
    // only the wrapper's two quotes
    expect(cmd.match(/'/g)).toHaveLength(2);
    expect(cmd.includes('\n')).toBe(false);
    expect(cmd.includes('!')).toBe(false);
  });
});

describe('abox ssh <host> -- <command>', () => {
  it('puts the typed command right behind the destination, with no second `--`', () => {
    const a = sshSessionArgs(profile(), env, { command: ['uptime', '-a'] });
    expect(a.slice(a.indexOf('--'))).toEqual(['--', 'server.example.org', 'uptime', '-a']);
    expect(a.filter((x) => x === '--')).toHaveLength(1);
  });

  it('without a command the argv ends at the destination', () => {
    const a = sshSessionArgs(profile(), env, { command: [] });
    expect(a.slice(a.indexOf('--'))).toEqual(['--', 'server.example.org']);
  });

  it('is for interactive sessions of a human only', () => {
    expect(() => buildSshArgs(profile(), env, { mode: 'batch', userCommand: ['id'] })).toThrow(
      /interactive/,
    );
    expect(() =>
      buildSshArgs(profile(), env, {
        mode: 'interactive',
        remoteCommand: 'id',
        userCommand: ['id'],
      }),
    ).toThrow();
  });
});

describe('local environment variables stay local', () => {
  it('clears SendEnv last: a user config (or a distribution default) cannot forward variables', async () => {
    const userConf = join(root, 'user_config');
    writeFileSync(
      userConf,
      'SendEnv LANG LC_*\nHost *\n  SendEnv SECRET_TOKEN\nHost vps\n  HostName server.example.org\n  SendEnv MORE\n',
    );
    const e: HostsEnv = { ...env, sshConfigFile: userConf, runtimeDir: join(root, 'run-env') };
    for (const mode of ['batch', 'interactive', 'tunnel'] as const) {
      const a = buildSshArgs(profile({ sshConfigAlias: 'vps', hostname: undefined }), e, { mode });
      const conf = a[a.indexOf('-F') + 1]!;
      const text = readFileSync(conf, 'utf8');
      expect(text.trimEnd().endsWith('Match all\n  SendEnv -*')).toBe(true);
      expect(text.indexOf('Include')).toBeLessThan(text.indexOf('SendEnv -*'));
      // what ssh itself computes from that config
      const res = await run('ssh', ['-G', '-F', conf, '--', 'vps']);
      expect(res.code).toBe(0);
      expect(parseSshG(res.stdout).hostname).toBe('server.example.org');
      expect(res.stdout).not.toMatch(/^sendenv /m);
    }
    // control: without the clearing entry the same config does send them
    const bare = join(root, 'no_clear');
    writeFileSync(bare, `Match all\nInclude ${userConf}\n`);
    const ctl = await run('ssh', ['-G', '-F', bare, '--', 'vps']);
    expect(ctl.stdout).toMatch(/^sendenv SECRET_TOKEN$/m);
  });
});
