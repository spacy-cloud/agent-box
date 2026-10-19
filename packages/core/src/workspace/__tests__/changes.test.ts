import { chmod, cp, mkdir, readFile, rename, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyPatchToTarget,
  checkPatch,
  checkTargetPath,
  dirtyPaths,
  openTarget,
} from '../apply.js';
import {
  buildPatch,
  buildReviewModel,
  diffDigest,
  expectedPatchNames,
  isDependencyFile,
  type ReviewModel,
} from '../changes.js';
import { exportWorkspace } from '../export.js';
import { prepareWorkspace } from '../prepare.js';
import type { ExportResult } from '../types.js';
import { FakeProvider, git, makeRepo, porcelain, tmp, useTempCleanup, write } from './helpers.js';

useTempCleanup();

const SB = 'local/ab12cd34';

interface Ctx {
  root: string;
  src: string;
  tree: string;
  review(): Promise<{ model: ReviewModel; result: ExportResult }>;
}

async function setup(prepare: (dir: string) => Promise<void> = async () => {}): Promise<Ctx> {
  const root = await tmp();
  const src = await makeRepo(join(root, 'project'));
  await prepare(src);
  const sandboxDir = join(root, 'sandboxes', 'ab12cd34');
  const r = await prepareWorkspace({
    mode: 'copy',
    source: src,
    sandboxDir,
    sandboxPath: '/workspace',
    access: 'rw',
    remote: false,
  });
  const tree = join(root, 'sandbox-tree');
  await cp(join(sandboxDir, 'staging'), tree, { recursive: true, verbatimSymlinks: true });
  const provider = new FakeProvider(tree);
  return {
    root,
    src,
    tree,
    async review() {
      const result = await exportWorkspace({
        record: r.record,
        provider,
        sandboxId: SB,
        format: 'diff',
        keepRaw: true,
        tmpDir: join(root, 'export-tmp'),
      });
      return { model: buildReviewModel(result), result };
    },
  };
}

const numbered = (n: number, mark: Record<number, string> = {}): string =>
  Array.from({ length: n }, (_, i) => mark[i + 1] ?? `line ${i + 1}`).join('\n') + '\n';

describe('review model', () => {
  it('lists files and hunks, flags, and a digest that follows the diff', async () => {
    const ctx = await setup(async (src) => {
      await write(join(src, 'long.txt'), numbered(60));
      git(src, 'add', '-A');
      git(src, 'commit', '-q', '-m', 'long');
    });
    const t = ctx.tree;
    await write(join(t, 'long.txt'), numbered(60, { 3: 'CHANGED 3', 55: 'CHANGED 55' }));
    await write(join(t, 'src/new.txt'), 'new\n');
    await write(join(t, 'tool.sh'), '#!/bin/sh\n', 0o755);
    await chmod(join(t, 'tool.sh'), 0o755);
    await write(
      join(t, 'package.json'),
      '{"name":"demo","scripts":{"test":"x"},"dependencies":{"a":"1"}}\n',
    );
    await write(join(t, 'bin.dat'), Buffer.from([0, 1, 2, 255]));
    await symlink('src/a.txt', join(t, 'ok-link'));
    await symlink('/etc/passwd', join(t, 'evil-link'));
    await rm(join(t, 'src/b.txt'));

    const { model, result } = await ctx.review();
    expect(model.digest).toBe(diffDigest(result.contentBytes as Buffer));
    const by = Object.fromEntries(model.files.map((f) => [f.path, f]));

    const long = by['long.txt']!;
    expect(long.status).toBe('modified');
    expect(long.hunks).toHaveLength(2);
    expect(long.hunkSelectable).toBe(true);
    expect(long.hunks[0]!.header).toMatch(/^@@ -1,\d+ \+1,\d+ @@/);
    expect(long.hunks[0]!.lines).toContain('+CHANGED 3');
    expect(long.hunks[1]!.lines).toContain('-line 55');
    expect(long.badges).toEqual([]);
    expect(long.needsConfirmation).toBe(false);

    expect(by['src/new.txt']).toMatchObject({ status: 'added', hunkSelectable: false, badges: [] });
    expect(by['src/b.txt']).toMatchObject({ status: 'deleted', applicable: true });
    expect(by['tool.sh']!.badges).toEqual(expect.arrayContaining(['executable', 'flagged']));
    expect(by['package.json']!.badges).toEqual(expect.arrayContaining(['dependency', 'flagged']));
    expect(by['package.json']!.flags.join(' ')).toContain('scripts');
    expect(by['bin.dat']).toMatchObject({ binary: true, contentOmitted: true });
    expect(by['bin.dat']!.badges).toContain('binary');
    expect(by['bin.dat']!.hunks).toEqual([]);
    expect(by['ok-link']).toMatchObject({ kind: 'symlink', applicable: true });
    expect(by['ok-link']!.badges).toContain('symlink');
    expect(by['evil-link']).toMatchObject({ applicable: false, notApplicable: 'unsafe_link' });

    // a different sandbox state gives a different digest
    await write(join(t, 'src/new.txt'), 'new, again\n');
    expect((await ctx.review()).model.digest).not.toBe(model.digest);
  });

  it('classifies dependency manifests and lock files', () => {
    for (const p of [
      'package.json',
      'web/pnpm-lock.yaml',
      'Cargo.lock',
      'requirements-dev.txt',
      'app/App.csproj',
      'go.sum',
    ])
      expect(isDependencyFile(p), p).toBe(true);
    for (const p of ['src/package.ts', 'README.md', 'requirements/notes.md'])
      expect(isDependencyFile(p), p).toBe(false);
  });

  it('refuses a diff that does not match the file list', () => {
    const result = {
      format: 'diff',
      contentBytes: Buffer.from('diff --git a/x b/x\nnew file mode 100644\n'),
      files: [],
      flagged: [],
      stats: {},
      warnings: [],
    } as unknown as ExportResult;
    expect(() => buildReviewModel(result)).toThrow(/more diff sections/);
  });
});

describe('selection -> patch', () => {
  async function twoHunks() {
    const ctx = await setup(async (src) => {
      await write(join(src, 'long.txt'), numbered(60));
      await write(join(src, 'other.txt'), 'one\ntwo\n');
      git(src, 'add', '-A');
      git(src, 'commit', '-q', '-m', 'long');
    });
    await write(
      join(ctx.tree, 'long.txt'),
      numbered(60, { 3: 'CHANGED 3', 30: 'CHANGED 30', 58: 'CHANGED 58' }),
    );
    await write(join(ctx.tree, 'other.txt'), 'one\nTWO\n');
    await write(join(ctx.tree, 'added.txt'), 'added\n');
    return ctx;
  }

  it('a subset of hunks produces a patch with exactly those hunks that applies to the project', async () => {
    const ctx = await twoHunks();
    const { model } = await ctx.review();
    const long = model.files.find((f) => f.path === 'long.txt')!;
    expect(long.hunks).toHaveLength(3);
    const built = buildPatch(model, [{ path: 'long.txt', hunks: [0, 2] }]);
    expect(built.files).toHaveLength(1);
    expect(built.files[0]).toMatchObject({ whole: false, hunks: [0, 2] });
    const text = built.patch.toString('latin1');
    expect(text).toContain('+CHANGED 3');
    expect(text).toContain('+CHANGED 58');
    expect(text).not.toContain('CHANGED 30');
    expect(text.match(/^@@ /gm)).toHaveLength(2);

    const target = await openTarget(ctx.src);
    expect(target.kind).toBe('git');
    await checkPatch(target, built.patch, expectedPatchNames(built.files));
    await applyPatchToTarget(target, built.patch);
    const now = (await readFile(join(ctx.src, 'long.txt'), 'utf8')).split('\n');
    expect(now[2]).toBe('CHANGED 3');
    expect(now[29]).toBe('line 30');
    expect(now[57]).toBe('CHANGED 58');
    // only the selected file was touched, nothing was staged
    expect(porcelain(ctx.src)).toBe(' M long.txt\n');
    expect(git(ctx.src, 'diff', '--cached', '--stat')).toBe('');
  });

  it('the middle hunk alone and whole-file selection give the same result as the export', async () => {
    const ctx = await twoHunks();
    const { model } = await ctx.review();
    const middle = buildPatch(model, [{ path: 'long.txt', hunks: [1] }]);
    const target = await openTarget(ctx.src);
    await applyPatchToTarget(target, middle.patch);
    expect((await readFile(join(ctx.src, 'long.txt'), 'utf8')).split('\n')[29]).toBe('CHANGED 30');
    git(ctx.src, 'checkout', '-q', '--', 'long.txt');

    const all = buildPatch(model, [
      { path: 'long.txt' },
      { path: 'other.txt' },
      { path: 'added.txt' },
    ]);
    expect(all.files.every((f) => f.whole)).toBe(true);
    await applyPatchToTarget(target, all.patch);
    expect(await readFile(join(ctx.src, 'added.txt'), 'utf8')).toBe('added\n');
    for (const f of ['long.txt', 'other.txt'])
      expect(await readFile(join(ctx.src, f), 'utf8')).toBe(
        await readFile(join(ctx.tree, f), 'utf8'),
      );
    // choosing every hunk equals choosing the file
    const everyHunk = buildPatch(model, [{ path: 'long.txt', hunks: [0, 1, 2] }]);
    expect(everyHunk.files[0]!.whole).toBe(true);
  });

  it('refuses unknown paths, duplicates, bad hunk lists and hunks of files that are whole-only', async () => {
    const ctx = await twoHunks();
    await rm(join(ctx.tree, 'src/b.txt'));
    const { model } = await ctx.review();
    const code = (sel: Parameters<typeof buildPatch>[1]): string => {
      try {
        buildPatch(model, sel);
        return 'no error';
      } catch (e) {
        return (e as { code: string }).code;
      }
    };
    expect(code([])).toBe('invalid_input');
    expect(code([{ path: 'nope.txt' }])).toBe('invalid_input');
    expect(code([{ path: '../etc/passwd' }])).toBe('invalid_input');
    expect(code([{ path: 'long.txt' }, { path: 'long.txt' }])).toBe('invalid_input');
    expect(code([{ path: 'long.txt', hunks: [7] }])).toBe('invalid_input');
    expect(code([{ path: 'long.txt', hunks: [1, 1] }])).toBe('invalid_input');
    expect(code([{ path: 'long.txt', hunks: [] }])).toBe('invalid_input');
    expect(code([{ path: 'added.txt', hunks: [0] }])).toBe('invalid_input');
    expect(code([{ path: 'src/b.txt', hunks: [0] }])).toBe('invalid_input');
    expect(code([{ path: 'src/b.txt' }, { path: 'long.txt', hunks: [2] }])).toBe('no error');
  });

  it('files that cannot be applied are visible but never part of a patch', async () => {
    const ctx = await setup();
    await symlink('/etc/passwd', join(ctx.tree, 'evil-link'));
    // file <-> symlink type change
    await rm(join(ctx.tree, 'src/a.txt'));
    await symlink('b.txt', join(ctx.tree, 'src/a.txt'));
    const { model } = await ctx.review();
    const by = Object.fromEntries(model.files.map((f) => [f.path, f]));
    expect(by['evil-link']!.notApplicable).toBe('unsafe_link');
    expect(by['src/a.txt']!.notApplicable).toBe('type_change');
    expect(() => buildPatch(model, [{ path: 'evil-link' }])).toThrow(/cannot be applied/);
    expect(() => buildPatch(model, [{ path: 'src/a.txt' }])).toThrow(/cannot be applied/);
  });

  it('refuses unsafe path names in a diff (.. segments, .git, control characters)', () => {
    const header = (p: string): string =>
      `diff --git a/${p} b/${p}\nnew file mode 100644\nindex 0000000..e69de29\n`;
    const fileFor = (path: string) => ({
      path,
      status: 'added' as const,
      kind: 'file' as const,
      mode: '100644',
      insertions: 0,
      deletions: 0,
      binary: false,
    });
    for (const p of [
      'sub/../escape.txt',
      '.git/hooks/pre-commit',
      'a/.GIT/config',
      'bad\u0007name',
    ]) {
      const result = {
        format: 'diff',
        contentBytes: Buffer.from(header(p)),
        files: [fileFor(p)],
        flagged: [],
        stats: {},
        warnings: [],
      } as unknown as ExportResult;
      const model = buildReviewModel(result);
      expect(model.files[0]!.applicable, p).toBe(false);
      expect(
        model.files[0]!.notApplicable === 'unsafe_path' ||
          model.files[0]!.notApplicable === 'unmapped',
      ).toBe(true);
      expect(() => buildPatch(model, [{ path: p }])).toThrow(/cannot be applied/);
    }
  });

  it('a binary file and an exec bit survive the round trip byte for byte', async () => {
    const ctx = await setup();
    const bytes = Buffer.from([0, 1, 2, 3, 255, 254, 10, 13, 0]);
    await write(join(ctx.tree, 'bin.dat'), bytes);
    await write(join(ctx.tree, 'run.sh'), 'echo é\n', 0o755);
    await chmod(join(ctx.tree, 'run.sh'), 0o755);
    const { model } = await ctx.review();
    const built = buildPatch(model, [{ path: 'bin.dat' }, { path: 'run.sh' }]);
    const target = await openTarget(ctx.src);
    await applyPatchToTarget(target, built.patch);
    expect(Buffer.compare(await readFile(join(ctx.src, 'bin.dat')), bytes)).toBe(0);
    expect(await readFile(join(ctx.src, 'run.sh'), 'utf8')).toBe('echo é\n');
    expect(git(ctx.src, 'diff', '--summary')).toBe('');
    expect(porcelain(ctx.src)).toContain('?? run.sh');
  });

  it('renames carry over', async () => {
    const ctx = await setup(async (src) => {
      await write(join(src, 'moved.txt'), numbered(30));
      git(src, 'add', '-A');
      git(src, 'commit', '-q', '-m', 'moved');
    });
    await mkdir(join(ctx.tree, 'dir'));
    await rename(join(ctx.tree, 'moved.txt'), join(ctx.tree, 'dir/renamed.txt'));
    const { model } = await ctx.review();
    const f = model.files.find((x) => x.path === 'dir/renamed.txt')!;
    expect(f).toMatchObject({ status: 'renamed', oldPath: 'moved.txt', hunkSelectable: false });
    const built = buildPatch(model, [{ path: 'dir/renamed.txt' }]);
    const target = await openTarget(ctx.src);
    await checkPatch(target, built.patch, expectedPatchNames(built.files));
    await applyPatchToTarget(target, built.patch);
    expect(await readFile(join(ctx.src, 'dir/renamed.txt'), 'utf8')).toBe(numbered(30));
  });
});

describe('target checks', () => {
  it('a project that is not a repository of its own is a plain directory', async () => {
    const root = await tmp();
    await mkdir(join(root, 'plain'));
    expect((await openTarget(join(root, 'plain'))).kind).toBe('plain');
    // a subdirectory of a repository is not treated as that repository either
    const repo = await makeRepo(join(root, 'repo'));
    await mkdir(join(repo, 'sub'));
    expect((await openTarget(join(repo, 'sub'))).kind).toBe('plain');
    expect((await openTarget(repo)).kind).toBe('git');
    await expect(openTarget(join(root, 'missing'))).rejects.toMatchObject({ code: 'not_found' });
  });

  it('reports uncommitted changes in affected paths: modified, staged, deleted, untracked', async () => {
    const root = await tmp();
    const repo = await makeRepo(join(root, 'repo'));
    await write(join(repo, 'src/a.txt'), 'alpha\nlocal edit\n');
    await write(join(repo, 'src/b.txt'), 'staged\n');
    git(repo, 'add', 'src/b.txt');
    await rm(join(repo, 'README.md'));
    await write(join(repo, 'new/dir/file.txt'), 'untracked\n');
    const target = await openTarget(repo);
    expect(
      await dirtyPaths(target, [
        'src/a.txt',
        'src/b.txt',
        'README.md',
        'new/dir/file.txt',
        'package.json',
        'unrelated.txt',
      ]),
    ).toEqual(['README.md', 'new/dir/file.txt', 'src/a.txt', 'src/b.txt']);
    expect(await dirtyPaths(await openTarget(await tmp()), ['x'])).toEqual([]);
  });

  it('refuses writing through symbolic links, into .git and nested repositories', async () => {
    const root = await tmp();
    const repo = await makeRepo(join(root, 'repo'));
    const outside = join(root, 'outside');
    await mkdir(outside);
    await symlink(outside, join(repo, 'linked'));
    await symlink(join(repo, 'src/a.txt'), join(repo, 'filelink'));
    await mkdir(join(repo, 'vendor/lib'), { recursive: true });
    await mkdir(join(repo, 'vendor/lib/.git'));
    const target = await openTarget(repo);
    const cache = new Map<string, 'ok'>();
    const code = async (rel: string, mustExist = false): Promise<string> => {
      try {
        await checkTargetPath(target, rel, mustExist, cache);
        return 'ok';
      } catch (e) {
        return (e as { code: string }).code;
      }
    };
    expect(await code('linked/new.txt')).toBe('policy_denied');
    expect(await code('filelink', true)).toBe('policy_denied');
    expect(await code('.git/hooks/pre-commit')).toBe('policy_denied');
    expect(await code('a/.GIT/x')).toBe('policy_denied');
    expect(await code('../x')).toBe('policy_denied');
    expect(await code('vendor/lib/file.txt')).toBe('policy_denied');
    expect(await code('src/a.txt', true)).toBe('ok');
    expect(await code('src/brand/new.txt')).toBe('ok');
    expect(await code('missing.txt', true)).toBe('conflict');
    expect(await code('README.md/inside')).toBe('conflict');
  });

  it('a patch that does not apply is reported before anything is written, and writes nothing', async () => {
    const ctx = await setup();
    await write(join(ctx.tree, 'src/a.txt'), 'alpha\nBETA\n');
    await write(join(ctx.tree, 'src/b.txt'), 'BRAVO\n');
    const { model } = await ctx.review();
    const built = buildPatch(model, [{ path: 'src/a.txt' }, { path: 'src/b.txt' }]);
    // the project moved on in the second file only (committed, so it is not "dirty")
    await write(join(ctx.src, 'src/b.txt'), 'something else\n');
    git(ctx.src, 'commit', '-q', '-am', 'moved on');
    const target = await openTarget(ctx.src);
    await expect(
      checkPatch(target, built.patch, expectedPatchNames(built.files)),
    ).rejects.toMatchObject({ code: 'conflict' });
    // all or nothing: the first file is untouched, too
    await expect(applyPatchToTarget(target, built.patch)).rejects.toBeTruthy();
    expect(await readFile(join(ctx.src, 'src/a.txt'), 'utf8')).toBe('alpha\nbeta\n');
    expect(porcelain(ctx.src)).toBe('');
  });

  it('refuses a patch that names other files than expected', async () => {
    const ctx = await setup();
    await write(join(ctx.tree, 'src/a.txt'), 'alpha\nBETA\n');
    await write(join(ctx.tree, 'src/b.txt'), 'BRAVO\n');
    const { model } = await ctx.review();
    const built = buildPatch(model, [{ path: 'src/a.txt' }, { path: 'src/b.txt' }]);
    const target = await openTarget(ctx.src);
    await expect(checkPatch(target, built.patch, ['src/a.txt'])).rejects.toMatchObject({
      code: 'internal',
    });
  });
});
