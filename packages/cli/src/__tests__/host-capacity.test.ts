import { execFileSync } from 'node:child_process';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseHostsYaml, type HostCapacity, type HostProfile } from '@abox/core';
import { applyHostLimitsPatch } from '../commands/host.js';
import {
  aboxText,
  capacityLines,
  liveText,
  limitsText,
  machineText,
  usageCell,
} from '../commands/host-capacity.js';
import { makeEnv, run, writeScript, type RunOptions, type TestEnv } from './harness.js';

const FAKE_SSH = fileURLToPath(
  new URL('../../../core/src/hosts/__tests__/fake-ssh.mjs', import.meta.url),
);

let t: TestEnv;
beforeEach(() => {
  t = makeEnv();
});
afterEach(() => t.cleanup());

/** The profiles in hosts.yaml (parsed the way abox reads them), by id. */
const hostsYaml = (): Record<string, HostProfile> =>
  Object.fromEntries(
    parseHostsYaml(readFileSync(join(t.aboxHome, 'config', 'hosts.yaml'), 'utf8')),
  );

describe('abox host set', () => {
  beforeEach(async () => {
    const add = await run(t, [
      'host',
      'add',
      'vps',
      '--hostname',
      'server.example.org',
      '--user',
      'abox',
    ]);
    expect(add.code, add.stderr).toBe(0);
  });

  it('sets, changes and removes the limits of an existing host without remove + add', async () => {
    const set = await run(t, ['host', 'set', 'vps', '--max-sandboxes', '3', '--json']);
    expect(set.code, set.stderr).toBe(0);
    expect(set.json.data.limits).toEqual({ sandboxes: 3 });
    expect(hostsYaml().vps.limits).toEqual({ sandboxes: 3 });

    // the other limits arrive next to it; a limit that is not mentioned stays
    const more = await run(t, ['host', 'set', 'vps', '--cpus', '8', '--memory', '16g']);
    expect(more.code, more.stderr).toBe(0);
    expect(more.stdout).toContain('limits are now 3 sandboxes, 8 cpus, 16g memory');
    expect(hostsYaml().vps.limits).toEqual({ sandboxes: 3, cpus: 8, memory: '16g' });

    // change one, remove one
    const change = await run(t, ['host', 'set', 'vps', '--max-sandboxes', '5', '--memory', 'none']);
    expect(change.code, change.stderr).toBe(0);
    expect(hostsYaml().vps.limits).toEqual({ sandboxes: 5, cpus: 8 });

    // removing the last ones leaves no empty `limits:` behind
    const clear = await run(t, ['host', 'set', 'vps', '--max-sandboxes', 'none', '--cpus', 'none']);
    expect(clear.stdout).toContain('limits are now none');
    expect(hostsYaml().vps.limits).toBeUndefined();
    // the rest of the profile is untouched
    expect(hostsYaml().vps).toMatchObject({ hostname: 'server.example.org', user: 'abox' });
  });

  it('shows the limits in host ls and records the change in the audit log', async () => {
    await run(t, ['host', 'set', 'vps', '--max-sandboxes', '3', '--cpus', '2', '--memory', '4g']);
    const ls = await run(t, ['host', 'ls']);
    expect(ls.stdout).toMatch(/LIMITS/);
    expect(ls.stdout).toContain('3 sandboxes, 2 cpus, 4g memory');
    const audit = await run(t, ['audit', '--action', 'host.update', '--json']);
    const entry = JSON.stringify(audit.json);
    expect(entry).toContain('host.update');
    expect(entry).toContain('"sandboxes":3');
  });

  it('accepts 0 sandboxes like host add (nothing may be created there)', async () => {
    const r = await run(t, ['host', 'set', 'vps', '--max-sandboxes', '0']);
    expect(r.code, r.stderr).toBe(0);
    expect(hostsYaml().vps.limits).toEqual({ sandboxes: 0 });
  });

  it('validates like host add and changes nothing on a bad value', async () => {
    await run(t, ['host', 'set', 'vps', '--cpus', '2']);
    for (const args of [
      ['--max-sandboxes', '-1'],
      ['--max-sandboxes', '3.5'],
      ['--max-sandboxes', '10001'],
      ['--max-sandboxes', 'many'],
      ['--cpus', '0'],
      ['--cpus', '1025'],
      ['--cpus', 'lots'],
      ['--memory', 'plenty'],
      ['--memory', '0'],
    ]) {
      const r = await run(t, ['host', 'set', 'vps', ...args, '--json']);
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.json).toMatchObject({ ok: false, code: 'invalid_input' });
    }
    expect(hostsYaml().vps.limits).toEqual({ cpus: 2 });
  });

  it('needs something to change and a known host', async () => {
    const none = await run(t, ['host', 'set', 'vps', '--json']);
    expect(none.code).toBe(2);
    expect(none.json.hint).toContain('none');
    const unknown = await run(t, ['host', 'set', 'nope', '--cpus', '2', '--json']);
    expect(unknown.code).toBe(2);
    expect(unknown.json).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('can limit the local host too (kept in hosts.yaml) and the limit holds for creates', async () => {
    const set = await run(t, ['host', 'set', 'local', '--max-sandboxes', '1']);
    expect(set.code, set.stderr).toBe(0);
    expect(hostsYaml().local.limits).toEqual({ sandboxes: 1 });
    const first = await run(t, ['create', 'host-shell', '--workspace', '.', '--yes', '--json']);
    expect(first.code, first.stderr).toBe(0);
    const second = await run(t, ['create', 'host-shell', '--workspace', '.', '--yes', '--json']);
    expect(second.code).toBe(3);
    expect(second.json.message).toContain('its limit is 1');
    await run(t, ['rm', '--force', first.json.data.sandbox.id]);
    // and it can be lifted again
    await run(t, ['host', 'set', 'local', '--max-sandboxes', 'none']);
    expect(hostsYaml().local.limits).toBeUndefined();
  });
});

describe('applyHostLimitsPatch', () => {
  it('keeps what is not mentioned, replaces what is given, drops "none"', () => {
    expect(
      applyHostLimitsPatch({ sandboxes: 3, cpus: 4, memory: '8g' }, { cpus: '2', memory: 'none' }),
    ).toEqual({ sandboxes: 3, cpus: 2 });
    expect(applyHostLimitsPatch(undefined, { maxSandboxes: '2' })).toEqual({ sandboxes: 2 });
    expect(applyHostLimitsPatch({ sandboxes: 2 }, { maxSandboxes: 'NONE' })).toEqual({});
    // the input is not changed
    const cur = { cpus: 4 };
    applyHostLimitsPatch(cur, { cpus: 'none' });
    expect(cur).toEqual({ cpus: 4 });
  });
});

describe('formatting of capacity', () => {
  const GIB = 1024 ** 3;
  const cap: HostCapacity = {
    host: 'vps',
    ts: 1,
    capacity: { cpus: 8, memoryBytes: 16 * GIB, source: 'engine' },
    live: {
      available: true,
      cpuPercent: 35,
      load: { m1: 0.5, m5: 0.6, m15: 0.7 },
      memoryTotalBytes: 16 * GIB,
      memoryAvailableBytes: 6 * GIB,
      memoryUsedBytes: 10 * GIB,
      source: 'ssh',
    },
    abox: {
      sandboxes: 2,
      running: 1,
      reserved: { cpus: 3, memoryBytes: 3 * GIB },
      usage: { cpuPercent: 12.5, memoryBytes: 200 * 1024 * 1024, sampled: 1 },
    },
    limits: {
      sandboxes: { limit: 3, reserved: 2 },
      memoryBytes: { limit: 12 * GIB, reserved: 3 * GIB },
    },
  };

  it('describes machine, load, abox and limits', () => {
    expect(machineText(cap)).toBe('8 cpus, 16.0 GiB memory (engine)');
    expect(liveText(cap)).toBe('cpu 35%, memory 10.0 GiB of 16.0 GiB (63%), load 0.5 0.6 0.7');
    expect(aboxText(cap)).toBe(
      '2 sandboxes (1 running) reserve 3 cpus and 3.0 GiB; using 12.5% of one cpu and 200 MiB',
    );
    expect(Object.fromEntries(capacityLines(cap))['limits']).toBe(
      'sandboxes 2 of 3, memory 3.0 GiB of 12.0 GiB',
    );
    expect(usageCell(cap)).toBe('cpu 35% ram 63%; 2 reserved');
    expect(limitsText({ sandboxes: 1 })).toBe('1 sandbox');
    expect(limitsText(undefined)).toBe('-');
  });

  it('says unknown instead of inventing numbers', () => {
    const unknown = {
      ...cap,
      capacity: { cpus: null, memoryBytes: null, source: 'unknown' },
      live: {
        available: false,
        reason: 'login failed',
        cpuPercent: null,
        load: null,
        memoryTotalBytes: null,
        memoryAvailableBytes: null,
        memoryUsedBytes: null,
        source: null,
      },
      abox: { ...cap.abox, usage: null },
      limits: {},
    };
    expect(machineText(unknown)).toBe('unknown');
    expect(liveText(unknown)).toBe('unknown (login failed)');
    expect(usageCell(unknown)).toBe('live unknown; 2 reserved');
    expect(usageCell(undefined, 'host key not trusted')).toBe('unknown (host key not trusted)');
    expect(Object.fromEntries(capacityLines(unknown))['limits']).toBeUndefined();
  });
});

describe('capacity of local through the CLI', () => {
  it('host ls --json includes capacity and live numbers of this machine', async () => {
    const r = await run(t, ['host', 'ls', '--json']);
    expect(r.code, r.stderr).toBe(0);
    const local = r.json.data.hosts.find((h: { id: string }) => h.id === 'local');
    expect(local.capacity).toMatchObject({ host: 'local' });
    expect(local.capacity.capacity.cpus).toBeGreaterThan(0);
    expect(local.capacity.capacity.memoryBytes).toBeGreaterThan(0);
    // on Linux /proc is there; elsewhere it is reported as unknown, never guessed
    if (process.platform === 'linux') {
      expect(local.capacity.live.available).toBe(true);
      expect(local.capacity.live.memoryTotalBytes).toBeGreaterThan(0);
    }
    expect(local.capacity.abox.sandboxes).toBe(0);
  });

  it('host ls --usage adds a USAGE column; plain host ls reads nothing', async () => {
    const plain = await run(t, ['host', 'ls']);
    expect(plain.stdout).not.toContain('USAGE');
    const usage = await run(t, ['host', 'ls', '--usage']);
    expect(usage.stdout).toContain('USAGE');
    expect(usage.stdout).toMatch(/cpu \d+% ram \d+%|live unknown/);
  });
});

describe('create prints the estimate', () => {
  it('as one line on stderr for a person, with the over-commit warnings', async () => {
    await run(t, ['host', 'set', 'local', '--max-sandboxes', '3']);
    const r = await run(t, ['create', 'host-shell', '--workspace', '.', '--yes'], { tty: true });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/Fits ~\d+x on local/);
    expect(r.stderr).toContain('reserved');
    await run(t, ['rm', '--force', r.stdout.match(/created (local\/[0-9a-f]{8})/)![1]!]);
  });

  it('is in the --json result, and not on stderr', async () => {
    await run(t, ['host', 'set', 'local', '--max-sandboxes', '3']);
    const r = await run(t, ['create', 'host-shell', '--workspace', '.', '--yes', '--json']);
    expect(r.code, r.stderr).toBe(0);
    const e = r.json.data.estimate;
    expect(e).toMatchObject({ host: 'local', blocked: [] });
    expect(e.request.template).toBe('host-shell');
    expect(e.fits).toBeGreaterThan(0);
    expect(e.bounds).toContainEqual(
      expect.objectContaining({ source: 'limit', resource: 'sandboxes', count: 3 }),
    );
    expect(e.capacity.host).toBe('local');
    expect(r.stderr).not.toContain('Fits');
    await run(t, ['rm', '--force', r.json.data.sandbox.id]);
  });

  it('is not asked for when nothing would show it, and a failure to estimate never fails the create', async () => {
    const quiet = await run(t, ['create', 'host-shell', '--workspace', '.', '--yes', '--quiet']);
    expect(quiet.code, quiet.stderr).toBe(0);
    expect(quiet.stderr).not.toContain('Fits');
    await run(t, ['rm', '--force', quiet.stdout.trim()]);
    const bad = await run(t, ['create', 'no-such-template', '--json']);
    expect(bad.code).toBe(2);
    expect(bad.json.code).toBe('not_found');
  });

  it('tells a person up front that a host limit will refuse the create', async () => {
    await run(t, ['host', 'set', 'local', '--max-sandboxes', '0']);
    const r = await run(t, ['create', 'host-shell', '--workspace', '.', '--yes'], { tty: true });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('Will be refused on local');
  });
});

describe('an ssh host over a stand-in ssh', () => {
  let opts: RunOptions;
  let key: string;
  beforeEach(async () => {
    // a key the "server" presents, and its entry in abox's known_hosts
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(t.root, 'hostkey')]);
    const pub = readFileSync(join(t.root, 'hostkey.pub'), 'utf8').trim().split(' ');
    key = `${pub[0]} ${pub[1]}`;
    const fingerprint = execFileSync('ssh-keygen', ['-lf', join(t.root, 'hostkey.pub')], {
      encoding: 'utf8',
    })
      .trim()
      .split(/\s+/)[1]!;
    const keyscan = writeScript(t, 'bin/ssh-keyscan', `echo 'server.example.org ${key}'`);
    chmodSync(keyscan, 0o755);
    writeFileSync(
      join(t.root, 'live.txt'),
      [
        'abox.uname',
        'Linux',
        'abox.stat1',
        'cpu  4705 356 584 3699 23 23 0 0 0 0',
        'abox.stat2',
        'cpu  4805 356 604 3779 23 23 0 0 0 0',
        'abox.loadavg',
        '0.52 0.58 0.59 1/467 12345',
        'abox.meminfo',
        'MemTotal:       16777216 kB',
        'MemAvailable:    6710886 kB',
        'abox.cpus',
        '8',
        '',
      ].join('\n'),
    );
    const info = JSON.stringify({
      SecurityOptions: ['name=seccomp', 'name=rootless'],
      Runtimes: { runc: {} },
      NCPU: 8,
      MemTotal: 16 * 1024 ** 3,
    });
    opts = {
      env: { FAKE_SSH_LIVE: join(t.root, 'live.txt'), FAKE_SSH_INFO: info },
      runtime: {
        hostsEnv: { sshBinary: FAKE_SSH, sshKeyscanBinary: keyscan, sshConfigFile: null },
      },
    };
    // the tunnel is a child of the CLI process: it gets the process environment
    process.env['FAKE_SSH_LIVE'] = join(t.root, 'live.txt');
    process.env['FAKE_SSH_INFO'] = info;
    const add = await run(
      t,
      [
        'host',
        'add',
        'vps',
        '--hostname',
        'server.example.org',
        '--user',
        'abox',
        '--zone',
        'lab',
        '--backend',
        'docker',
        '--engine-socket',
        '/run/user/1000/docker.sock',
        '--max-sandboxes',
        '3',
      ],
      opts,
    );
    expect(add.code, add.stderr).toBe(0);
    const trust = await run(t, ['host', 'trust', 'vps', '--fingerprint', fingerprint], opts);
    expect(trust.code, trust.stderr).toBe(0);
  });
  afterEach(() => {
    delete process.env['FAKE_SSH_LIVE'];
    delete process.env['FAKE_SSH_INFO'];
  });

  it('host test shows the size of the machine, what is in use and the limits', async () => {
    const r = await run(t, ['host', 'test', 'vps', '--json'], opts);
    expect(r.code, r.stderr).toBe(0);
    expect(r.json.data.capacity).toMatchObject({
      host: 'vps',
      capacity: { cpus: 8, memoryBytes: 16 * 1024 ** 3, source: 'engine' },
      live: { available: true, cpuPercent: 60, source: 'ssh' },
      limits: { sandboxes: { limit: 3, reserved: 0 } },
    });
    const text = await run(t, ['host', 'test', 'vps'], opts);
    expect(text.stdout).toMatch(/capacity: +8 cpus, 16.0 GiB memory \(engine\)/);
    expect(text.stdout).toContain('in use now:    cpu 60%, memory 9.6 GiB of 16.0 GiB (60%)');
    expect(text.stdout).toMatch(/limits: +sandboxes 0 of 3/);
  });

  it('host ls --json carries the same for the ssh host next to local', async () => {
    const r = await run(t, ['host', 'ls', '--json'], opts);
    expect(r.code, r.stderr).toBe(0);
    const vps = r.json.data.hosts.find((h: { id: string }) => h.id === 'vps');
    expect(vps.capacity.capacity.cpus).toBe(8);
    expect(vps.capacity.live.cpuPercent).toBe(60);
    expect(vps.capacityError).toBeUndefined();
  });

  it('a host whose live read fails is listed with live numbers unknown, not as an error', async () => {
    process.env['FAKE_SSH_LIVE'] = join(t.root, 'live-missing.txt');
    writeFileSync(join(t.root, 'live-missing.txt'), 'nothing useful\n');
    const r = await run(t, ['host', 'ls', '--json'], {
      ...opts,
      env: { ...opts.env, FAKE_SSH_LIVE: join(t.root, 'live-missing.txt') },
    });
    const vps = r.json.data.hosts.find((h: { id: string }) => h.id === 'vps');
    expect(vps.capacity.live.available).toBe(false);
    expect(vps.capacity.capacity.source).toBe('engine');
  });
});
