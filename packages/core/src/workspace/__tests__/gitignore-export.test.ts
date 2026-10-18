import { cp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exportWorkspace } from '../export.js';
import { prepareWorkspace } from '../prepare.js';
import type { WorkspaceRecord } from '../types.js';
import { FakeProvider, git, makeRepo, tmp, useTempCleanup, write } from './helpers.js';

useTempCleanup();

const common = { access: 'rw' as const, remote: false, sandboxPath: '/workspace' };

interface Ctx {
  record: WorkspaceRecord;
  tree: string;
  run(): ReturnType<typeof exportWorkspace>;
}

/** A project with ignore rules, copied; `tree` is the sandbox's view that the test then changes. */
async function setup(opts: { gitignore?: boolean; tracked?: string[] } = {}): Promise<Ctx> {
  const root = await tmp();
  const src = await makeRepo(join(root, 'project'));
  await write(join(src, '.gitignore'), 'dist/\ntarget/\n.env\n*.log\n');
  await write(join(src, 'pkg/.gitignore'), 'generated.txt\n');
  git(src, 'add', '-A');
  if (opts.tracked) {
    for (const f of opts.tracked) await write(join(src, f), 'tracked\n');
    git(src, 'add', '-f', ...opts.tracked);
  }
  git(src, 'commit', '-q', '-m', 'ignore rules');
  await write(join(src, '.git/info/exclude'), 'scratch-notes.md\n');
  const sandboxDir = join(root, 'sb');
  const r = await prepareWorkspace({
    ...common,
    mode: 'copy',
    source: src,
    sandboxDir,
    ...(opts.gitignore !== undefined ? { gitignore: opts.gitignore } : {}),
  });
  const tree = join(root, 'sandbox-tree');
  await cp(join(sandboxDir, 'staging'), tree, { recursive: true, verbatimSymlinks: true });
  return {
    record: r.record,
    tree,
    run: () =>
      exportWorkspace({
        record: r.record,
        provider: new FakeProvider(tree),
        sandboxId: 'local/ab12cd34',
        format: 'diff',
        tmpDir: join(root, 'export-tmp'),
      }),
  };
}

/** What a build and a few tools leave behind in the sandbox. */
async function litter(tree: string): Promise<void> {
  await write(join(tree, 'target/debug/app'), 'binary');
  await write(join(tree, 'dist/bundle.js'), 'bundle');
  await write(join(tree, '.env'), 'TOKEN=1');
  await write(join(tree, 'build.log'), 'log');
  await write(join(tree, 'src/trace.log'), 'log');
  await write(join(tree, 'pkg/generated.txt'), 'generated');
  await write(join(tree, 'scratch-notes.md'), 'notes');
}

describe('export of a copy workspace with .gitignore', () => {
  it('does not list what the rules ignore, but real changes', async () => {
    const ctx = await setup();
    await litter(ctx.tree);
    await write(join(ctx.tree, 'src/a.txt'), 'alpha\nchanged\n');
    await write(join(ctx.tree, 'src/added.ts'), 'export {};\n');
    const r = await ctx.run();
    expect(r.files.map((f) => `${f.status}:${f.path}`).sort()).toEqual([
      'added:src/added.ts',
      'modified:src/a.txt',
    ]);
    expect(r.content).not.toMatch(/dist|bundle|TOKEN|target|generated|notes/);
    expect(r.stats.ignored).toBe(7);
    expect(r.stats.ignoredPaths).toEqual(
      expect.arrayContaining(['target/', 'dist/', '.env', 'build.log', 'src/trace.log']),
    );
    expect(r.stats.excluded).toBe(0);
    expect(r.warnings.join('\n')).toMatch(/7 path\(s\).*ignored by the workspace's \.gitignore/);
  });

  it('shows ignored paths when the copy was made without .gitignore', async () => {
    const ctx = await setup({ gitignore: false });
    await write(join(ctx.tree, 'dist/new.js'), 'n');
    await write(join(ctx.tree, 'src/b.txt'), 'bravo\nmore\n');
    const r = await ctx.run();
    expect(r.files.map((f) => f.path).sort()).toContain('dist/new.js');
    expect(r.stats.ignored).toBeUndefined();
    expect(ctx.record.gitignore?.enabled).toBe(false);
  });

  it('keeps comparing paths the baseline has, even when a rule matches them', async () => {
    const ctx = await setup({ tracked: ['dist/kept.js', 'dist/gone.js'] });
    await write(join(ctx.tree, 'dist/kept.js'), 'edited\n');
    await rm(join(ctx.tree, 'dist/gone.js'));
    await write(join(ctx.tree, 'dist/new.js'), 'ignored, new');
    const r = await ctx.run();
    expect(r.files.map((f) => `${f.status}:${f.path}`).sort()).toEqual([
      'deleted:dist/gone.js',
      'modified:dist/kept.js',
    ]);
    expect(r.stats.ignored).toBe(1);
  });

  it('uses the rules of the baseline: the sandbox cannot hide a change by editing .gitignore', async () => {
    const ctx = await setup();
    await write(join(ctx.tree, '.gitignore'), 'dist/\n*.ts\n*.txt\n');
    await write(join(ctx.tree, 'src/hidden.ts'), 'export const x = 1;\n');
    await write(join(ctx.tree, 'src/a.txt'), 'rewritten\n');
    // a .gitignore the sandbox adds in a new directory is not trusted either
    await write(join(ctx.tree, 'newdir/.gitignore'), 'secret.txt\n');
    await write(join(ctx.tree, 'newdir/secret.txt'), 's');
    const r = await ctx.run();
    expect(r.files.map((f) => f.path).sort()).toEqual([
      '.gitignore',
      'newdir/.gitignore',
      'newdir/secret.txt',
      'src/a.txt',
      'src/hidden.ts',
    ]);
    expect(r.stats.ignored).toBe(0);
  });

  it('leaves a baseline without gitignore bookkeeping alone (older records)', async () => {
    const ctx = await setup();
    const old: WorkspaceRecord = { ...ctx.record };
    delete old.gitignore;
    await write(join(ctx.tree, 'dist/x.js'), 'x');
    const r = await exportWorkspace({
      record: old,
      provider: new FakeProvider(ctx.tree),
      sandboxId: 'local/ab12cd34',
      format: 'diff',
      tmpDir: join(await tmp(), 'export-tmp'),
    });
    expect(r.files.map((f) => f.path)).toEqual(['dist/x.js']);
  });

  it('records the .git/info/exclude of the source with the workspace', async () => {
    const ctx = await setup();
    expect(ctx.record.gitignore).toMatchObject({
      enabled: true,
      infoExclude: 'scratch-notes.md\n',
    });
  });
});
