import { describe, expect, it } from 'vitest';
import { isAboxError } from '../errors.js';
import { parseHostsYaml } from './registry.js';
import {
  isForwardListen,
  isForwardTarget,
  isHostId,
  isHostname,
  isIdentityPath,
  isProxyJump,
  isSafeAbsPath,
  isSshAlias,
  isSshUser,
  validateHostProfile,
} from './schema.js';
import type { HostProfile } from './model.js';

function ssh(over: Partial<HostProfile> = {}): HostProfile {
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

describe('value grammars', () => {
  it('host ids', () => {
    for (const ok of ['local', 'vps', 'lab-1', 'a', '0x']) expect(isHostId(ok)).toBe(true);
    for (const bad of ['', '-x', 'Vps', 'a_b', 'a b', 'a/b', 'x'.repeat(64), 'ä'])
      expect(isHostId(bad)).toBe(false);
  });

  it('hostnames reject option and shell injection', () => {
    for (const ok of [
      'server.example.org',
      'lab-1',
      '10.0.0.5',
      '::1',
      '2001:db8::1',
      'a_b.example',
    ]) {
      expect(isHostname(ok), ok).toBe(true);
    }
    for (const bad of [
      '-oProxyCommand=touch /tmp/x',
      '-host',
      'host;rm -rf /',
      'host\nProxyCommand x',
      'host name',
      'host`id`',
      '$(id)',
      'a|b',
      'host:22',
      '',
      'fe80::1%eth0',
      'user@host',
      "h'ost",
      'h"ost',
    ]) {
      expect(isHostname(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('aliases, users, paths', () => {
    expect(isSshAlias('my-host.v2')).toBe(true);
    expect(isSshAlias('*')).toBe(false);
    expect(isSshAlias('-o')).toBe(false);
    expect(isSshUser('abox')).toBe(true);
    expect(isSshUser('-oFoo')).toBe(false);
    expect(isSshUser('a b')).toBe(false);
    expect(isSafeAbsPath('/run/user/1001/podman/podman.sock')).toBe(true);
    for (const bad of [
      'relative/sock',
      '/a b',
      "/a'b",
      '/a;b',
      '/a$b',
      '/a`b',
      '/a:b',
      '/a\nb',
      '/a%b',
      '/a"b',
    ]) {
      expect(isSafeAbsPath(bad), bad).toBe(false);
    }
    expect(isIdentityPath('~/.ssh/id_ed25519')).toBe(true);
    expect(isIdentityPath('/home/u/key')).toBe(true);
    expect(isIdentityPath('key')).toBe(false);
    expect(isIdentityPath('/a\nb')).toBe(false);
    expect(isIdentityPath('/a%d/b')).toBe(false);
  });

  it('proxy jump', () => {
    for (const ok of [
      'jump',
      'u@jump',
      'u@jump:2222',
      'a,b',
      'u@[::1]:22',
      'u@jump.example.org,h2',
    ]) {
      expect(isProxyJump(ok), ok).toBe(true);
    }
    for (const bad of [
      '-oProxyCommand=x',
      'a,-oX=1',
      'a;b',
      'a b',
      'a@',
      '@a',
      'a:99999',
      'ssh://x',
    ]) {
      expect(isProxyJump(bad), bad).toBe(false);
    }
  });

  it('forward endpoints only listen on loopback', () => {
    for (const ok of [
      '8080',
      '127.0.0.1:8080',
      'localhost:8080',
      '[::1]:8080',
      '/run/abox/x.sock',
    ]) {
      expect(isForwardListen(ok), ok).toBe(true);
    }
    for (const bad of ['0.0.0.0:8080', '*:8080', '8080:80', '0', '70000', '10.0.0.1:80', 'x']) {
      expect(isForwardListen(bad), bad).toBe(false);
    }
    for (const ok of ['db.internal:5432', '[::1]:80', '/var/run/x.sock'])
      expect(isForwardTarget(ok), ok).toBe(true);
    for (const bad of ['db:0', 'db', '-oX:80', 'a b:80', 'db:80;x'])
      expect(isForwardTarget(bad), bad).toBe(false);
  });
});

describe('validateHostProfile', () => {
  it('accepts a sane profile', () => {
    expect(() => validateHostProfile(ssh())).not.toThrow();
  });

  it('rejects an ssh host without destination', () => {
    expect(() => validateHostProfile(ssh({ hostname: undefined }))).toThrow(/hostname/);
  });

  it('rejects injection through any field, with field path', () => {
    const cases: Array<[Partial<HostProfile>, string]> = [
      [{ hostname: '-oProxyCommand=x' }, 'hostname'],
      [{ user: '-oFoo' }, 'user'],
      [{ proxyJump: '-oProxyCommand=x' }, 'proxy_jump'],
      [{ identityFile: '/a\n/b' }, 'identity_file'],
      [{ engineSocket: '/run/x;rm' }, 'engine_socket'],
      [{ sshConfigAlias: '*', hostname: undefined }, 'ssh_config_alias'],
      [{ port: 0 }, 'port'],
      [{ tags: ['bad tag'] }, 'tags'],
      [{ limits: { memory: 'lots' } }, 'limits.memory'],
    ];
    for (const [over, path] of cases) {
      try {
        validateHostProfile(ssh(over));
        throw new Error(`accepted ${JSON.stringify(over)}`);
      } catch (e) {
        expect(isAboxError(e), String(e)).toBe(true);
        if (isAboxError(e)) {
          expect(e.code).toBe('invalid_input');
          expect(
            e.issues.some((i) => i.path?.startsWith(path)),
            `${path}: ${JSON.stringify(e.issues)}`,
          ).toBe(true);
        }
      }
    }
  });

  it('keeps "local" reserved', () => {
    expect(() => validateHostProfile(ssh({ id: 'local' }))).toThrow(/local/);
    expect(() => validateHostProfile(ssh({ kind: 'local' }))).toThrow(/reserved/);
  });
});

describe('parseHostsYaml', () => {
  it('always contains an implicit local host', () => {
    const hosts = parseHostsYaml('');
    const local = hosts.get('local')!;
    expect(local).toMatchObject({
      kind: 'local',
      zone: 'workstation',
      backends: ['docker', 'podman', 'process', 'python', 'vm'],
    });
  });

  it('accepts python and vm in the backends of a host', () => {
    const hosts = parseHostsYaml(
      'hosts:\n  box:\n    kind: ssh\n    hostname: box.example.org\n    user: dev\n    backends: [python, vm]\n  local:\n    backends: [python]\n',
    );
    expect(hosts.get('box')!.backends).toEqual(['python', 'vm']);
    expect(hosts.get('local')!.backends).toEqual(['python']);
    expect(() => parseHostsYaml('hosts:\n  x:\n    backends: [lxc]\n')).toThrow();
  });

  it('parses the concept example (placeholders only)', () => {
    const hosts = parseHostsYaml(`
hosts:
  local:
    kind: local
    zone: workstation
    backends: [docker, process]
  vps:
    kind: ssh
    hostname: server.example.org
    user: abox
    port: 22
    zone: shared
    min_isolation: hardened
    backends: [podman]
    engine_socket: /run/user/1001/podman/podman.sock
    tags: [private, internet]
    limits: { cpus: 1, memory: 2g, sandboxes: 2 }
    port_forwards:
      - { name: web, kind: local, listen: 8080, target: "localhost:80" }
      - { name: socks, kind: dynamic, listen: "127.0.0.1:1080" }
`);
    const vps = hosts.get('vps')!;
    expect(vps).toMatchObject({
      hostname: 'server.example.org',
      user: 'abox',
      zone: 'shared',
      minIsolation: 'hardened',
      backends: ['podman'],
      engineSocket: '/run/user/1001/podman/podman.sock',
      tags: ['private', 'internet'],
      limits: { cpus: 1, memory: '2g', sandboxes: 2 },
    });
    expect(vps.portForwards).toHaveLength(2);
  });

  it('defaults ssh hosts to zone shared and no backends', () => {
    const h = parseHostsYaml('hosts:\n  box:\n    hostname: box.example.org\n').get('box')!;
    expect(h).toMatchObject({ kind: 'ssh', zone: 'shared', backends: [], favorite: false });
  });

  it('reports field paths and line numbers', () => {
    const text = `hosts:
  vps:
    hostname: server.example.org
    zone: public
    colour: red
  Bad_Id:
    hostname: x.example.org
`;
    try {
      parseHostsYaml(text, 'hosts.yaml');
      throw new Error('should fail');
    } catch (e) {
      expect(isAboxError(e)).toBe(true);
      if (!isAboxError(e)) return;
      expect(e.code).toBe('invalid_input');
      const paths = e.issues.map((i) => i.path);
      expect(paths).toContain('hosts.vps.zone');
      expect(paths).toContain('hosts.vps.colour');
      expect(paths).toContain('hosts.Bad_Id');
      const zone = e.issues.find((i) => i.path === 'hosts.vps.zone');
      expect(zone?.line).toBe(4);
    }
  });

  it('rejects invalid yaml, unknown top-level keys and misuse of kind local', () => {
    expect(() => parseHostsYaml('hosts: [')).toThrow(/invalid hosts file/);
    expect(() => parseHostsYaml('hostz: {}')).toThrow(/unknown key/);
    expect(() =>
      parseHostsYaml('hosts:\n  local:\n    kind: ssh\n    hostname: x.example.org'),
    ).toThrow(/local/);
    expect(() => parseHostsYaml('hosts:\n  other:\n    kind: local')).toThrow(/reserved/);
    expect(() =>
      parseHostsYaml('hosts:\n  local:\n    kind: local\n    hostname: x.example.org'),
    ).toThrow(/not allowed/);
  });

  it('rejects forwards that would listen on the network and duplicate names', () => {
    const base = 'hosts:\n  h:\n    hostname: h.example.org\n    port_forwards:\n';
    expect(() =>
      parseHostsYaml(
        `${base}      - { name: a, kind: local, listen: "0.0.0.0:80", target: "x:80" }`,
      ),
    ).toThrow();
    expect(() =>
      parseHostsYaml(`${base}      - { name: a, kind: dynamic, listen: 1080, target: "x:80" }`),
    ).toThrow(/no target/);
    expect(() =>
      parseHostsYaml(
        `${base}      - { name: a, kind: dynamic, listen: 1080 }\n      - { name: a, kind: dynamic, listen: 1081 }`,
      ),
    ).toThrow(/duplicate/);
  });
});

describe('hardened runtimes and the rootful opt-in', () => {
  const yaml = (extra: string) =>
    `hosts:\n  srv:\n    hostname: srv.example.org\n    backends: [docker, podman]\n${extra}`;

  it('reads runtimes per engine and allow_rootful from hosts.yaml', () => {
    const h = parseHostsYaml(
      yaml('    runtimes: { docker: runsc, podman: kata }\n    allow_rootful: true\n'),
    ).get('srv')!;
    expect(h.runtimes).toEqual({ docker: 'runsc', podman: 'kata' });
    expect(h.allowRootful).toBe(true);
    const plain = parseHostsYaml(yaml('')).get('srv')!;
    expect(plain.runtimes).toBeUndefined();
    expect(plain.allowRootful).toBeUndefined();
  });

  it('rejects unsafe runtime names, unknown engines and a runtime for an engine the host lacks', () => {
    expect(() => parseHostsYaml(yaml('    runtimes: { docker: "runsc --privileged" }\n'))).toThrow(
      /runtime name/,
    );
    expect(() => parseHostsYaml(yaml('    runtimes: { docker: "-x" }\n'))).toThrow(/runtime name/);
    expect(() => parseHostsYaml(yaml('    runtimes: { lxc: runsc }\n'))).toThrow(/unknown key/);
    expect(() =>
      parseHostsYaml(
        'hosts:\n  srv:\n    hostname: srv.example.org\n    backends: [podman]\n    runtimes: { docker: runsc }\n',
      ),
    ).toThrow(/needs the backend docker/);
  });

  it('allow_rootful is for ssh hosts only; validateHostProfile checks the same grammar', () => {
    expect(() =>
      parseHostsYaml('hosts:\n  local:\n    kind: local\n    allow_rootful: true\n'),
    ).toThrow(/not allowed/);
    expect(() =>
      validateHostProfile(ssh({ backends: ['docker'], runtimes: { docker: 'a b' } })),
    ).toThrow(/runtime name/);
    expect(
      validateHostProfile(
        ssh({ backends: ['docker'], runtimes: { docker: 'io.containerd.kata.v2' } }),
      ),
    ).toBeDefined();
  });
});
