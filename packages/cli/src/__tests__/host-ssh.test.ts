import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEnv, run, type RunOptions, type TestEnv } from './harness.js';

/**
 * `abox ssh`, `abox host rm` and `abox host add --runtime` against a fake ssh that only records its
 * argv (packages/core/src/hosts/__tests__/fake-ssh.mjs): exact arguments, no sshd needed.
 */
const FAKE_SSH = fileURLToPath(
  new URL('../../../core/src/hosts/__tests__/fake-ssh.mjs', import.meta.url),
);

let t: TestEnv;
let log: string;
let opts: RunOptions;
beforeEach(async () => {
  t = makeEnv();
  log = join(t.root, 'ssh.log');
  // helpers that run ssh themselves (`host rm`) inherit the process environment, not the CLI's
  process.env['FAKE_SSH_LOG'] = log;
  process.env['FAKE_SSH_MASTER'] = '1';
  opts = {
    env: { FAKE_SSH_LOG: log, FAKE_SSH_MASTER: '1' },
    runtime: { hostsEnv: { sshBinary: FAKE_SSH, sshConfigFile: null } },
  };
  const add = await run(
    t,
    ['host', 'add', 'vps', '--hostname', 'server.example.org', '--user', 'abox'],
    opts,
  );
  expect(add.code, add.stderr).toBe(0);
});
afterEach(() => {
  delete process.env['FAKE_SSH_LOG'];
  delete process.env['FAKE_SSH_MASTER'];
  t.cleanup();
});

const calls = (): string[][] =>
  existsSync(log)
    ? readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as string[])
    : [];

describe('abox ssh <host> -- <command>', () => {
  it('hands the command to ssh right behind the destination: no second "--" for the remote shell', async () => {
    const r = await run(t, ['ssh', 'vps', '--', 'uptime', '-a'], opts);
    expect(r.code, r.stderr).toBe(0);
    const argv = calls().at(-1)!;
    expect(argv.slice(argv.indexOf('--'))).toEqual(['--', 'server.example.org', 'uptime', '-a']);
    expect(argv.filter((a) => a === '--')).toHaveLength(1);
    // an interactive session: still strict and without agent forwarding
    expect(argv).toContain('BatchMode=no');
    expect(argv).toContain('ForwardAgent=no');
    expect(argv).toContain('StrictHostKeyChecking=yes');
  });

  it('without a command it opens a plain session', async () => {
    const r = await run(t, ['ssh', 'vps'], opts);
    expect(r.code, r.stderr).toBe(0);
    const argv = calls().at(-1)!;
    expect(argv.slice(argv.indexOf('--'))).toEqual(['--', 'server.example.org']);
  });

  it('passes the exit status of the remote command on', async () => {
    const failing = {
      ...opts,
      runtime: { hostsEnv: { sshBinary: '/bin/false', sshConfigFile: null } },
    };
    expect((await run(t, ['ssh', 'vps', '--', 'x'], failing)).code).toBe(1);
  });
});

describe('abox host rm', () => {
  it('ends a live ssh master (ControlPersist) of the host before it forgets the profile', async () => {
    const r = await run(t, ['host', 'rm', 'vps'], opts);
    expect(r.code, r.stderr).toBe(0);
    const exit = calls().find((c) => c.includes('-O'));
    expect(exit).toBeDefined();
    expect(exit![exit!.indexOf('-O') + 1]).toBe('exit');
    expect(exit!.indexOf('-O')).toBeLessThan(exit!.indexOf('--'));
    expect(exit!.at(-1)).toBe('server.example.org');
    expect(exit!.some((a) => a.startsWith('ControlPath=') && a !== 'ControlPath=none')).toBe(true);
    const ls = await run(t, ['host', 'ls', '--json'], opts);
    expect(ls.json.data.hosts.map((h: { id: string }) => h.id)).toEqual(['local']);
  });

  it('an unknown host is not_found and runs no ssh', async () => {
    const before = calls().length;
    const r = await run(t, ['host', 'rm', 'nosuch'], opts);
    expect(r.code).toBe(2);
    expect(calls().length).toBe(before);
  });
});

describe('abox host add --runtime / --allow-rootful', () => {
  it('stores the hardened runtime per engine and the explicit rootful opt-in', async () => {
    const r = await run(
      t,
      [
        'host',
        'add',
        'lab',
        '--hostname',
        'lab.example.org',
        '--backend',
        'docker,podman',
        '--runtime',
        'docker=runsc',
        '--runtime',
        'podman=kata',
        '--allow-rootful',
        '--json',
      ],
      opts,
    );
    expect(r.code, r.stderr).toBe(0);
    expect(r.json.data).toMatchObject({
      runtimes: { docker: 'runsc', podman: 'kata' },
      allowRootful: true,
    });
    const text = readFileSync(join(t.aboxHome, 'config', 'hosts.yaml'), 'utf8');
    expect(text).toMatch(/runtimes: \{ docker: runsc, podman: kata \}/);
    expect(text).toMatch(/allow_rootful: true/);
  });

  it('rejects malformed runtimes with a usage error', async () => {
    for (const bad of ['runsc', 'lxc=runsc', 'docker=', 'docker=runsc --privileged']) {
      const r = await run(
        t,
        [
          'host',
          'add',
          'x1',
          '--hostname',
          'x.example.org',
          '--backend',
          'docker',
          '--runtime',
          bad,
        ],
        opts,
      );
      expect(r.code, bad).toBe(2);
    }
    // a runtime for an engine the host does not have is caught by the profile validation
    const noEngine = await run(
      t,
      [
        'host',
        'add',
        'x2',
        '--hostname',
        'x.example.org',
        '--backend',
        'podman',
        '--runtime',
        'docker=runsc',
      ],
      opts,
    );
    expect(noEngine.code).toBe(2);
    expect(noEngine.stderr).toMatch(/needs the backend docker/);
  });
});
