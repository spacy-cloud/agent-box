/**
 * Roadmap phase 1 acceptance criteria (Docker backend, through the real manager).
 *
 *  1. template build + cached rebuild < 2 s            4. restrictive defaults, verified inside the sandbox
 *  2. warm create < 5 s, exec/cp/logs/stop/rm           5. reconcile after kill -9
 *  3. invalid templates: error with line/field          7. capabilities-based rejection (no silent omission)
 *
 * (6 = CLI json/exit codes and 8 = Podman are not testable here; see README.)
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ERROR_CODES, isAboxError } from '@abox/core';
import {
  A,
  DOCKER,
  HUMAN,
  HUMAN_YES,
  RUN,
  createdOf,
  docker,
  errorOf,
  dockerProvider,
  freshTemplate,
  makeEnv,
  openAbox,
  sh,
  sweepE2E,
  type Ctx,
  type Env,
} from './harness.js';

const register = fileURLToPath(new URL('./loader/register.mjs', import.meta.url));
const child = fileURLToPath(new URL('./crash-child.ts', import.meta.url));

const fresh = freshTemplate();
const BAD_TEMPLATE = `apiVersion: 1
name: e2e-bad
description: A template with mistakes (e2e).
backend: docker
base: { os: 'alpine:3.22' }
resources:
  cpus: 1
  memory: lots-of-it
  ttl: 30m
network:
  mode: wide-open
`;

const lineOf = (needle: string): number =>
  BAD_TEMPLATE.split('\n').findIndex((l) => l.includes(needle)) + 1;

describe.skipIf(!DOCKER)('phase 1 acceptance (docker backend via the manager)', () => {
  let env: Env;
  let ctx: Ctx;
  const timings: Record<string, number> = {};

  beforeAll(async () => {
    env = makeEnv();
    ctx = await openAbox(env, { templates: { [fresh.name]: fresh.yaml, 'e2e-bad': BAD_TEMPLATE } });
    // The default template image exists in the cache before the timing tests run.
    await ctx.abox.buildTemplate(HUMAN, 'alpine-min');
  }, 300_000);

  afterAll(async () => {
    console.info(`[e2e timings] ${JSON.stringify(timings)}`);
    await ctx?.close();
    await sweepE2E();
    env?.cleanup();
  }, 120_000);

  // -- 1 --------------------------------------------------------------------------------------------------
  describe('1. template build', () => {
    it('builds a fresh template, the second build is a cache hit in < 2 s', async () => {
      const first = await ctx.abox.buildTemplate(HUMAN, fresh.name);
      expect(first.cached, 'a template with a unique build step cannot be cached yet').toBe(false);
      expect(first.image.ref).toContain(fresh.name);
      timings['build_cold_ms'] = first.durationMs;

      const t0 = Date.now();
      const second = await ctx.abox.buildTemplate(HUMAN, fresh.name);
      const wall = Date.now() - t0;
      timings['build_cached_ms'] = wall;
      expect(second.cached).toBe(true);
      expect(second.image.ref).toBe(first.image.ref);
      expect(second.templateHash).toBe(first.templateHash);
      expect(wall, `cached rebuild took ${wall} ms`).toBeLessThan(2000);
    }, 180_000);

    it('the build is audited as a network-enabled step', async () => {
      const entries = await ctx.abox.queryAudit(HUMAN, {
        action: ['image.build_start', 'image.build'],
      });
      expect(entries.length).toBeGreaterThan(0);
      expect(JSON.stringify(entries.map((e) => e.details))).toContain('networkAccess');
    });

    it('a changed build step produces a new image (cache is keyed by content)', async () => {
      const again = freshTemplate();
      const dir = join(env.aboxHome, 'config', 'templates');
      writeFileSync(join(dir, `${fresh.name}.yaml`), again.yaml);
      const r = await ctx.abox.buildTemplate(HUMAN, fresh.name);
      expect(r.cached).toBe(false);
      expect(r.templateHash).not.toBe(
        (await ctx.abox.showTemplate(HUMAN, 'alpine-min')).template.hash,
      );
    }, 180_000);
  });

  // -- 2 --------------------------------------------------------------------------------------------------
  describe('2. lifecycle: create, exec, files, logs, stop, remove', () => {
    let id = '';
    let stagingDir = '';

    it('a warm create (image cached) takes < 5 s', async () => {
      const t0 = Date.now();
      const c = await ctx.create(A, {
        template: 'alpine-min',
        workspace: { mode: 'copy', path: env.app },
      });
      const ms = Date.now() - t0;
      timings['create_warm_ms'] = ms;
      id = c.sandbox.id;
      expect(c.sandbox.state).toBe('running');
      expect(ms, `warm create took ${ms} ms`).toBeLessThan(5000);
      stagingDir = join(ctx.abox.paths.dataDir, 'sandboxes', id.split('/')[1]!);
    });

    it('exec: argv and command, exit codes, cwd, env, stdin, timeout', async () => {
      const r = await sh(ctx, A, id, 'echo out; echo err >&2; exit 3');
      expect(r).toMatchObject({
        exitCode: 3,
        stdout: 'out\n',
        stderr: 'err\n',
        timedOut: false,
        truncated: false,
      });
      const a = await ctx.abox.exec(A, id, {
        argv: ['sh', '-c', 'echo "$FOO:$(pwd):$(cat)"'],
        env: { FOO: 'bar' },
        cwd: '/tmp',
        stdin: 'in',
      });
      expect(a).toMatchObject({ status: 'completed', exitCode: 0, stdout: 'bar:/tmp:in\n' });
      const t = await sh(ctx, A, id, 'sleep 30', { timeoutMs: 1000 });
      expect(t.timedOut).toBe(true);
      // the workspace copy is there
      expect((await sh(ctx, A, id, 'cat /workspace/README.md /workspace/src/a.txt')).stdout).toBe(
        'hello from the e2e project\na\n',
      );
    });

    it('exec output is capped and marked truncated; the full output is in the log file', async () => {
      const r = await sh(ctx, A, id, 'head -c 200000 /dev/zero | tr "\\0" x', {
        maxOutputBytes: 1000,
      });
      expect(r.truncated).toBe(true);
      expect(r.stdout.length).toBeLessThanOrEqual(1000);
      const log = await ctx.abox.readLog(A, r.logRef, { maxBytes: 4096 });
      expect(log.size).toBeGreaterThan(100_000);
    });

    it('copy in / copy out: writeFile, readFile (binary), listDir, export files', async () => {
      const bin = Buffer.concat([Buffer.from([0, 1, 2, 255, 254]), Buffer.from('tail')]);
      await ctx.abox.writeFile(A, id, '/workspace/in.bin', bin);
      const back = await ctx.abox.readFile(A, id, '/workspace/in.bin');
      expect(back.encoding).toBe('base64');
      expect(Buffer.from(back.content, 'base64').equals(bin)).toBe(true);
      await ctx.abox.writeFile(A, id, 'note.txt', 'relative path, resolves against the workspace');
      expect((await ctx.abox.readFile(A, id, '/workspace/note.txt')).content).toContain(
        'relative path',
      );
      const names = (await ctx.abox.listDir(A, id, '/workspace')).map((e) => e.name).sort();
      expect(names).toEqual(['README.md', 'in.bin', 'note.txt', 'src']);
      await sh(ctx, A, id, 'echo changed > /workspace/README.md');
      const exp = await ctx.abox.exportSandbox(A, id, { format: 'files' });
      expect(exp.outDir).toBeDefined();
      // agents never choose the destination: it lies below the abox data dir
      expect(exp.outDir!.startsWith(ctx.abox.paths.dataDir)).toBe(true);
      expect(existsSync(join(exp.outDir!, 'README.md'))).toBe(true);
      // the original project is untouched
      expect(readFileSync(join(env.app, 'README.md'), 'utf8')).toBe('hello from the e2e project\n');
    });

    it('logs: exec log refs and background process logs', async () => {
      const r = await sh(ctx, A, id, 'echo logged-line');
      const log = await ctx.abox.readLog(A, r.logRef);
      expect(log.content).toContain('logged-line');
      const p = await ctx.abox.startProcess(
        A,
        id,
        { command: 'for i in 1 2 3; do echo tick$i; sleep 0.2; done' },
        { waitForApprovalMs: 0 },
      );
      if (p.status !== 'started') throw new Error(p.status);
      await new Promise((res) => setTimeout(res, 2500));
      const pl = await ctx.abox.processLogs(A, p.process.id);
      expect(pl.content).toContain('tick3');
      expect((await ctx.abox.listProcesses(A, id)).map((x) => x.id)).toContain(p.process.id);
    });

    it('stop: exec on a stopped sandbox is a clear conflict; start brings it back', async () => {
      const s = await ctx.abox.stopSandbox(A, id);
      expect(s.state).toBe('stopped');
      expect(await errorOf(sh(ctx, A, id, 'true'))).toMatchObject({ code: 'conflict' });
      const r = await ctx.abox.startSandbox(A, id);
      expect(r.state).toBe('running');
      expect((await sh(ctx, A, id, 'cat /workspace/note.txt')).exitCode).toBe(0);
    });

    it('remove: container, workspace staging and registry entry are gone; removing twice is a no-op', async () => {
      const short = id.split('/')[1]!;
      expect(existsSync(stagingDir)).toBe(true);
      expect(await ctx.abox.removeSandbox(A, id)).toEqual({ id, removed: true });
      expect((await ctx.abox.listSandboxes(A)).sandboxes.map((s) => s.id)).not.toContain(id);
      expect(existsSync(stagingDir)).toBe(false);
      const ps = await docker(['ps', '-a', '--filter', `name=abox-local-${short}`, '-q']);
      expect(ps.stdout.trim()).toBe('');
      expect(await ctx.abox.removeSandbox(A, id)).toEqual({ id, removed: false });
      ctx.created.splice(ctx.created.indexOf(id), 1);
    });
  });

  // -- 3 --------------------------------------------------------------------------------------------------
  describe('3. invalid templates give concrete errors with line and field', () => {
    it('validateTemplate(<file>) lists every problem with field path and line', async () => {
      const file = join(env.aboxHome, 'config', 'templates', 'e2e-bad.yaml');
      const v = await ctx.abox.validateTemplate(HUMAN, file);
      expect(v.ok).toBe(false);
      const memory = v.issues.find((i) => i.path?.includes('memory'));
      const mode = v.issues.find((i) => i.path?.includes('network'));
      expect(memory, JSON.stringify(v.issues)).toBeDefined();
      expect(mode, JSON.stringify(v.issues)).toBeDefined();
      expect(memory?.line).toBe(lineOf('memory:'));
      expect(mode?.line).toBe(lineOf('mode: wide-open'));
    });

    it('the broken file is listed with its problems (humans)', async () => {
      const l = await ctx.abox.listTemplates(HUMAN);
      const p = l.problems.find((x) => x.path.endsWith('e2e-bad.yaml'));
      expect(p?.issues.map((i) => i.line)).toEqual([lineOf('memory:'), lineOf('mode: wide-open')]);
      // ... and agents never see broken files (no information leak about the host)
      expect((await ctx.abox.listTemplates(A)).problems).toEqual([]);
    });

    it('createSandbox of an invalid template reports the line and field, not just "not found"', async () => {
      const err = await errorOf(
        ctx.abox.createSandbox(HUMAN_YES, { template: 'e2e-bad', workspace: { mode: 'empty' } }),
      );
      expect(isAboxError(err)).toBe(true);
      const e = err as {
        code: string;
        message: string;
        hint?: string;
        issues: Array<{ path?: string; line?: number }>;
        exitCode: number;
      };
      const visible = JSON.stringify({ message: e.message, hint: e.hint, issues: e.issues });
      expect(['template_invalid', 'invalid_input'], `got ${e.code}: ${visible}`).toContain(e.code);
      expect(visible).toContain('memory');
      expect(visible).toContain(String(lineOf('memory:')));
    });

    it('an unknown template is not_found and lists the available ones', async () => {
      const err = (await errorOf(
        ctx.abox.createSandbox(HUMAN, { template: 'nope-nope', workspace: { mode: 'empty' } }),
      )) as {
        code: string;
        hint?: string;
      };
      expect(err.code).toBe('not_found');
      expect(err.hint).toContain('alpine-min');
    });
  });

  // -- 4 --------------------------------------------------------------------------------------------------
  describe('4. defaults are restrictive (verified inside the sandbox)', () => {
    let id = '';
    beforeAll(async () => {
      id = (
        await ctx.create(A, { template: 'alpine-min', workspace: { mode: 'copy', path: env.app } })
      ).sandbox.id;
    });

    it('runs as a non-root user without capabilities, no-new-privileges and seccomp', async () => {
      expect((await sh(ctx, A, id, 'id -u')).stdout.trim()).not.toBe('0');
      const status = (await sh(ctx, A, id, 'cat /proc/self/status')).stdout;
      for (const f of ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']) {
        expect(status, f).toMatch(new RegExp(`${f}:\\s+0000000000000000`));
      }
      expect(status).toMatch(/NoNewPrivs:\s+1/);
      expect(status).toMatch(/Seccomp:\s+2/);
    });

    it('privileged operations fail', async () => {
      expect((await sh(ctx, A, id, 'mount -t tmpfs none /mnt 2>&1')).exitCode).not.toBe(0);
      expect((await sh(ctx, A, id, 'su -c id root 2>&1 < /dev/null')).exitCode).not.toBe(0);
      expect((await sh(ctx, A, id, 'chown root /workspace/README.md 2>&1')).exitCode).not.toBe(0);
      expect((await sh(ctx, A, id, 'touch /etc/e2e 2>&1')).exitCode).not.toBe(0);
    });

    it('network is off: only loopback, no route, no DNS answer', async () => {
      const ifaces = (await sh(ctx, A, id, 'ls /sys/class/net')).stdout.trim();
      expect(ifaces).toBe('lo');
      expect((await sh(ctx, A, id, 'cat /proc/net/route | tail -n +2 | wc -l')).stdout.trim()).toBe(
        '0',
      );
      expect((await sh(ctx, A, id, 'nslookup example.com 2>&1')).exitCode).not.toBe(0);
    });

    it('a TTL is set and reported (inspect, effective options, backend label)', async () => {
      const v = await ctx.abox.inspectSandbox(A, id);
      expect(Math.abs(v.expiresAt - v.createdAt - 30 * 60_000)).toBeLessThan(2000);
      expect(v.ttlRemainingMs).toBeGreaterThan(29 * 60_000);
      expect(v.network.mode).toBe('none');
      const prov = (v.effective as { provider?: Record<string, unknown> }).provider!;
      expect(prov).toMatchObject({
        privileged: false,
        networkMode: 'none',
        capDrop: ['ALL'],
        pidsLimit: 128,
        memoryBytes: 256 * 1024 * 1024,
      });
      expect(prov['securityOpt']).toContain('no-new-privileges:true');
      const raw = await docker([
        'inspect',
        '--format',
        '{{json .Config.Labels}}',
        `abox-local-${id.split('/')[1]}`,
      ]);
      const labels = JSON.parse(raw.stdout) as Record<string, string>;
      expect(Number(labels['abox.expires'])).toBe(v.expiresAt);
    });

    it('the container exits by itself when the TTL passes (sleep until abox.expires)', async () => {
      const b = await ctx.create(A, {
        template: 'alpine-min',
        workspace: { mode: 'empty' },
        overrides: { ttl: '5s' },
      });
      const short = b.sandbox.id.split('/')[1]!;
      expect(Math.abs(b.sandbox.expiresAt - b.sandbox.createdAt - 5000)).toBeLessThan(2000);
      const deadline = Date.now() + 20_000;
      let running = true;
      while (running && Date.now() < deadline) {
        const r = await docker([
          'inspect',
          '--format',
          '{{.State.Running}}',
          `abox-local-${short}`,
        ]);
        running = r.stdout.trim() === 'true';
        if (running) await new Promise((res) => setTimeout(res, 500));
      }
      expect(running, 'container still running 20 s after its 5 s TTL').toBe(false);
      expect((await ctx.abox.inspectSandbox(A, b.sandbox.id)).expired).toBe(true);
    }, 60_000);

    it('the profile caps what an agent may ask for (ttl, memory, cpus) and says so', async () => {
      for (const overrides of [{ ttl: '9h' }, { memory: '64g' }, { cpus: 64 }]) {
        const err = (await errorOf(
          ctx.abox.createSandbox(A, {
            template: 'alpine-min',
            workspace: { mode: 'empty' },
            overrides,
          }),
        )) as {
          code: string;
          message: string;
        };
        expect(err.code, JSON.stringify(overrides)).toBe('policy_denied');
        expect(err.message).toMatch(/ttl|memory|cpus/i);
      }
    });
  });

  // -- 5 --------------------------------------------------------------------------------------------------
  describe('5. reconcile after kill -9 of the creating process', () => {
    /** Runs a real docker create in a child process and SIGKILLs it while it hangs at `hangAt`. */
    async function crashCreate(
      root: string,
      project: string,
      hangAt: 'prepare' | 'create' | 'start',
      inst: string,
    ): Promise<void> {
      const marker = join(root, `marker-${hangAt}`);
      const proc = spawn(
        process.execPath,
        ['--import', register, child, root, project, marker, hangAt, RUN, inst],
        {
          stdio: ['ignore', 'inherit', 'pipe'],
        },
      );
      let stderr = '';
      proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
      const deadline = Date.now() + 60_000;
      while (!existsSync(marker)) {
        if (proc.exitCode !== null)
          throw new Error(`child exited early (${String(proc.exitCode)}): ${stderr}`);
        if (Date.now() > deadline) {
          proc.kill('SIGKILL');
          throw new Error(`child did not reach ${hangAt}: ${stderr}`);
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      proc.kill('SIGKILL');
      await exited;
    }

    it.each(['prepare', 'create', 'start'] as const)(
      'kill -9 while the create hangs before %s: doctor reports it, reconcile --apply cleans docker and disk',
      async (hangAt) => {
        const w = makeEnv();
        let c: Ctx | undefined;
        try {
          const inst = `crash${hangAt}`;
          await crashCreate(w.root, w.app, hangAt, inst);
          c = await openAbox(w, { policy: false, reconcileOnOpen: false, instance: inst });
          const list = await c.abox.listSandboxes(HUMAN, { state: 'preparing' });
          expect(list.sandboxes).toHaveLength(1);
          const id = list.sandboxes[0]!.id;
          const short = id.split('/')[1]!;
          const container = `abox-local-${short}`;
          const stage = join(c.abox.paths.dataDir, 'sandboxes', short);
          const dockerHas = async (): Promise<boolean> =>
            (await docker(['ps', '-a', '--filter', `name=^${container}$`, '-q'])).stdout.trim() !==
            '';
          // `start` hangs after the backend created the container; before that nothing exists in docker
          expect(await dockerHas()).toBe(hangAt === 'start');

          const report = await c.abox.doctor(HUMAN);
          expect(report.reconcile.interrupted.map((e) => e.id)).toEqual([id]);
          expect(
            report.checks.some((k) => k.id === 'reconcile.interrupted' && k.level === 'warn'),
          ).toBe(true);
          // doctor reports, it deletes nothing
          expect(await dockerHas()).toBe(hangAt === 'start');
          expect((await c.abox.doctor(HUMAN)).reconcile.interrupted.map((e) => e.id)).toEqual([id]);

          const applied = await c.abox.reconcile(HUMAN, { apply: true });
          expect(applied.applied.markedFailed).toEqual([id]);
          expect(await dockerHas(), 'docker container of the dead create must be removed').toBe(
            false,
          );
          expect(existsSync(stage)).toBe(false);
          const clean = await c.abox.doctor(HUMAN);
          expect(clean.reconcile).toMatchObject({ interrupted: [], orphans: [], ghosts: [] });
          expect((await c.abox.listSandboxes(HUMAN)).sandboxes).toEqual([]);
          expect((await c.abox.verifyAudit(HUMAN)).ok).toBe(true);

          // the idempotency key is free again and a retry works
          const retry = await c.create(HUMAN_YES, {
            template: 'alpine-min',
            workspace: { mode: 'copy', path: w.app },
            requestId: 'crash-1',
          });
          expect(retry.sandbox.id).not.toBe(id);
        } finally {
          await c?.close();
          await sweepE2E();
          w.cleanup();
        }
      },
      240_000,
    );

    it('a sandbox whose container vanished (docker rm -f) is reported as ghost and fixed by reconcile', async () => {
      const c = await ctx.create(A, { template: 'alpine-min', workspace: { mode: 'empty' } });
      const short = c.sandbox.id.split('/')[1]!;
      await docker(['rm', '-f', '-v', `abox-local-${short}`]);
      const list = await ctx.abox.listSandboxes(HUMAN);
      const view = list.sandboxes.find((s) => s.id === c.sandbox.id);
      expect(view).toMatchObject({ stale: true, missingInBackend: true });
      const rep = await ctx.abox.reconcile(HUMAN, {});
      expect(rep.ghosts.map((g) => g.id)).toContain(c.sandbox.id);
      const applied = await ctx.abox.reconcile(HUMAN, { apply: true });
      expect([...applied.applied.removed, ...applied.applied.markedStale]).toContain(c.sandbox.id);
      ctx.created.splice(ctx.created.indexOf(c.sandbox.id), 1);
    });

    it('a backend container unknown to the registry is an orphan; removed only with apply AND removeOrphans', async () => {
      // Create through the provider directly, bypassing the registry.
      const { makeTestSpec, makeTestTemplate } = await import('@abox/contract-tests');
      const tpl = makeTestTemplate({
        name: 'e2e-orphan',
        backend: 'docker',
        isolation: 'container',
        base: { os: 'alpine:3.22', osFamily: 'alpine' },
        user: { name: 'dev', uid: 1000, sudo: false },
        workspace: { mode: 'empty', path: '/workspace', access: 'rw' },
      });
      const image = await ctx.docker.prepare(tpl);
      const spec = await makeTestSpec(ctx.docker, tpl, { image });
      await ctx.docker.create(spec);
      try {
        const rep = await ctx.abox.reconcile(HUMAN, {});
        expect(rep.orphans.map((o) => o.id)).toContain(spec.id);
        await ctx.abox.reconcile(HUMAN, { apply: true });
        expect(
          (await ctx.docker.list()).map((s) => s.id),
          'apply alone must not remove orphans',
        ).toContain(spec.id);
        await ctx.abox.reconcile(HUMAN, { apply: true, removeOrphans: true });
        expect((await ctx.docker.list()).map((s) => s.id)).not.toContain(spec.id);
      } finally {
        await ctx.docker.remove(spec.id).catch(() => undefined);
      }
    }, 120_000);
  });

  // -- 6 (the part that is testable without the CLI) -------------------------------------------------------
  describe('6. stable error codes and exit codes (the machine-readable contract of every surface)', () => {
    it('policy / input / not_found / unsupported map to the documented exit codes', async () => {
      const cases: Array<[() => Promise<unknown>, string, number]> = [
        [() => ctx.abox.inspectSandbox(A, 'local/deadbeef'), 'not_found', ERROR_CODES.not_found],
        [
          () => ctx.abox.createSandbox({ contextId: 'nobody' }, { template: 'alpine-min' }),
          'policy_denied',
          ERROR_CODES.policy_denied,
        ],
        [
          () =>
            ctx.abox.createSandbox(A, {
              template: 'alpine-min',
              workspace: { mode: 'empty' },
              overrides: { ttl: '-1' },
            }),
          'invalid_input',
          ERROR_CODES.invalid_input,
        ],
        [
          () => ctx.abox.createSandbox(A, { template: 'alpine-min', bogusField: 1 } as never),
          'invalid_input',
          2,
        ],
      ];
      for (const [p, code, exit] of cases) {
        const e = (await errorOf(p())) as {
          code: string;
          exitCode: number;
          toJSON(): Record<string, unknown>;
        };
        expect(e.code).toBe(code);
        expect(e.exitCode).toBe(exit);
        expect(e.toJSON()).toMatchObject({ ok: false, code });
      }
    });
  });

  // -- 7 --------------------------------------------------------------------------------------------------
  describe('7. capabilities are reported and honoured (clear rejection instead of silently ignoring)', () => {
    it('process backend: truthful capabilities (no filter, no mounts, no limits, isolation none)', async () => {
      const details = await ctx.abox.showTemplate(HUMAN, 'host-shell');
      expect(details.capabilities).toMatchObject({
        isolation: 'none',
        networkModes: ['open'],
        networkFilter: false,
        mounts: false,
        nonRootUser: false,
        limits: { cpus: false, memory: false, pids: false, disk: false },
      });
      // isolation none always needs an explicit human confirmation
      const pending = await ctx.abox.createSandbox(HUMAN, {
        template: 'host-shell',
        workspace: { mode: 'empty' },
      });
      expect(pending.status).toBe('confirmation_required');
    });

    it('process backend: allowlist network and additional mounts are unsupported, not silently dropped', async () => {
      const net = (await errorOf(
        ctx.abox.createSandbox(HUMAN_YES, {
          template: 'host-shell',
          workspace: { mode: 'empty' },
          overrides: { network: { mode: 'allowlist', allow: ['example.com'] } },
        }),
      )) as { code: string };
      expect(net.code).toBe('unsupported');
      const mnt = (await errorOf(
        ctx.abox.createSandbox(HUMAN_YES, {
          template: 'host-shell',
          workspace: { mode: 'empty' },
          overrides: { mounts: [{ source: env.datasets, target: '/data' }] },
        }),
      )) as { code: string };
      expect(mnt.code).toBe('unsupported');
      expect(
        (await ctx.abox.listSandboxes(HUMAN)).sandboxes.filter((s) => s.template === 'host-shell'),
      ).toEqual([]);
    });

    it('a backend without snapshot support: snapshot/restore are unsupported with a hint', async () => {
      const w = makeEnv();
      const noSnap = dockerProvider();
      const wrapped = new Proxy(noSnap, {
        get(t, prop) {
          if (prop === 'capabilities') return () => ({ ...t.capabilities(), snapshots: false });
          if (prop === 'snapshot' || prop === 'restore') return undefined;
          const v = Reflect.get(t, prop, t) as unknown;
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
        },
      });
      const c = await openAbox(w, { providers: { docker: () => wrapped } });
      try {
        const sb = await c.create(A, { template: 'alpine-min', workspace: { mode: 'empty' } });
        const err = (await errorOf(c.abox.snapshot(A, sb.sandbox.id, 'snap1'))) as {
          code: string;
          hint?: string;
        };
        expect(err.code).toBe('unsupported');
        expect(err.hint).toBeTruthy();
        expect(await errorOf(c.abox.restore(A, sb.sandbox.id, 'snap1'))).toMatchObject({
          code: 'unsupported',
        });
      } finally {
        await c.close();
        w.cleanup();
      }
    }, 120_000);

    it('docker backend: a disk limit is unsupported when the storage driver has no quota (and nothing is left behind)', async () => {
      await ctx.docker.init();
      const caps = ctx.docker.capabilities();
      if (caps.limits.disk) return; // xfs+pquota / btrfs / zfs engine: the limit is enforceable, nothing to reject
      writeFileSync(
        join(env.aboxHome, 'config', 'templates', 'e2e-disk.yaml'),
        `apiVersion: 1
name: e2e-disk
description: Alpine with a disk quota (e2e).
backend: docker
base: { os: 'alpine:3.22' }
resources: { cpus: 1, memory: 256m, disk: 1g, ttl: 30m }
`,
      );
      const err = (await errorOf(
        ctx.abox.createSandbox(HUMAN_YES, { template: 'e2e-disk', workspace: { mode: 'empty' } }),
      )) as {
        code: string;
        message: string;
      };
      expect(err.code).toBe('unsupported');
      expect(err.message.toLowerCase()).toContain('disk');
      expect(
        (await ctx.abox.listSandboxes(HUMAN)).sandboxes.filter((s) => s.template === 'e2e-disk'),
      ).toEqual([]);
      expect(
        (
          await docker(['ps', '-a', '-q', '--filter', 'label=abox.template=e2e-disk'])
        ).stdout.trim(),
      ).toBe('');
    });

    it('docker backend capabilities: what is advertised', async () => {
      const caps = ctx.docker.capabilities();
      expect(caps).toMatchObject({
        isolation: 'container',
        networkFilter: true,
        nonRootUser: true,
        snapshots: true,
        mounts: true,
        limits: { cpus: true, memory: true, pids: true },
      });
      expect(caps.networkModes).toEqual(expect.arrayContaining(['none', 'allowlist', 'open']));
    });

    it('docker backend: snapshot and restore work end to end', async () => {
      const c = await ctx.create(A, { template: 'alpine-min', workspace: { mode: 'empty' } });
      const id = c.sandbox.id;
      await sh(ctx, A, id, 'echo v1 > /workspace/f.txt');
      const { snapshotId } = await ctx.abox.snapshot(A, id, 'one');
      await sh(ctx, A, id, 'echo v2 > /workspace/f.txt; echo new > /workspace/g.txt');
      await ctx.abox.restore(A, id, snapshotId);
      const r = await sh(ctx, A, id, 'cat /workspace/f.txt; ls /workspace');
      expect(r.stdout).toContain('v1');
      expect(r.stdout).not.toContain('g.txt');
    }, 120_000);

    it('process backend: snapshot and restore work end to end', async () => {
      const sb = createdOf(
        await ctx.abox.createSandbox(HUMAN_YES, {
          template: 'host-shell',
          workspace: { mode: 'empty' },
        }),
      );
      ctx.created.push(sb.sandbox.id);
      await ctx.abox.writeFile(HUMAN, sb.sandbox.id, 'f.txt', 'v1');
      const { snapshotId } = await ctx.abox.snapshot(HUMAN, sb.sandbox.id, 'one');
      await ctx.abox.writeFile(HUMAN, sb.sandbox.id, 'f.txt', 'v2');
      await ctx.abox.restore(HUMAN, sb.sandbox.id, snapshotId);
      expect((await ctx.abox.readFile(HUMAN, sb.sandbox.id, 'f.txt')).content).toBe('v1');
    }, 60_000);
  });

  // -- instance scoping (found while writing 5) -----------------------------------------------------------------
  describe('two abox instances on one container engine', () => {
    it("do not report each other's sandboxes as orphans (a removeOrphans reconcile would delete them)", async () => {
      const mine = await ctx.create(A, { template: 'alpine-min', workspace: { mode: 'empty' } });
      const other = makeEnv(); // an independent ABOX_HOME (think: a second user in the docker group, or CI) ...
      const c2 = await openAbox(other, { unscoped: true }); // ... talking to the same daemon
      try {
        const rep = await c2.abox.reconcile(HUMAN, {});
        expect(
          rep.orphans.map((o) => o.id),
          'instance 2 sees the sandbox of instance 1 as an orphan',
        ).not.toContain(mine.sandbox.id);
      } finally {
        await c2.close();
        other.cleanup();
      }
    });
  });
});
