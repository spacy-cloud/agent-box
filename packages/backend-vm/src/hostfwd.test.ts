import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  freeLoopbackPort,
  hostfwdAddLine,
  hostfwdFailed,
  hostfwdRemoveLine,
  parseUsernet,
} from './hostfwd.js';
import { findQemu } from './qemu.js';
import { qmpCall } from './qmp.js';

const USERNET = [
  'Hub -1 (n0):',
  '  Protocol[State]    FD  Source Address  Port   Dest. Address  Port RecvQ SendQ',
  '  TCP[HOST_FORWARD]  15       127.0.0.1 34567       10.0.2.15  5173     0     0',
  '  TCP[ESTABLISHED]   17       10.0.2.15 41000     93.184.216.34   80     0     0',
  '  TCP[HOST_FORWARD]  16       127.0.0.1 34000       10.0.2.15  3000     0     0',
  '  TCP[HOST_FORWARD]  18         0.0.0.0 35000       10.0.2.15  9000     0     0',
  '  UDP[40 sec]        19       10.0.2.15 5353        10.0.2.3    53     0     0',
].join('\r\n');

describe('hostfwd helpers', () => {
  it('formats the monitor commands: loopback only', () => {
    expect(hostfwdAddLine(34567, 5173)).toBe('hostfwd_add n0 tcp:127.0.0.1:34567-:5173');
    expect(hostfwdRemoveLine(34567)).toBe('hostfwd_remove n0 tcp:127.0.0.1:34567');
    expect(hostfwdAddLine(1, 2)).not.toContain('0.0.0.0');
  });

  it('reads only the loopback host-forward rules out of `info usernet`, by guest port', () => {
    expect(parseUsernet(USERNET)).toEqual([
      { hostPort: 34000, guestPort: 3000 },
      { hostPort: 34567, guestPort: 5173 },
    ]);
    expect(parseUsernet('')).toEqual([]);
  });

  it('knows a failure from the monitor reply', () => {
    expect(hostfwdFailed('')).toBe(false);
    expect(hostfwdFailed('\r\n')).toBe(false);
    expect(hostfwdFailed("Could not set up host forwarding rule 'tcp:127.0.0.1:1-:2'\r\n")).toBe(
      true,
    );
  });

  it('finds a free loopback port', async () => {
    const p = await freeLoopbackPort();
    expect(p).toBeGreaterThan(1023);
    const s = createServer();
    await new Promise<void>((r) => s.listen(p, '127.0.0.1', r));
    await new Promise((r) => s.close(r));
  });
});

// QEMU itself, without a guest: paused (-S), software emulation, no disk. It has the same user-mode
// netdev, seccomp filter and monitor as a sandbox VM, so the rules are exercised for real.
const qemu = findQemu();
describe.skipIf(!qemu)('hostfwd rules against a real QEMU (no guest, no KVM)', () => {
  let dir: string;
  let proc: ChildProcess;
  let qmp: string;

  const monitor = (line: string): Promise<string> =>
    qmpCall<string>(qmp, 'human-monitor-command', { 'command-line': line });

  const start = async (netdev: string): Promise<void> => {
    proc = spawn(
      qemu!,
      [
        '-machine',
        'q35,accel=tcg',
        '-m',
        '64',
        '-display',
        'none',
        '-no-user-config',
        '-nodefaults',
        '-sandbox',
        'on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny',
        '-netdev',
        netdev,
        '-device',
        'virtio-net-pci,netdev=n0',
        '-qmp',
        `unix:${qmp},server=on,wait=off`,
        '-S',
      ],
      { stdio: 'ignore' },
    );
    for (let i = 0; i < 50; i++) {
      try {
        await qmpCall(qmp, 'query-status');
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw new Error('qemu did not come up');
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'abox-hostfwd-'));
    qmp = join(dir, 'q.sock');
  });
  afterAll(() => {
    proc?.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  });

  it('adds, lists and removes a rule on 127.0.0.1 with restrict=on, and refuses a taken port', async () => {
    await start('user,id=n0,restrict=on,net=10.0.2.0/24');
    const port = await freeLoopbackPort();
    expect(hostfwdFailed(await monitor(hostfwdAddLine(port, 5173)))).toBe(false);
    expect(parseUsernet(await monitor('info usernet'))).toEqual([
      { hostPort: port, guestPort: 5173 },
    ]);
    // it listens on the loopback and nowhere else
    const probe = createServer();
    await expect(
      new Promise<void>((res, rej) => {
        probe.once('error', rej);
        probe.listen(port, '127.0.0.1', () => res());
      }),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });
    // a second rule for the same host port fails and says so
    expect(hostfwdFailed(await monitor(hostfwdAddLine(port, 5174)))).toBe(true);
    expect(parseUsernet(await monitor('info usernet'))).toHaveLength(1);
    expect(await monitor(hostfwdRemoveLine(port))).toContain('removed');
    expect(parseUsernet(await monitor('info usernet'))).toEqual([]);
    await new Promise<void>((res) =>
      probe.listen(port, '127.0.0.1', () => probe.close(() => res())),
    );
  }, 60_000);
});
