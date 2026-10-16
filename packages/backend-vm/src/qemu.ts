import { execFile } from 'node:child_process';
import { accessSync, constants as fsConstants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { AboxError } from '@abox/core';

const execFileP = promisify(execFile);

/** Fixed PCI slots on the Q35 root bus: guest network interface names stay stable across boots. */
const SLOT = { rng: 3, disk: 4, nic: 5, serial: 6, seed: 7 } as const;

/** MAC address of the single NIC (same in every VM; each VM has its own private user-mode network). */
export const GUEST_MAC = '52:54:00:12:34:56';

/** Address the guest uses to reach the egress proxy of `allowlist` sandboxes. */
export const PROXY_GUEST_IP = '10.0.2.100';
export const PROXY_GUEST_PORT = 3128;

export type QemuNetwork =
  | { kind: 'none' }
  /** User-mode NAT without restrictions (`open`). */
  | { kind: 'open' }
  /**
   * `restrict=on` user-mode network with one `guestfwd` rule: connections to
   * PROXY_GUEST_IP:PROXY_GUEST_PORT run `relay` (stdin/stdout = the connection).
   */
  | { kind: 'restricted'; relay: string[] };

export interface QemuConfig {
  name: string;
  memoryMiB: number;
  cpus: number;
  /** Writable qcow2 overlay. */
  diskPath: string;
  qmpSocket: string;
  qgaSocket: string;
  pidFile: string;
  /** `ringbuf`: last 64 KiB readable via QMP (sandboxes). `file`: unbounded log (image builds). */
  console: { kind: 'ringbuf' } | { kind: 'file'; path: string };
  network: QemuNetwork;
  /** NoCloud seed (FAT, label CIDATA); image builds only. */
  seedImage?: string;
  /** Boot directly into this internal snapshot (`-loadvm`). */
  loadSnapshot?: string;
  /** Host file receiving what the guest writes to /dev/virtio-ports/abox.build; image builds only. */
  buildLog?: string;
}

/** Characters allowed in paths that end up inside a `guestfwd=...-cmd:` shell command. */
const SAFE_CMD_ARG = /^[A-Za-z0-9_./:=@%+-]+$/;

/** Builds the `guestfwd` command string; every word must be shell-safe (no quoting is attempted). */
export function relayCommand(relay: string[]): string {
  for (const w of relay) {
    if (!SAFE_CMD_ARG.test(w)) {
      throw new AboxError(
        'invalid_input',
        `path '${w}' contains characters that are not allowed in the proxy relay command`,
        {
          hint: 'Use a data directory whose path consists of letters, digits and _ . / : = @ % + - only.',
        },
      );
    }
  }
  return relay.join(' ').replaceAll(',', ',,');
}

/**
 * Full argument vector for `qemu-system-x86_64`. Pure function (unit tested).
 *
 * Hardening: seccomp sandbox, no default devices, no display/VNC/SPICE, monitor and guest agent on
 * unix sockets inside the sandbox's private directory, no host network listener.
 * `allowlist` sandboxes need `guestfwd=cmd:` which makes libslirp fork a relay process for every
 * guest connection; that is incompatible with the `spawn` and `elevateprivileges` seccomp
 * restrictions (verified with QEMU 11.1), so those two are dropped for this mode only.
 */
export function buildQemuArgs(c: QemuConfig): string[] {
  /** QEMU option values: a literal comma is written as two commas. */
  const esc = (p: string): string => p.replaceAll(',', ',,');
  const restricted = c.network.kind === 'restricted';
  const sandbox = restricted
    ? 'on,obsolete=deny,resourcecontrol=deny'
    : 'on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny';
  const args: string[] = [
    '-name',
    `${c.name},process=${c.name}`,
    '-machine',
    'q35,accel=kvm,usb=off,vmport=off',
    '-cpu',
    'host',
    '-m',
    String(c.memoryMiB),
    '-smp',
    String(c.cpus),
    '-display',
    'none',
    '-no-user-config',
    '-nodefaults',
    '-sandbox',
    sandbox,
    '-object',
    'rng-random,id=rng0,filename=/dev/urandom',
    '-device',
    `virtio-rng-pci,rng=rng0,bus=pcie.0,addr=${SLOT.rng}`,
    '-blockdev',
    `driver=file,node-name=disk0-file,filename=${esc(c.diskPath)},discard=unmap`,
    '-blockdev',
    'driver=qcow2,node-name=disk0,file=disk0-file,discard=unmap',
    '-device',
    `virtio-blk-pci,drive=disk0,bootindex=1,bus=pcie.0,addr=${SLOT.disk}`,
  ];
  if (c.seedImage) {
    args.push(
      '-drive',
      `if=none,id=seed0,file=${esc(c.seedImage)},format=raw,readonly=on`,
      '-device',
      `virtio-blk-pci,drive=seed0,bus=pcie.0,addr=${SLOT.seed}`,
    );
  }
  args.push(
    '-chardev',
    `socket,id=qga0,path=${esc(c.qgaSocket)},server=on,wait=off`,
    '-device',
    `virtio-serial-pci,id=vser0,bus=pcie.0,addr=${SLOT.serial}`,
    '-device',
    'virtserialport,chardev=qga0,name=org.qemu.guest_agent.0',
    '-qmp',
    `unix:${esc(c.qmpSocket)},server=on,wait=off`,
  );
  if (c.buildLog) {
    args.push(
      '-chardev',
      `file,id=blog0,path=${esc(c.buildLog)}`,
      '-device',
      'virtserialport,chardev=blog0,name=abox.build,bus=vser0.0',
    );
  }
  if (c.console.kind === 'ringbuf') {
    args.push('-chardev', 'ringbuf,id=con0,size=65536');
  } else {
    args.push('-chardev', `file,id=con0,path=${esc(c.console.path)}`);
  }
  args.push('-serial', 'chardev:con0');
  switch (c.network.kind) {
    case 'none':
      args.push('-nic', 'none');
      break;
    case 'open':
      args.push(
        '-netdev',
        'user,id=n0',
        '-device',
        `virtio-net-pci,netdev=n0,mac=${GUEST_MAC},bus=pcie.0,addr=${SLOT.nic}`,
      );
      break;
    case 'restricted':
      args.push(
        '-netdev',
        `user,id=n0,restrict=on,net=10.0.2.0/24,guestfwd=tcp:${PROXY_GUEST_IP}:${PROXY_GUEST_PORT}-cmd:${relayCommand(c.network.relay)}`,
        '-device',
        `virtio-net-pci,netdev=n0,mac=${GUEST_MAC},bus=pcie.0,addr=${SLOT.nic}`,
      );
      break;
  }
  args.push('-pidfile', c.pidFile);
  if (c.loadSnapshot) args.push('-loadvm', c.loadSnapshot);
  return args;
}

export function findInPath(name: string, extraDirs: string[] = []): string | undefined {
  const dirs = [...(process.env['PATH'] ?? '').split(delimiter).filter(Boolean), ...extraDirs];
  for (const d of dirs) {
    const p = join(d, name);
    try {
      accessSync(p, fsConstants.X_OK);
      return p;
    } catch {
      /* next */
    }
  }
  return undefined;
}

export function findQemu(override?: string): string | undefined {
  if (override) return override;
  return findInPath('qemu-system-x86_64', ['/usr/bin', '/usr/local/bin', '/opt/qemu/bin']);
}

export async function qemuVersion(binary: string): Promise<string> {
  const { stdout } = await execFileP(binary, ['--version'], { timeout: 10_000 });
  const m = /version\s+(\S+)/.exec(stdout);
  return m ? (m[1] as string) : stdout.split('\n')[0]?.trim() || 'unknown';
}

/** True when the version is at least `major.minor`. */
export function versionAtLeast(version: string, major: number, minor = 0): boolean {
  const m = /^(\d+)\.(\d+)/.exec(version);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a > major || (a === major && b >= minor);
}

export function memoryToMiB(bytes: number): number {
  // Below 256 MiB a cloud image does not boot reliably; round to full MiB.
  return Math.max(256, Math.ceil(bytes / (1024 * 1024)));
}
