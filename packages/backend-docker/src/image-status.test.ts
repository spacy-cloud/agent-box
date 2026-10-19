import { tmpdir } from 'node:os';
import type Docker from 'dockerode';
import { describe, expect, it } from 'vitest';
import { parseTemplateYaml, resolveTemplate } from '@abox/core';
import type { HostConnection, ResolvedTemplate } from '@abox/core';
import { createDockerProvider } from './provider.js';
import { dockerEnabled, newProvider } from './__tests__/harness.js';

async function template(base = 'ubuntu:24.04'): Promise<ResolvedTemplate> {
  const text = `apiVersion: 1\nname: demo\nbackend: docker\nbase:\n  os: ${base}\ntools: [git]\n`;
  return resolveTemplate(parseTemplateYaml(text), {
    source: { kind: 'user', path: '/x/demo.yaml' },
    contentText: text,
  });
}

const notFound = () => Object.assign(new Error('no such image'), { statusCode: 404 });

/**
 * A client that can only inspect images and report engine info. Anything that would build or pull
 * (`pull`, `buildImage`) is missing on purpose: calling it fails the test with a TypeError.
 */
function engine(images: Record<string, { Size: number }>, info: Record<string, unknown> = {}) {
  const asked: string[] = [];
  const docker = {
    info: () => Promise.resolve({ Driver: 'overlay2', ...info }),
    version: () => Promise.resolve({ Version: '27.0.0', ApiVersion: '1.46' }),
    getImage: (ref: string) => ({
      inspect: () => {
        asked.push(ref);
        const img = images[ref];
        return img ? Promise.resolve({ Id: `sha256:${ref}`, ...img }) : Promise.reject(notFound());
      },
    }),
  } as unknown as Docker;
  return { docker, asked };
}

const local: HostConnection = { host: 'local', kind: 'local' };

describe('DockerProvider.imageStatus', () => {
  it('reports an existing environment image with its size, asking nothing else', async () => {
    const t = await template();
    const tag = `abox/demo:${t.hash.slice(0, 16)}`;
    const { docker, asked } = engine({ [tag]: { Size: 1234 } });
    const r = await createDockerProvider(local, { docker }).imageStatus(t);
    expect(r).toEqual({ ref: tag, present: true, sizeBytes: 1234 });
    expect(asked).toEqual([tag]);
  });

  it('reports a missing image and whether its base image is already on the engine', async () => {
    const t = await template();
    const tag = `abox/demo:${t.hash.slice(0, 16)}`;
    const withBase = engine({ 'ubuntu:24.04': { Size: 1 } });
    await expect(
      createDockerProvider(local, { docker: withBase.docker }).imageStatus(t),
    ).resolves.toEqual({
      ref: tag,
      present: false,
      base: { ref: 'ubuntu:24.04', present: true },
    });
    const without = engine({});
    await expect(
      createDockerProvider(local, { docker: without.docker }).imageStatus(t),
    ).resolves.toEqual({
      ref: tag,
      present: false,
      base: { ref: 'ubuntu:24.04', present: false },
    });
  });

  it('an engine that fails is an error the manager can report', async () => {
    const t = await template();
    const docker = {
      info: () => Promise.resolve({}),
      version: () => Promise.resolve({ Version: '1', ApiVersion: '1' }),
      getImage: () => ({
        inspect: () => Promise.reject(Object.assign(new Error('boom'), { statusCode: 500 })),
      }),
    } as unknown as Docker;
    await expect(createDockerProvider(local, { docker }).imageStatus(t)).rejects.toBeInstanceOf(
      Error,
    );
  });
});

describe('DockerProvider.diskSpace', () => {
  it('measures the storage root of a local engine', async () => {
    const { docker } = engine({}, { DockerRootDir: tmpdir() });
    const d = await createDockerProvider(local, { docker }).diskSpace();
    expect(d).toBeDefined();
    expect(d!.path).toBe(tmpdir());
    expect(d!.totalBytes).toBeGreaterThan(0);
    expect(d!.freeBytes).toBeGreaterThanOrEqual(0);
    expect(d!.freeBytes).toBeLessThanOrEqual(d!.totalBytes);
  });

  it('is unknown for a remote engine, a missing root and an engine that does not say', async () => {
    const { docker } = engine({}, { DockerRootDir: tmpdir() });
    const remote: HostConnection = { host: 'srv', kind: 'ssh' };
    await expect(createDockerProvider(remote, { docker }).diskSpace()).resolves.toBeUndefined();
    const gone = engine({}, { DockerRootDir: '/no/such/abox/storage/root' });
    await expect(
      createDockerProvider(local, { docker: gone.docker }).diskSpace(),
    ).resolves.toBeUndefined();
    const silent = engine({}, {});
    await expect(
      createDockerProvider(local, { docker: silent.docker }).diskSpace(),
    ).resolves.toBeUndefined();
  });
});

describe.skipIf(!dockerEnabled)('DockerProvider.imageStatus and diskSpace (real engine)', () => {
  it('only looks: a template that was never built is reported missing, and nothing is created', async () => {
    const p = newProvider();
    const unique = `doctor-${Math.random().toString(16).slice(2, 10)}`;
    const text = `apiVersion: 1\nname: ${unique}\nbackend: docker\nbase:\n  os: alpine:3.22\ntools: [git]\n`;
    const t = await resolveTemplate(parseTemplateYaml(text), {
      source: { kind: 'user', path: `/x/${unique}.yaml` },
      contentText: text,
    });
    const r = await p.imageStatus(t);
    expect(r.present).toBe(false);
    expect(r.ref).toBe(`abox/${unique}:${t.hash.slice(0, 16)}`);
    expect(r.base?.ref).toBe('alpine:3.22');
    expect(typeof r.base?.present).toBe('boolean');
  });

  it('reports the free space of the storage root of the engine', async () => {
    const d = await newProvider().diskSpace();
    // a local engine whose root this user may stat; a remote or hidden one is allowed to be unknown
    if (d) {
      expect(d.freeBytes).toBeGreaterThan(0);
      expect(d.totalBytes).toBeGreaterThanOrEqual(d.freeBytes);
    }
  });
});
