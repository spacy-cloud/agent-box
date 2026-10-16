import { randomBytes } from 'node:crypto';
import Docker from 'dockerode';
import {
  createDockerProvider,
  type DockerProvider,
  type DockerProviderOptions,
} from '../provider.js';
import type { SandboxSpec } from '@abox/core';

/**
 * The engine is shared with other developers' test runs (core, python, e2e sweep `abox.test=1`), so
 * this package labels its objects with a key of its own and a value that is unique per process.
 */
export const TEST_LABEL = 'abox.dtest';
export const TEST_RUN = randomBytes(4).toString('hex');

/** Instance id of the providers of this process: they only see and delete their own objects. */
export const TEST_INSTANCE = `dtest${TEST_RUN}`;

export const dockerEnabled = process.env['ABOX_TEST_DOCKER'] === '1';

export function newProvider(opts: DockerProviderOptions = {}): DockerProvider {
  return createDockerProvider(
    { host: 'local', kind: 'local' },
    {
      instanceId: TEST_INSTANCE,
      stopTimeoutSec: 1,
      ...opts,
      extraLabels: { [TEST_LABEL]: TEST_RUN, ...opts.extraLabels },
    },
  );
}

/** Remove everything this process created (label `abox.dtest=<run>`): containers, networks, images. */
export async function sweepTestObjects(socketPath = '/var/run/docker.sock'): Promise<void> {
  const docker = new Docker({ socketPath });
  const filters = { label: [`${TEST_LABEL}=${TEST_RUN}`] };
  for (const c of await docker.listContainers({ all: true, filters })) {
    await docker
      .getContainer(c.Id)
      .remove({ force: true, v: true })
      .catch(() => undefined);
  }
  for (const n of await docker.listNetworks({ filters })) {
    await docker
      .getNetwork(n.Id)
      .remove()
      .catch(() => undefined);
  }
  for (const i of await docker.listImages({ filters })) {
    for (const t of i.RepoTags ?? [])
      await docker
        .getImage(t)
        .remove({ force: true })
        .catch(() => undefined);
    if ((i.RepoTags ?? []).length === 0)
      await docker
        .getImage(i.Id)
        .remove({ force: true })
        .catch(() => undefined);
  }
  // Snapshot images carry the label through `commit` changes as well.
}

export class Tracker {
  readonly ids: string[] = [];
  constructor(private readonly provider: DockerProvider) {}
  async create(spec: SandboxSpec, start = true): Promise<SandboxSpec> {
    this.ids.push(spec.id);
    await this.provider.create(spec);
    if (start) await this.provider.start(spec.id);
    return spec;
  }
  async cleanup(): Promise<void> {
    for (const id of this.ids) await this.provider.remove(id).catch(() => undefined);
  }
}
