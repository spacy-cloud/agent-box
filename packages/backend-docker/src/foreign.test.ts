import { describe, expect, it } from 'vitest';
import type Docker from 'dockerode';
import type { ForeignResource } from '@abox/core';
import { DockerProvider } from './provider.js';

/** An engine stand-in: containers, networks and volumes with labels; records what is removed. */
function fakeEngine(objects: {
  containers?: Array<{
    id: string;
    name: string;
    labels: Record<string, string>;
    state?: string;
    /** `State.StartedAt` as the engine reports it; default: never started. */
    startedAt?: string;
  }>;
  networks?: Array<{ id: string; name: string; labels: Record<string, string> }>;
  volumes?: Array<{ name: string; labels: Record<string, string> }>;
  /** Images by their tags; only snapshot images carry `abox.role=snapshot`. */
  images?: Array<{ id: string; tags: string[]; labels: Record<string, string> }>;
}) {
  const calls = {
    removed: [] as string[],
    filters: [] as unknown[],
    imageFilters: [] as unknown[],
    removeOpts: [] as unknown[],
  };
  const gone = (): never => {
    throw Object.assign(new Error('no such object'), { statusCode: 404 });
  };
  const matches = (labels: Record<string, string>, filters?: { label?: string[] }): boolean =>
    (filters?.label ?? []).every((l) => {
      const [k, v] = l.split('=');
      return labels[k!] === v;
    });
  const docker = {
    listContainers: (o: { filters?: { label?: string[] } }) => {
      calls.filters.push(o.filters);
      return Promise.resolve(
        (objects.containers ?? [])
          .filter((c) => matches(c.labels, o.filters))
          .map((c) => ({
            Id: c.id,
            Names: [`/${c.name}`],
            Labels: c.labels,
            State: c.state ?? 'running',
            Created: 1_700_000_000,
          })),
      );
    },
    listNetworks: (o: { filters?: { label?: string[] } }) =>
      Promise.resolve(
        (objects.networks ?? [])
          .filter((n) => matches(n.labels, o.filters))
          .map((n) => ({
            Id: n.id,
            Name: n.name,
            Labels: n.labels,
            Created: '2024-01-02T03:04:05Z',
          })),
      ),
    listVolumes: (o: { filters?: { label?: string[] } }) =>
      Promise.resolve({
        Volumes: (objects.volumes ?? [])
          .filter((v) => matches(v.labels, o.filters))
          .map((v) => ({ Name: v.name, Labels: v.labels, CreatedAt: '2024-02-03T04:05:06Z' })),
        Warnings: [],
      }),
    listImages: (o: { filters?: { label?: string[] } }) => {
      calls.imageFilters.push(o.filters);
      return Promise.resolve(
        (objects.images ?? [])
          .filter((i) => matches(i.labels, o.filters))
          .map((i) => ({ Id: i.id, RepoTags: i.tags, Labels: i.labels, Created: 1_600_000_000 })),
      );
    },
    getImage: (ref: string) => {
      const i = (objects.images ?? []).find((x) => x.tags.includes(ref) || x.id === ref);
      return {
        inspect: () => (i ? Promise.resolve({ Id: i.id, Config: { Labels: i.labels } }) : gone()),
        remove: () => {
          calls.removed.push(`image:${ref}`);
          return Promise.resolve();
        },
      };
    },
    getContainer: (ref: string) => {
      const c = (objects.containers ?? []).find((x) => x.id === ref);
      return {
        inspect: () =>
          c
            ? Promise.resolve({
                Id: c.id,
                Config: { Labels: c.labels },
                State: { StartedAt: c.startedAt ?? '0001-01-01T00:00:00Z' },
              })
            : gone(),
        remove: (opts: unknown) => {
          calls.removed.push(`container:${ref}`);
          calls.removeOpts.push(opts);
          return Promise.resolve();
        },
      };
    },
    getNetwork: (ref: string) => {
      const n = (objects.networks ?? []).find((x) => x.id === ref);
      return {
        inspect: () => (n ? Promise.resolve({ Id: n.id, Name: n.name, Labels: n.labels }) : gone()),
        remove: () => {
          calls.removed.push(`network:${ref}`);
          return Promise.resolve();
        },
      };
    },
    getVolume: (ref: string) => {
      const v = (objects.volumes ?? []).find((x) => x.name === ref);
      return {
        inspect: () => (v ? Promise.resolve({ Name: v.name, Labels: v.labels }) : gone()),
        remove: () => {
          calls.removed.push(`volume:${ref}`);
          return Promise.resolve();
        },
      };
    },
  };
  return { docker: docker as unknown as Docker, calls };
}

const host = { host: 'local', kind: 'local' } as const;
const mine = 'abc123';
const managed = (instance: string | undefined, extra: Record<string, string> = {}) => ({
  'abox.managed': '1',
  ...(instance !== undefined ? { 'abox.instance': instance } : {}),
  ...extra,
});

describe('listForeign / removeForeign (engine stand-in)', () => {
  const objects = {
    containers: [
      {
        id: 'c-mine',
        name: 'abox-local-aaaaaaaa',
        labels: managed(mine, { 'abox.role': 'sandbox' }),
      },
      {
        id: 'c-other',
        name: 'abox-local-bbbbbbbb',
        labels: managed('lost999', {
          'abox.role': 'sandbox',
          'abox.name': 'work',
          'abox.id': 'local/bbbbbbbb',
        }),
        state: 'exited',
        startedAt: '2024-03-04T05:06:07.123456789Z',
      },
      {
        id: 'c-proxy',
        name: 'abox-proxy-bbbbbbbb',
        labels: managed('lost999', { 'abox.role': 'proxy' }),
      },
      { id: 'c-empty', name: 'abox-local-cccccccc', labels: managed('') },
      { id: 'c-legacy', name: 'abox-local-dddddddd', labels: managed(undefined) },
      { id: 'c-plain', name: 'not-abox', labels: { app: 'web' } },
    ],
    networks: [
      {
        id: 'n-mine',
        name: 'abox-int-aaaaaaaa',
        labels: managed(mine, { 'abox.role': 'network' }),
      },
      {
        id: 'n-other',
        name: 'abox-int-bbbbbbbb',
        labels: managed('lost999', { 'abox.role': 'network' }),
      },
      { id: 'n-open', name: 'abox-open', labels: managed(undefined, { 'abox.role': 'network' }) },
      {
        id: 'n-egress',
        name: 'abox-egress',
        labels: managed(undefined, { 'abox.role': 'network' }),
      },
      { id: 'n-plain', name: 'bridge2', labels: {} },
    ],
    volumes: [
      { name: 'vol-mine', labels: managed(mine) },
      { name: 'vol-other', labels: managed('lost999') },
      { name: 'vol-plain', labels: {} },
    ],
    images: [
      {
        id: 'sha256:mine',
        tags: ['abox-snap/aaaaaaaa:keep'],
        labels: managed(mine, { 'abox.role': 'snapshot' }),
      },
      {
        id: 'sha256:other',
        tags: ['abox-snap/bbbbbbbb:before', 'abox-snap-base/cccccccc:base'],
        labels: {
          ...managed('lost999', {
            'abox.role': 'snapshot',
            'abox.name': 'work',
            'abox.id': 'local/bbbbbbbb',
          }),
        },
      },
      // an environment image of another installation is not a snapshot: never listed
      {
        id: 'sha256:env',
        tags: ['abox/node:abc'],
        labels: managed('lost999', { 'abox.role': 'image' }),
      },
    ],
  };

  it('lists abox-labelled objects of other or no instance, nothing else', async () => {
    const { docker, calls } = fakeEngine(objects);
    const p = new DockerProvider(host, { docker, instanceId: mine });
    const found = await p.listForeign();
    expect(found.map((f) => `${f.kind}:${f.ref}`)).toEqual([
      'container:c-other',
      'container:c-proxy',
      'container:c-empty',
      'container:c-legacy',
      'network:n-other',
      'volume:vol-other',
      'image:abox-snap/bbbbbbbb:before',
      'image:abox-snap-base/cccccccc:base',
    ]);
    expect(calls.filters).toEqual([{ label: ['abox.managed=1'] }]);
    expect(calls.imageFilters).toEqual([{ label: ['abox.role=snapshot'] }]);
    expect(found[0]).toEqual({
      kind: 'container',
      ref: 'c-other',
      name: 'abox-local-bbbbbbbb',
      instance: 'lost999',
      aboxName: 'work',
      sandboxId: 'local/bbbbbbbb',
      role: 'sandbox',
      state: 'exited',
      createdAt: 1_700_000_000_000,
      startedAt: Date.parse('2024-03-04T05:06:07.123Z'),
      engine: 'docker',
    });
    expect(found.find((f) => f.ref === 'abox-snap/bbbbbbbb:before')).toEqual({
      kind: 'image',
      ref: 'abox-snap/bbbbbbbb:before',
      name: 'abox-snap/bbbbbbbb:before',
      instance: 'lost999',
      aboxName: 'work',
      sandboxId: 'local/bbbbbbbb',
      role: 'snapshot',
      createdAt: 1_600_000_000_000,
      engine: 'docker',
    });
    // never started: no start time rather than year 1
    expect(found.find((f) => f.ref === 'c-proxy')).not.toHaveProperty('startedAt');
    expect(found.find((f) => f.ref === 'c-empty')?.instance).toBe('');
    expect(found.find((f) => f.ref === 'c-legacy')?.instance).toBe('');
    expect(found.find((f) => f.ref === 'n-other')?.createdAt).toBe(
      Date.parse('2024-01-02T03:04:05Z'),
    );
    expect(found.find((f) => f.ref === 'vol-other')?.createdAt).toBe(
      Date.parse('2024-02-03T04:05:06Z'),
    );
  });

  it('a container that vanishes between list and inspect is still listed, without a start time', async () => {
    const { docker } = fakeEngine(objects);
    const gone = docker.getContainer.bind(docker);
    (docker as unknown as { getContainer: unknown }).getContainer = (ref: string) =>
      ref === 'c-other'
        ? { inspect: () => Promise.reject(Object.assign(new Error('gone'), { statusCode: 404 })) }
        : gone(ref);
    const found = await new DockerProvider(host, { docker, instanceId: mine }).listForeign();
    expect(found.find((f) => f.ref === 'c-other')).not.toHaveProperty('startedAt');
    expect(found.map((f) => f.ref)).toContain('c-other');
  });

  it('an installation without an id treats every instance id as foreign, unlabelled objects as its own', async () => {
    const { docker } = fakeEngine(objects);
    const p = new DockerProvider(host, { docker, kind: 'podman' });
    const found = await p.listForeign();
    expect(found.map((f) => f.ref)).toEqual(
      expect.arrayContaining(['c-mine', 'c-other', 'n-mine', 'vol-mine']),
    );
    expect(found.map((f) => f.ref)).not.toContain('c-empty');
    expect(found.map((f) => f.ref)).not.toContain('c-legacy');
    expect(found.map((f) => f.ref)).not.toContain('n-open');
    expect(found[0]?.engine).toBe('podman');
  });

  it('removes a listed object (containers with their anonymous volumes)', async () => {
    const { docker, calls } = fakeEngine(objects);
    const p = new DockerProvider(host, { docker, instanceId: mine });
    for (const f of await p.listForeign()) await p.removeForeign(f);
    expect(calls.removed).toEqual([
      'container:c-other',
      'container:c-proxy',
      'container:c-empty',
      'container:c-legacy',
      'network:n-other',
      'volume:vol-other',
      'image:abox-snap/bbbbbbbb:before',
      'image:abox-snap-base/cccccccc:base',
    ]);
    expect(calls.removeOpts[0]).toEqual({ force: true, v: true });
  });

  it('refuses anything that is not a foreign abox object, whatever the caller passes', async () => {
    const { docker, calls } = fakeEngine(objects);
    const p = new DockerProvider(host, { docker, instanceId: mine });
    const r = (
      o: Partial<ForeignResource> & Pick<ForeignResource, 'kind' | 'ref'>,
    ): ForeignResource => ({
      name: o.ref,
      instance: 'x',
      engine: 'docker',
      ...o,
    });
    for (const bad of [
      r({ kind: 'container', ref: 'c-mine' }),
      r({ kind: 'container', ref: 'c-plain' }),
      r({ kind: 'network', ref: 'n-mine' }),
      r({ kind: 'network', ref: 'n-open' }),
      r({ kind: 'network', ref: 'n-egress' }),
      // the shared networks by name, also when they do not exist (yet) on this engine
      r({ kind: 'network', ref: 'abox-open' }),
      r({ kind: 'network', ref: 'abox-egress' }),
      r({ kind: 'network', ref: 'n-gone', name: 'abox-open' }),
      r({ kind: 'network', ref: 'n-plain' }),
      r({ kind: 'volume', ref: 'vol-mine' }),
      r({ kind: 'volume', ref: 'vol-plain' }),
      r({ kind: 'image', ref: 'abox-snap/aaaaaaaa:keep' }),
    ])
      await expect(p.removeForeign(bad), `${bad.kind} ${bad.ref}`).rejects.toMatchObject({
        code: 'conflict',
      });
    for (const ref of ['../etc', 'a/b', '-rf', '', 'x y'])
      await expect(p.removeForeign(r({ kind: 'container', ref }))).rejects.toMatchObject({
        code: 'invalid_input',
      });
    // an image is named by a snapshot tag only: not an environment image, not an id, not another tag
    for (const ref of [
      'abox/node:abc',
      'sha256:other',
      'alpine:3.22',
      'abox-snap/x',
      '../abox-snap/a:b',
    ])
      await expect(p.removeForeign(r({ kind: 'image', ref }))).rejects.toMatchObject({
        code: 'invalid_input',
      });
    expect(calls.removed).toEqual([]);
  });

  it('an object that is already gone is not an error', async () => {
    const { docker, calls } = fakeEngine(objects);
    const p = new DockerProvider(host, { docker, instanceId: mine });
    await p.removeForeign({
      kind: 'container',
      ref: 'c-vanished',
      name: 'x',
      instance: 'x',
      engine: 'docker',
    });
    expect(calls.removed).toEqual([]);
  });
});
