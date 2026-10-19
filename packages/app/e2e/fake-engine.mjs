// A container engine in memory, for the port forward e2e tests (no docker needed).
//
// The GUI process loads this file before its own main module (see `useFakeEngine` in helpers.ts). It
// replaces the `docker` backend of @abox/runtime with an in-memory provider that can forward ports like the
// real container backends: only for network modes allowlist and open, forwards end with the sandbox, the host
// side is 127.0.0.1. Nothing listens on the forwarded host ports: opening a preview is checked with a stubbed
// `shell.openExternal`. The server "in the sandbox" answers on port 5173 only (target `up`), everything
// else is `down`, so both states show up in the panel.
import { setTimeout as sleep } from 'node:timers/promises';
import { AboxError } from '@abox/core';
import { registerProvider } from '@abox/runtime';

const ANSWERING_PORT = 5173;

class FakeEngine {
  kind = 'docker';
  isolation = 'container';

  constructor(host) {
    this.host = host;
    this.sandboxes = new Map();
    this.forwards = new Map();
    this.nextHostPort = 41_000;
  }

  capabilities() {
    return {
      isolation: 'container',
      networkModes: ['none', 'allowlist', 'open'],
      networkFilter: true,
      workspaceDelivery: ['none', 'copy', 'bind'],
      mounts: true,
      snapshots: false,
      tty: false,
      limits: { cpus: true, memory: true, pids: true, disk: true },
      nonRootUser: true,
      secretInjection: ['proxy', 'env', 'file'],
      osFamilies: ['debian', 'alpine', 'fedora', 'arch', 'unknown'],
      remote: false,
      extendExpiry: true,
      portForward: ['allowlist', 'open'],
    };
  }

  status() {
    return Promise.resolve({ ok: true, version: 'fake', details: ['in memory'], warnings: [] });
  }

  // Templates called `build-*` or `fail-*` run a pretend image build: output lines (with credentials, to see
  // that they are masked before the window gets them) arrive one by one, `fail-*` ends in an error. Every
  // other template is "already built", as before.
  async prepare(template, opts = {}) {
    const ref = `fake/${template.name}:${template.hash.slice(0, 12)}`;
    const pinnedBase = `ubuntu@sha256:${template.hash.slice(0, 16)}`;
    if (!/^(build|fail)-/.test(template.name)) {
      return { ref, templateHash: template.hash, cached: true, pinnedBase };
    }
    const say = (line) => opts.onProgress?.(line);
    const steps = 120;
    const pause = () => sleep(12);
    for (let i = 1; i <= steps; i++) {
      say(`Step ${i}/${steps} : RUN install-part-${i}`);
      if (i === 3) say('Step 3/120 : ENV API_TOKEN=tok-e2e-1234567890');
      if (i === 4) say('fetching https://bob:hunter2pw@registry.example.org/pkg.tgz');
      if (opts.signal?.aborted) break;
      await pause();
      if (template.name.startsWith('fail-') && i === 60) {
        say('ERROR: the step failed (fake engine)');
        throw new AboxError('backend_error', 'Image build failed: the step failed (fake engine)', {
          details: { log: 'ERROR: the step failed (fake engine)' },
        });
      }
    }
    return { ref, templateHash: template.hash, cached: false, pinnedBase };
  }

  gcImages() {
    return Promise.resolve([]);
  }

  // The readiness check (`abox doctor --for`) asks these two; they only look. The image is never built
  // and the disk has room, so the answer does not depend on the machine the test runs on.
  imageStatus(template) {
    return Promise.resolve({
      ref: `fake/${template.name}:${template.hash.slice(0, 12)}`,
      present: false,
      base: { ref: 'ubuntu:24.04', present: true },
    });
  }

  diskSpace() {
    const GiB = 1024 ** 3;
    return Promise.resolve({
      path: '/var/lib/fake-engine',
      freeBytes: 200 * GiB,
      totalBytes: 500 * GiB,
    });
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
      effective: { fake: true, network: s.network.mode, nonRoot: true },
    };
  }

  create(spec) {
    this.sandboxes.set(spec.id, { spec, state: 'created' });
    return Promise.resolve(this.info(this.sandboxes.get(spec.id)));
  }

  start(id) {
    this.get(id).state = 'running';
    return Promise.resolve();
  }

  stop(id) {
    this.get(id).state = 'stopped';
    this.forwards.delete(id);
    return Promise.resolve();
  }

  remove(id) {
    this.sandboxes.delete(id);
    this.forwards.delete(id);
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

  addPortForward(id, req) {
    const sb = this.get(id);
    if (sb.state !== 'running') {
      return Promise.reject(new AboxError('conflict', `sandbox ${id} is not running`));
    }
    const open = this.forwards.get(id) ?? [];
    if (open.some((p) => p.sandboxPort === req.sandboxPort)) {
      return Promise.reject(
        new AboxError('conflict', `port ${req.sandboxPort} is already forwarded`),
      );
    }
    const hostPort = req.hostPort ?? this.nextHostPort++;
    if (open.some((p) => p.hostPort === hostPort)) {
      return Promise.reject(
        new AboxError('conflict', `host port ${hostPort} is already in use`, {
          hint: 'Pick another host port or leave it empty.',
        }),
      );
    }
    const fwd = {
      sandboxPort: req.sandboxPort,
      hostAddress: '127.0.0.1',
      hostPort,
      url: `http://127.0.0.1:${hostPort}/`,
      createdAt: Date.now(),
      target: req.sandboxPort === ANSWERING_PORT ? 'up' : 'down',
      connections: 0,
    };
    this.forwards.set(id, [...open, fwd]);
    return Promise.resolve({ ...fwd });
  }

  listPortForwards(id) {
    this.get(id);
    return Promise.resolve(
      [...(this.forwards.get(id) ?? [])]
        .sort((a, b) => a.sandboxPort - b.sandboxPort)
        .map((p) => ({ ...p })),
    );
  }

  removePortForward(id, sandboxPort) {
    this.get(id);
    const open = this.forwards.get(id) ?? [];
    const gone = open.find((p) => p.sandboxPort === sandboxPort);
    this.forwards.set(
      id,
      open.filter((p) => p !== gone),
    );
    return Promise.resolve(gone ? { ...gone } : undefined);
  }
}

registerProvider('docker', () => (host) => new FakeEngine(host));
