import { describe, expect, it } from 'vitest';
import {
  buildQemuArgs,
  memoryToMiB,
  relayCommand,
  versionAtLeast,
  type QemuConfig,
} from './qemu.js';

const base: QemuConfig = {
  name: 'abox-ab12',
  memoryMiB: 512,
  cpus: 2,
  diskPath: '/data/vm/sandboxes/ab12/disk.qcow2',
  qmpSocket: '/run/user/1000/abox-vm/x/ab12/qmp.sock',
  qgaSocket: '/run/user/1000/abox-vm/x/ab12/qga.sock',
  pidFile: '/data/vm/sandboxes/ab12/qemu.pid',
  console: { kind: 'ringbuf' },
  network: { kind: 'none' },
};

/** Value following the first occurrence of `flag`. */
function arg(args: string[], flag: string, nth = 0): string | undefined {
  let seen = 0;
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === flag) {
      if (seen === nth) return args[i + 1];
      seen++;
    }
  }
  return undefined;
}

describe('buildQemuArgs', () => {
  it('uses KVM, a minimal machine and the full seccomp sandbox', () => {
    const a = buildQemuArgs(base);
    expect(arg(a, '-machine')).toMatch(/^q35,accel=kvm,/);
    expect(arg(a, '-cpu')).toBe('host');
    expect(arg(a, '-m')).toBe('512');
    expect(arg(a, '-smp')).toBe('2');
    expect(a).toContain('-nodefaults');
    expect(a).toContain('-no-user-config');
    expect(arg(a, '-display')).toBe('none');
    expect(arg(a, '-sandbox')).toBe(
      'on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny',
    );
  });

  it('never exposes VNC/SPICE/monitor/network listeners', () => {
    for (const network of [
      { kind: 'none' },
      { kind: 'open' },
      { kind: 'restricted', relay: ['/usr/bin/socat', 'STDIO', 'UNIX-CONNECT:/p/proxy.sock'] },
    ] as const) {
      const a = buildQemuArgs({ ...base, network });
      const joined = a.join(' ');
      for (const forbidden of [
        '-vnc',
        '-spice',
        '-monitor',
        '-incoming',
        'hostfwd',
        '-serial tcp',
        '-gdb',
        'telnet',
        'websocket',
      ]) {
        expect(joined, `${network.kind}: ${forbidden}`).not.toContain(forbidden);
      }
      // every server socket is a unix socket
      for (const m of joined.matchAll(/([^ ]*server=on[^ ]*)/g))
        expect(m[1]).toMatch(/path=\/|unix:\//);
      expect(arg(a, '-display')).toBe('none');
    }
    const a = buildQemuArgs(base);
    expect(arg(a, '-qmp')).toBe('unix:/run/user/1000/abox-vm/x/ab12/qmp.sock,server=on,wait=off');
    expect(a.join(' ')).toContain(
      'socket,id=qga0,path=/run/user/1000/abox-vm/x/ab12/qga.sock,server=on,wait=off',
    );
  });

  it('attaches the guest agent port, the overlay disk and a bounded console', () => {
    const a = buildQemuArgs(base);
    expect(a.join(' ')).toContain('virtserialport,chardev=qga0,name=org.qemu.guest_agent.0');
    expect(a.join(' ')).toContain(
      'driver=file,node-name=disk0-file,filename=/data/vm/sandboxes/ab12/disk.qcow2,discard=unmap',
    );
    expect(a.join(' ')).toContain('driver=qcow2,node-name=disk0,file=disk0-file');
    expect(a.join(' ')).toContain('ringbuf,id=con0,size=65536');
    expect(arg(a, '-pidfile')).toBe('/data/vm/sandboxes/ab12/qemu.pid');
  });

  it('mode none has no network device at all', () => {
    const a = buildQemuArgs(base);
    expect(arg(a, '-nic')).toBe('none');
    expect(a.join(' ')).not.toContain('virtio-net');
    expect(a.join(' ')).not.toContain('-netdev');
  });

  it('mode open is plain user-mode NAT', () => {
    const a = buildQemuArgs({ ...base, network: { kind: 'open' } });
    expect(arg(a, '-netdev')).toBe('user,id=n0');
    expect(a.join(' ')).toContain('virtio-net-pci,netdev=n0,mac=52:54:00:12:34:56');
    expect(arg(a, '-sandbox')).toContain('spawn=deny');
  });

  it('mode allowlist is restrict=on with exactly one guestfwd to the relay command', () => {
    const a = buildQemuArgs({
      ...base,
      network: {
        kind: 'restricted',
        relay: ['/usr/bin/socat', 'STDIO', 'UNIX-CONNECT:/data/vm/sandboxes/ab12/proxy/proxy.sock'],
      },
    });
    const nd = arg(a, '-netdev') as string;
    expect(nd).toContain('restrict=on');
    expect(nd).toContain(
      'guestfwd=tcp:10.0.2.100:3128-cmd:/usr/bin/socat STDIO UNIX-CONNECT:/data/vm/sandboxes/ab12/proxy/proxy.sock',
    );
    expect(nd.match(/guestfwd/g)).toHaveLength(1);
    expect(nd).not.toContain('hostfwd');
    // guestfwd=cmd forks in QEMU: spawn/elevateprivileges can not be denied in this mode (documented)
    const sb = arg(a, '-sandbox') as string;
    expect(sb).toContain('obsolete=deny');
    expect(sb).toContain('resourcecontrol=deny');
    expect(sb).not.toContain('spawn=deny');
    expect(sb).not.toContain('elevateprivileges=deny');
  });

  it('adds the build seed, the build log port and -loadvm only when asked', () => {
    const plain = buildQemuArgs(base).join(' ');
    expect(plain).not.toContain('seed0');
    expect(plain).not.toContain('abox.build');
    expect(plain).not.toContain('-loadvm');
    const b = buildQemuArgs({
      ...base,
      seedImage: '/w/seed.img',
      buildLog: '/w/build.log',
      console: { kind: 'file', path: '/w/console.log' },
      loadSnapshot: 'snap1',
    }).join(' ');
    expect(b).toContain('file=/w/seed.img,format=raw,readonly=on');
    expect(b).toContain('file,id=blog0,path=/w/build.log');
    expect(b).toContain('virtserialport,chardev=blog0,name=abox.build,bus=vser0.0');
    expect(b).toContain('file,id=con0,path=/w/console.log');
    expect(b.endsWith('-loadvm snap1')).toBe(true);
  });

  it('escapes commas in paths for QEMU option values', () => {
    const a = buildQemuArgs({
      ...base,
      diskPath: '/data/a,b/disk.qcow2',
      qgaSocket: '/r/a,b/qga.sock',
    });
    expect(a.join(' ')).toContain('filename=/data/a,,b/disk.qcow2,');
    expect(a.join(' ')).toContain('path=/r/a,,b/qga.sock,');
  });

  it('pins the PCI slots so guest interface names are stable between builds and boots', () => {
    const open = buildQemuArgs({ ...base, network: { kind: 'open' } }).join(' ');
    expect(open).toContain('virtio-net-pci,netdev=n0,mac=52:54:00:12:34:56,bus=pcie.0,addr=5');
    const withSeed = buildQemuArgs({
      ...base,
      network: { kind: 'open' },
      seedImage: '/s.img',
    }).join(' ');
    expect(withSeed).toContain('virtio-net-pci,netdev=n0,mac=52:54:00:12:34:56,bus=pcie.0,addr=5');
  });
});

describe('relayCommand', () => {
  it('joins shell-safe words', () => {
    expect(relayCommand(['/usr/bin/socat', 'STDIO', 'UNIX-CONNECT:/a/b.sock'])).toBe(
      '/usr/bin/socat STDIO UNIX-CONNECT:/a/b.sock',
    );
  });
  it('refuses anything that needs shell quoting', () => {
    expect(() => relayCommand(['/usr/bin/socat', 'STDIO', 'UNIX-CONNECT:/a b/c.sock'])).toThrow(
      /not allowed/,
    );
    expect(() => relayCommand(['/x;rm -rf /'])).toThrow();
    expect(() => relayCommand(['/a,b'])).toThrow();
    expect(() => relayCommand(['$(id)'])).toThrow();
  });
});

describe('helpers', () => {
  it('memoryToMiB rounds up and enforces the minimum', () => {
    expect(memoryToMiB(512 * 1024 * 1024)).toBe(512);
    expect(memoryToMiB(512 * 1024 * 1024 + 1)).toBe(513);
    expect(memoryToMiB(64 * 1024 * 1024)).toBe(256);
  });
  it('versionAtLeast', () => {
    expect(versionAtLeast('11.1.2', 6)).toBe(true);
    expect(versionAtLeast('6.0.0', 6, 0)).toBe(true);
    expect(versionAtLeast('5.2.0', 6)).toBe(false);
    expect(versionAtLeast('weird', 6)).toBe(false);
  });
});
