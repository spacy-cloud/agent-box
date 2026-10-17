import { existsSync, readFileSync, readdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../../config/config.js';
import type { Abox } from '../abox.js';
import type { ExecOutcome } from '../types.js';
import { A, B, HUMAN, HUMAN_YES, created, createApproved, makeEnv, openAbox } from './harness.js';
import type { TestEnv } from './harness.js';

let env: TestEnv;
let abox: Abox;

async function setup(config?: string): Promise<void> {
  env = makeEnv();
  abox = await openAbox(env, config ? { config: parseConfig(config) } : {});
}
afterEach(() => {
  abox.close();
  env.cleanup();
});

function done(r: ExecOutcome): Extract<ExecOutcome, { status: 'completed' }> {
  if (r.status !== 'completed') throw new Error(`exec not completed: ${r.status}`);
  return r;
}

async function newShell(caller = HUMAN_YES, extra: Record<string, unknown> = {}): Promise<string> {
  const r = created(
    await abox.createSandbox(caller, {
      template: 'host-shell',
      workspace: { mode: 'copy', path: env.project },
      ...extra,
    } as never),
  );
  return r.sandbox.id;
}

describe('process backend end to end', () => {
  beforeEach(() => setup());

  it('create -> list -> inspect with workspace, ttl and effective options', async () => {
    const id = await newShell();
    const list = await abox.listSandboxes(HUMAN);
    expect(list.sandboxes.map((s) => s.id)).toEqual([id]);
    const v = await abox.inspectSandbox(HUMAN, id);
    expect(v).toMatchObject({
      backend: 'process',
      isolation: 'none',
      state: 'running',
      template: 'host-shell',
      owner: 'human',
      stale: false,
    });
    expect(v.workspace).toMatchObject({
      mode: 'copy',
      sandboxPath: '/workspace',
      source: env.project,
    });
    expect(v.ttlRemainingMs).toBeGreaterThan(3_000_000);
    expect(v.effective).toMatchObject({
      provider: { isolation: 'none' },
      policy: { isolation: 'none' },
    });
    expect(v.network.mode).toBe('open');
    expect(v.processes).toEqual([]);
    expect(readdirSync(join(abox.paths.dataDir, 'sandboxes'))).toHaveLength(1);
  });

  it('exec: exit codes, stdin, env, cwd, timeout, truncation and the full log', async () => {
    const id = await newShell();
    const ok = done(await abox.exec(HUMAN, id, { command: 'echo out; echo err >&2; exit 3' }));
    expect(ok).toMatchObject({
      exitCode: 3,
      stdout: 'out\n',
      stderr: 'err\n',
      truncated: false,
      timedOut: false,
    });
    expect(done(await abox.exec(HUMAN, id, { argv: ['cat'], stdin: 'piped' })).stdout).toBe(
      'piped',
    );
    expect(
      done(await abox.exec(HUMAN, id, { command: 'echo $FOO', env: { FOO: 'bar' } })).stdout,
    ).toBe('bar\n');
    expect(done(await abox.exec(HUMAN, id, { command: 'ls' })).stdout).toContain('README.md');
    expect(
      done(await abox.exec(HUMAN, id, { command: 'pwd', cwd: '/workspace/src' })).stdout.trim(),
    ).toMatch(/workspace\/src$/);

    const slow = done(await abox.exec(HUMAN, id, { command: 'sleep 5', timeoutMs: 300 }));
    expect(slow.timedOut).toBe(true);
    expect(slow.durationMs).toBeLessThan(3000);

    const big = done(
      await abox.exec(HUMAN, id, { command: 'yes x | head -c 20000', maxOutputBytes: 1000 }),
    );
    expect(big.truncated).toBe(true);
    expect(Buffer.byteLength(big.stdout)).toBeLessThanOrEqual(1000);
    const log = await abox.readLog(HUMAN, big.logRef, { maxBytes: 1_000_000 });
    expect(log.content.length).toBeGreaterThan(19_000);
    const audit = (await abox.queryAudit(HUMAN, { action: 'sandbox.exec', limit: 1 }))[0]!;
    expect(audit.details).toMatchObject({ truncated: true, logRef: big.logRef });
    expect(JSON.stringify(audit.details)).not.toContain('xxxxxxxx'); // output is never audited
  });

  it('exec needs a running sandbox', async () => {
    const id = await newShell();
    await abox.stopSandbox(HUMAN, id);
    await expect(abox.exec(HUMAN, id, { argv: ['true'] })).rejects.toMatchObject({
      code: 'conflict',
    });
    expect((await abox.startSandbox(HUMAN, id)).state).toBe('running');
    done(await abox.exec(HUMAN, id, { argv: ['true'] }));
  });

  it('files: write, read (text and binary), list, relative paths', async () => {
    const id = await newShell();
    await abox.writeFile(HUMAN, id, '/workspace/new/hello.txt', 'héllo');
    const r = await abox.readFile(HUMAN, id, '/workspace/new/hello.txt');
    expect(r).toMatchObject({ encoding: 'utf8', content: 'héllo', truncated: false });
    expect((await abox.readFile(HUMAN, id, 'new/hello.txt')).content).toBe('héllo');
    expect(
      (await abox.readFile(HUMAN, id, '/workspace/new/hello.txt', { maxBytes: 2 })).truncated,
    ).toBe(true);
    await abox.writeFile(HUMAN, id, '/workspace/bin.dat', Buffer.from([0, 1, 2, 255]));
    const bin = await abox.readFile(HUMAN, id, '/workspace/bin.dat');
    expect(bin.encoding).toBe('base64');
    expect(Buffer.from(bin.content, 'base64')).toEqual(Buffer.from([0, 1, 2, 255]));
    const entries = await abox.listDir(HUMAN, id, '/workspace');
    expect(entries.map((e) => e.name)).toEqual(
      expect.arrayContaining(['README.md', 'new', 'bin.dat']),
    );
    await expect(abox.readFile(HUMAN, id, '/workspace/../../etc/passwd')).rejects.toBeTruthy();
    const audit = await abox.queryAudit(HUMAN, { action: 'sandbox.write_file' });
    expect(JSON.stringify(audit)).not.toContain('héllo');
  });

  it('background processes: start, logs (incremental), exit status, stop', async () => {
    const id = await newShell();
    const s = await abox.startProcess(HUMAN, id, {
      command: 'echo first; sleep 0.3; echo second; sleep 30',
    });
    if (s.status !== 'started') throw new Error('x');
    const pid = s.process.id;
    let logs = await abox.processLogs(HUMAN, pid);
    for (let i = 0; i < 40 && !logs.content.includes('second'); i++) {
      await new Promise((r) => setTimeout(r, 100));
      logs = await abox.processLogs(HUMAN, pid);
    }
    expect(logs.content).toBe('first\nsecond\n');
    expect(logs.process.status).toBe('running');
    const next = await abox.processLogs(HUMAN, pid, { sinceBytes: 6 });
    expect(next.content).toBe('second\n');
    expect((await abox.processLogs(HUMAN, pid, { tail: 1 })).content).toBe('second\n');
    const stopped = await abox.stopProcess(HUMAN, pid);
    expect(stopped.status).toBe('killed');
    // really gone: the group is dead
    const view = await abox.listProcesses(HUMAN, id);
    expect(view.map((p) => p.status)).toEqual(['killed']);

    const quick = await abox.startProcess(HUMAN, id, { argv: ['sh', '-c', 'echo done; exit 4'] });
    if (quick.status !== 'started') throw new Error('x');
    let st = quick.process.status;
    for (let i = 0; i < 30 && st === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 100));
      st = (await abox.processLogs(HUMAN, quick.process.id)).process.status;
    }
    const final = (await abox.listProcesses(HUMAN, id)).find((p) => p.id === quick.process.id)!;
    expect(final).toMatchObject({ status: 'exited', exitCode: 4 });
    expect((await abox.processLogs(HUMAN, quick.process.id)).content).toBe('done\n');
  }, 20_000);

  it('snapshot and restore work on a backend that supports them, unsupported otherwise', async () => {
    const id = await newShell();
    await abox.writeFile(HUMAN, id, '/workspace/state.txt', 'v1');
    const snap = await abox.snapshot(HUMAN, id, 'before');
    await abox.writeFile(HUMAN, id, '/workspace/state.txt', 'v2');
    await abox.restore(HUMAN, id, snap.snapshotId);
    expect((await abox.readFile(HUMAN, id, '/workspace/state.txt')).content).toBe('v1');

    const fake = created(
      await abox.createSandbox(A, { template: 'fake-box', workspace: { mode: 'empty' } }),
    );
    const e = await abox.snapshot(A, fake.sandbox.id, 'x').catch((err: unknown) => err);
    expect(e).toMatchObject({ code: 'unsupported' });
    expect((e as { hint: string }).hint).toBeTruthy();
  });

  it('export produces a diff / files and flags risky paths; nothing is applied to the project', async () => {
    const id = await newShell();
    await abox.writeFile(HUMAN, id, '/workspace/src/a.txt', 'changed\n');
    await abox.writeFile(HUMAN, id, '/workspace/.husky/pre-commit', 'echo hi\n');
    const diff = await abox.exportSandbox(HUMAN, id, { format: 'diff' });
    expect(diff.content).toContain('+changed');
    expect(diff.files.map((f) => f.path)).toEqual(
      expect.arrayContaining(['src/a.txt', '.husky/pre-commit']),
    );
    expect(diff.flagged.map((f) => f.path)).toContain('.husky/pre-commit');
    expect(readFileSync(join(env.project, 'src', 'a.txt'), 'utf8')).toBe('a\n');
    expect(existsSync(join(env.project, '.husky'))).toBe(false);

    const out = join(env.root, 'home', 'projects', 'out-files');
    const files = await abox.exportSandbox(HUMAN, id, { format: 'files', outDir: out });
    expect(files.written?.length).toBe(2);
    expect(readFileSync(join(out, 'src', 'a.txt'), 'utf8')).toBe('changed\n');
    await expect(
      abox.exportSandbox(HUMAN, id, { format: 'files', outDir: join(env.home, '.ssh', 'x') }),
    ).rejects.toMatchObject({ code: 'policy_denied' });

    const audit = (
      await abox.queryAudit(HUMAN, { action: 'sandbox.export', limit: 2, order: 'asc' })
    )[0]!;
    expect(
      (audit.details as { flagged: Array<{ path: string }> }).flagged.map((f) => f.path),
    ).toContain('.husky/pre-commit');
    expect(JSON.stringify(audit.details)).not.toContain('echo hi');
  });

  it('remove cleans backend, workspace and registry; it is idempotent', async () => {
    const id = await newShell();
    const short = id.split('/')[1]!;
    expect(existsSync(join(abox.paths.dataDir, 'process', 'sandboxes', short))).toBe(true);
    expect(await abox.removeSandbox(HUMAN, id)).toEqual({ id, removed: true });
    expect(existsSync(join(abox.paths.dataDir, 'process', 'sandboxes', short))).toBe(false);
    expect(existsSync(join(abox.paths.dataDir, 'sandboxes', short))).toBe(false);
    expect((await abox.listSandboxes(HUMAN)).sandboxes).toEqual([]);
    expect(await abox.removeSandbox(HUMAN, id)).toEqual({ id, removed: false });
  });

  it('worktree/mount need bind delivery, which the process backend refuses clearly', async () => {
    await expect(
      abox.createSandbox(HUMAN_YES, {
        template: 'host-shell',
        workspace: { mode: 'mount', path: env.project },
      }),
    ).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('a failed create on the process backend leaves no directories', async () => {
    await expect(
      abox.createSandbox(HUMAN_YES, {
        template: 'host-shell',
        workspace: { mode: 'copy', path: env.project },
        overrides: { network: { mode: 'none' } },
      }),
    ).rejects.toMatchObject({ code: 'unsupported' });
    const d = join(abox.paths.dataDir, 'sandboxes');
    expect(existsSync(d) ? readdirSync(d).length : 0).toBe(0);
  });
});

describe('agents on the process backend (approval flow, caps)', () => {
  beforeEach(() => setup('limits: { execMaxOutputBytes: 100, execTimeoutMs: 1000 }'));

  it('isolation none needs an approval for agents; exec caps apply to agents but not to the human', async () => {
    const first = await abox.createSandbox(
      A,
      { template: 'host-shell', workspace: { mode: 'copy', path: env.project } },
      { waitForApprovalMs: 0 },
    );
    expect(first.status).toBe('pending_approval');
    if (first.status !== 'pending_approval') return;
    expect(first.reasons.join(' ')).toContain('isolation "none"');
    const sb = await createApproved(abox, A, {
      template: 'host-shell',
      workspace: { mode: 'copy', path: env.project },
    });
    const id = sb.sandbox.id;
    const out = done(
      await abox.exec(A, id, { command: 'yes y | head -c 5000', maxOutputBytes: 100000 }),
    );
    expect(out.truncated).toBe(true);
    expect(Buffer.byteLength(out.stdout)).toBeLessThanOrEqual(100);
    const t = done(await abox.exec(A, id, { command: 'sleep 5', timeoutMs: 60000 }));
    expect(t.timedOut).toBe(true);
    expect(t.durationMs).toBeLessThan(3000);
    const h = done(
      await abox.exec(HUMAN, id, { command: 'yes y | head -c 5000', maxOutputBytes: 100000 }),
    );
    expect(Buffer.byteLength(h.stdout)).toBe(5000);
    // B sees nothing of it
    await expect(abox.exec(B, id, { argv: ['true'] })).rejects.toMatchObject({ code: 'not_found' });
    // agents cannot choose where a files export goes; it lands in an abox-owned directory
    await abox.writeFile(A, id, '/workspace/new.txt', 'n');
    await expect(
      abox.exportSandbox(A, id, { format: 'files', outDir: join(env.projects, 'mine') }),
    ).rejects.toMatchObject({ code: 'policy_denied' });
    const ex = await abox.exportSandbox(A, id, { format: 'files' });
    expect(ex.outDir).toContain(join(abox.paths.dataDir, 'exports'));
    expect(readFileSync(join(ex.outDir!, ex.written![0]!), 'utf8')).toBe('n');
    await abox.removeSandbox(A, id);
  });
});

describe('ttl, gc and logs on the process backend', () => {
  beforeEach(() => setup('logs: { retentionDays: 1 }'));

  it('ttl expiry stops the sandbox (and its processes); gc removes it', async () => {
    const id = await newShell();
    const s = await abox.startProcess(HUMAN, id, { command: 'sleep 30' });
    if (s.status !== 'started') throw new Error('x');
    env.clock.t += 2 * 3600_000;
    const list = await abox.listSandboxes(HUMAN);
    expect(list.sandboxes[0]).toMatchObject({ id, state: 'expired' });
    await expect(abox.exec(HUMAN, id, { argv: ['true'] })).rejects.toMatchObject({
      code: 'conflict',
    });
    const dry = await abox.gc(HUMAN, { dryRun: true });
    expect(dry.sandboxes).toEqual([id]);
    expect((await abox.listSandboxes(HUMAN)).sandboxes).toHaveLength(1);
    const report = await abox.gc(HUMAN);
    expect(report.sandboxes).toEqual([id]);
    expect((await abox.listSandboxes(HUMAN)).sandboxes).toEqual([]);
    expect(existsSync(join(abox.paths.dataDir, 'process', 'sandboxes', id.split('/')[1]!))).toBe(
      false,
    );
    expect(
      await abox.queryAudit(HUMAN, { action: ['sandbox.expired', 'sandbox.gc'] }),
    ).toHaveLength(2);
  });

  it('gc rotates old logs and removes stale workspace directories', async () => {
    const id = await newShell();
    const x = done(await abox.exec(HUMAN, id, { argv: ['echo', 'hi'] }));
    const logDir = join(abox.paths.logsDir, id.split('/')[1]!);
    const file = join(logDir, readdirSync(logDir)[0]!);
    expect(x.logRef).toContain(readdirSync(logDir)[0]!);
    const old = new Date(Date.now() - 3 * 86_400_000);
    utimesSync(file, old, old);
    // a leftover directory nobody refers to
    const { mkdirSync } = await import('node:fs');
    const stale = join(abox.paths.dataDir, 'sandboxes', 'deadbeef');
    mkdirSync(stale, { recursive: true });
    const dry = await abox.gc(HUMAN, { dryRun: true });
    expect(dry.logs.files).toBe(1);
    expect(dry.workspaces).toEqual([stale]);
    expect(existsSync(file)).toBe(true);
    const r = await abox.gc(HUMAN);
    expect(r.logs.files).toBe(1);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(stale)).toBe(false);
    // the live sandbox's workspace stays
    expect(existsSync(join(abox.paths.dataDir, 'sandboxes', id.split('/')[1]!))).toBe(true);
    await abox.removeSandbox(HUMAN, id);
  });
});
