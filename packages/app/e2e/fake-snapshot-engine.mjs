// A container engine in memory that manages snapshots like the docker backend does, for the snapshot e2e
// tests (no docker needed). Loaded before the GUI's main module like `fake-engine.mjs` (see `useFakeEngine`).
//
// - `snapshot` records an entry with a size (a MiB per file the test wrote, so sizes differ),
//   `listSnapshots` / `deleteSnapshot` answer for all sandboxes, and a snapshot outlives its sandbox (what a
//   real engine does when it could not delete the image), so "sandbox deleted" rows exist.
// - `create` accepts `spec.fromSnapshot` and records it, so a test can see what the manager passed.
import { AboxError } from '@abox/core';
import { registerProvider } from '@abox/runtime';

const MIB = 1024 * 1024;

class FakeSnapshotEngine {
  kind = 'docker';
  isolation = 'container';

  constructor(host) {
    this.host = host;
    this.sandboxes = new Map();
    this.snapshots = new Map();
    this.counter = 0;
  }

  capabilities() {
    return {
      isolation: 'container',
      networkModes: ['none', 'allowlist', 'open'],
      networkFilter: true,
      workspaceDelivery: ['none', 'copy', 'bind'],
      mounts: true,
      snapshots: true,
      snapshotClone: true,
      tty: false,
      limits: { cpus: true, memory: true, pids: true, disk: true },
      nonRootUser: true,
      secretInjection: ['proxy', 'env', 'file'],
      osFamilies: ['debian', 'alpine', 'fedora', 'arch', 'unknown'],
      remote: false,
      extendExpiry: true,
    };
  }

  status() {
    return Promise.resolve({ ok: true, version: 'fake', details: ['in memory'], warnings: [] });
  }

  prepare(template) {
    return Promise.resolve({
      ref: `fake/${template.name}:${template.hash.slice(0, 12)}`,
      templateHash: template.hash,
      cached: true,
      pinnedBase: `ubuntu@sha256:${template.hash.slice(0, 16)}`,
    });
  }

  gcImages() {
    return Promise.resolve([]);
  }

  get(id) {
    const sb = this.sandboxes.get(id);
    if (!sb) throw new AboxError('not_found', `sandbox '${id}' not found`);
    return sb;
  }

  info(sb) {
    const s = sb.spec;
    return {
      id: s.id,
      host: s.host,
      name: s.name,
      state: sb.state,
      backend: 'docker',
      isolation: 'container',
      template: s.template.name,
      templateHash: s.template.hash,
      owner: s.owner,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      labels: { ...s.labels },
      backendRef: `fake:${s.id}`,
      effective: {
        fake: true,
        network: s.network.mode,
        nonRoot: true,
        ...(s.fromSnapshot ? { fromSnapshot: s.fromSnapshot } : {}),
      },
    };
  }

  create(spec) {
    if (spec.fromSnapshot && !this.snapshots.has(spec.fromSnapshot)) {
      return Promise.reject(new AboxError('not_found', `unknown snapshot ${spec.fromSnapshot}`));
    }
    this.sandboxes.set(spec.id, { spec, state: 'created' });
    return Promise.resolve(this.info(this.sandboxes.get(spec.id)));
  }

  start(id) {
    this.get(id).state = 'running';
    return Promise.resolve();
  }

  stop(id) {
    this.get(id).state = 'stopped';
    return Promise.resolve();
  }

  // The snapshots stay: the engine could not delete an image that was in use.
  remove(id) {
    this.sandboxes.delete(id);
    return Promise.resolve();
  }

  extendExpiry(id, expiresAt) {
    const sb = this.get(id);
    sb.spec = { ...sb.spec, expiresAt };
    return Promise.resolve();
  }

  exec(id) {
    this.get(id);
    return Promise.resolve({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false,
      durationMs: 1,
    });
  }

  // eslint-disable-next-line require-yield
  async *spawn() {
    throw new AboxError('unsupported', 'spawn is not supported by the fake engine');
  }

  attach() {
    return Promise.reject(new AboxError('unsupported', 'tty is not supported by the fake engine'));
  }

  copyIn() {
    return Promise.resolve();
  }

  copyOut() {
    return Promise.resolve();
  }

  readFile(id, path) {
    this.get(id);
    return Promise.reject(new AboxError('not_found', `no such file ${path}`));
  }

  writeFile() {
    return Promise.resolve();
  }

  listDir() {
    return Promise.resolve([]);
  }

  inspect(id) {
    return Promise.resolve(this.info(this.get(id)));
  }

  list() {
    return Promise.resolve([...this.sandboxes.values()].map((sb) => this.info(sb)));
  }

  snapshot(id, name) {
    const sb = this.get(id);
    const snapshotId = `abox-snap/${id.split('/')[1]}:${name}`;
    this.snapshots.set(snapshotId, {
      snapshotId,
      sandboxId: id,
      name,
      createdAt: Date.now() - 60_000 * (this.counter % 5),
      sizeBytes: (3 + 2 * this.counter++) * MIB,
      template: sb.spec.template.name,
      carriesSecrets: false,
    });
    return Promise.resolve(snapshotId);
  }

  restore(id, snapshotId) {
    this.get(id);
    if (!this.snapshots.has(snapshotId)) {
      return Promise.reject(new AboxError('not_found', `Unknown snapshot ${snapshotId}`));
    }
    return Promise.resolve();
  }

  listSnapshots(opts) {
    return Promise.resolve(
      [...this.snapshots.values()]
        .filter((s) => !opts?.sandboxId || s.sandboxId === opts.sandboxId)
        .map((s) => ({ ...s })),
    );
  }

  deleteSnapshot(sandboxId, snapshotId) {
    const s = this.snapshots.get(snapshotId);
    if (!s) return Promise.resolve();
    if (s.sandboxId !== sandboxId) {
      return Promise.reject(new AboxError('not_found', `Unknown snapshot ${snapshotId}`));
    }
    this.snapshots.delete(snapshotId);
    return Promise.resolve();
  }
}

registerProvider('docker', () => (host) => new FakeSnapshotEngine(host));
