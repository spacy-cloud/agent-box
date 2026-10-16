import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeEnv, run, type TestEnv } from './harness.js';

/**
 * Lifecycle through the CLI on the `process` backend (template host-shell: no isolation, no
 * Docker needed). Docker-specific behaviour is covered in docker.test.ts.
 */
let t: TestEnv;
let id: string;

beforeAll(async () => {
  t = makeEnv();
  const r = await run(t, [
    'create',
    'host-shell',
    '--workspace',
    '.',
    '--name',
    'shelly',
    '--yes',
    '--json',
  ]);
  expect(r.code, r.stderr).toBe(0);
  id = r.json.data.sandbox.id;
});
afterAll(async () => {
  await run(t, ['rm', '--force', id]);
  t.cleanup();
});

describe('confirmation for risky creates', () => {
  it('needs --yes without a terminal (exit 3, risks in details)', async () => {
    const r = await run(t, ['create', 'host-shell', '--workspace', '.', '--json']);
    expect(r.code).toBe(3);
    expect(r.json).toMatchObject({ ok: false, code: 'approval_required' });
    expect(r.json.details.reasons[0]).toContain('isolation "none"');
    expect(r.json.details.risks.length).toBeGreaterThan(0);
    expect(r.json.hint).toContain('--yes');
  });

  it('shows the risks and asks interactively', async () => {
    const no = await run(t, ['create', 'host-shell', '--workspace', '.'], {
      tty: true,
      stdin: 'n\n',
    });
    expect(no.code).toBe(3);
    expect(no.stderr).toContain('Confirmation required');
    expect(no.stderr).toContain('Risks:');
    expect(no.stderr).toContain('Proceed? [y/N]');
    const before = (await run(t, ['ls', '--json'])).json.data.sandboxes.length;
    const yes = await run(t, ['create', 'host-shell', '--workspace', '.', '--name', 'asked'], {
      tty: true,
      stdin: 'y\n',
    });
    expect(yes.code, yes.stderr).toBe(0);
    expect(yes.stdout).toMatch(/created local\/[0-9a-f]{8}/);
    const after = (await run(t, ['ls', '--json'])).json.data.sandboxes;
    expect(after.length).toBe(before + 1);
    await run(t, ['rm', '--force', 'asked']);
  });

  it('is idempotent with --request-id', async () => {
    const a = await run(t, [
      'create',
      'host-shell',
      '--workspace',
      '.',
      '--yes',
      '--request-id',
      'req-1',
      '--json',
    ]);
    const b = await run(t, [
      'create',
      'host-shell',
      '--workspace',
      '.',
      '--yes',
      '--request-id',
      'req-1',
      '--json',
    ]);
    expect(a.code).toBe(0);
    expect(b.json.data.sandbox.id).toBe(a.json.data.sandbox.id);
    expect(b.json.data.idempotent).toBe(true);
    await run(t, ['rm', '--force', a.json.data.sandbox.id]);
  });
});

describe('inspecting', () => {
  it('lists with a stable JSON shape', async () => {
    const r = await run(t, ['ls', '--json']);
    expect(r.code).toBe(0);
    expect(Object.keys(r.json)).toEqual(['ok', 'data']);
    expect(Object.keys(r.json.data).sort()).toEqual(['orphans', 'sandboxes', 'unreachableHosts']);
    const s = r.json.data.sandboxes.find((x: { id: string }) => x.id === id);
    expect(s).toMatchObject({
      id,
      name: 'shelly',
      template: 'host-shell',
      backend: 'process',
      owner: 'human',
      state: 'running',
      host: 'local',
    });
    for (const k of [
      'createdAt',
      'expiresAt',
      'ttlRemainingMs',
      'network',
      'resources',
      'mounts',
      'workspace',
      'effective',
    ]) {
      expect(s).toHaveProperty(k);
    }
  });

  it('feeds shell completion with sandbox ids', async () => {
    const r = await run(t, ['__ids']);
    expect(r.code).toBe(0);
    expect(r.stdout.split('\n')).toContain(id);
  });

  it('filters, quiet-prints ids and accepts names and short ids', async () => {
    const running = await run(t, ['ls', '--state', 'running', '--quiet']);
    expect(running.stdout.split('\n')).toContain(id);
    const stopped = await run(t, ['ls', '--state', 'stopped', '--json']);
    expect(stopped.json.data.sandboxes.find((x: { id: string }) => x.id === id)).toBeUndefined();
    const badState = await run(t, ['ls', '--state', 'sleepy']);
    expect(badState.code).toBe(2);
    const byName = await run(t, ['inspect', 'shelly', '--json']);
    expect(byName.json.data.id).toBe(id);
    const short = await run(t, ['inspect', id.split('/')[1]!, '--json']);
    expect(short.json.data.id).toBe(id);
    const human = await run(t, ['ls']);
    expect(human.stdout).toMatch(/^ID\s+NAME\s+TEMPLATE\s+STATE/);
    expect(human.stdout).toContain('shelly');
  });

  it('inspects with the restrictive facts and reports unknown ids as exit 2', async () => {
    const r = await run(t, ['inspect', id, '--json']);
    expect(r.json.data).toMatchObject({ id, isolation: 'none', network: { mode: 'open' } });
    expect(r.json.data.resources.ttlMs).toBeGreaterThan(0);
    const human = await run(t, ['inspect', id]);
    expect(human.stdout).toContain('state:');
    const missing = await run(t, ['inspect', 'local/deadbeef', '--json']);
    expect(missing.code).toBe(2);
    expect(missing.json.code).toBe('not_found');
    const noName = await run(t, ['inspect', 'no-such-name', '--json']);
    expect(noName.code).toBe(2);
  });
});

describe('exec', () => {
  it('passes stdout/stderr through and returns the command exit code', async () => {
    const r = await run(t, ['exec', id, '--', 'sh', '-c', 'echo out; echo err >&2; exit 7']);
    expect(r.code).toBe(7);
    expect(r.stdout).toBe('out\n');
    expect(r.stderr).toBe('err\n');
    const ok = await run(t, ['exec', id, '--', 'echo', 'hi', '--json']);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toBe('hi --json\n'); // after "--" everything belongs to the command
  });

  it('supports --cwd, --env and stdin', async () => {
    const r = await run(t, [
      'exec',
      id,
      '--cwd',
      '/tmp',
      '--env',
      'GREETING=hello=world',
      '--',
      'sh',
      '-c',
      'echo "$GREETING $(pwd)"',
    ]);
    expect(r.stdout).toMatch(/^hello=world \/.*\/tmp\n$/); // the process backend confines /tmp below its root
    const stdin = await run(t, ['exec', id, '--stdin', '--', 'cat'], { stdin: 'from stdin\n' });
    expect(stdin.stdout).toBe('from stdin\n');
  });

  it('gives JSON with the command result and still exits with its code', async () => {
    const r = await run(t, ['--json', 'exec', id, '--', 'sh', '-c', 'echo x; exit 3']);
    expect(r.code).toBe(3);
    expect(r.json).toMatchObject({
      ok: true,
      data: { status: 'completed', exitCode: 3, stdout: 'x\n', timedOut: false },
    });
    expect(r.json.data.logRef).toBeTruthy();
  });

  it('maps a timeout to exit code 5', async () => {
    const r = await run(t, ['--json', 'exec', id, '--timeout', '1s', '--', 'sleep', '10']);
    expect(r.code).toBe(5);
    expect(r.json).toMatchObject({ ok: false, code: 'timeout' });
    expect(r.json.details.durationMs).toBeLessThan(5000);
    const human = await run(t, ['exec', id, '--timeout', '1s', '--', 'sleep', '10']);
    expect(human.code).toBe(5);
    expect(human.stderr).toContain('timeout');
  });
});

describe('files', () => {
  it('copies files and directories both ways', async () => {
    const up = join(t.root, 'upload.txt');
    writeFileSync(up, 'payload\n');
    const r = await run(t, ['cp', up, `${id}:/workspace/upload.txt`]);
    expect(r.code, r.stderr).toBe(0);
    expect((await run(t, ['exec', id, '--', 'cat', 'upload.txt'])).stdout).toBe('payload\n');

    const down = join(t.root, 'down.txt');
    const r2 = await run(t, ['cp', `${id}:/workspace/hello.txt`, down]);
    expect(r2.code, r2.stderr).toBe(0);
    expect(readFileSync(down, 'utf8')).toBe('hello\n');

    // into an existing directory / trailing slash keeps the file name
    const dir = join(t.root, 'outdir');
    mkdirSync(dir);
    await run(t, ['cp', `${id}:/workspace/hello.txt`, dir]);
    expect(readFileSync(join(dir, 'hello.txt'), 'utf8')).toBe('hello\n');
    await run(t, ['cp', up, `${id}:/workspace/`]);
    expect((await run(t, ['exec', id, '--', 'ls'])).stdout).toContain('upload.txt');

    // directories
    const tree = join(t.root, 'tree');
    mkdirSync(join(tree, 'sub'), { recursive: true });
    writeFileSync(join(tree, 'sub', 'f.txt'), 'deep\n');
    const d1 = await run(t, ['cp', tree, `${id}:/workspace/tree`]);
    expect(d1.code, d1.stderr).toBe(0);
    expect((await run(t, ['exec', id, '--', 'cat', 'tree/sub/f.txt'])).stdout).toBe('deep\n');
    const back = join(t.root, 'tree-back');
    const d2 = await run(t, ['cp', `${id}:/workspace/tree`, back]);
    expect(d2.code, d2.stderr).toBe(0);
    expect(readFileSync(join(back, 'sub', 'f.txt'), 'utf8')).toBe('deep\n');
    expect(existsSync(join(back, 'tree'))).toBe(false);
  });

  it('validates cp arguments', async () => {
    const both = await run(t, ['cp', `${id}:/a`, `${id}:/b`, '--json']);
    expect(both.code).toBe(2);
    const neither = await run(t, ['cp', '/etc/hostname', '/tmp/x', '--json']);
    expect(neither.code).toBe(2);
    const missing = await run(t, ['cp', join(t.root, 'nope'), `${id}:/workspace/x`, '--json']);
    expect(missing.code).toBe(2);
    expect(missing.json.code).toBe('not_found');
  });

  it('exports changes as diff and flags risky files', async () => {
    await run(t, [
      'exec',
      id,
      '--',
      'sh',
      '-c',
      'echo changed > hello.txt; mkdir -p .github/workflows; echo run > .github/workflows/ci.yml',
    ]);
    const r = await run(t, ['export', id, '--format', 'diff']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('+changed');
    expect(r.stderr).toContain('WARNING');
    expect(r.stderr).toContain('.github/workflows/ci.yml');
    const j = await run(t, ['--json', 'export', id]);
    expect(j.json.data.flagged.map((f: { path: string }) => f.path)).toContain(
      '.github/workflows/ci.yml',
    );
    const out = join(t.root, 'changes.diff');
    const f = await run(t, ['export', id, '--out', out]);
    expect(f.code).toBe(0);
    expect(readFileSync(out, 'utf8')).toContain('+changed');
    const dir = join(t.home, 'export-files');
    const files = await run(t, ['export', id, '--format', 'files', '--out', dir]);
    expect(files.code, files.stderr).toBe(0);
    expect(readFileSync(join(dir, 'hello.txt'), 'utf8')).toBe('changed\n');
    const noOut = await run(t, ['export', id, '--format', 'files', '--json']);
    expect(noOut.code).toBe(2);
    const badFormat = await run(t, ['export', id, '--format', 'zip', '--json']);
    expect(badFormat.code).toBe(2);
  });
});

describe('background processes, logs, snapshots, ttl', () => {
  it('starts, reads and stops a background process', async () => {
    const start = await run(t, [
      '--json',
      'process',
      'start',
      id,
      '--',
      'sh',
      '-c',
      'echo started; sleep 30',
    ]);
    expect(start.code, start.stderr).toBe(0);
    const pid = start.json.data.process.id;
    expect(pid).toMatch(/^p[0-9a-f]{8}$/);
    await new Promise((r) => setTimeout(r, 600));
    const logs = await run(t, ['process', 'logs', pid, '--tail', '5']);
    expect(logs.stdout).toContain('started');
    const ls = await run(t, ['process', 'ls', id]);
    expect(ls.stdout).toContain(pid);
    expect(ls.stdout).toContain('running');
    const stop = await run(t, ['process', 'stop', pid, '--json']);
    expect(stop.code).toBe(0);
    expect(['killed', 'exited']).toContain(stop.json.data.status);
    const ghost = await run(t, ['process', 'logs', 'pdeadbeef', '--json']);
    expect(ghost.code).toBe(2);
  });

  it('snapshots and restores (backends that support it)', async () => {
    await run(t, ['exec', id, '--', 'sh', '-c', 'echo v1 > state.txt']);
    const snap = await run(t, ['snapshot', id, 'before', '--json']);
    expect(snap.code, snap.stderr).toBe(0);
    const snapshotId = snap.json.data.snapshotId as string;
    expect(snapshotId).toContain('before');
    await run(t, ['exec', id, '--', 'sh', '-c', 'echo v2 > state.txt']);
    const restore = await run(t, ['restore', id, snapshotId, '--json']);
    expect(restore.code, restore.stderr).toBe(0);
    expect((await run(t, ['exec', id, '--', 'cat', 'state.txt'])).stdout).toBe('v1\n');
    const bad = await run(t, ['snapshot', id, 'not a valid name!', '--json']);
    expect(bad.code).toBe(2);
    const ghost = await run(t, ['restore', id, 'abox-snap/nothing:here', '--json']);
    expect(ghost.code).not.toBe(0);
    expect(ghost.json.ok).toBe(false);
  });

  it('reads sandbox logs where the backend provides them', async () => {
    const logs = await run(t, ['logs', id, '--json']);
    if (logs.code === 0) expect(logs.json.data).toHaveProperty('logs');
    else expect(logs.json.code).toBe('unsupported');
  });

  it('extends the lifetime', async () => {
    const before = (await run(t, ['inspect', id, '--json'])).json.data.expiresAt;
    const r = await run(t, ['extend', id, '30m', '--json']);
    expect(r.code, r.stderr).toBe(0);
    const after = (await run(t, ['inspect', id, '--json'])).json.data.expiresAt;
    expect(Math.abs(after - before - 30 * 60_000)).toBeLessThan(2000);
    const bad = await run(t, ['extend', id, 'forever', '--json']);
    expect(bad.code).toBe(2);
  });
});

describe('stop, start and remove', () => {
  it('stops, starts and removes several sandboxes with --force for running ones', async () => {
    const a = (await run(t, ['create', 'host-shell', '--workspace', '.', '--yes', '--json'])).json
      .data.sandbox.id as string;
    const b = (await run(t, ['create', 'host-shell', '--workspace', '.', '--yes', '--json'])).json
      .data.sandbox.id as string;
    const stop = await run(t, ['stop', a, '--json']);
    expect(stop.code).toBe(0);
    expect(stop.json.data.results[0].sandbox.state).toBe('stopped');
    const start = await run(t, ['start', a]);
    expect(start.stdout).toContain(`started ${a}`);

    const refuse = await run(t, ['rm', a, b, '--json']);
    expect(refuse.code).toBe(2);
    expect(refuse.json.code).toBe('conflict');
    expect(refuse.json.details.errors).toHaveLength(2);
    expect((await run(t, ['ls', '--state', 'running', '-q'])).stdout).toContain(a);

    const rm = await run(t, ['rm', '--force', a, b, '--json']);
    expect(rm.code, rm.stderr).toBe(0);
    expect(rm.json.data.results).toEqual([
      { id: a, removed: true },
      { id: b, removed: true },
    ]);
    const again = await run(t, ['rm', a, '--json']);
    expect(again.code).toBe(0);
    expect(again.json.data.results[0].removed).toBe(false);
    const gone = await run(t, ['ls', '--json']);
    expect(gone.json.data.sandboxes.find((x: { id: string }) => x.id === a)).toBeUndefined();
    const all = await run(t, ['ls', '--all', '--json']);
    expect(all.json.data.sandboxes.find((x: { id: string }) => x.id === a)?.state).toBe('removed');
  });
});

describe('shell', () => {
  it('needs a terminal', async () => {
    const r = await run(t, ['shell', id, '--json']);
    expect(r.code).toBe(2);
    expect(r.json.hint).toContain('abox exec');
  });
});

describe.runIf(spawnSync('git', ['--version']).status === 0)('git workspaces', () => {
  const git = (cwd: string, ...args: string[]): string =>
    spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.org', ...args], {
      cwd,
      encoding: 'utf8',
    }).stdout;

  it('clones a repository and exports the result as a branch and a patch', async () => {
    const repo = join(t.home, 'repo');
    mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');

    const c = await run(t, [
      'create',
      'host-shell',
      '--workspace',
      repo,
      '--mode',
      'clone',
      '--ref',
      'main',
      '--yes',
      '--json',
    ]);
    expect(c.code, c.stderr).toBe(0);
    const gid = c.json.data.sandbox.id as string;
    await run(t, ['exec', gid, '--', 'sh', '-c', 'echo two >> a.txt; echo new > b.txt']);

    const patch = await run(t, ['export', gid, '--format', 'patch']);
    expect(patch.code, patch.stderr).toBe(0);
    expect(patch.stdout).toContain('+two');
    expect(patch.stdout).toContain('Subject:');

    const branch = await run(t, [
      'export',
      gid,
      '--format',
      'branch',
      '--branch',
      'abox/cli-test',
      '--json',
    ]);
    expect(branch.code, branch.stderr).toBe(0);
    expect(branch.json.data.branch).toBe('abox/cli-test');
    expect(git(repo, 'branch', '--list', 'abox/cli-test')).toContain('abox/cli-test');
    // the original working tree is untouched
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('one\n');
    const again = await run(t, [
      'export',
      gid,
      '--format',
      'branch',
      '--branch',
      'abox/cli-test',
      '--json',
    ]);
    expect(again.code).not.toBe(0);
    const forced = await run(t, [
      'export',
      gid,
      '--format',
      'branch',
      '--branch',
      'abox/cli-test',
      '--force',
      '--json',
    ]);
    expect(forced.code, forced.stderr).toBe(0);
    const human = await run(t, [
      'export',
      gid,
      '--format',
      'branch',
      '--branch',
      'abox/cli-test-2',
    ]);
    expect(human.stdout).toContain('git merge abox/cli-test-2');
    await run(t, ['rm', '--force', gid]);
  });
});
