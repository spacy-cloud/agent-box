import { describe, expect, it } from 'vitest';
import type Docker from 'dockerode';
import { DockerProvider } from './index.js';

/** A minimal engine: only what `init()` and `status()` ask. */
function fakeEngine(runtimes: string[]): Docker {
  return {
    ping: async () => 'OK',
    info: async () => ({
      Driver: 'overlay2',
      DriverStatus: [['Backing Filesystem', 'extfs']],
      Runtimes: Object.fromEntries(runtimes.map((r) => [r, { path: r }])),
      SecurityOptions: ['name=seccomp,profile=builtin', 'name=rootless'],
      CgroupVersion: '2',
    }),
    version: async () => ({ Version: '27.0.0', ApiVersion: '1.47' }),
    createNetwork: async () => ({ remove: async () => undefined }),
    listContainers: async () => [],
  } as unknown as Docker;
}

const host = { host: 'local', kind: 'local' } as const;
const make = (engineRuntimes: string[], hardenedRuntime?: string): DockerProvider =>
  new DockerProvider(host, {
    docker: fakeEngine(engineRuntimes),
    proxy: false,
    ...(hardenedRuntime ? { hardenedRuntime } : {}),
  });

describe('hardened runtime detection (fake engine)', () => {
  it('is hardened only when the configured runtime is installed in the engine', async () => {
    const p = make(['runc', 'runsc'], 'runsc');
    expect(p.hardenedRuntime).toBe('runsc');
    expect(p.capabilities().isolation).toBe('container'); // not known before the engine was asked
    await p.init();
    expect(p.capabilities().isolation).toBe('hardened');
    expect(p.isolation).toBe('hardened');
    const st = await p.status();
    expect(st.details.join('\n')).toContain('isolation: hardened');
    expect(st.warnings.join('\n')).not.toContain('hardened runtime');
  });

  it('stays at container and warns when the runtime is configured but missing', async () => {
    const p = make(['runc'], 'runsc');
    await p.init();
    expect(p.capabilities().isolation).toBe('container');
    const st = await p.status();
    expect(st.ok).toBe(true);
    expect(st.details.join('\n')).toContain('isolation: container');
    expect(st.warnings.join('\n')).toContain(
      'Configured hardened runtime "runsc" is not installed',
    );
  });

  it('stays at container when nothing is configured, even if the engine has runsc', async () => {
    const p = make(['runc', 'runsc']);
    await p.init();
    expect(p.hardenedRuntime).toBeUndefined();
    expect(p.capabilities().isolation).toBe('container');
  });

  it('a template that needs hardened is refused on a container-only provider', async () => {
    const p = make(['runc'], 'kata');
    await p.init();
    const spec = {
      host: 'local',
      id: 'local/abcd1234',
      template: { isolation: 'hardened' },
      network: { mode: 'none', injections: [] },
      workspace: { kind: 'none' },
      mounts: [],
      resources: {},
      user: { uid: 1000 },
    };
    await expect(p.create(spec as never)).rejects.toMatchObject({ code: 'unsupported' });
  });
});
