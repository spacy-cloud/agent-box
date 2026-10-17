import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openAbox } from '@abox/runtime';
import {
  BIN,
  makeEnv,
  run,
  runBin,
  sleep,
  spawnBin,
  writePolicy,
  type TestEnv,
} from './harness.js';

/**
 * Phase-1 acceptance criteria through the real CLI (`dist/bin.js`) against a real Docker engine.
 * Run with ABOX_TEST_DOCKER=1. Everything lives below a private ABOX_HOME; engine objects are
 * removed again (only objects this test created).
 */
const DOCKER = process.env['ABOX_TEST_DOCKER'] === '1';
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

describe.runIf(DOCKER)('CLI against Docker (acceptance criteria Phase 1/3)', () => {
  let t: TestEnv;
  let id: string;
  const timings: Record<string, number> = {};
  const created: string[] = [];
  const rmImages: string[] = [];

  beforeAll(() => {
    execFileSync('npx', ['tsc', '-b', 'packages/cli'], { cwd: root, stdio: 'pipe' });
    t = makeEnv();
    expect(existsSync(BIN)).toBe(true);
  }, 120_000);

  afterAll(async () => {
    for (const sid of created) await runBin(t, ['rm', '--force', sid]).catch(() => undefined);
    for (const name of rmImages) {
      const ids = spawnSync('docker', ['images', '-q', `abox/${name}`], { encoding: 'utf8' })
        .stdout.split('\n')
        .filter(Boolean);
      if (ids.length) spawnSync('docker', ['rmi', '-f', ...ids]);
    }
    console.info(`[cli docker timings] ${JSON.stringify(timings)}`);
    t.cleanup();
  }, 120_000);

  it('template build: the second build of an unchanged template is a cache hit in < 2 s', async () => {
    const first = await runBin(t, ['template', 'build', 'alpine-min', '--json']);
    expect(first.code, first.stderr).toBe(0);
    timings['build_first_ms'] = first.ms;
    const second = await runBin(t, ['template', 'build', 'alpine-min', '--json']);
    expect(second.code, second.stderr).toBe(0);
    expect(second.json.data.cached).toBe(true);
    timings['build_second_ms'] = second.ms;
    timings['build_second_manager_ms'] = second.json.data.durationMs;
    expect(second.ms).toBeLessThan(2000);
    const human = await runBin(t, ['template', 'build', 'alpine-min']);
    expect(human.stdout).toContain('up to date');
  }, 300_000);

  it('create --workspace . starts a sandbox warm in < 5 s with restrictive defaults', async () => {
    const r = await runBin(t, [
      'create',
      'alpine-min',
      '--workspace',
      '.',
      '--name',
      'accept',
      '--json',
    ]);
    expect(r.code, r.stderr).toBe(0);
    timings['create_warm_ms'] = r.ms;
    timings['create_warm_manager_ms'] = r.json.data.durationMs;
    expect(r.ms).toBeLessThan(5000);
    id = r.json.data.sandbox.id;
    created.push(id);

    const inspect = await runBin(t, ['inspect', id, '--json']);
    const s = inspect.json.data;
    expect(s.network.mode).toBe('none');
    expect(s.isolation).toBe('container');
    expect(s.state).toBe('running');
    expect(s.ttlRemainingMs).toBeGreaterThan(0);
    expect(s.ttlRemainingMs).toBeLessThanOrEqual(s.resources.ttlMs);
    expect(s.resources.ttlMs).toBeLessThanOrEqual(24 * 3600_000);
    expect(s.effective.provider).toMatchObject({
      privileged: false,
      capDrop: ['ALL'],
      networkMode: 'none',
    });
    expect(s.effective.provider.user).not.toMatch(/^(0|root)(:|$)/);
    const uid = await runBin(t, ['exec', id, '--', 'id', '-u']);
    expect(Number(uid.stdout.trim())).toBeGreaterThan(0);
    // no network from inside
    const net = await runBin(t, [
      'exec',
      id,
      '--timeout',
      '15s',
      '--',
      'sh',
      '-c',
      'wget -q -T 3 -O- http://1.1.1.1/ >/dev/null 2>&1 && echo reachable || echo blocked',
    ]);
    expect(net.stdout.trim()).toBe('blocked');
  }, 120_000);

  it('network allowlist: a denied egress is in the audit log (F4), entries with a port are accepted (F5)', async () => {
    const r = await runBin(
      t,
      [
        'create',
        'alpine-min',
        '--net',
        'allowlist',
        '--allow',
        'allowed.example.org,ported.example.org:8443',
        '--name',
        'egress',
        '--yes',
        '--json',
      ],
      { timeoutMs: 300_000 },
    );
    expect(r.code, r.stderr).toBe(0);
    const sid = r.json.data.sandbox.id as string;
    created.push(sid);
    expect(r.json.data.sandbox.network.allow).toEqual(
      expect.arrayContaining(['allowed.example.org', 'ported.example.org:8443']),
    );
    // busybox wget honours the sandbox's http_proxy: the proxy answers 403 and records the decision
    const w = await runBin(t, [
      'exec',
      sid,
      '--timeout',
      '30s',
      '--',
      'sh',
      '-c',
      'wget -q -T 8 -O- http://denied-egress-probe.example.org/ >/dev/null 2>&1; echo wget-exit=$?',
    ]);
    expect(w.stdout).toMatch(/wget-exit=[1-9]/);
    const audit = await runBin(t, [
      'audit',
      '--sandbox',
      sid,
      '--action',
      'network.egress',
      '--limit',
      '100',
      '--json',
    ]);
    const hits = (
      audit.json.data.entries as Array<{
        decision: string;
        details: { host: string; port: number };
      }>
    ).filter((e) => e.details.host === 'denied-egress-probe.example.org');
    expect(hits.length, audit.stdout).toBeGreaterThan(0);
    expect(hits[0]).toMatchObject({ decision: 'deny', details: { port: 80 } });
    await runBin(t, ['rm', '--force', sid]);
  }, 400_000);

  it('ls --json has a stable shape', async () => {
    const r = await runBin(t, ['ls', '--json']);
    expect(r.code).toBe(0);
    expect(Object.keys(r.json)).toEqual(['ok', 'data']);
    expect(Object.keys(r.json.data).sort()).toEqual(['orphans', 'sandboxes', 'unreachableHosts']);
    const s = r.json.data.sandboxes.find((x: { id: string }) => x.id === id);
    expect(s).toMatchObject({
      name: 'accept',
      template: 'alpine-min',
      backend: 'docker',
      state: 'running',
      owner: 'human',
    });
    const filtered = await runBin(t, ['ls', '--state', 'stopped', '--json']);
    expect(filtered.json.data.sandboxes).toEqual([]);
  });

  it('exec, cp in both directions, logs', async () => {
    const e = await runBin(t, [
      'exec',
      id,
      '--',
      'sh',
      '-c',
      'cat hello.txt; echo err >&2; exit 4',
    ]);
    expect(e.code).toBe(4);
    expect(e.stdout).toBe('hello\n');
    expect(e.stderr).toBe('err\n');

    const up = t.write('home/up/data.txt', 'uploaded\n');
    expect((await runBin(t, ['cp', up, `${id}:/workspace/data.txt`])).code).toBe(0);
    expect((await runBin(t, ['exec', id, '--', 'cat', '/workspace/data.txt'])).stdout).toBe(
      'uploaded\n',
    );
    const dir = join(t.home, 'tree');
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'sub', 'f'), 'deep\n');
    expect((await runBin(t, ['cp', dir, `${id}:/workspace/tree`])).code).toBe(0);
    expect((await runBin(t, ['exec', id, '--', 'cat', '/workspace/tree/sub/f'])).stdout).toBe(
      'deep\n',
    );
    const down = join(t.home, 'down.txt');
    expect((await runBin(t, ['cp', `${id}:/workspace/hello.txt`, down])).code).toBe(0);
    expect(readFileSync(down, 'utf8')).toBe('hello\n');
    const back = join(t.home, 'tree-back');
    expect((await runBin(t, ['cp', `${id}:/workspace/tree`, back])).code).toBe(0);
    expect(readFileSync(join(back, 'sub', 'f'), 'utf8')).toBe('deep\n');
    expect(
      (await runBin(t, ['cp', join(t.home, 'missing'), `${id}:/workspace/x`, '--json'])).code,
    ).toBe(2);

    const logs = await runBin(t, ['logs', id, '--json']);
    expect(logs.code, logs.stderr).toBe(0);
    expect(logs.json.data).toHaveProperty('logs');
    const tail = await runBin(t, ['logs', id, '--tail', '5']);
    expect(tail.code).toBe(0);
    const follow = spawnBin(t, ['logs', id, '-f']);
    await sleep(1500);
    follow.child.kill('SIGINT');
    expect(await follow.exited).toBe(0);

    await runBin(t, ['exec', id, '--', 'sh', '-c', 'echo changed > hello.txt']);
    const diff = await runBin(t, ['export', id, '--format', 'diff']);
    expect(diff.code, diff.stderr).toBe(0);
    expect(diff.stdout).toContain('+changed');
  }, 120_000);

  it('background process, snapshot/restore, extend', async () => {
    const start = await runBin(t, [
      'process',
      'start',
      id,
      '--json',
      '--',
      'sh',
      '-c',
      'echo bg-started; sleep 60',
    ]);
    expect(start.code, start.stderr).toBe(0);
    const pid = start.json.data.process.id;
    await sleep(700);
    expect((await runBin(t, ['process', 'logs', pid])).stdout).toContain('bg-started');
    expect((await runBin(t, ['process', 'stop', pid])).code).toBe(0);

    await runBin(t, ['exec', id, '--', 'sh', '-c', 'echo v1 > state.txt']);
    const snap = await runBin(t, ['snapshot', id, 'one', '--json']);
    expect(snap.code, snap.stderr).toBe(0);
    await runBin(t, ['exec', id, '--', 'sh', '-c', 'echo v2 > state.txt']);
    const restored = await runBin(t, ['restore', id, snap.json.data.snapshotId, '--json']);
    expect(restored.code, restored.stderr).toBe(0);
    expect((await runBin(t, ['exec', id, '--', 'cat', 'state.txt'])).stdout).toBe('v1\n');
    // restore by the name given to "snapshot" (Docker's snapshot id is not the name)
    await runBin(t, ['exec', id, '--', 'sh', '-c', 'echo v3 > state.txt']);
    const byName = await runBin(t, ['restore', id, 'one', '--json']);
    expect(byName.code, byName.stderr).toBe(0);
    expect(byName.json.data.restored).toBe(snap.json.data.snapshotId);
    expect((await runBin(t, ['exec', id, '--', 'cat', 'state.txt'])).stdout).toBe('v1\n');

    const before = (await runBin(t, ['inspect', id, '--json'])).json.data.expiresAt;
    expect((await runBin(t, ['extend', id, '10m'])).code).toBe(0);
    expect(
      (await runBin(t, ['inspect', id, '--json'])).json.data.expiresAt - before,
    ).toBeGreaterThan(9 * 60_000);
  }, 180_000);

  it.runIf(spawnSync('sh', ['-c', 'command -v script']).status === 0)(
    'shell: an interactive terminal session',
    async () => {
      const r = await runBin(t, ['shell', id, '--json']);
      expect(r.code).toBe(2); // no tty in the test process
      const script = spawnSync(
        'script',
        ['-qec', `${process.execPath} ${BIN} shell ${id}`, '/dev/null'],
        {
          cwd: t.project,
          env: t.env,
          input: 'echo shell-works-$((6*7))\nexit 3\n',
          encoding: 'utf8',
          timeout: 60_000,
        },
      );
      expect(script.stdout).toContain('shell-works-42');
      // opened and closed through the manager: audit entries with duration and exit code, never content
      const audit = await runBin(t, ['audit', '--sandbox', id, '--limit', '200', '--json']);
      const entries = audit.json.data.entries as Array<{
        action: string;
        details: Record<string, unknown> | null;
      }>;
      expect(entries.some((e) => e.action === 'sandbox.attach')).toBe(true);
      const end = entries.find((e) => e.action === 'sandbox.attach.end');
      expect(end?.details).toMatchObject({ exitCode: 3 });
      expect(JSON.stringify(entries)).not.toContain('shell-works');
    },
    90_000,
  );

  it('stop, start, rm', async () => {
    const stop = await runBin(t, ['stop', id]);
    expect(stop.code, stop.stderr).toBe(0);
    expect((await runBin(t, ['ls', '--state', 'stopped', '-q'])).stdout).toContain(id);
    expect((await runBin(t, ['exec', id, '--json', '--', 'true'])).code).not.toBe(0);
    expect((await runBin(t, ['start', id])).code).toBe(0);
    const refuse = await runBin(t, ['rm', id, '--json']);
    expect(refuse.code).toBe(2);
    expect(refuse.json.code).toBe('conflict');
    await runBin(t, ['stop', id]);
    const rm = await runBin(t, ['rm', id, '--json']);
    expect(rm.code, rm.stderr).toBe(0);
    expect(rm.json.data.results[0]).toEqual({ id, removed: true });
    created.splice(created.indexOf(id), 1);
    const gone = await runBin(t, ['ls', '--json']);
    expect(gone.json.data.sandboxes.find((x: { id: string }) => x.id === id)).toBeUndefined();
    expect(
      spawnSync('docker', ['ps', '-aq', '--filter', `label=abox.id=${id}`], {
        encoding: 'utf8',
      }).stdout.trim(),
    ).toBe('');
  }, 120_000);

  it('kill -9 of a CLI create: doctor reports the interrupted create and reconcile --apply repairs it', async () => {
    const name = `slow-${Date.now().toString(36)}`;
    rmImages.push(`${name}*`);
    t.write(
      `home/proj/.sandbox/${name}.yaml`,
      [
        'apiVersion: 1',
        `name: ${name}`,
        'description: Takes a while to build so the test can interrupt the create.',
        'backend: docker',
        'base: { os: alpine:3.22 }',
        `setup:`,
        `  - run: "echo ${name} && sleep 20"`,
        'network: { mode: none }',
        '',
      ].join('\n'),
    );
    const { child, exited } = spawnBin(t, ['create', name, '--workspace', '.', '--yes']);
    let sandboxId: string | undefined;
    const until = Date.now() + 30_000;
    while (!sandboxId && Date.now() < until) {
      await sleep(250);
      const ls = await run(t, ['ls', '--all', '--json']);
      sandboxId = ls.json?.data?.sandboxes?.find(
        (s: { template: string; state: string }) => s.template === name && s.state === 'preparing',
      )?.id;
    }
    expect(sandboxId, 'the create never reached the preparing state').toBeTruthy();
    child.kill('SIGKILL');
    expect(await exited).not.toBe(0);
    created.push(sandboxId!);

    const doctor = await runBin(t, ['doctor', '--json']);
    expect(doctor.code).not.toBe(0);
    expect(doctor.json.ok).toBe(false);
    const report = doctor.json.details.report;
    expect(report.reconcile.interrupted.map((e: { id: string }) => e.id)).toContain(sandboxId);
    const human = await runBin(t, ['doctor']);
    expect(human.stdout).toContain('interrupted create');
    expect(human.stdout).toContain('reconcile --apply');

    const dry = await runBin(t, ['reconcile', '--json']);
    expect(dry.json.data.interrupted.map((e: { id: string }) => e.id)).toContain(sandboxId);
    expect(dry.json.data.applied.markedFailed).toEqual([]);

    const fix = await runBin(t, ['reconcile', '--apply', '--json']);
    expect(fix.code, fix.stderr).toBe(0);
    expect(fix.json.data.applied.markedFailed).toContain(sandboxId);
    const after = await runBin(t, ['ls', '--all', '--json']);
    expect(after.json.data.sandboxes.find((s: { id: string }) => s.id === sandboxId)?.state).toBe(
      'failed',
    );
    const doctor2 = await runBin(t, ['doctor', '--json']);
    const rep2 = doctor2.json.data?.reconcile ?? doctor2.json.details?.report.reconcile;
    expect(rep2.interrupted).toEqual([]);
    // gc would remove images; --dry-run only reports
    const gc = await runBin(t, ['gc', '--dry-run', '--json']);
    expect(gc.code, gc.stderr).toBe(0);
    created.splice(created.indexOf(sandboxId!), 1);
  }, 180_000);

  it('Ctrl-C during a create ends with exit 130 and leaves nothing behind', async () => {
    const name = `sig-${Date.now().toString(36)}`;
    rmImages.push(`${name}*`);
    t.write(
      `home/proj/.sandbox/${name}.yaml`,
      [
        'apiVersion: 1',
        `name: ${name}`,
        'description: Slow build for the interrupt test.',
        'backend: docker',
        'base: { os: alpine:3.22 }',
        'setup:',
        `  - run: "echo ${name} && sleep 20"`,
        'network: { mode: none }',
        '',
      ].join('\n'),
    );
    const { child, exited } = spawnBin(t, ['create', name, '--workspace', '.', '--yes']);
    let sandboxId: string | undefined;
    const until = Date.now() + 30_000;
    while (!sandboxId && Date.now() < until) {
      await sleep(250);
      const ls = await run(t, ['ls', '--all', '--json']);
      sandboxId = ls.json?.data?.sandboxes?.find(
        (s: { template: string; state: string }) => s.template === name && s.state === 'preparing',
      )?.id;
    }
    expect(sandboxId).toBeTruthy();
    child.kill('SIGINT');
    expect(await exited).toBe(130);
    const after = await runBin(t, ['ls', '--all', '--json']);
    expect(after.json.data.sandboxes.find((s: { id: string }) => s.id === sandboxId)?.state).toBe(
      'failed',
    );
    expect(
      spawnSync('docker', ['ps', '-aq', '--filter', `label=abox.id=${sandboxId}`], {
        encoding: 'utf8',
      }).stdout.trim(),
    ).toBe('');
  }, 120_000);

  it('approvals work without a GUI: agent request -> abox approvals approve -> retry succeeds', async () => {
    writePolicy(
      t,
      `version: 1
profiles:
  agent:
    approval: strict
    templates: [alpine-min]
    limits: { sandboxes: 3, cpus: 2, memory: 1g, ttl: 1h }
    workspace: { roots: ['${t.home}'], modes: [copy, empty] }
    network: { modes: [none], allow_presets: [], allow: [] }
    mounts: deny
    secrets: { allowed: [], inject: [proxy] }
    isolation: { min: container, network_open: vm, mounts: container, secrets_env: container }
contexts:
  tester: { profile: agent }
`,
    );
    const req = {
      template: 'alpine-min',
      requestId: 'docker-approval',
      workspace: { mode: 'copy' as const, path: t.project },
    };
    const agent = async () => {
      const rt = await openAbox({ env: t.env, contextId: 'tester' });
      try {
        return await rt.abox.createSandbox(rt.caller, req, { waitForApprovalMs: 0 });
      } finally {
        await rt.close();
      }
    };
    const first = await agent();
    expect(first.status).toBe('pending_approval');
    if (first.status !== 'pending_approval') return;
    const ls = await runBin(t, ['approvals', 'ls', '--json']);
    expect(ls.json.data.approvals.map((a: { id: string }) => a.id)).toContain(first.approvalId);
    const approve = await runBin(t, ['approvals', 'approve', first.approvalId, '--yes', '--json']);
    expect(approve.code, approve.stderr).toBe(0);
    const second = await agent();
    expect(second.status).toBe('created');
    if (second.status === 'created') {
      created.push(second.sandbox.id);
      expect((await runBin(t, ['inspect', second.sandbox.id, '--json'])).json.data.owner).toBe(
        'agent:tester',
      );
    }
  }, 120_000);

  it('Dockerfile base: trust and approvals cover the Dockerfile; a rewrite after the approval fails closed', async () => {
    writePolicy(
      t,
      `version: 1
profiles:
  agent:
    approval: medium
    templates: [df-tpl]
    limits: { sandboxes: 3, cpus: 2, memory: 1g, ttl: 1h }
    workspace: { roots: ['${t.home}'], modes: [copy, empty] }
    network: { modes: [none], allow_presets: [], allow: [] }
    mounts: deny
    secrets: { allowed: [], inject: [proxy] }
    isolation: { min: container, network_open: vm, mounts: container, secrets_env: container }
contexts:
  tester: { profile: agent }
`,
    );
    rmImages.push('df-tpl', 'df-tpl-base');
    const proj = join(t.home, 'df-proj');
    const dir = join(proj, '.sandbox');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'df-tpl.yaml'),
      'apiVersion: 1\nname: df-tpl\ndescription: Template with its own Dockerfile, CLI docker tests only.\nbackend: docker\nbase: { dockerfile: ./Dockerfile }\nresources: { cpus: 1, memory: 256m, pids: 128, ttl: 30m }\n',
    );
    const dockerfile = join(dir, 'Dockerfile');
    writeFileSync(dockerfile, 'FROM alpine:3.22\nRUN echo ok > /etc/marker-ok\n');
    const images = (): string =>
      spawnSync('docker', ['images', '--format', '{{.Repository}}:{{.Tag}}', 'abox/df-tpl*'], {
        encoding: 'utf8',
      })
        .stdout.split('\n')
        .filter(Boolean)
        .sort()
        .join('\n');
    const agent = async (requestId: string) => {
      const rt = await openAbox({ env: t.env, contextId: 'tester' });
      try {
        return await rt.abox.createSandbox(
          rt.caller,
          {
            template: 'df-tpl',
            requestId,
            projectDir: proj,
            workspace: { mode: 'empty' as const },
          },
          { waitForApprovalMs: 0 },
        );
      } finally {
        await rt.close();
      }
    };

    const first = await agent('df-1');
    expect(first.status).toBe('pending_approval');
    if (first.status !== 'pending_approval') return;
    expect(first.kind).toBe('template_trust');
    const approve = await runBin(t, ['approvals', 'approve', first.approvalId, '--yes', '--json']);
    expect(approve.code, approve.stderr).toBe(0);
    const ok = await agent('df-1');
    expect(ok.status).toBe('created');
    if (ok.status !== 'created') return;
    created.push(ok.sandbox.id);
    expect((await runBin(t, ['exec', ok.sandbox.id, '--', 'cat', '/etc/marker-ok'])).stdout).toBe(
      'ok\n',
    );
    const imagesBefore = images();
    expect(imagesBefore).toContain('abox/df-tpl:');

    // the Dockerfile is rewritten after the approval
    writeFileSync(
      dockerfile,
      'FROM alpine:3.22\nRUN echo ok > /etc/marker-ok\nRUN echo EVIL2 > /etc/marker\n',
    );
    const evil = await agent('df-2');
    expect(evil.status).toBe('pending_approval');
    if (evil.status !== 'pending_approval') {
      if (evil.status === 'created') created.push(evil.sandbox.id);
      return;
    }
    expect(evil.approvalId).not.toBe(first.approvalId);
    // nothing was built or started for the unapproved content
    expect(images()).toBe(imagesBefore);
    const review = await runBin(t, ['approvals', 'show', evil.approvalId]);
    expect(review.stdout).toContain('+  RUN echo EVIL2 > /etc/marker');
    expect(review.stdout).toContain('Build context');

    // with a new approval of the new content it works again
    const approve2 = await runBin(t, ['approvals', 'approve', evil.approvalId, '--yes', '--json']);
    expect(approve2.code, approve2.stderr).toBe(0);
    const again = await agent('df-2');
    expect(again.status).toBe('created');
    if (again.status === 'created') {
      created.push(again.sandbox.id);
      expect((await runBin(t, ['exec', again.sandbox.id, '--', 'cat', '/etc/marker'])).stdout).toBe(
        'EVIL2\n',
      );
    }
  }, 300_000);
});

describe.runIf(DOCKER && process.env['ABOX_TEST_NODE_DEV'] === '1')(
  'node-dev (needs network, slow)',
  () => {
    it('builds node-dev, then hits the cache', async () => {
      const t = makeEnv();
      try {
        const first = await runBin(t, ['template', 'build', 'node-dev', '--json'], {
          timeoutMs: 900_000,
        });
        expect(first.code, first.stderr).toBe(0);
        const second = await runBin(t, ['template', 'build', 'node-dev', '--json']);
        expect(second.json.data.cached).toBe(true);
        expect(second.ms).toBeLessThan(2000);
        console.info(`[node-dev] first ${first.ms} ms, second ${second.ms} ms`);
      } finally {
        t.cleanup();
      }
    }, 1_000_000);
  },
);
