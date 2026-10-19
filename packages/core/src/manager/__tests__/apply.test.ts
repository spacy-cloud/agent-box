import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Abox } from '../abox.js';
import type { ApplyChangesResult, ApplyConfirmationRequired, ChangesView } from '../types.js';
import { A, B, HUMAN, HUMAN_YES, created, makeEnv, openAbox } from './harness.js';
import type { TestEnv } from './harness.js';

let env: TestEnv;
let abox: Abox;

const GIT_ENV = {
  PATH: process.env['PATH'] ?? '',
  HOME: '/nonexistent',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 't@example.org',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 't@example.org',
};
function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: env.project, env: GIT_ENV, encoding: 'utf8' });
}

const numbered = (n: number, mark: Record<number, string> = {}): string =>
  Array.from({ length: n }, (_, i) => mark[i + 1] ?? `line ${i + 1}`).join('\n') + '\n';

async function setup(opts: { git?: boolean } = {}): Promise<void> {
  env = makeEnv();
  writeFileSync(join(env.project, 'long.txt'), numbered(60));
  if (opts.git !== false) {
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('commit', '-q', '-m', 'initial');
  }
  abox = await openAbox(env);
}
afterEach(() => {
  abox.close();
  env.cleanup();
});

async function newShell(): Promise<string> {
  return created(
    await abox.createSandbox(HUMAN_YES, {
      template: 'host-shell',
      workspace: { mode: 'copy', path: env.project },
    } as never),
  ).sandbox.id;
}

async function change(id: string, files: Record<string, string>): Promise<void> {
  for (const [p, c] of Object.entries(files)) await abox.writeFile(HUMAN, id, `/workspace/${p}`, c);
}

const read = (p: string): string => readFileSync(join(env.project, p), 'utf8');

async function review(id: string): Promise<ChangesView> {
  return abox.reviewChanges(HUMAN, id);
}

function applied(r: ApplyChangesResult | ApplyConfirmationRequired): ApplyChangesResult {
  if (r.status === 'confirmation_required') throw new Error('confirmation required');
  return r;
}

describe('review and apply of sandbox changes (git project)', () => {
  beforeEach(() => setup());

  it('review lists files, flags and the target; flagged files need confirmation', async () => {
    const id = await newShell();
    await change(id, {
      'long.txt': numbered(60, { 3: 'CHANGED 3', 57: 'CHANGED 57' }),
      'src/new.txt': 'new\n',
      'package.json': '{"name":"x","scripts":{"postinstall":"echo"}}\n',
      '.husky/pre-commit': 'echo hi\n',
    });
    const v = await review(id);
    expect(v.target).toMatchObject({ kind: 'git', path: env.project, dirtyPaths: [] });
    const by = Object.fromEntries(v.files.map((f) => [f.path, f]));
    expect(by['long.txt']).toMatchObject({ hunkSelectable: true, needsConfirmation: false });
    expect(by['long.txt']!.hunks).toHaveLength(2);
    expect(by['package.json']!.badges).toEqual(expect.arrayContaining(['dependency', 'flagged']));
    expect(by['.husky/pre-commit']!.needsConfirmation).toBe(true);
    expect(by['src/new.txt']!.needsConfirmation).toBe(false);
    expect(v.digest).toMatch(/^[0-9a-f]{64}$/);
    // nothing was written to the project
    expect(existsSync(join(env.project, 'src/new.txt'))).toBe(false);
    const audit = await abox.queryAudit(HUMAN, { action: 'sandbox.changes', limit: 5 });
    expect(audit.length).toBe(1);
    expect(JSON.stringify(audit[0]!.details)).not.toContain('CHANGED');
  });

  it('applies a hunk subset after the plan was confirmed; audited; nothing before the confirmation', async () => {
    const id = await newShell();
    await change(id, {
      'long.txt': numbered(60, { 3: 'CHANGED 3', 57: 'CHANGED 57' }),
      'src/new.txt': 'new\n',
    });
    const v = await review(id);
    const params = {
      digest: v.digest,
      selection: [{ path: 'long.txt', hunks: [1] }, { path: 'src/new.txt' }],
    };

    const dry = await abox.applyChanges(HUMAN, id, { ...params, dryRun: true });
    expect(dry).toMatchObject({ status: 'dry_run' });
    expect(existsSync(join(env.project, 'src/new.txt'))).toBe(false);

    const first = await abox.applyChanges(HUMAN, id, params);
    expect(first.status).toBe('confirmation_required');
    const plan = (first as ApplyConfirmationRequired).plan;
    expect(plan).toMatchObject({ target: env.project, targetKind: 'git', hunks: 2 });
    expect(plan.files.map((f) => f.path)).toEqual(['long.txt', 'src/new.txt']);
    expect(existsSync(join(env.project, 'src/new.txt'))).toBe(false);
    expect(read('long.txt')).toBe(numbered(60));

    const done = applied(await abox.applyChanges(HUMAN_YES, id, params));
    expect(done.status).toBe('applied');
    expect(read('src/new.txt')).toBe('new\n');
    expect(read('long.txt')).toBe(numbered(60, { 57: 'CHANGED 57' }));
    expect(git('status', '--porcelain')).toBe(' M long.txt\n?? src/new.txt\n');
    expect(git('diff', '--cached', '--name-only')).toBe('');

    const log = await abox.queryAudit(HUMAN, { action: 'sandbox.apply', order: 'asc', limit: 10 });
    expect(log.map((e) => (e.details as { dryRun?: boolean }).dryRun)).toEqual([true, false]);
    const last = log[1]!.details as {
      files: Array<{ path: string; hunks: number }>;
      digest: string;
    };
    expect(last.digest).toBe(v.digest);
    expect(last.files).toEqual([
      expect.objectContaining({ path: 'long.txt', hunks: 1, totalHunks: 2 }),
      expect.objectContaining({ path: 'src/new.txt' }),
    ]);
    expect(JSON.stringify(last)).not.toContain('CHANGED');
  });

  it('refuses a changed sandbox state (digest) and writes nothing', async () => {
    const id = await newShell();
    await change(id, { 'src/new.txt': 'new\n' });
    const v = await review(id);
    await change(id, { 'src/new.txt': 'something the human did not review\n' });
    await expect(
      abox.applyChanges(HUMAN_YES, id, { digest: v.digest, selection: [{ path: 'src/new.txt' }] }),
    ).rejects.toMatchObject({ code: 'conflict', details: { stale: true } });
    expect(existsSync(join(env.project, 'src/new.txt'))).toBe(false);
    await expect(
      abox.changesPatch(HUMAN, id, { digest: v.digest, selection: [{ path: 'src/new.txt' }] }),
    ).rejects.toMatchObject({ code: 'conflict' });
    const denied = await abox.queryAudit(HUMAN, { action: 'sandbox.apply', decision: 'deny' });
    expect(denied).toHaveLength(1);
  });

  it('refuses a selection the renderer invented', async () => {
    const id = await newShell();
    await change(id, { 'src/new.txt': 'new\n' });
    const v = await review(id);
    for (const selection of [
      [{ path: 'src/other.txt' }],
      [{ path: '../outside.txt' }],
      [{ path: '/etc/passwd' }],
      [{ path: '.git/config' }],
      [{ path: 'src/new.txt', hunks: [3] }],
    ]) {
      await expect(
        abox.applyChanges(HUMAN_YES, id, { digest: v.digest, selection }),
      ).rejects.toMatchObject({ code: 'invalid_input' });
    }
    await expect(
      abox.applyChanges(HUMAN_YES, id, {
        digest: v.digest,
        selection: [{ path: 'src/new.txt' }],
        patch: 'diff --git a/x b/x',
      } as never),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      abox.applyChanges(HUMAN_YES, id, { digest: 'abc', selection: [{ path: 'src/new.txt' }] }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('flagged files are only applied when each one was acknowledged', async () => {
    const id = await newShell();
    await change(id, { 'run.sh': '#!/bin/sh\necho\n', 'src/new.txt': 'new\n' });
    const v = await review(id);
    expect(v.files.find((f) => f.path === 'run.sh')!.needsConfirmation).toBe(true);
    const selection = [{ path: 'run.sh' }, { path: 'src/new.txt' }];
    await expect(
      abox.applyChanges(HUMAN_YES, id, { digest: v.digest, selection }),
    ).rejects.toMatchObject({ code: 'policy_denied' });
    await expect(
      abox.applyChanges(HUMAN_YES, id, {
        digest: v.digest,
        selection,
        acknowledgeFlagged: ['src/new.txt'],
      }),
    ).rejects.toMatchObject({ code: 'policy_denied' });
    expect(existsSync(join(env.project, 'run.sh'))).toBe(false);
    const r = applied(
      await abox.applyChanges(HUMAN_YES, id, {
        digest: v.digest,
        selection,
        acknowledgeFlagged: ['run.sh'],
      }),
    );
    expect(r.plan.flaggedPaths).toEqual(['run.sh']);
    expect(read('run.sh')).toBe('#!/bin/sh\necho\n');
  });

  it('refuses when an affected file has uncommitted changes in the project', async () => {
    const id = await newShell();
    await change(id, {
      'long.txt': numbered(60, { 3: 'CHANGED 3' }),
      'src/a.txt': 'sandbox\n',
      'src/new.txt': 'new\n',
    });
    writeFileSync(join(env.project, 'long.txt'), numbered(60, { 40: 'my local edit' }));
    writeFileSync(join(env.project, 'src/new.txt'), 'untracked local file\n');
    const v = await review(id);
    expect(v.target.dirtyPaths).toEqual(['long.txt', 'src/new.txt']);
    const e = await abox
      .applyChanges(HUMAN_YES, id, {
        digest: v.digest,
        selection: [{ path: 'long.txt' }, { path: 'src/a.txt' }],
      })
      .catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'conflict', details: { dirty: ['long.txt'] } });
    // an untracked file where an added file would go counts as well
    await expect(
      abox.applyChanges(HUMAN_YES, id, { digest: v.digest, selection: [{ path: 'src/new.txt' }] }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(read('long.txt')).toContain('my local edit');
    // files that are clean can still be applied on their own
    const ok = applied(
      await abox.applyChanges(HUMAN_YES, id, {
        digest: v.digest,
        selection: [{ path: 'src/a.txt' }],
      }),
    );
    expect(ok.status).toBe('applied');
    expect(read('src/a.txt')).toBe('sandbox\n');
  });

  it('refuses a target path that became a symbolic link after the review', async () => {
    const id = await newShell();
    await change(id, { 'src/new.txt': 'new\n' });
    const v = await review(id);
    const outside = join(env.root, 'outside');
    mkdirSync(outside);
    rmSync(join(env.project, 'src'), { recursive: true });
    symlinkSync(outside, join(env.project, 'src'));
    git('add', '-A'); // the project is clean again (the link replaced src/)
    git('commit', '-q', '-m', 'src is a link now');
    await expect(
      abox.applyChanges(HUMAN_YES, id, { digest: v.digest, selection: [{ path: 'src/new.txt' }] }),
    ).rejects.toMatchObject({ code: 'policy_denied' });
    expect(existsSync(join(outside, 'new.txt'))).toBe(false);
  });

  it('the patch of a selection is a plain git patch of exactly that selection', async () => {
    const id = await newShell();
    await change(id, {
      'long.txt': numbered(60, { 3: 'CHANGED 3', 57: 'CHANGED 57' }),
      'src/new.txt': 'new\n',
    });
    const v = await review(id);
    const r = await abox.changesPatch(HUMAN, id, {
      digest: v.digest,
      selection: [{ path: 'long.txt', hunks: [0] }],
    });
    const text = r.patch.toString('utf8');
    expect(text).toContain('+CHANGED 3');
    expect(text).not.toContain('CHANGED 57');
    expect(text).not.toContain('src/new.txt');
    writeFileSync(join(env.root, 'sel.patch'), r.patch);
    git('apply', '--check', join(env.root, 'sel.patch'));
    expect(read('long.txt')).toBe(numbered(60));
    const audit = await abox.queryAudit(HUMAN, { action: 'sandbox.changes_patch' });
    expect(audit).toHaveLength(1);
  });
});

describe('apply to a project that is not a git repository', () => {
  beforeEach(() => setup({ git: false }));

  it('needs the extra confirmation and says so in the plan', async () => {
    const id = await newShell();
    await change(id, { 'src/new.txt': 'new\n' });
    const v = await review(id);
    expect(v.target.kind).toBe('plain');
    const params = { digest: v.digest, selection: [{ path: 'src/new.txt' }] };
    await expect(abox.applyChanges(HUMAN_YES, id, params)).rejects.toMatchObject({
      code: 'policy_denied',
      details: { nonGit: true },
    });
    const ask = await abox.applyChanges(HUMAN, id, { ...params, allowNonGit: true });
    expect(ask.status).toBe('confirmation_required');
    expect((ask as ApplyConfirmationRequired).risks.join(' ')).toMatch(/not a git repository/);
    const done = applied(await abox.applyChanges(HUMAN_YES, id, { ...params, allowNonGit: true }));
    expect(done.plan.targetKind).toBe('plain');
    expect(read('src/new.txt')).toBe('new\n');
  });
});

describe('who can do this', () => {
  beforeEach(() => setup());

  it('agents cannot review, patch or apply, not even their own sandbox, and it is audited', async () => {
    const sb = await abox.createSandbox(HUMAN_YES, {
      template: 'host-shell',
      workspace: { mode: 'copy', path: env.project },
    } as never);
    const id = created(sb).sandbox.id;
    await change(id, { 'src/new.txt': 'new\n' });
    const v = await review(id);
    const sel = { digest: v.digest, selection: [{ path: 'src/new.txt' }] };
    for (const who of [A, B, { contextId: 'agent-a', humanConfirmed: true }]) {
      await expect(abox.reviewChanges(who, id)).rejects.toMatchObject({ code: 'policy_denied' });
      await expect(abox.changesPatch(who, id, sel)).rejects.toMatchObject({
        code: 'policy_denied',
      });
      await expect(abox.applyChanges(who, id, sel)).rejects.toMatchObject({
        code: 'policy_denied',
      });
      await expect(abox.applyChanges(who, id, { ...sel, dryRun: true })).rejects.toMatchObject({
        code: 'policy_denied',
      });
    }
    expect(existsSync(join(env.project, 'src/new.txt'))).toBe(false);
    const denied = await abox.queryAudit(HUMAN, { decision: 'deny', limit: 50 });
    expect(denied.map((d) => d.action)).toEqual(
      expect.arrayContaining(['sandbox.changes_denied', 'sandbox.apply_denied']),
    );
  });

  it('a workspace without a source project has nothing to apply to', async () => {
    const id = created(
      await abox.createSandbox(HUMAN_YES, {
        template: 'host-shell',
        workspace: { mode: 'empty' },
      } as never),
    ).sandbox.id;
    await abox.writeFile(HUMAN, id, '/workspace/x.txt', 'x\n');
    const v = await review(id);
    expect(v.target).toMatchObject({ kind: 'unavailable', reason: 'no_source' });
    await expect(
      abox.applyChanges(HUMAN_YES, id, { digest: v.digest, selection: [{ path: 'x.txt' }] }),
    ).rejects.toMatchObject({ code: 'unsupported' });
  });
});
