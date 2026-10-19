import { describe, expect, it } from 'vitest';
import { IPC } from '../../src/shared/ipc';

const ok = (c: keyof typeof IPC, v: unknown) => IPC[c].safeParse(v).success;

describe('IPC: host capacity, fit estimate and host limits', () => {
  it('capacity:host names one host and nothing else', () => {
    expect(ok('capacity:host', { id: 'local' })).toBe(true);
    expect(ok('capacity:host', { id: 'home-server' })).toBe(true);
    expect(ok('capacity:host', { id: '../etc' })).toBe(false);
    expect(ok('capacity:host', { id: 'Home' })).toBe(false);
    expect(ok('capacity:host', {})).toBe(false);
    expect(ok('capacity:host', { id: 'a', command: 'uptime' })).toBe(false);
  });

  it('capacity:estimate takes the template, the host and the cpu / memory fields of the form', () => {
    expect(ok('capacity:estimate', { template: 'node-dev' })).toBe(true);
    expect(
      ok('capacity:estimate', {
        host: 'home-server',
        template: 'node-dev',
        overrides: { cpus: 2.5, memory: '4g' },
        projectDir: '/home/u/proj',
        workspacePath: '/home/u/proj',
      }),
    ).toBe(true);
    expect(ok('capacity:estimate', { host: 'a b', template: 't' })).toBe(false);
    expect(ok('capacity:estimate', { template: 't', overrides: { cpus: 0 } })).toBe(false);
    expect(ok('capacity:estimate', { template: 't', overrides: { memory: 'lots' } })).toBe(false);
    expect(ok('capacity:estimate', { template: 't', overrides: { ttl: '1h' } })).toBe(false);
    expect(ok('capacity:estimate', { template: 't', projectDir: 'relative' })).toBe(false);
    expect(ok('capacity:estimate', { template: '' })).toBe(false);
  });

  it('host limits: 0 sandboxes is allowed (as in hosts.yaml and the CLI), more than 10000 is not', () => {
    const patch = (limits: unknown) => ok('hosts:update', { id: 'srv', patch: { limits } });
    expect(patch({ sandboxes: 0 })).toBe(true);
    expect(patch({ sandboxes: 3, cpus: 2.5, memory: '16g' })).toBe(true);
    expect(patch(null)).toBe(true);
    expect(patch({ sandboxes: 10_001 })).toBe(false);
    expect(patch({ sandboxes: -1 })).toBe(false);
    expect(patch({ sandboxes: 1.5 })).toBe(false);
    expect(patch({ cpus: 1025 })).toBe(false);
    expect(patch({ memory: 'lots' })).toBe(false);
    expect(patch({ shell: 'x' })).toBe(false);
    expect(ok('hosts:add', { id: 'nas', hostname: 'nas.lan', limits: { sandboxes: 3 } })).toBe(
      true,
    );
  });
});

describe('IPC: readiness check', () => {
  it('doctor:for names a template (and the host it runs on) or a host, and nothing else', () => {
    expect(ok('doctor:for', { kind: 'host', host: 'home-server' })).toBe(true);
    expect(ok('doctor:for', { kind: 'template', template: 'flutter-dev' })).toBe(true);
    expect(
      ok('doctor:for', {
        kind: 'template',
        template: 'flutter-dev',
        host: 'home-server',
        projectDir: '/home/u/proj',
        workspacePath: '/home/u/proj',
      }),
    ).toBe(true);
    expect(ok('doctor:for', { kind: 'host' })).toBe(false);
    expect(ok('doctor:for', { kind: 'host', host: '../etc' })).toBe(false);
    expect(ok('doctor:for', { kind: 'template' })).toBe(false);
    expect(ok('doctor:for', { kind: 'template', template: 't', projectDir: 'relative/dir' })).toBe(
      false,
    );
    expect(ok('doctor:for', { host: 'srv' })).toBe(false);
    expect(ok('doctor:for', { kind: 'host', host: 'srv', command: 'id' })).toBe(false);
  });
});
