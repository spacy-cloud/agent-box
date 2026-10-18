import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { HostProfile } from './model.js';
import {
  countCpusInStat,
  cpuPercentBetween,
  liveCommand,
  liveScript,
  parseCpuCount,
  parseCpuStat,
  parseLiveOutput,
  parseLiveSections,
  parseLoadavg,
  parseMeminfo,
  readLocalLive,
  readRemoteLive,
} from './live.js';
import { buildSshArgs, hostsEnvFromPaths, type HostsEnv } from './ssh-args.js';

const STAT_A = 'cpu  4705 356 584 3699 23 23 0 0 0 0';
const STAT_B = 'cpu  4805 356 604 3779 23 23 0 0 0 0';
const MEMINFO = [
  'MemTotal:       16384000 kB',
  'MemFree:         1024000 kB',
  'MemAvailable:    6553600 kB',
  'Buffers:          102400 kB',
  'SwapTotal:       2097148 kB',
].join('\n');
const LOADAVG = '0.52 0.58 0.59 1/467 12345\n';

describe('parsing /proc', () => {
  it('reads the load average', () => {
    expect(parseLoadavg(LOADAVG)).toEqual({ m1: 0.52, m5: 0.58, m15: 0.59 });
    expect(parseLoadavg('')).toBeUndefined();
    expect(parseLoadavg('garbage in here')).toBeUndefined();
  });

  it('reads MemTotal and MemAvailable in bytes and leaves out what is missing', () => {
    expect(parseMeminfo(MEMINFO)).toEqual({
      totalBytes: 16384000 * 1024,
      availableBytes: 6553600 * 1024,
    });
    // kernels before 3.14 have no MemAvailable: it is not derived from MemFree and the caches
    expect(parseMeminfo('MemTotal: 1000 kB\nMemFree: 500 kB\n')).toEqual({
      totalBytes: 1000 * 1024,
    });
    expect(parseMeminfo('nothing')).toEqual({});
  });

  it('reads the aggregate cpu counters: guest time is not counted twice, iowait is idle', () => {
    expect(parseCpuStat(STAT_A)).toEqual({ total: 9390, idle: 3722 });
    expect(parseCpuStat('cpu  1 2 3 4 5 6 7 8 9 10')).toEqual({ total: 36, idle: 9 });
    // a per-cpu line, a short line and noise are not the aggregate
    expect(parseCpuStat('cpu0 1 2 3 4 5 6 7 8')).toBeUndefined();
    expect(parseCpuStat('cpu  1 2 3')).toBeUndefined();
    expect(parseCpuStat('intr 12345')).toBeUndefined();
  });

  it('computes the cpu percentage from two samples', () => {
    const a = parseCpuStat(STAT_A)!;
    const b = parseCpuStat(STAT_B)!;
    // 200 ticks passed, 80 of them idle
    expect(cpuPercentBetween(a, b)).toBe(60);
    // an idle machine
    expect(cpuPercentBetween({ total: 100, idle: 100 }, { total: 200, idle: 200 })).toBe(0);
    // a fully busy one
    expect(cpuPercentBetween({ total: 100, idle: 50 }, { total: 200, idle: 50 })).toBe(100);
    // one decimal
    expect(cpuPercentBetween({ total: 0, idle: 0 }, { total: 3, idle: 2 })).toBe(33.3);
  });

  it('gives no percentage when the counters did not advance or went backwards', () => {
    const a = parseCpuStat(STAT_A)!;
    expect(cpuPercentBetween(a, a)).toBeNull();
    expect(cpuPercentBetween(parseCpuStat(STAT_B)!, a)).toBeNull();
    expect(cpuPercentBetween({ total: 10, idle: 5 }, { total: 20, idle: 2 })).toBeNull();
  });

  it('counts cpus', () => {
    expect(countCpusInStat(`${STAT_A}\ncpu0 1 2 3 4 5 6 7 8\ncpu1 1 2 3 4 5 6 7 8\nintr 1`)).toBe(
      2,
    );
    expect(countCpusInStat(STAT_A)).toBeNull();
    expect(parseCpuCount('8\n')).toBe(8);
    expect(parseCpuCount('processor : 0\nmodel name : x\nprocessor : 1\n')).toBe(2);
    expect(parseCpuCount('0')).toBeNull();
    expect(parseCpuCount('grep: no such file')).toBeNull();
  });
});

describe('readLocalLive', () => {
  const files: Record<string, string[]> = {
    '/proc/stat': [
      `${STAT_A}\ncpu0 1 2 3 4 5 6 7 8\ncpu1 1 2 3 4 5 6 7 8\n`,
      `${STAT_B}\ncpu0 1 2 3 4 5 6 7 8\ncpu1 1 2 3 4 5 6 7 8\n`,
    ],
    '/proc/loadavg': [LOADAVG],
    '/proc/meminfo': [MEMINFO],
  };
  const reader = () => {
    const seen: Record<string, number> = {};
    return async (p: string): Promise<string> => {
      const list = files[p];
      if (!list) throw new Error(`ENOENT ${p}`);
      const i = seen[p] ?? 0;
      seen[p] = i + 1;
      return list[Math.min(i, list.length - 1)]!;
    };
  };

  it('combines two stat readings with the load average and memory', async () => {
    const r = await readLocalLive({
      read: reader(),
      sampleMs: 1,
      now: () => 42,
      platform: 'linux',
    });
    expect(r).toEqual({
      ok: true,
      usage: {
        ts: 42,
        cpuPercent: 60,
        load: { m1: 0.52, m5: 0.58, m15: 0.59 },
        memoryTotalBytes: 16384000 * 1024,
        memoryAvailableBytes: 6553600 * 1024,
        cpus: 2,
        source: 'local',
      },
    });
  });

  it('is unknown (not guessed) off Linux or when /proc cannot be read', async () => {
    expect(await readLocalLive({ platform: 'darwin' })).toMatchObject({ ok: false });
    expect(
      await readLocalLive({
        read: () => Promise.reject(new Error('EACCES')),
        sampleMs: 1,
        platform: 'linux',
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('EACCES') });
  });

  it('keeps what it could read when one file is missing', async () => {
    delete files['/proc/meminfo'];
    try {
      const r = await readLocalLive({ read: reader(), sampleMs: 1, platform: 'linux' });
      expect(r).toMatchObject({
        ok: true,
        usage: { cpuPercent: 60, memoryTotalBytes: null, memoryAvailableBytes: null },
      });
    } finally {
      files['/proc/meminfo'] = [MEMINFO];
    }
  });
});

const REMOTE_OUT = [
  'Welcome to the server', // rc file noise before the first marker
  'abox.uname',
  'Linux',
  'abox.stat1',
  STAT_A,
  'abox.stat2',
  STAT_B,
  'abox.loadavg',
  LOADAVG.trim(),
  'abox.meminfo',
  'MemTotal:       16384000 kB',
  'MemAvailable:    6553600 kB',
  'abox.cpus',
  '8',
  '',
].join('\n');

describe('the remote read', () => {
  it('parses the output of the fixed script', () => {
    expect(parseLiveSections(REMOTE_OUT).stat1).toBe(`${STAT_A}\n`);
    expect(parseLiveOutput(REMOTE_OUT, 7)).toEqual({
      ok: true,
      usage: {
        ts: 7,
        cpuPercent: 60,
        load: { m1: 0.52, m5: 0.58, m15: 0.59 },
        memoryTotalBytes: 16384000 * 1024,
        memoryAvailableBytes: 6553600 * 1024,
        cpus: 8,
        source: 'ssh',
      },
    });
  });

  it('tolerates CRLF and a missing second part', () => {
    const crlf = REMOTE_OUT.replaceAll('\n', '\r\n');
    expect(parseLiveOutput(crlf, 1)).toMatchObject({
      ok: true,
      usage: { cpuPercent: 60, cpus: 8 },
    });
    const noStat = REMOTE_OUT.replace(/abox\.stat2\n[^\n]*\n/, '');
    expect(parseLiveOutput(noStat, 1)).toMatchObject({
      ok: true,
      usage: { cpuPercent: null, memoryTotalBytes: 16384000 * 1024 },
    });
  });

  it('is unknown on a host without /proc', () => {
    expect(parseLiveOutput('abox.uname\nFreeBSD\n', 1)).toEqual({
      ok: false,
      reason: 'FreeBSD: no /proc',
    });
    expect(parseLiveOutput('', 1)).toMatchObject({ ok: false });
    expect(
      parseLiveOutput('abox.uname\nLinux\nabox.stat1\nx\nabox.stat2\ny\nabox.meminfo\nz\n', 1),
    ).toMatchObject({ ok: false });
  });

  it('bounds what it keeps of a hostile or runaway output', () => {
    const big = `abox.meminfo\n${'MemTotal: 1 kB\n'.repeat(100_000)}abox.stat1\n${STAT_A}\n`;
    const s = parseLiveSections(big);
    expect(s.meminfo!.length).toBeLessThan(4096 + 64);
  });

  it('is a fixed command: nothing in it depends on the host or on input', () => {
    const cmd = liveCommand();
    expect(cmd).toBe(liveCommand());
    expect(cmd.startsWith("sh -c '")).toBe(true);
    expect(cmd.endsWith("'")).toBe(true);
    // one quoted word for the remote shell: no single quote inside, no "!" (history expansion)
    expect(liveScript()).not.toMatch(/['!]/);
    // read-only: only these programs, no redirect to a file (2>/dev/null is the only redirect)
    expect(liveScript().replaceAll('2>/dev/null', '')).not.toMatch(/>/);
    // the whole script is pinned: a change to what runs on the host has to change this test too
    expect(liveScript()).toBe(
      'echo abox.uname; uname -s; if [ -r /proc/stat ] && [ -r /proc/meminfo ]; then echo abox.stat1; head -n 1 /proc/stat; sleep 0.5 2>/dev/null || sleep 1; echo abox.stat2; head -n 1 /proc/stat; echo abox.loadavg; cat /proc/loadavg 2>/dev/null; echo abox.meminfo; grep -E "^(MemTotal|MemAvailable):" /proc/meminfo; echo abox.cpus; grep -c "^processor" /proc/cpuinfo 2>/dev/null; fi;',
    );
  });

  it('is sent over the hardened batch connection as ONE remote command argument', () => {
    const env: HostsEnv = hostsEnvFromPaths(
      { configDir: '/home/u/.config/abox', runtimeDir: '/tmp/x/run' },
      { sshConfigFile: null },
    );
    const profile: HostProfile = {
      id: 'srv',
      kind: 'ssh',
      hostname: 'server.example.org',
      user: 'abox',
      zone: 'lab',
      backends: ['docker'],
      tags: [],
      favorite: false,
      portForwards: [],
    };
    const args = buildSshArgs(profile, env, { mode: 'batch', remoteCommand: liveCommand() });
    expect(args.at(-1)).toBe(liveCommand());
    expect(args.at(-2)).toBe('server.example.org');
    expect(args).toContain('BatchMode=yes');
    expect(args).toContain('StrictHostKeyChecking=yes');
    // the host name and user are arguments of their own, never part of the remote command
    expect(liveCommand()).not.toContain('server.example.org');
    expect(args.filter((a) => a.includes('/proc/'))).toEqual([liveCommand()]);
  });
});

describe('readRemoteLive with a stand-in ssh', () => {
  const dir = mkdtempSync(join(tmpdir(), 'abox-live-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const profile: HostProfile = {
    id: 'srv',
    kind: 'ssh',
    hostname: 'server.example.org',
    zone: 'lab',
    backends: [],
    tags: [],
    favorite: false,
    portForwards: [],
  };

  function fakeSsh(name: string, body: string): HostsEnv {
    const file = join(dir, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
    return hostsEnvFromPaths(
      { configDir: join(dir, 'cfg'), runtimeDir: join(dir, 'run') },
      { sshBinary: file, sshConfigFile: null, now: () => 99 },
    );
  }

  it('runs the command once and parses the answer', async () => {
    const log = join(dir, 'argv.log');
    const env = fakeSsh(
      'ssh-ok',
      `printf '%s\\n' "$@" > '${log}'\ncat <<'EOF'\n${REMOTE_OUT}\nEOF`,
    );
    const r = await readRemoteLive(profile, env);
    expect(r).toMatchObject({
      ok: true,
      usage: { ts: 99, cpuPercent: 60, cpus: 8, source: 'ssh' },
    });
    const argv = readFileSync(log, 'utf8').split('\n');
    expect(argv).toContain(liveCommand());
  });

  it('turns a failing ssh into a reason, not an exception', async () => {
    expect(
      await readRemoteLive(
        profile,
        fakeSsh('ssh-denied', 'echo "user@host: Permission denied (publickey)." >&2; exit 255'),
      ),
    ).toEqual({ ok: false, reason: 'login failed' });
    expect(
      await readRemoteLive(
        profile,
        fakeSsh('ssh-key', 'echo "Host key verification failed." >&2; exit 255'),
      ),
    ).toEqual({ ok: false, reason: 'host key not trusted' });
    expect(
      await readRemoteLive(profile, fakeSsh('ssh-slow', 'exec sleep 5'), { timeoutMs: 200 }),
    ).toEqual({ ok: false, reason: 'timeout' });
  });
});
