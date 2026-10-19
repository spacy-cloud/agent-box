import { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest';
import {
  NETWORK_MODES,
  type ErrorCode,
  type ExecEvent,
  type ExecRequest,
  type ExecResult,
  type PreparedImage,
  type ProviderCapabilities,
  type ResolvedTemplate,
  type SandboxProvider,
  type SandboxSpec,
} from '@abox/core';
import { cleanupSandbox, makeTestSpec, randomId, sleep, waitFor } from './helpers.js';

/**
 * Options for {@link defineProviderContract}.
 *
 * Contract semantics that are not obvious from `SandboxProvider` and that every
 * backend must follow (the suite below enforces them):
 *
 * - `create()` leaves the sandbox in state `created`; `start()` makes it `running`; `stop()`
 *   makes it `stopped`. `exec`/`spawn` on a sandbox that is not running reject with `conflict`.
 * - `create()` with an id that already exists rejects with `conflict` and leaves the first sandbox intact.
 * - A failed `create()` (including every `unsupported` rejection) leaves nothing behind.
 * - `inspect`/`list` report state `expired` once `expiresAt < now`, regardless of the
 *   lifecycle state. `create()` with an `expiresAt` in the past succeeds.
 * - `extendExpiry(id, t)` (only with `capabilities().extendExpiry`) moves the deadline at which
 *   the backend itself ends the sandbox, not just the reported one: a sandbox extended past its
 *   original `expiresAt` keeps running, can be stopped and started again, and reports `t`.
 *   It never shortens (`invalid_input`); without the capability the method is absent or rejects
 *   with `unsupported`.
 * - `updateResources(id, limits)` (only with `capabilities().updateResources`) changes the cpu and/or
 *   memory limit of a running or stopped sandbox and keeps it across a restart; an empty or
 *   invalid request is `invalid_input`; without the capability the method is absent or rejects
 *   with `unsupported`.
 * - `addPortForward` / `listPortForwards` / `removePortForward` (only with a non-empty
 *   `capabilities().portForward`) publish a TCP port of a running sandbox on `127.0.0.1` of the
 *   machine running abox only, without giving the sandbox any new way out; they end with the
 *   sandbox (`stop`, `remove`). Real port-forward behaviour is tested per backend, not here.
 * - `copyIn(host, p)` / `copyOut(p, host)`: the entry at the source *becomes* the entry at the
 *   destination path (like `cp -a src dst` with a non-existing `dst`); the destination's parent
 *   must exist. Directories are copied recursively.
 * - Absolute sandbox paths are only meaningful for the file APIs (`readFile`, `writeFile`, ...).
 *   Commands should use relative paths against `cwd`: backends without a filesystem boundary
 *   (`process`) cannot translate absolute sandbox paths inside command lines.
 * - `spawn` ignores `maxOutputBytes` (there is no truncation flag on a stream).
 */
export interface ContractOptions {
  name: string;
  createProvider(): Promise<SandboxProvider> | SandboxProvider;
  /** Minimal valid template for this backend. */
  template(): ResolvedTemplate;
  /** Spec builder hook to adapt delivery etc. Applied to every base spec before test overrides. */
  spec?(base: SandboxSpec): SandboxSpec;
  /** Skip the whole suite (`true`, or a reason string shown in the suite name). */
  skip?: boolean | string;
  /** Per-test timeout in ms (default 60 000). */
  timeoutMs?: number;
  /**
   * Run the `gcImages` tests. These call `gcImages(keep)` which removes every cached
   * image not in `keep`, so enable it only when the image store belongs to the test run
   * (default false).
   */
  gc?: boolean;
  /**
   * Time in ms a `create` + `start` may take on this backend (default 0). The "running sandbox
   * becomes expired" test sets the TTL to `startBudgetMs + 2500` so that slow-booting backends
   * (a cold VM needs 3-6 s) are still running when they have started.
   */
  startBudgetMs?: number;
  /** Called once after the suite, e.g. to delete a temp data directory. */
  dispose?(provider: SandboxProvider): Promise<void> | void;
}

interface ErrorLike {
  name?: unknown;
  code?: unknown;
  message?: unknown;
}

async function captureError(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  return undefined;
}

/** Asserts that `p` rejects with an `AboxError` carrying one of `codes`. */
async function expectRejects(p: Promise<unknown>, ...codes: ErrorCode[]): Promise<void> {
  const err = await captureError(p);
  expect(
    err,
    `expected a rejection with code ${codes.join(' | ')}, but the call succeeded`,
  ).toBeDefined();
  const e = err as ErrorLike;
  expect(e.name, `expected an AboxError, got: ${String((err as Error)?.stack ?? err)}`).toBe(
    'AboxError',
  );
  expect(codes, `unexpected error code '${String(e.code)}': ${String(e.message)}`).toContain(
    e.code,
  );
}

async function collect(iter: AsyncIterable<ExecEvent>): Promise<Array<ExecEvent & { at: number }>> {
  const out: Array<ExecEvent & { at: number }> = [];
  for await (const ev of iter) out.push({ ...ev, at: Date.now() });
  return out;
}

function joinData(events: ExecEvent[], type: 'stdout' | 'stderr'): string {
  return Buffer.concat(events.flatMap((e) => (e.type === type ? [e.data] : []))).toString('utf8');
}

/** Recursively reads a host directory into `relPath -> content | 'dir'`. */
async function readTree(root: string, rel = ''): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const ent of await readdir(join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      out[r] = 'dir';
      Object.assign(out, await readTree(root, r));
    } else if (ent.isFile()) {
      out[r] = (await readFile(join(root, r))).toString('base64');
    } else {
      out[r] = 'other';
    }
  }
  return out;
}

const BINARY = Buffer.concat([
  Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
  Buffer.from([0, 0, 255, 255, 0, 10, 13, 10, 0]),
  randomBytes(3000),
]);

/**
 * Registers the complete provider contract suite (Vitest `describe`/`it`).
 * Call it from a `*.test.ts` file of the backend package.
 */
export function defineProviderContract(opts: ContractOptions): void {
  const skipReason = typeof opts.skip === 'string' ? opts.skip : undefined;
  const suiteName = `provider contract: ${opts.name}${skipReason ? ` [skipped: ${skipReason}]` : ''}`;
  const suite = opts.skip ? describe.skip : describe;
  const timeout = opts.timeoutMs ?? 60_000;

  suite(suiteName, () => {
    let provider!: SandboxProvider;
    let template!: ResolvedTemplate;
    let image!: PreparedImage;
    let caps!: ProviderCapabilities;
    let ws!: string;
    const createdIds = new Set<string>();
    const tmpDirs: string[] = [];

    // -- plumbing --------------------------------------------------------------------------

    const test = (name: string, fn: (ctx: TestContext) => Promise<void>) =>
      it(name, { timeout }, fn);

    /** Builds a spec (base -> `opts.spec` hook -> overrides) and registers it for the final sweep. */
    async function mk(overrides: Partial<SandboxSpec> = {}): Promise<SandboxSpec> {
      let spec = await makeTestSpec(provider, template, { image });
      if (opts.spec) spec = opts.spec(spec);
      spec = { ...spec, ...overrides };
      createdIds.add(spec.id);
      return spec;
    }

    async function tmp(): Promise<string> {
      const dir = await mkdtemp(join(tmpdir(), 'abox-ct-'));
      await chmod(dir, 0o755);
      tmpDirs.push(dir);
      return dir;
    }

    const wsPath = (name: string): string => posix.join(ws, name);

    /** Creates + starts a sandbox, returns its id. Cleanup is done by the final sweep or `finish`. */
    async function startSandbox(overrides: Partial<SandboxSpec> = {}): Promise<string> {
      const spec = await mk(overrides);
      await provider.create(spec);
      await provider.start(spec.id);
      return spec.id;
    }

    async function finish(id: string): Promise<void> {
      await cleanupSandbox(provider, id);
    }

    const sh = (
      id: string,
      command: string,
      extra: Partial<ExecRequest> = {},
    ): Promise<ExecResult> => provider.exec(id, { command, ...extra });

    async function expectNothingLeft(id: string): Promise<void> {
      const all = await provider.list();
      expect(all.map((s) => s.id)).not.toContain(id);
      await expectRejects(provider.inspect(id), 'not_found');
    }

    /** True once `kill -0 pid` fails inside the sandbox (the process is gone). */
    async function processGone(id: string, pid: string): Promise<boolean> {
      return waitFor(
        async () =>
          (await provider.exec(id, { argv: ['sh', '-c', 'kill -0 "$1"', 'sh', pid] })).exitCode !==
          0,
        8000,
        100,
      );
    }

    beforeAll(async () => {
      provider = await opts.createProvider();
      template = opts.template();
      caps = provider.capabilities();
      ws = template.workspace.path;
      image = await provider.prepare(template);
    });

    afterAll(async () => {
      if (provider) {
        for (const id of createdIds) await cleanupSandbox(provider, id);
      }
      for (const d of tmpDirs) await rm(d, { recursive: true, force: true }).catch(() => undefined);
      if (provider) await opts.dispose?.(provider);
    });

    // -- capabilities ----------------------------------------------------------------------

    describe('capabilities', () => {
      test('has the documented shape', async () => {
        expect(caps.isolation).toBe(provider.isolation);
        expect(typeof provider.kind).toBe('string');
        expect(provider.host.host.length).toBeGreaterThan(0);
        expect(caps.networkModes.length).toBeGreaterThan(0);
        expect(new Set(caps.networkModes).size).toBe(caps.networkModes.length);
        for (const m of caps.networkModes) expect(NETWORK_MODES).toContain(m);
        expect(caps.workspaceDelivery).toContain('none');
        for (const k of caps.workspaceDelivery) expect(['none', 'bind', 'copy']).toContain(k);
        for (const flag of [
          caps.networkFilter,
          caps.mounts,
          caps.snapshots,
          caps.tty,
          caps.nonRootUser,
          caps.remote,
        ]) {
          expect(typeof flag).toBe('boolean');
        }
        for (const l of ['cpus', 'memory', 'pids', 'disk'] as const)
          expect(typeof caps.limits[l]).toBe('boolean');
        for (const s of caps.secretInjection) expect(['proxy', 'env', 'file']).toContain(s);
        expect(caps.osFamilies.length).toBeGreaterThan(0);
      });

      test('is internally consistent', async () => {
        // The domain allowlist is enforced by the proxy; mode and capability must agree.
        expect(caps.networkFilter).toBe(caps.networkModes.includes('allowlist'));
        // A remote host cannot bind-mount host directories.
        if (caps.remote) expect(caps.workspaceDelivery).not.toContain('bind');
        // `extendExpiry` is present exactly when the capability is claimed.
        expect(typeof provider.extendExpiry === 'function').toBe(caps.extendExpiry === true);
        // A backend that claims `updateResources` provides it (the python wrapper always has the method).
        if (caps.updateResources) expect(typeof provider.updateResources).toBe('function');
        // A backend that claims port forwards provides all three methods, and forwards only for
        // modes it offers (`none` has no interface to reach).
        if (caps.portForward && caps.portForward.length > 0) {
          expect(typeof provider.addPortForward).toBe('function');
          expect(typeof provider.listPortForwards).toBe('function');
          expect(typeof provider.removePortForward).toBe('function');
          for (const m of caps.portForward) expect(caps.networkModes).toContain(m);
          expect(caps.portForward).not.toContain('none');
        }
        // Snapshot methods are present exactly when snapshots are supported.
        if (caps.snapshots) {
          expect(typeof provider.snapshot).toBe('function');
          expect(typeof provider.restore).toBe('function');
        }
      });

      test('is stable across calls', async () => {
        expect(provider.capabilities()).toEqual(caps);
      });
    });

    describe('status', () => {
      test('never throws and reports a healthy backend', async () => {
        const s = await provider.status();
        expect(typeof s.ok).toBe('boolean');
        expect(Array.isArray(s.details)).toBe(true);
        expect(Array.isArray(s.warnings)).toBe(true);
        expect(
          s.ok,
          `status details: ${s.details.join('; ')} / warnings: ${s.warnings.join('; ')}`,
        ).toBe(true);
        await expect(provider.status()).resolves.toBeDefined();
      });
    });

    // -- prepare / gc ------------------------------------------------------------------------

    describe('prepare', () => {
      test('is cached: the second call returns cached=true and the same ref', async () => {
        const first = await provider.prepare(template);
        const second = await provider.prepare(template);
        expect(typeof first.ref).toBe('string');
        expect(first.ref.length).toBeGreaterThan(0);
        expect(first.templateHash).toBe(template.hash);
        expect(second.cached).toBe(true);
        expect(second.ref).toBe(first.ref);
        expect(second.templateHash).toBe(template.hash);
      });

      test('gcImages removes images that are not kept and returns their refs', async (ctx) => {
        if (!opts.gc) return ctx.skip();
        const other = { ...template, hash: `ct${randomId('', 8)}` };
        const otherImage = await provider.prepare(other);
        const removed = await provider.gcImages([template.hash]);
        expect(removed).toContain(otherImage.ref);
        expect(removed).not.toContain(image.ref);
        // The kept image is still prepared (cached), the removed one has to be rebuilt.
        expect((await provider.prepare(template)).cached).toBe(true);
        expect((await provider.prepare(other)).cached).toBe(false);
        await provider.gcImages([template.hash]);
      });

      test('gcImages with everything kept removes nothing of ours', async (ctx) => {
        if (!opts.gc) return ctx.skip();
        const removed = await provider.gcImages([template.hash]);
        expect(removed).not.toContain(image.ref);
        expect((await provider.prepare(template)).cached).toBe(true);
      });
    });

    // -- lifecycle ---------------------------------------------------------------------------

    describe('lifecycle', () => {
      test('create (not started) shows up in list() with correct metadata', async () => {
        const labels = { 'ct.case': 'list', 'ct.rand': randomId('', 4) };
        const spec = await mk({ owner: `agent:ct-${randomId('', 4)}`, labels });
        const info = await provider.create(spec);
        try {
          expect(info.id).toBe(spec.id);
          expect(info.state).toBe('created');
          const listed = (await provider.list()).find((s) => s.id === spec.id);
          expect(listed, 'created sandbox missing from list()').toBeDefined();
          expect(listed?.state).toBe('created');
          expect(listed?.host).toBe(spec.host);
          expect(listed?.name).toBe(spec.name);
          expect(listed?.owner).toBe(spec.owner);
          expect(listed?.template).toBe(template.name);
          expect(listed?.templateHash).toBe(template.hash);
          expect(listed?.expiresAt).toBe(spec.expiresAt);
          expect(Math.abs((listed?.createdAt ?? 0) - spec.createdAt)).toBeLessThan(5 * 60_000);
          expect(listed?.labels).toMatchObject(labels);
          expect(listed?.backend).toBe(provider.kind);
          expect(listed?.isolation).toBe(provider.isolation);
          expect(typeof listed?.backendRef).toBe('string');
          expect(listed?.backendRef.length).toBeGreaterThan(0);
        } finally {
          await finish(spec.id);
        }
      });

      test('start -> running, inspect agrees with list', async () => {
        const spec = await mk();
        await provider.create(spec);
        try {
          await provider.start(spec.id);
          const info = await provider.inspect(spec.id);
          expect(info.state).toBe('running');
          expect(info.id).toBe(spec.id);
          expect(info.owner).toBe(spec.owner);
          expect(info.templateHash).toBe(template.hash);
          const listed = (await provider.list()).find((s) => s.id === spec.id);
          expect(listed?.state).toBe('running');
        } finally {
          await finish(spec.id);
        }
      });

      test('creating an existing id rejects with conflict and keeps the first sandbox', async () => {
        const spec = await mk();
        await provider.create(spec);
        try {
          await expectRejects(provider.create(spec), 'conflict');
          expect((await provider.inspect(spec.id)).state).toBe('created');
        } finally {
          await finish(spec.id);
        }
      });

      test('stop -> stopped, start again works and exec runs', async () => {
        const id = await startSandbox();
        try {
          await provider.stop(id);
          expect((await provider.inspect(id)).state).toBe('stopped');
          expect(((await provider.list()).find((s) => s.id === id) ?? { state: '' }).state).toBe(
            'stopped',
          );
          await provider.start(id);
          expect((await provider.inspect(id)).state).toBe('running');
          const r = await provider.exec(id, { argv: ['echo', 'again'] });
          expect(r.stdout).toBe('again\n');
        } finally {
          await finish(id);
        }
      });

      test('a stopped sandbox is read with the rights of the sandbox user, not as root', async () => {
        const id = await startSandbox();
        try {
          const name = `ct-stopped-${randomId('', 4)}.txt`;
          await provider.writeFile(id, wsPath(name), Buffer.from('mine\n'));
          await sh(id, `ln -s /etc/shadow ct-shadow-link-${name}`);
          await provider.stop(id);
          // root-only files stay unreadable, also through a link planted in the workspace
          for (const p of ['/etc/shadow', wsPath(`ct-shadow-link-${name}`)]) {
            const err = await captureError(provider.readFile(id, p, 100));
            expect(err, `reading ${p} of a stopped sandbox must be refused`).toBeDefined();
            expect((err as ErrorLike).name).toBe('AboxError');
          }
          // what the sandbox user owns is readable, or the backend needs the sandbox running
          const ok = await captureError(provider.readFile(id, wsPath(name), 100));
          if (ok === undefined) {
            expect((await provider.readFile(id, wsPath(name), 100)).data.toString()).toBe('mine\n');
          } else {
            expect((ok as ErrorLike).code).toBe('conflict');
          }
        } finally {
          await finish(id);
        }
      });

      test('stop terminates processes started in the sandbox', async () => {
        const id = await startSandbox();
        try {
          const pidFile = `ct-bg-${randomId('', 4)}`;
          const r = await sh(id, `sleep 300 >/dev/null 2>&1 </dev/null & echo $! > ${pidFile}`);
          expect(r.exitCode).toBe(0);
          const pid = (await provider.readFile(id, wsPath(pidFile), 64)).data.toString().trim();
          expect(pid).toMatch(/^\d+$/);
          expect(
            (await provider.exec(id, { argv: ['sh', '-c', 'kill -0 "$1"', 'sh', pid] })).exitCode,
          ).toBe(0);
          await provider.stop(id);
          await provider.start(id);
          expect(await processGone(id, pid), `background process ${pid} survived stop()`).toBe(
            true,
          );
        } finally {
          await finish(id);
        }
      });

      test('exec/spawn on a sandbox that is not running reject with conflict', async () => {
        const spec = await mk();
        await provider.create(spec);
        try {
          await expectRejects(provider.exec(spec.id, { argv: ['echo', 'x'] }), 'conflict');
          await expectRejects(
            collect(provider.spawn(spec.id, { argv: ['echo', 'x'] })),
            'conflict',
          );
          await provider.start(spec.id);
          await provider.stop(spec.id);
          await expectRejects(provider.exec(spec.id, { argv: ['echo', 'x'] }), 'conflict');
        } finally {
          await finish(spec.id);
        }
      });

      test('list filters by owner and by state', async () => {
        const owner = `agent:ct-${randomId('', 4)}`;
        const a = await mk({ owner });
        const b = await mk({ owner });
        const c = await mk({ owner: `${owner}-other` });
        await provider.create(a);
        await provider.create(b);
        await provider.create(c);
        try {
          await provider.start(a.id);
          const byOwner = (await provider.list({ owner })).map((s) => s.id).sort();
          expect(byOwner).toEqual([a.id, b.id].sort());
          const running = (await provider.list({ owner, state: 'running' })).map((s) => s.id);
          expect(running).toEqual([a.id]);
          const created = (await provider.list({ owner, state: 'created' })).map((s) => s.id);
          expect(created).toEqual([b.id]);
          expect(await provider.list({ owner: `${owner}-nobody` })).toEqual([]);
          const byTemplate = await provider.list({ owner, template: template.name });
          expect(byTemplate.map((s) => s.id).sort()).toEqual([a.id, b.id].sort());
          expect(await provider.list({ owner, template: 'no-such-template' })).toEqual([]);
        } finally {
          await Promise.all([finish(a.id), finish(b.id), finish(c.id)]);
        }
      });

      test('remove deletes the sandbox; removing again does not throw', async () => {
        const id = await startSandbox();
        await provider.remove(id);
        await expectNothingLeft(id);
        await expect(provider.remove(id)).resolves.toBeUndefined();
        await expect(
          provider.remove(`${provider.host.host}/ct${randomId('', 6)}`),
        ).resolves.toBeUndefined();
      });

      test('remove works on a running sandbox with a background process', async () => {
        const id = await startSandbox();
        await sh(id, 'sleep 300 >/dev/null 2>&1 </dev/null &');
        await provider.remove(id);
        await expectNothingLeft(id);
      });

      test('a sandbox with an expiresAt in the past is reported as expired', async () => {
        const spec = await mk({ expiresAt: Date.now() - 1000 });
        await provider.create(spec);
        try {
          expect((await provider.inspect(spec.id)).state).toBe('expired');
          const listed = (await provider.list()).find((s) => s.id === spec.id);
          expect(listed?.state).toBe('expired');
          expect((await provider.list({ state: 'expired' })).map((s) => s.id)).toContain(spec.id);
          expect((await provider.list({ state: 'created' })).map((s) => s.id)).not.toContain(
            spec.id,
          );
        } finally {
          await finish(spec.id);
        }
      });

      test('a running sandbox becomes expired when expiresAt passes', async () => {
        const spec = await mk({ expiresAt: Date.now() + (opts.startBudgetMs ?? 0) + 2500 });
        await provider.create(spec);
        try {
          await provider.start(spec.id);
          expect((await provider.inspect(spec.id)).state).toBe('running');
          await sleep(Math.max(0, spec.expiresAt - Date.now()) + 500);
          expect((await provider.inspect(spec.id)).state).toBe('expired');
          expect((await provider.list({ state: 'expired' })).map((s) => s.id)).toContain(spec.id);
        } finally {
          await finish(spec.id);
        }
      });

      test('operations on an unknown id reject with not_found (remove is idempotent)', async () => {
        const id = `${provider.host.host}/ct${randomId('', 6)}`;
        await expectRejects(provider.inspect(id), 'not_found');
        await expectRejects(provider.start(id), 'not_found');
        await expectRejects(provider.stop(id), 'not_found');
        await expectRejects(provider.exec(id, { argv: ['echo', 'x'] }), 'not_found');
        await expectRejects(collect(provider.spawn(id, { argv: ['echo', 'x'] })), 'not_found');
        await expectRejects(provider.readFile(id, '/etc/hostname', 10), 'not_found');
        await expectRejects(provider.writeFile(id, wsPath('x'), Buffer.from('x')), 'not_found');
        await expectRejects(provider.listDir(id, ws), 'not_found');
        await expectRejects(provider.copyIn(id, tmpdir(), wsPath('x')), 'not_found');
        await expectRejects(
          provider.copyOut(id, ws, join(tmpdir(), `abox-ct-${randomId('', 4)}`)),
          'not_found',
        );
        await expect(provider.remove(id)).resolves.toBeUndefined();
      });
    });

    // -- exec / spawn / files on one shared running sandbox ---------------------------------------

    describe('exec, spawn and files', () => {
      let id!: string;

      beforeAll(async () => {
        id = await startSandbox({ env: { CT_SPEC_VAR: 'from-spec', CT_OVERRIDE: 'spec' } });
      });
      afterAll(async () => {
        if (id) await finish(id);
      });

      describe('exec', () => {
        test('argv form: stdout, exit code 0, result shape', async () => {
          const r = await provider.exec(id, { argv: ['echo', 'hello', 'world'] });
          expect(r.stdout).toBe('hello world\n');
          expect(r.stderr).toBe('');
          expect(r.exitCode).toBe(0);
          expect(r.timedOut).toBe(false);
          expect(r.truncated).toBe(false);
          expect(typeof r.durationMs).toBe('number');
          expect(r.durationMs).toBeGreaterThanOrEqual(0);
        });

        test('argv form does not interpret shell syntax', async () => {
          const r = await provider.exec(id, { argv: ['echo', '$HOME;', '&&', '`x`', '*'] });
          expect(r.stdout).toBe('$HOME; && `x` *\n');
        });

        test('command form runs through a shell', async () => {
          const r = await sh(id, 'echo one; echo two | tr a-z A-Z');
          expect(r.stdout).toBe('one\nTWO\n');
          expect(r.exitCode).toBe(0);
        });

        test('non-zero exit codes are returned, not thrown', async () => {
          expect((await provider.exec(id, { argv: ['sh', '-c', 'exit 7'] })).exitCode).toBe(7);
          expect((await sh(id, 'exit 42')).exitCode).toBe(42);
          expect((await provider.exec(id, { argv: ['false'] })).exitCode).toBe(1);
        });

        test('stdout and stderr are separated', async () => {
          const r = await sh(id, 'echo out; echo err 1>&2; exit 3');
          expect(r.stdout).toBe('out\n');
          expect(r.stderr).toBe('err\n');
          expect(r.exitCode).toBe(3);
        });

        test('cwd selects the working directory (relative paths resolve there)', async () => {
          const dir = `ct-cwd-${randomId('', 4)}`;
          await provider.writeFile(id, wsPath(`${dir}/marker.txt`), Buffer.from('m'));
          const r = await provider.exec(id, { argv: ['ls'], cwd: wsPath(dir) });
          expect(r.stdout.trim()).toBe('marker.txt');
        });

        test('the default working directory is the workspace path', async () => {
          const name = `ct-default-cwd-${randomId('', 4)}.txt`;
          await provider.writeFile(id, wsPath(name), Buffer.from('w'));
          const r = await provider.exec(id, { argv: ['ls'] });
          expect(r.stdout.split('\n')).toContain(name);
        });

        test('env: request env, sandbox spec env and precedence', async () => {
          const r = await sh(id, 'printf "%s|%s|%s" "$CT_REQ_VAR" "$CT_SPEC_VAR" "$CT_OVERRIDE"', {
            env: { CT_REQ_VAR: 'from-request', CT_OVERRIDE: 'request' },
          });
          expect(r.stdout).toBe('from-request|from-spec|request');
          const again = await sh(id, 'printf "%s|%s" "$CT_REQ_VAR" "$CT_OVERRIDE"');
          expect(again.stdout).toBe('|spec');
        });

        test('stdin (string and Buffer) is passed to the process', async () => {
          expect((await provider.exec(id, { argv: ['cat'], stdin: 'ping\n' })).stdout).toBe(
            'ping\n',
          );
          const bin = Buffer.from('buffer-data\n');
          expect((await provider.exec(id, { argv: ['cat'], stdin: bin })).stdout).toBe(
            'buffer-data\n',
          );
        });

        test('a process that reads stdin without any being given sees EOF', async () => {
          const r = await provider.exec(id, { argv: ['cat'], timeoutMs: 10_000 });
          expect(r.exitCode).toBe(0);
          expect(r.timedOut).toBe(false);
          expect(r.stdout).toBe('');
        });

        test('timeoutMs kills the process and reports timedOut', async () => {
          const pidFile = `ct-timeout-${randomId('', 4)}`;
          const started = Date.now();
          const r = await sh(id, `echo $$ > ${pidFile}; exec sleep 30`, { timeoutMs: 800 });
          const elapsed = Date.now() - started;
          expect(r.timedOut).toBe(true);
          expect(r.exitCode).not.toBe(0);
          expect(elapsed).toBeLessThan(800 + 6000);
          const pid = (await provider.readFile(id, wsPath(pidFile), 64)).data.toString().trim();
          expect(pid).toMatch(/^\d+$/);
          expect(await processGone(id, pid), `timed-out process ${pid} is still alive`).toBe(true);
          // the sandbox stays usable
          expect((await provider.exec(id, { argv: ['echo', 'alive'] })).stdout).toBe('alive\n');
        });

        test('a fast command with timeoutMs is not marked timedOut', async () => {
          const r = await provider.exec(id, { argv: ['echo', 'quick'], timeoutMs: 20_000 });
          expect(r.timedOut).toBe(false);
          expect(r.exitCode).toBe(0);
        });

        test('maxOutputBytes truncates each stream and sets the flag', async () => {
          const r = await sh(id, "head -c 10000 /dev/zero | tr '\\0' a", { maxOutputBytes: 100 });
          expect(r.truncated).toBe(true);
          expect(r.stdout.length).toBeGreaterThan(0);
          expect(r.stdout.length).toBeLessThanOrEqual(100);
          expect(r.stdout).toMatch(/^a+$/);
          expect(r.exitCode).toBe(0);

          const e = await sh(id, "head -c 2000 /dev/zero | tr '\\0' b 1>&2", {
            maxOutputBytes: 50,
          });
          expect(e.truncated).toBe(true);
          expect(e.stderr.length).toBeLessThanOrEqual(50);

          const small = await sh(id, 'echo short', { maxOutputBytes: 100 });
          expect(small.truncated).toBe(false);
          expect(small.stdout).toBe('short\n');
        });

        test('moderately large output is returned completely', async () => {
          const r = await sh(id, "head -c 200000 /dev/zero | tr '\\0' c");
          expect(r.truncated).toBe(false);
          expect(r.stdout.length).toBe(200_000);
        });

        test('a request with neither argv nor command is rejected as invalid_input', async () => {
          await expectRejects(provider.exec(id, {}), 'invalid_input');
          await expectRejects(provider.exec(id, { argv: [] }), 'invalid_input');
        });

        test('a missing binary yields a non-zero exit code or an AboxError, never a crash', async () => {
          const err = await captureError(
            provider.exec(id, { argv: [`ct-no-such-binary-${randomId('', 4)}`] }),
          );
          if (err !== undefined) {
            expect((err as ErrorLike).name).toBe('AboxError');
          } else {
            const r = await provider.exec(id, { argv: [`ct-no-such-binary-${randomId('', 4)}`] });
            expect(r.exitCode).not.toBe(0);
          }
        });

        test('an abort signal stops the call quickly', async () => {
          const ac = new AbortController();
          const started = Date.now();
          const p = captureError(provider.exec(id, { argv: ['sleep', '30'], signal: ac.signal }));
          setTimeout(() => ac.abort(), 300);
          await p; // either rejected or resolved with a kill exit code
          expect(Date.now() - started).toBeLessThan(8000);
          expect((await provider.exec(id, { argv: ['echo', 'ok'] })).stdout).toBe('ok\n');
        });

        test('concurrent execs do not interfere', async () => {
          const results = await Promise.all(
            [1, 2, 3, 4].map((n) => sh(id, `sleep 0.2; echo n${n}`).then((r) => r.stdout)),
          );
          expect(results).toEqual(['n1\n', 'n2\n', 'n3\n', 'n4\n']);
        });

        test('runs as a non-root user when nonRootUser is advertised', async (ctx) => {
          if (!caps.nonRootUser) return ctx.skip();
          const r = await provider.exec(id, { argv: ['id', '-u'] });
          expect(r.stdout.trim()).not.toBe('0');
        });
      });

      describe('spawn', () => {
        test('yields stdout events, then exactly one exit event last', async () => {
          const events = await collect(
            provider.spawn(id, { command: 'echo a; sleep 0.3; echo b' }),
          );
          expect(joinData(events, 'stdout')).toBe('a\nb\n');
          const last = events[events.length - 1];
          expect(last?.type).toBe('exit');
          expect(events.filter((e) => e.type === 'exit')).toHaveLength(1);
          if (last?.type === 'exit') {
            expect(last.exitCode).toBe(0);
            expect(last.timedOut).toBe(false);
          }
          for (const e of events) {
            if (e.type !== 'exit') expect(Buffer.isBuffer(e.data)).toBe(true);
          }
        });

        test('separates stderr and propagates the exit code', async () => {
          const events = await collect(
            provider.spawn(id, { command: 'echo out; echo err 1>&2; exit 5' }),
          );
          expect(joinData(events, 'stdout')).toBe('out\n');
          expect(joinData(events, 'stderr')).toBe('err\n');
          const last = events[events.length - 1];
          expect(last).toMatchObject({ type: 'exit', exitCode: 5, timedOut: false });
        });

        test('streams: the first output arrives before the process ends', async () => {
          const events = await collect(
            provider.spawn(id, { command: 'echo first; sleep 1; echo second' }),
          );
          const first = events.find((e) => e.type === 'stdout');
          const exit = events.find((e) => e.type === 'exit');
          expect(first).toBeDefined();
          expect(exit).toBeDefined();
          expect((exit?.at ?? 0) - (first?.at ?? 0)).toBeGreaterThanOrEqual(400);
        });

        test('honours stdin, env and cwd', async () => {
          const dir = `ct-spawn-${randomId('', 4)}`;
          await provider.writeFile(id, wsPath(`${dir}/f.txt`), Buffer.from('x'));
          const events = await collect(
            provider.spawn(id, {
              command: 'cat; ls; printf "%s" "$CT_S"',
              stdin: 'in\n',
              env: { CT_S: 'env' },
              cwd: wsPath(dir),
            }),
          );
          expect(joinData(events, 'stdout')).toBe('in\nf.txt\nenv');
        });

        test('timeoutMs ends the stream with timedOut=true', async () => {
          const started = Date.now();
          const events = await collect(
            provider.spawn(id, { argv: ['sleep', '30'], timeoutMs: 500 }),
          );
          const last = events[events.length - 1];
          expect(last?.type).toBe('exit');
          if (last?.type === 'exit') {
            expect(last.timedOut).toBe(true);
            expect(last.exitCode).not.toBe(0);
          }
          expect(Date.now() - started).toBeLessThan(500 + 6000);
        });
      });

      describe('files', () => {
        test('writeFile/readFile roundtrip (text)', async () => {
          const p = wsPath(`ct-${randomId('', 4)}.txt`);
          await provider.writeFile(id, p, Buffer.from('hello files\n'));
          const r = await provider.readFile(id, p, 1024);
          expect(r.data.toString()).toBe('hello files\n');
          expect(r.truncated).toBe(false);
          expect(r.size).toBe(12);
        });

        test('writeFile/readFile roundtrip (binary, empty, overwrite)', async () => {
          const p = wsPath(`ct-${randomId('', 4)}.bin`);
          await provider.writeFile(id, p, BINARY);
          const r = await provider.readFile(id, p, BINARY.length + 10);
          expect(r.data.equals(BINARY)).toBe(true);
          expect(r.size).toBe(BINARY.length);
          expect(r.truncated).toBe(false);

          await provider.writeFile(id, p, Buffer.alloc(0));
          const empty = await provider.readFile(id, p, 10);
          expect(empty.data.length).toBe(0);
          expect(empty.size).toBe(0);
          expect(empty.truncated).toBe(false);

          await provider.writeFile(id, p, Buffer.from('second'));
          expect((await provider.readFile(id, p, 100)).data.toString()).toBe('second');
        });

        test('readFile maxBytes truncates and still reports the full size', async () => {
          const p = wsPath(`ct-${randomId('', 4)}.txt`);
          await provider.writeFile(id, p, Buffer.from('0123456789'.repeat(100)));
          const r = await provider.readFile(id, p, 10);
          expect(r.data.toString()).toBe('0123456789');
          expect(r.truncated).toBe(true);
          expect(r.size).toBe(1000);
          const exact = await provider.readFile(id, p, 1000);
          expect(exact.truncated).toBe(false);
          expect(exact.data.length).toBe(1000);
          const none = await provider.readFile(id, p, 0);
          expect(none.data.length).toBe(0);
          expect(none.truncated).toBe(true);
          expect(none.size).toBe(1000);
        });

        test('writeFile applies the requested mode and the file is executable', async () => {
          const name = `ct-${randomId('', 4)}.sh`;
          await provider.writeFile(
            id,
            wsPath(name),
            Buffer.from('#!/bin/sh\necho from-script\n'),
            0o755,
          );
          const entry = (await provider.listDir(id, ws)).find((e) => e.name === name);
          expect(entry).toBeDefined();
          expect((entry?.mode ?? 0) & 0o777).toBe(0o755);
          expect((await provider.exec(id, { argv: [`./${name}`] })).stdout).toBe('from-script\n');
          const priv = `ct-${randomId('', 4)}.secret`;
          await provider.writeFile(id, wsPath(priv), Buffer.from('x'), 0o600);
          const e2 = (await provider.listDir(id, ws)).find((e) => e.name === priv);
          expect((e2?.mode ?? 0) & 0o777).toBe(0o600);
          // a mode a typical umask (022) would alter must still be applied exactly
          const wide = `ct-${randomId('', 4)}.wide`;
          await provider.writeFile(id, wsPath(wide), Buffer.from('x'), 0o664);
          const e3 = (await provider.listDir(id, ws)).find((e) => e.name === wide);
          expect((e3?.mode ?? 0) & 0o777).toBe(0o664);
        });

        test('files written by exec are visible to readFile and vice versa', async () => {
          const name = `ct-${randomId('', 4)}.txt`;
          await sh(id, `echo via-exec > ${name}`);
          expect((await provider.readFile(id, wsPath(name), 100)).data.toString()).toBe(
            'via-exec\n',
          );
          await provider.writeFile(id, wsPath(name), Buffer.from('via-api\n'));
          expect((await provider.exec(id, { argv: ['cat', name] })).stdout).toBe('via-api\n');
        });

        test('readFile of a missing path rejects with not_found; of a directory rejects', async () => {
          await expectRejects(
            provider.readFile(id, wsPath(`ct-missing-${randomId('', 4)}`), 10),
            'not_found',
          );
          const err = await captureError(provider.readFile(id, ws, 10));
          expect(err, 'reading a directory as a file must fail').toBeDefined();
          expect((err as ErrorLike).name).toBe('AboxError');
        });

        test('listDir lists files, directories and symlinks', async () => {
          const dir = `ct-ls-${randomId('', 4)}`;
          await provider.writeFile(id, wsPath(`${dir}/a.txt`), Buffer.from('abc'), 0o644);
          await sh(id, `mkdir ${dir}/sub && ln -s a.txt ${dir}/link`);
          const entries = await provider.listDir(id, wsPath(dir));
          const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
          expect(Object.keys(byName).sort()).toEqual(['a.txt', 'link', 'sub']);
          expect(byName['a.txt']).toMatchObject({ type: 'file', size: 3 });
          expect(byName['sub']?.type).toBe('dir');
          expect(byName['link']?.type).toBe('symlink');
          for (const e of entries) {
            expect(typeof e.mode).toBe('number');
            expect(typeof e.mtimeMs).toBe('number');
            expect(e.mtimeMs).toBeGreaterThan(0);
          }
          await expectRejects(provider.listDir(id, wsPath(`${dir}/nope`)), 'not_found');
          const onFile = await captureError(provider.listDir(id, wsPath(`${dir}/a.txt`)));
          expect((onFile as ErrorLike | undefined)?.name).toBe('AboxError');
        });

        test('copyIn/copyOut roundtrip of a directory tree', async () => {
          const src = join(await tmp(), 'tree');
          await mkdir(join(src, 'a', 'b'), { recursive: true });
          await mkdir(join(src, 'empty'));
          await writeFile(join(src, 'top.txt'), 'top');
          await writeFile(join(src, 'a', 'mid.txt'), 'mid');
          await writeFile(join(src, 'a', 'b', 'deep.txt'), 'deep');
          await writeFile(join(src, 'a', 'b', 'data.bin'), BINARY);

          const dest = wsPath(`ct-tree-${randomId('', 4)}`);
          await provider.copyIn(id, src, dest);
          expect((await provider.readFile(id, `${dest}/top.txt`, 100)).data.toString()).toBe('top');
          expect((await provider.readFile(id, `${dest}/a/mid.txt`, 100)).data.toString()).toBe(
            'mid',
          );
          expect((await provider.readFile(id, `${dest}/a/b/deep.txt`, 100)).data.toString()).toBe(
            'deep',
          );
          expect(
            (await provider.readFile(id, `${dest}/a/b/data.bin`, 1 << 20)).data.equals(BINARY),
          ).toBe(true);
          const empty = (await provider.listDir(id, dest)).find((e) => e.name === 'empty');
          expect(empty?.type).toBe('dir');
          expect((await provider.listDir(id, `${dest}/empty`)).length).toBe(0);

          const out = join(await tmp(), 'out');
          await provider.copyOut(id, dest, out);
          expect(await readTree(out)).toEqual(await readTree(src));
        });

        test('copyIn/copyOut of a single file', async () => {
          const dir = await tmp();
          await writeFile(join(dir, 'one.bin'), BINARY);
          const dest = wsPath(`ct-one-${randomId('', 4)}.bin`);
          await provider.copyIn(id, join(dir, 'one.bin'), dest);
          expect((await provider.readFile(id, dest, 1 << 20)).data.equals(BINARY)).toBe(true);
          await provider.copyOut(id, dest, join(dir, 'back.bin'));
          expect((await readFile(join(dir, 'back.bin'))).equals(BINARY)).toBe(true);
        });

        // /tmp is a tmpfs on some backends (docker): the file APIs must all see the same /tmp, whatever
        // way the data got there (a copy that lands in a hidden directory is silent data loss).
        test('copyIn/copyOut under /tmp of a running sandbox see the same files as readFile/writeFile', async () => {
          const dir = `/tmp/ct-tmpcopy-${randomId('', 4)}`;
          await provider.writeFile(id, `${dir}/seed`, Buffer.from('seed'));
          const src = join(await tmp(), 'tree');
          await mkdir(join(src, 'sub'), { recursive: true });
          await writeFile(join(src, 'top.txt'), 'top');
          await writeFile(join(src, 'sub', 'data.bin'), BINARY);

          await provider.copyIn(id, src, `${dir}/in`);
          expect((await provider.readFile(id, `${dir}/in/top.txt`, 100)).data.toString()).toBe(
            'top',
          );
          expect(
            (await provider.readFile(id, `${dir}/in/sub/data.bin`, 1 << 20)).data.equals(BINARY),
          ).toBe(true);
          expect((await provider.listDir(id, `${dir}/in`)).map((e) => e.name).sort()).toEqual([
            'sub',
            'top.txt',
          ]);

          const one = join(await tmp(), 'one.bin');
          await writeFile(one, BINARY);
          await provider.copyIn(id, one, `${dir}/one.bin`);
          expect((await provider.readFile(id, `${dir}/one.bin`, 1 << 20)).data.equals(BINARY)).toBe(
            true,
          );

          // what was written through the file API (or by a command) is what copyOut returns
          await provider.writeFile(id, `${dir}/written.bin`, BINARY);
          const back = join(await tmp(), 'written.bin');
          await provider.copyOut(id, `${dir}/written.bin`, back);
          expect((await readFile(back)).equals(BINARY)).toBe(true);
          const tree = join(await tmp(), 'tree-out');
          await provider.copyOut(id, `${dir}/in`, tree);
          expect(await readTree(tree)).toEqual(await readTree(src));
          await expectRejects(
            provider.copyOut(id, `${dir}/missing-${randomId('', 4)}`, join(await tmp(), 'nope')),
            'not_found',
          );
        });

        test('copyIn of a missing host path and copyOut of a missing sandbox path reject with not_found', async () => {
          const dir = await tmp();
          await expectRejects(provider.copyIn(id, join(dir, 'nope'), wsPath('x')), 'not_found');
          await expectRejects(
            provider.copyOut(id, wsPath(`ct-nope-${randomId('', 4)}`), join(dir, 'out')),
            'not_found',
          );
        });
      });
    });

    // -- workspace delivery, mounts, files, secrets ----------------------------------------------

    describe('workspace delivery and mounts', () => {
      async function hostTree(): Promise<string> {
        const dir = await tmp();
        await mkdir(join(dir, 'sub'), { recursive: true });
        await mkdir(join(dir, 'node_modules', 'dep'), { recursive: true });
        await writeFile(join(dir, 'a.txt'), 'host-a');
        await writeFile(join(dir, 'sub', 'b.txt'), 'host-b');
        await writeFile(join(dir, 'node_modules', 'dep', 'x.js'), 'x');
        await chmod(join(dir, 'a.txt'), 0o644);
        await chmod(join(dir, 'sub', 'b.txt'), 0o644);
        return dir;
      }

      for (const kind of ['bind', 'copy'] as const) {
        test(`delivery '${kind}' not in capabilities is rejected with unsupported and leaves nothing behind`, async (ctx) => {
          if (caps.workspaceDelivery.includes(kind)) return ctx.skip();
          const hostPath = await hostTree();
          const workspace =
            kind === 'bind'
              ? ({ kind: 'bind', hostPath, sandboxPath: ws, access: 'rw' } as const)
              : ({ kind: 'copy', hostPath, sandboxPath: ws } as const);
          const spec = await mk({ workspace });
          await expectRejects(provider.create(spec), 'unsupported');
          await expectNothingLeft(spec.id);
        });
      }

      test('copy delivery places the host tree in the sandbox (honouring exclude)', async (ctx) => {
        if (!caps.workspaceDelivery.includes('copy')) return ctx.skip();
        const hostPath = await hostTree();
        const spec = await mk({
          workspace: { kind: 'copy', hostPath, sandboxPath: ws, exclude: ['node_modules'] },
        });
        await provider.create(spec);
        try {
          await provider.start(spec.id);
          expect((await provider.readFile(spec.id, wsPath('a.txt'), 100)).data.toString()).toBe(
            'host-a',
          );
          expect((await provider.readFile(spec.id, wsPath('sub/b.txt'), 100)).data.toString()).toBe(
            'host-b',
          );
          const names = (await provider.listDir(spec.id, ws)).map((e) => e.name);
          expect(names).not.toContain('node_modules');
          // a copy is decoupled from the host: changes in the sandbox do not reach the host
          await provider.writeFile(spec.id, wsPath('a.txt'), Buffer.from('changed'));
          expect((await readFile(join(hostPath, 'a.txt'))).toString()).toBe('host-a');
        } finally {
          await finish(spec.id);
        }
      });

      test('copy delivery from a missing host directory fails and leaves nothing behind', async (ctx) => {
        if (!caps.workspaceDelivery.includes('copy')) return ctx.skip();
        const hostPath = join(await tmp(), 'does-not-exist');
        const spec = await mk({ workspace: { kind: 'copy', hostPath, sandboxPath: ws } });
        const err = await captureError(provider.create(spec));
        expect(err, 'create with a missing workspace source must fail').toBeDefined();
        expect((err as ErrorLike).name).toBe('AboxError');
        await expectNothingLeft(spec.id);
      });

      test('bind delivery shows the host directory in the sandbox', async (ctx) => {
        if (!caps.workspaceDelivery.includes('bind')) return ctx.skip();
        const hostPath = await hostTree();
        const spec = await mk({
          workspace: { kind: 'bind', hostPath, sandboxPath: ws, access: 'ro' },
        });
        await provider.create(spec);
        try {
          await provider.start(spec.id);
          expect((await provider.readFile(spec.id, wsPath('a.txt'), 100)).data.toString()).toBe(
            'host-a',
          );
          expect((await provider.readFile(spec.id, wsPath('sub/b.txt'), 100)).data.toString()).toBe(
            'host-b',
          );
        } finally {
          await finish(spec.id);
        }
      });

      test('extra mounts are rejected with unsupported when mounts=false (nothing left behind)', async (ctx) => {
        if (caps.mounts) return ctx.skip();
        const hostPath = await hostTree();
        const spec = await mk({
          mounts: [{ hostPath, sandboxPath: '/mnt/ct-extra', access: 'ro' }],
        });
        await expectRejects(provider.create(spec), 'unsupported');
        await expectNothingLeft(spec.id);
      });

      test('extra mounts are visible in the sandbox when mounts=true', async (ctx) => {
        if (!caps.mounts) return ctx.skip();
        const hostPath = await hostTree();
        const spec = await mk({
          mounts: [{ hostPath, sandboxPath: '/mnt/ct-extra', access: 'ro' }],
        });
        await provider.create(spec);
        try {
          await provider.start(spec.id);
          expect(
            (await provider.readFile(spec.id, '/mnt/ct-extra/a.txt', 100)).data.toString(),
          ).toBe('host-a');
        } finally {
          await finish(spec.id);
        }
      });
    });

    describe('network modes', () => {
      for (const mode of NETWORK_MODES) {
        test(`mode '${mode}' that is not advertised is rejected with unsupported and leaves nothing behind`, async (ctx) => {
          if (caps.networkModes.includes(mode)) return ctx.skip();
          const spec = await mk({
            network: {
              mode,
              allow: mode === 'allowlist' ? ['example.org'] : [],
              blockPrivate: true,
              privateExceptions: [],
              injections: [],
            },
          });
          await expectRejects(provider.create(spec), 'unsupported');
          await expectNothingLeft(spec.id);
        });
      }

      test('the default network mode chosen by makeTestSpec creates cleanly', async () => {
        const spec = await mk();
        expect(caps.networkModes).toContain(spec.network.mode);
        await provider.create(spec);
        try {
          expect((await provider.inspect(spec.id)).state).toBe('created');
        } finally {
          await finish(spec.id);
        }
      });

      test('proxy header injections are rejected with unsupported when secretInjection lacks proxy', async (ctx) => {
        if (caps.secretInjection.includes('proxy')) return ctx.skip();
        const base = await mk();
        const spec = await mk({
          network: {
            ...base.network,
            injections: [{ host: 'api.example.org', header: 'Authorization', value: 'Bearer ct' }],
          },
        });
        await expectRejects(provider.create(spec), 'unsupported');
        await expectNothingLeft(spec.id);
      });
    });

    describe('spec files (secret injection kind file)', () => {
      test('files are placed in the sandbox with their mode', async (ctx) => {
        if (!caps.secretInjection.includes('file')) return ctx.skip();
        const dir = `/tmp/ct-files-${randomId('', 4)}`;
        const spec = await mk({
          files: [
            { sandboxPath: `${dir}/secret.txt`, content: Buffer.from('s3cret'), mode: 0o600 },
            { sandboxPath: `${dir}/bin.dat`, content: BINARY, mode: 0o644 },
          ],
        });
        await provider.create(spec);
        try {
          await provider.start(spec.id);
          expect((await provider.readFile(spec.id, `${dir}/secret.txt`, 100)).data.toString()).toBe(
            's3cret',
          );
          expect(
            (await provider.readFile(spec.id, `${dir}/bin.dat`, 1 << 20)).data.equals(BINARY),
          ).toBe(true);
          const entry = (await provider.listDir(spec.id, dir)).find((e) => e.name === 'secret.txt');
          expect((entry?.mode ?? 0) & 0o777).toBe(0o600);
        } finally {
          await finish(spec.id);
        }
      });

      test('files are rejected with unsupported when secretInjection lacks file', async (ctx) => {
        if (caps.secretInjection.includes('file')) return ctx.skip();
        const spec = await mk({
          files: [{ sandboxPath: '/tmp/ct-secret', content: Buffer.from('x'), mode: 0o600 }],
        });
        await expectRejects(provider.create(spec), 'unsupported');
        await expectNothingLeft(spec.id);
      });
    });

    // -- snapshots -------------------------------------------------------------------------

    describe('snapshots', () => {
      test('without snapshot support the calls are undefined or reject with unsupported', async (ctx) => {
        if (caps.snapshots) return ctx.skip();
        const id = await startSandbox();
        try {
          if (provider.snapshot) await expectRejects(provider.snapshot(id, 'ct'), 'unsupported');
          if (provider.restore) await expectRejects(provider.restore(id, 'ct'), 'unsupported');
        } finally {
          await finish(id);
        }
      });

      test('snapshot/restore roundtrip restores files and removes later changes', async (ctx) => {
        if (!caps.snapshots || !provider.snapshot || !provider.restore) return ctx.skip();
        const id = await startSandbox();
        try {
          const keep = wsPath('ct-snap.txt');
          const extra = wsPath('ct-snap-extra.txt');
          await provider.writeFile(id, keep, Buffer.from('v1'));
          const snap = await provider.snapshot(id, `ct${randomId('', 4)}`);
          expect(typeof snap).toBe('string');
          expect(snap.length).toBeGreaterThan(0);
          await provider.writeFile(id, keep, Buffer.from('v2'));
          await provider.writeFile(id, extra, Buffer.from('new'));
          await provider.restore(id, snap);
          if ((await provider.inspect(id)).state !== 'running') await provider.start(id);
          expect((await provider.readFile(id, keep, 100)).data.toString()).toBe('v1');
          await expectRejects(provider.readFile(id, extra, 100), 'not_found');
          // the sandbox is fully usable afterwards
          expect((await provider.exec(id, { argv: ['echo', 'post-restore'] })).stdout).toBe(
            'post-restore\n',
          );
        } finally {
          await finish(id);
        }
      });

      test('listSnapshots and deleteSnapshot (when offered) show a snapshot and delete exactly it', async (ctx) => {
        if (!caps.snapshots || !provider.snapshot || !provider.listSnapshots) return ctx.skip();
        expect(typeof provider.deleteSnapshot).toBe('function');
        const id = await startSandbox();
        try {
          await provider.writeFile(id, wsPath('ct-list.txt'), Buffer.from('listed'));
          const a = await provider.snapshot(id, `ct${randomId('', 4)}a`);
          const b = await provider.snapshot(id, `ct${randomId('', 4)}b`);
          const mine = await provider.listSnapshots({ sandboxId: id });
          expect(mine.map((s) => s.snapshotId).sort()).toEqual([a, b].sort());
          for (const s of mine) {
            expect(s.sandboxId).toBe(id);
            expect(s.createdAt).toBeGreaterThan(0);
            if (s.sizeBytes !== undefined) expect(s.sizeBytes).toBeGreaterThanOrEqual(0);
          }
          expect((await provider.listSnapshots()).map((s) => s.snapshotId)).toEqual(
            expect.arrayContaining([a, b]),
          );
          await provider.deleteSnapshot!(id, a);
          expect(
            (await provider.listSnapshots({ sandboxId: id })).map((s) => s.snapshotId),
          ).toEqual([b]);
          // deleting twice is fine; the other snapshot and the sandbox are untouched
          await provider.deleteSnapshot!(id, a);
          await provider.restore!(id, b);
          if ((await provider.inspect(id)).state !== 'running') await provider.start(id);
          expect((await provider.readFile(id, wsPath('ct-list.txt'), 100)).data.toString()).toBe(
            'listed',
          );
        } finally {
          await finish(id);
        }
      });

      test('deleteSnapshot refuses a snapshot of another sandbox', async (ctx) => {
        if (!caps.snapshots || !provider.snapshot || !provider.deleteSnapshot) return ctx.skip();
        if (!provider.listSnapshots) return ctx.skip();
        const one = await startSandbox();
        const two = await startSandbox();
        try {
          const snap = await provider.snapshot(one, `ct${randomId('', 4)}`);
          // refused (not_found) or a no-op, but never the other sandbox's snapshot that goes
          const outcome = await provider.deleteSnapshot(two, snap).then(
            () => undefined,
            (e: unknown) => e,
          );
          if (outcome !== undefined) expect((outcome as { code?: string }).code).toBe('not_found');
          expect(
            (await provider.listSnapshots!({ sandboxId: one })).map((s) => s.snapshotId),
          ).toContain(snap);
          await provider.deleteSnapshot(one, snap);
        } finally {
          await finish(one);
          await finish(two);
        }
      });

      test('snapshot of an unknown sandbox rejects with not_found', async (ctx) => {
        if (!caps.snapshots || !provider.snapshot || !provider.restore) return ctx.skip();
        const ghost = `${provider.host.host}/ct${randomId('', 6)}`;
        await expectRejects(provider.snapshot(ghost, 'x'), 'not_found');
        await expectRejects(provider.restore(ghost, 'x'), 'not_found');
      });
    });

    // -- expiry ----------------------------------------------------------------------------

    describe('extendExpiry', () => {
      test('without the capability the call is absent or rejects with unsupported', async (ctx) => {
        if (caps.extendExpiry) return ctx.skip();
        const id = await startSandbox();
        try {
          if (provider.extendExpiry)
            await expectRejects(provider.extendExpiry(id, Date.now() + 3_600_000), 'unsupported');
        } finally {
          await finish(id);
        }
      });

      test('extend moves the backend deadline', async (ctx) => {
        if (!caps.extendExpiry || !provider.extendExpiry) return ctx.skip();
        const spec = await mk({ expiresAt: Date.now() + (opts.startBudgetMs ?? 0) + 6000 });
        await provider.create(spec);
        try {
          await provider.start(spec.id);
          expect((await provider.inspect(spec.id)).state).toBe('running');
          const moved = Date.now() + 120_000;
          await provider.extendExpiry(spec.id, moved);
          const after = await provider.inspect(spec.id);
          expect(after.expiresAt).toBeGreaterThanOrEqual(moved);
          expect(after.expiresAt).toBeLessThan(moved + 1000);
          // Well past the deadline the sandbox was created with.
          await sleep(Math.max(0, spec.expiresAt - Date.now()) + 3000);
          expect((await provider.inspect(spec.id)).state).toBe('running');
          expect((await provider.list({ state: 'expired' })).map((s) => s.id)).not.toContain(
            spec.id,
          );
          expect((await provider.exec(spec.id, { argv: ['echo', 'still-here'] })).stdout).toBe(
            'still-here\n',
          );
          // A restart honours the moved deadline too (the old one is over).
          await provider.stop(spec.id);
          await provider.start(spec.id);
          expect((await provider.inspect(spec.id)).state).toBe('running');
          expect((await provider.exec(spec.id, { argv: ['echo', 'again'] })).stdout).toBe(
            'again\n',
          );
        } finally {
          await finish(spec.id);
        }
      });

      test('never shortens; unknown ids reject with not_found', async (ctx) => {
        if (!caps.extendExpiry || !provider.extendExpiry) return ctx.skip();
        const spec = await mk({ expiresAt: Date.now() + 3_600_000 });
        await provider.create(spec);
        try {
          await expectRejects(
            provider.extendExpiry(spec.id, spec.expiresAt - 60_000),
            'invalid_input',
          );
          expect((await provider.inspect(spec.id)).expiresAt).toBeGreaterThanOrEqual(
            spec.expiresAt,
          );
          expect((await provider.inspect(spec.id)).expiresAt).toBeLessThan(spec.expiresAt + 1000);
          await expectRejects(
            provider.extendExpiry(`${provider.host.host}/ct${randomId('', 6)}`, spec.expiresAt),
            'not_found',
          );
        } finally {
          await finish(spec.id);
        }
      });

      test('an expired sandbox cannot be extended', async (ctx) => {
        if (!caps.extendExpiry || !provider.extendExpiry) return ctx.skip();
        const spec = await mk({ expiresAt: Date.now() - 1000 });
        await provider.create(spec);
        try {
          await expectRejects(provider.extendExpiry(spec.id, Date.now() + 3_600_000), 'conflict');
          expect((await provider.inspect(spec.id)).state).toBe('expired');
        } finally {
          await finish(spec.id);
        }
      });
    });

    // -- resource limits -------------------------------------------------------------------

    describe('updateResources', () => {
      test('without the capability the call is absent or rejects with unsupported', async (ctx) => {
        if (caps.updateResources) return ctx.skip();
        const id = await startSandbox();
        try {
          if (provider.updateResources)
            await expectRejects(provider.updateResources(id, { cpus: 1 }), 'unsupported');
        } finally {
          await finish(id);
        }
      });

      test('changes the limits of a running sandbox and keeps them across a restart', async (ctx) => {
        if (!caps.updateResources || !provider.updateResources) return ctx.skip();
        const id = await startSandbox();
        try {
          const memory = 384 * 1024 * 1024;
          await provider.updateResources(id, { cpus: 0.5, memoryBytes: memory });
          expect((await sh(id, 'echo still-here')).stdout).toBe('still-here\n');
          // Backends that report their limits report the new ones.
          const check = async (): Promise<void> => {
            const eff = (await provider.inspect(id)).effective ?? {};
            if (typeof eff['cpus'] === 'number') expect(eff['cpus']).toBeCloseTo(0.5, 5);
            if (typeof eff['memoryBytes'] === 'number') expect(eff['memoryBytes']).toBe(memory);
          };
          await check();
          // Only the named field changes.
          await provider.updateResources(id, { cpus: 1 });
          const eff = (await provider.inspect(id)).effective ?? {};
          if (typeof eff['cpus'] === 'number') expect(eff['cpus']).toBeCloseTo(1, 5);
          if (typeof eff['memoryBytes'] === 'number') expect(eff['memoryBytes']).toBe(memory);
          await provider.stop(id);
          await provider.updateResources(id, { cpus: 0.5 });
          await provider.start(id);
          expect((await provider.inspect(id)).state).toBe('running');
          await check();
        } finally {
          await finish(id);
        }
      });

      test('rejects an empty or invalid request, and unknown ids', async (ctx) => {
        if (!caps.updateResources || !provider.updateResources) return ctx.skip();
        const id = await startSandbox();
        try {
          await expectRejects(provider.updateResources(id, {}), 'invalid_input');
          await expectRejects(provider.updateResources(id, { cpus: -1 }), 'invalid_input');
          await expectRejects(provider.updateResources(id, { memoryBytes: 0 }), 'invalid_input');
          await expectRejects(provider.updateResources(id, { cpus: Number.NaN }), 'invalid_input');
          await expectRejects(
            provider.updateResources(`${provider.host.host}/ct${randomId('', 6)}`, { cpus: 1 }),
            'not_found',
          );
        } finally {
          await finish(id);
        }
      });
    });

    // -- tty -------------------------------------------------------------------------------

    describe('tty', () => {
      test('attach rejects with unsupported when tty=false', async (ctx) => {
        if (caps.tty) return ctx.skip();
        const id = await startSandbox();
        try {
          await expectRejects(provider.attach(id, { cols: 80, rows: 24 }), 'unsupported');
        } finally {
          await finish(id);
        }
      });

      test('attach opens an interactive shell when tty=true', async (ctx) => {
        if (!caps.tty) return ctx.skip();
        const id = await startSandbox();
        try {
          const session = await provider.attach(id, { cols: 80, rows: 24, argv: ['sh'] });
          let out = '';
          session.stream.on('data', (d: Buffer | string) => {
            out += d.toString();
          });
          await session.resize(100, 30);
          session.stream.write('echo ct-tty-$((20+22))\nexit\n');
          const code = await Promise.race([
            session.wait(),
            sleep(20_000).then(() => {
              throw new Error('tty session did not end');
            }),
          ]);
          expect(code).toBe(0);
          expect(out).toContain('ct-tty-42');
          await session.close();
        } finally {
          await finish(id);
        }
      });
    });
  });
}
