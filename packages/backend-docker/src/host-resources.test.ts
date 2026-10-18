import { execFileSync } from 'node:child_process';
import type Docker from 'dockerode';
import { describe, expect, it } from 'vitest';
import { createDockerProvider } from './provider.js';
import { TEST_ENGINE, TEST_SOCKET, dockerEnabled, newProvider } from './__tests__/harness.js';

/** A client that only knows `info()` and `version()`, like the part of the engine API `hostResources` uses. */
function withInfo(info: () => Promise<unknown>) {
  const docker = {
    info,
    version: () => Promise.resolve({ Version: '27.0.0', ApiVersion: '1.46' }),
  } as unknown as Docker;
  return createDockerProvider({ host: 'local', kind: 'local' }, { docker });
}

describe('DockerProvider.hostResources (fake engine)', () => {
  it('reads NCPU and MemTotal of the engine info: the capacity the sandboxes share', async () => {
    const p = withInfo(() =>
      Promise.resolve({ NCPU: 8, MemTotal: 16 * 1024 ** 3, Driver: 'overlay2' }),
    );
    await expect(p.hostResources()).resolves.toEqual({ cpus: 8, memoryBytes: 16 * 1024 ** 3 });
  });

  it('is undefined when the engine does not say (or says nonsense), never a guess', async () => {
    for (const info of [
      {},
      { NCPU: 0, MemTotal: 0 },
      { NCPU: 4 },
      { MemTotal: 1024 },
      { NCPU: 'many', MemTotal: 'lots' },
      { NCPU: -1, MemTotal: 5 },
    ]) {
      await expect(
        withInfo(() => Promise.resolve(info)).hostResources(),
        JSON.stringify(info),
      ).resolves.toBeUndefined();
    }
  });

  it('an engine that cannot be reached is an error the manager can report', async () => {
    const p = withInfo(() =>
      Promise.reject(Object.assign(new Error('connect ENOENT /x'), { code: 'ENOENT' })),
    );
    await expect(p.hostResources()).rejects.toMatchObject({ code: expect.any(String) });
  });

  it('is part of the provider interface (the manager looks for it)', () => {
    expect(typeof withInfo(() => Promise.resolve({})).hostResources).toBe('function');
  });
});

describe.skipIf(!dockerEnabled)('DockerProvider.hostResources (real engine)', () => {
  it('returns what the engine itself reports as NCPU and MemTotal', async () => {
    const info = JSON.parse(
      execFileSync(TEST_ENGINE, ['info', '--format', '{{json .}}'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          ...(TEST_ENGINE === 'docker' ? { DOCKER_HOST: `unix://${TEST_SOCKET}` } : {}),
        },
      }),
    ) as { NCPU?: number; MemTotal?: number; host?: { cpus?: number; memTotal?: number } };
    const r = await newProvider().hostResources();
    expect(r).toBeDefined();
    expect(r!.cpus).toBe(info.NCPU ?? info.host?.cpus);
    expect(r!.memoryBytes).toBe(info.MemTotal ?? info.host?.memTotal);
    expect(r!.cpus).toBeGreaterThan(0);
    expect(r!.memoryBytes).toBeGreaterThan(0);
  });
});
