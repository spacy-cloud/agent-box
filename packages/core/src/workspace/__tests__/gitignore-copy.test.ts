import { readdir, readFile, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileExcludes } from '../glob.js';
import { GitignoreSession } from '../gitignore.js';
import { prepareWorkspace } from '../prepare.js';
import { scanTree } from '../scan.js';
import { git, makeRepo, tmp, useTempCleanup, write } from './helpers.js';

useTempCleanup();

const common = { access: 'rw' as const, remote: false, sandboxPath: '/workspace' };

/** A project the way a node project looks after `npm install` and a build. */
async function project(): Promise<{ root: string; src: string }> {
  const root = await tmp();
  const src = await makeRepo(join(root, 'project'));
  await write(
    join(src, '.gitignore'),
    ['node_modules/', 'dist', '.env', '*.log', '!important.log', '/secret', ''].join('\n'),
  );
  await write(join(src, 'src/gen/.gitignore'), '*.generated\n');
  git(src, 'add', '-A');
  git(src, 'commit', '-q', '-m', 'add ignore files');
  await write(join(src, 'node_modules/pkg/index.js'), 'x'.repeat(5000));
  await write(join(src, 'node_modules/pkg/lib/more.js'), 'y'.repeat(3000));
  await write(join(src, 'dist/bundle.js'), 'z'.repeat(2000));
  await write(join(src, '.env'), 'TOKEN=abc\n');
  await write(join(src, 'debug.log'), 'log');
  await write(join(src, 'important.log'), 'kept');
  await write(join(src, 'secret'), 's');
  await write(join(src, 'sub/secret'), 'not anchored here');
  await write(join(src, 'src/gen/x.generated'), 'g');
  await write(join(src, 'src/new.ts'), 'export {};\n');
  return { root, src };
}

async function filesOf(dir: string, base = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(join(dir, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (rel === '.git') continue;
    if (e.isDirectory()) out.push(...(await filesOf(dir, rel)));
    else out.push(rel);
  }
  return out.sort();
}

describe('copy workspaces and .gitignore', () => {
  it('leaves out what the ignore files ignore and keeps .git', async () => {
    const { root, src } = await project();
    const sandboxDir = join(root, 'sb');
    const r = await prepareWorkspace({ ...common, mode: 'copy', source: src, sandboxDir });
    const staging = join(sandboxDir, 'staging');
    expect(await filesOf(staging)).toEqual([
      '.gitignore',
      'README.md',
      'important.log',
      'package.json',
      'src/a.txt',
      'src/b.txt',
      'src/gen/.gitignore',
      'src/new.ts',
      'sub/secret',
    ]);
    // .git is copied as before (and never evaluated as content)
    expect(existsSync(join(staging, '.git/HEAD'))).toBe(true);
    expect(r.warnings.join('\n')).toMatch(/\.git was copied/);
    expect(r.record.gitignore).toMatchObject({ enabled: true, ignored: 6 });
    // the baseline is exactly what was copied
    expect(r.record.manifest?.files).toBe((await filesOf(staging)).length);
    expect(r.record.manifest?.bytes).toBeGreaterThan(0);
  });

  it('gitignore: false copies everything, as before', async () => {
    const { root, src } = await project();
    const sandboxDir = join(root, 'sb');
    const r = await prepareWorkspace({
      ...common,
      mode: 'copy',
      source: src,
      sandboxDir,
      gitignore: false,
    });
    const files = await filesOf(join(sandboxDir, 'staging'));
    expect(files).toEqual(expect.arrayContaining(['node_modules/pkg/index.js', '.env', 'secret']));
    expect(r.record.gitignore).toEqual({ enabled: false, ignored: 0 });
  });

  it('the pre-scan reports what the copy moves, to the byte', async () => {
    const { root, src } = await project();
    for (const gitignore of [true, false]) {
      const scan = await scanTree(src, {
        exclude: compileExcludes(['*.generated']),
        gitMode: 'visit',
        ...(gitignore ? { gitignore: new GitignoreSession() } : {}),
      });
      const sandboxDir = join(root, `sb-${gitignore}`);
      const r = await prepareWorkspace({
        ...common,
        mode: 'copy',
        source: src,
        sandboxDir,
        exclude: ['*.generated'],
        gitignore,
        scan,
      });
      const m = r.record.manifest;
      // the manifest does not list `.git`, the scan does
      const gitScan = await scanTree(join(src, '.git'));
      expect(m?.files).toBe(scan.files - gitScan.files);
      expect(m?.bytes).toBe(scan.bytes - gitScan.bytes);
      if (gitignore) expect(r.record.gitignore?.ignored).toBe(scan.ignored);
    }
  });

  it('measures what is ignored, when asked', async () => {
    const { src } = await project();
    const plain = await scanTree(src, { gitignore: new GitignoreSession() });
    expect(plain.ignoredTotals).toBeUndefined();
    const scan = await scanTree(src, { gitignore: new GitignoreSession(), measureIgnored: true });
    expect(scan.ignored).toBe(6);
    expect(scan.ignoredTotals).toEqual({
      files: 2 + 1 + 1 + 1 + 1 + 1,
      bytes: 5000 + 3000 + 2000 + 10 + 3 + 1 + 1,
      partial: false,
    });
    // the totals of the workspace are not changed by measuring
    expect(scan.bytes).toBe(plain.bytes);
    expect(scan.entries).toBe(plain.entries);
    // and without the rules nothing is ignored
    const all = await scanTree(src);
    expect(all.ignored).toBe(0);
    expect(all.bytes).toBe(scan.bytes + 5000 + 3000 + 2000 + 10 + 3 + 1 + 1);
  });

  it('keeps files git tracks even when a pattern matches them', async () => {
    const { root, src } = await project();
    git(src, 'add', '-f', 'dist/bundle.js', '.env');
    git(src, 'commit', '-q', '-m', 'force-added');
    const sandboxDir = join(root, 'sb');
    const r = await prepareWorkspace({ ...common, mode: 'copy', source: src, sandboxDir });
    const files = await filesOf(join(sandboxDir, 'staging'));
    expect(files).toContain('dist/bundle.js');
    expect(files).toContain('.env');
    expect(files).not.toContain('node_modules/pkg/index.js');
    // nothing tracked is missing: the copy equals HEAD plus the untracked files that are not ignored
    expect(r.warnings.join('\n')).toMatch(/differ from the source HEAD/); // src/new.ts is untracked
    const tracked = git(src, 'ls-files', '-z').split('\0').filter(Boolean);
    for (const f of tracked) expect(files).toContain(f);
  });

  it('explicit excludes apply on top, also to .git', async () => {
    const { root, src } = await project();
    const sandboxDir = join(root, 'sb');
    await prepareWorkspace({
      ...common,
      mode: 'copy',
      source: src,
      sandboxDir,
      exclude: ['.git', 'src/'],
    });
    const staging = join(sandboxDir, 'staging');
    expect(existsSync(join(staging, '.git'))).toBe(false);
    expect(existsSync(join(staging, 'src'))).toBe(false);
    expect(existsSync(join(staging, 'important.log'))).toBe(true);
    expect(existsSync(join(staging, '.env'))).toBe(false);
  });

  it('records .git/info/exclude and applies it', async () => {
    const { root, src } = await project();
    await write(join(src, '.git/info/exclude'), 'scratch-notes.md\n');
    await write(join(src, 'scratch-notes.md'), 'private');
    const sandboxDir = join(root, 'sb');
    const r = await prepareWorkspace({ ...common, mode: 'sync', source: src, sandboxDir });
    expect(existsSync(join(sandboxDir, 'staging/scratch-notes.md'))).toBe(false);
    expect(r.record.gitignore?.infoExclude).toBe('scratch-notes.md\n');
  });

  it('works without a repository and for a source whose .git is a file', async () => {
    const root = await tmp();
    const src = join(root, 'plain');
    await write(join(src, '.gitignore'), 'build/\n');
    await write(join(src, 'build/out'), 'o');
    await write(join(src, 'main.c'), 'm');
    const a = await prepareWorkspace({
      ...common,
      mode: 'copy',
      source: src,
      sandboxDir: join(root, 'a'),
    });
    expect(await filesOf(join(root, 'a/staging'))).toEqual(['.gitignore', 'main.c']);
    expect(a.record.gitignore?.ignored).toBe(1);

    const repo = await makeRepo(join(root, 'repo'));
    git(repo, 'worktree', 'add', '-q', join(root, 'wt'));
    await write(join(root, 'wt/.gitignore'), 'tmp/\n');
    await write(join(root, 'wt/tmp/x'), 'x');
    await prepareWorkspace({
      ...common,
      mode: 'copy',
      source: join(root, 'wt'),
      sandboxDir: join(root, 'b'),
    });
    expect(existsSync(join(root, 'b/staging/tmp'))).toBe(false);
    expect(existsSync(join(root, 'b/staging/README.md'))).toBe(true);
  });

  it('does not apply a .gitignore that is a link and warns about it', async () => {
    const root = await tmp();
    const src = join(root, 'proj');
    await write(join(root, 'elsewhere'), '*\n');
    await write(join(src, 'a.txt'), 'a');
    await symlink(join(root, 'elsewhere'), join(src, '.gitignore'));
    const r = await prepareWorkspace({
      ...common,
      mode: 'copy',
      source: src,
      sandboxDir: join(root, 'sb'),
    });
    expect(existsSync(join(root, 'sb/staging/a.txt'))).toBe(true);
    expect(r.warnings).toContain('.gitignore: .gitignore is a symbolic link and was not applied');
  });

  it('other modes are untouched by the option', async () => {
    const { root, src } = await project();
    const r = await prepareWorkspace({
      ...common,
      mode: 'clone',
      source: src,
      sandboxDir: join(root, 'sb'),
      gitignore: false,
    });
    expect(r.record.gitignore).toBeUndefined();
    const text = await readFile(join(root, 'sb/staging/.gitignore'), 'utf8');
    expect(text).toContain('node_modules/');
  });
});
