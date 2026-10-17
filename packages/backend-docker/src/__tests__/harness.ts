import { randomBytes } from 'node:crypto';
import Docker from 'dockerode';
import {
  createDockerProvider,
  createPodmanProvider,
  defaultSocketPath,
  type DockerProvider,
  type DockerProviderOptions,
} from '../provider.js';
import type { SandboxSpec } from '@abox/core';

/**
 * The engine is shared with other developers' test runs (core, python, e2e sweep `abox.test=1`), so
 * this package labels its objects with a key of its own and a value that is unique per process.
 */
export const TEST_LABEL = 'abox.dtest';
/** Process that owns the objects: when it is gone, a later run may remove them. */
export const TEST_PID_LABEL = 'abox.dtest-pid';
export const TEST_RUN = randomBytes(4).toString('hex');

/** Instance id of the providers of this process: they only see and delete their own objects. */
export const TEST_INSTANCE = `dtest${TEST_RUN}`;

export const dockerEnabled = process.env['ABOX_TEST_DOCKER'] === '1';

/**
 * The engine the integration tests run against: `ABOX_TEST_ENGINE=podman` makes `newProvider` a Podman
 * provider (default: Docker), `ABOX_TEST_ENGINE_SOCKET=/path/to/engine.sock` points every client of the
 * suite at another socket (default: the engine's usual one: `/var/run/docker.sock`, or Podman's user
 * socket). Together they run the suite against a Podman socket.
 */
export const TEST_ENGINE: 'docker' | 'podman' =
  process.env['ABOX_TEST_ENGINE'] === 'podman' ? 'podman' : 'docker';
export const TEST_SOCKET: string =
  process.env['ABOX_TEST_ENGINE_SOCKET'] || defaultSocketPath(TEST_ENGINE);

export function newProvider(opts: DockerProviderOptions = {}): DockerProvider {
  return (TEST_ENGINE === 'podman' ? createPodmanProvider : createDockerProvider)(
    { host: 'local', kind: 'local' },
    {
      socketPath: TEST_SOCKET,
      instanceId: TEST_INSTANCE,
      stopTimeoutSec: 1,
      ...opts,
      extraLabels: {
        [TEST_LABEL]: TEST_RUN,
        [TEST_PID_LABEL]: String(process.pid),
        ...opts.extraLabels,
      },
    },
  );
}

/** Objects of a run that was killed (timeout, Ctrl-C, crash) stay behind; a later run removes them once they are this old. */
export const STALE_AFTER_MS = 30 * 60_000;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

type Labeled = { Labels?: Record<string, string> | null };

/**
 * An object of another run is stale when the process that created it is gone (`abox.dtest-pid`) or,
 * for objects without that label, when it is older than `STALE_AFTER_MS`. Objects of a live run are
 * never touched.
 */
function isStale(o: Labeled, createdMs: number): boolean {
  const pid = Number(o.Labels?.[TEST_PID_LABEL]);
  if (Number.isInteger(pid) && pid > 0) return !processAlive(pid);
  return Date.now() - createdMs > STALE_AFTER_MS;
}

/** Removes the objects matching `filters`; `only` narrows the set (stale sweep). */
async function removeAll(
  docker: Docker,
  filters: { label: string[] },
  only: (o: Labeled, createdMs: number) => boolean = () => true,
  images = true,
): Promise<void> {
  for (const c of await docker.listContainers({ all: true, filters })) {
    if (!only(c, c.Created * 1000)) continue;
    await docker
      .getContainer(c.Id)
      .remove({ force: true, v: true })
      .catch(() => undefined);
  }
  for (const n of await docker.listNetworks({ filters })) {
    if (!only(n, Date.parse(n.Created ?? '') || 0)) continue;
    await docker
      .getNetwork(n.Id)
      .remove()
      .catch(() => undefined);
  }
  const vols = await docker.listVolumes({ filters }).catch(() => ({ Volumes: [] }));
  for (const v of vols.Volumes ?? []) {
    if (!only(v, Date.parse(v.CreatedAt ?? '') || 0)) continue;
    await docker
      .getVolume(v.Name)
      .remove({ force: true })
      .catch(() => undefined);
  }
  if (!images) return;
  for (const i of await docker.listImages({ filters })) {
    if (!only(i, i.Created * 1000)) continue;
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

async function leftovers(docker: Docker, filters: { label: string[] }): Promise<string[]> {
  const left: string[] = [];
  for (const c of await docker.listContainers({ all: true, filters }))
    left.push(`container ${c.Names?.[0] ?? c.Id}`);
  for (const n of await docker.listNetworks({ filters })) left.push(`network ${n.Name}`);
  const vols = await docker.listVolumes({ filters }).catch(() => ({ Volumes: [] }));
  for (const v of vols.Volumes ?? []) left.push(`volume ${v.Name}`);
  return left;
}

/**
 * Remove everything this process created (label `abox.dtest=<run>`): containers (any state, also
 * `created` ones that never started and ones whose TTL ended), networks, volumes, images. Retries and
 * fails loudly when something is still there, so a leak shows up as a failed test run instead of
 * piling up on the engine. It also removes what runs that were killed before their cleanup left
 * behind: objects of any other `abox.dtest` run whose creating process is gone (or, without the pid
 * label, older than `STALE_AFTER_MS`).
 */
export async function sweepTestObjects(socketPath = TEST_SOCKET): Promise<void> {
  const docker = new Docker({ socketPath });
  const own = { label: [`${TEST_LABEL}=${TEST_RUN}`] };
  let left: string[] = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    await removeAll(docker, own);
    left = await leftovers(docker, own);
    if (left.length === 0) break;
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  // Runs of other processes are touched only when they are clearly dead.
  // Images are left alone here: they are a cache keyed by the template hash, and a run in progress may be using one
  // that an earlier run built (and labelled).
  await removeAll(docker, { label: [TEST_LABEL] }, isStale, false).catch(() => undefined);
  if (left.length > 0) {
    throw new Error(`test objects of run ${TEST_RUN} could not be removed: ${left.join(', ')}`);
  }
}

/**
 * A run that is interrupted (Ctrl-C, `timeout`, a closed terminal) removes its objects before it
 * exits. A SIGKILL cannot be caught; the stale sweep of the next run covers that.
 */
let signalsHooked = false;
export function sweepOnSignals(socketPath = TEST_SOCKET): void {
  if (signalsHooked || !dockerEnabled) return;
  signalsHooked = true;
  for (const [sig, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 129],
  ] as const) {
    process.once(sig, () => {
      const hard = setTimeout(() => process.exit(code), 20_000);
      hard.unref();
      sweepTestObjects(socketPath).then(
        () => process.exit(code),
        () => process.exit(code),
      );
    });
  }
}
sweepOnSignals();

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
