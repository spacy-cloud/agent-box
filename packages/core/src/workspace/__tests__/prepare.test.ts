import { chmod, lstat, mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AboxError } from '../../errors.js';
import { cleanupWorkspace, prepareWorkspace } from '../prepare.js';
import {
  git,
  headOf,
  makeRepo,
  markerAbsent,
  porcelain,
  tmp,
  useTempCleanup,
  write,
} from './helpers.js';

useTempCleanup();

async function setup(): Promise<{ src: string; sandboxDir: string; root: string }> {
  const root = await tmp();
  const src = await makeRepo(join(root, 'project'));
  return { root, src, sandboxDir: join(root, 'sandboxes', 'ab12cd34') };
}

const common = { access: 'rw' as const, remote: false, sandboxPath: '/workspace' };

describe('prepareWorkspace', () => {
  it('empty -> none', async () => {
    const { sandboxDir } = await setup();
    const r = await prepareWorkspace({ ...common, mode: 'empty', sandboxDir });
    expect(r.delivery).toEqual({ kind: 'none', sandboxPath: '/workspace' });
    expect(r.record.baseline.kind).toBe('empty');
  });

  it('record is JSON-serializable and secret-free', async () => {
    const { src, sandboxDir } = await setup();
    const r = await prepareWorkspace({ ...common, mode: 'copy', source: src, sandboxDir });
    expect(JSON.parse(JSON.stringify(r.record))).toEqual(r.record);
  });

  describe('mount: repository filter drivers (trusted config) vs sandbox-writable attributes', () => {
    async function repoWithDrivers(): Promise<{ root: string; src: string; marker: string }> {
      const { root, src } = await setup();
      const marker = join(root, 'driver-ran');
      for (const [k, v] of [
        ['filter.evil.clean', `sh -c 'touch ${marker}; cat'`],
        ['filter.evil.smudge', `sh -c 'touch ${marker}; cat'`],
        ['filter.evil.process', `sh -c 'touch ${marker}'`],
        ['filter.evil.required', 'true'],
        ['diff.evil.textconv', `sh -c 'touch ${marker}; cat' --`],
        ['diff.evil.command', `touch ${marker}`],
        ['merge.evil.driver', `touch ${marker}`],
      ] as const)
        git(src, 'config', k, v);
      return { root, src, marker };
    }

    it('the premise: plain git status DOES run the driver once .gitattributes activates it', async () => {
      const { src, marker } = await repoWithDrivers();
      await write(join(src, '.gitattributes'), '* filter=evil\n');
      await write(join(src, 'src/a.txt'), 'alpha\nchanged\n'); // racy-clean files are not re-hashed
      // (a required filter that fails makes git fail; the marker is what matters)
      spawnSync('git', ['status', '--porcelain'], {
        cwd: src,
        stdio: 'ignore',
        env: {
          PATH: process.env['PATH'] ?? '',
          HOME: '/nonexistent',
          GIT_CONFIG_GLOBAL: '/dev/null',
        },
      });
      expect(existsSync(marker)).toBe(true);
    });

    it('creating a mount workspace after a sandbox wrote .gitattributes runs no driver', async () => {
      const { root, src, marker } = await repoWithDrivers();
      // what an earlier rw mount sandbox could have left behind
      await write(join(src, '.gitattributes'), '* filter=evil diff=evil merge=evil\n');
      await write(join(src, 'src/.gitattributes'), '*.txt filter=evil\n');
      await write(join(src, 'src/a.txt'), 'alpha\nchanged\n');
      const r = await prepareWorkspace({
        ...common,
        mode: 'mount',
        source: src,
        sandboxDir: join(root, 'sandboxes', 'ab12cd34'),
      });
      expect(existsSync(marker), 'a driver from the repository config ran').toBe(false);
      expect(r.warnings.join(' ')).toMatch(/uncommitted changes/);
    });
  });

  describe('mount', () => {
    it('binds the source with .git read-only and records host-owned baseline', async () => {
      const { src, sandboxDir } = await setup();
      const r = await prepareWorkspace({ ...common, mode: 'mount', source: src, sandboxDir });
      expect(r.delivery).toMatchObject({
        kind: 'bind',
        hostPath: src,
        access: 'rw',
        readonlySubpaths: ['.git'],
      });
      expect(r.record.baseline).toMatchObject({
        kind: 'git',
        commit: headOf(src),
        gitDir: join(src, '.git'),
      });
      expect(r.record.gitMarker?.kind).toBe('dir');
      expect(r.record.liveTree).toBe(src);
    });

    it('makes a .git file (linked worktree / submodule checkout) read-only too', async () => {
      const { src, root, sandboxDir } = await setup();
      const wt = join(root, 'linked');
      git(src, 'worktree', 'add', '-q', '-b', 'other', wt);
      const r = await prepareWorkspace({ ...common, mode: 'mount', source: wt, sandboxDir });
      expect((await lstat(join(wt, '.git'))).isFile()).toBe(true);
      expect(r.delivery).toMatchObject({ kind: 'bind', readonlySubpaths: ['.git'] });
      expect(r.record.gitMarker?.kind).toBe('file');
      expect(r.record.baseline).toMatchObject({ kind: 'git', gitDir: join(src, '.git') });
    });

    it('lists nested submodule .git entries as read-only', async () => {
      const { src, sandboxDir } = await setup();
      git(src, 'update-index', '--add', '--cacheinfo', `160000,${headOf(src)},vendor/lib`);
      await write(join(src, 'vendor/lib/.git'), 'gitdir: /somewhere\n');
      const r = await prepareWorkspace({ ...common, mode: 'mount', source: src, sandboxDir });
      expect(r.delivery).toMatchObject({ readonlySubpaths: ['.git', 'vendor/lib/.git'] });
    });

    it('is unsupported on remote hosts', async () => {
      const { src, sandboxDir } = await setup();
      await expect(
        prepareWorkspace({ ...common, remote: true, mode: 'mount', source: src, sandboxDir }),
      ).rejects.toMatchObject({
        code: 'unsupported',
        message: 'workspace mode mount is not available on remote hosts; use clone, copy or sync',
      });
    });

    it('non-git directory gets a snapshot baseline and no read-only subpaths', async () => {
      const root = await tmp();
      const dir = join(root, 'plain');
      await write(join(dir, 'x.txt'), 'x');
      const r = await prepareWorkspace({
        ...common,
        mode: 'mount',
        source: dir,
        sandboxDir: join(root, 'sb'),
      });
      expect(r.delivery).toEqual({
        kind: 'bind',
        hostPath: dir,
        sandboxPath: '/workspace',
        access: 'rw',
      });
      expect(r.record.baseline.kind).toBe('git');
      expect(r.record.manifest?.files).toBe(1);
    });

    it('warns about a dirty source', async () => {
      const { src, sandboxDir } = await setup();
      await write(join(src, 'src/a.txt'), 'changed\n');
      const r = await prepareWorkspace({ ...common, mode: 'mount', source: src, sandboxDir });
      expect(r.warnings.join('\n')).toMatch(/uncommitted/);
    });
  });

  describe('worktree', () => {
    it('creates a worktree on its own branch and leaves the source untouched', async () => {
      const { src, sandboxDir } = await setup();
      await write(join(src, 'dirty.txt'), 'untracked\n');
      const before = {
        head: headOf(src),
        status: porcelain(src),
        branch: git(src, 'branch', '--show-current'),
      };
      const marker = join(sandboxDir, '..', 'hook-ran');
      await write(join(src, '.git/hooks/post-checkout'), `#!/bin/sh\ntouch ${marker}\n`, 0o755);
      await chmod(join(src, '.git/hooks/post-checkout'), 0o755);

      const r = await prepareWorkspace({ ...common, mode: 'worktree', source: src, sandboxDir });
      const wt = join(sandboxDir, 'worktree');
      expect(r.delivery).toEqual({
        kind: 'bind',
        hostPath: wt,
        sandboxPath: '/workspace',
        access: 'rw',
        readonlySubpaths: ['.git'],
      });
      expect(r.record.branch).toBe('abox/ab12cd34');
      expect(git(src, 'rev-parse', 'abox/ab12cd34').trim()).toBe(headOf(src));
      expect(await readFile(join(wt, 'src/a.txt'), 'utf8')).toBe('alpha\nbeta\n');
      expect(existsSync(join(wt, 'dirty.txt'))).toBe(false);
      expect((await lstat(join(wt, '.git'))).isFile()).toBe(true);
      expect(r.record.gitMarker?.kind).toBe('file');
      expect(r.record.worktree?.adminDir).toContain('/worktrees/');
      // source repo: working tree, HEAD and current branch unchanged
      expect(headOf(src)).toBe(before.head);
      expect(porcelain(src)).toBe(before.status);
      expect(git(src, 'branch', '--show-current')).toBe(before.branch);
      // hooks must not run
      expect(markerAbsent(marker)).toBe(true);
    });

    it('honours ref', async () => {
      const { src, sandboxDir } = await setup();
      const first = headOf(src);
      await write(join(src, 'later.txt'), 'later\n');
      git(src, 'add', '-A');
      git(src, 'commit', '-q', '-m', 'second');
      const r = await prepareWorkspace({
        ...common,
        mode: 'worktree',
        source: src,
        sandboxDir,
        ref: first,
      });
      expect(r.record.baseline).toMatchObject({ commit: first });
      expect(existsSync(join(sandboxDir, 'worktree', 'later.txt'))).toBe(false);
    });

    it('rejects option-like refs, unknown refs and rolls back', async () => {
      const { src, sandboxDir } = await setup();
      await expect(
        prepareWorkspace({
          ...common,
          mode: 'worktree',
          source: src,
          sandboxDir,
          ref: '--upload-pack=x',
        }),
      ).rejects.toMatchObject({ code: 'invalid_input' });
      await expect(
        prepareWorkspace({ ...common, mode: 'worktree', source: src, sandboxDir, ref: 'nope' }),
      ).rejects.toMatchObject({ code: 'invalid_input' });
      expect(git(src, 'branch', '--list', 'abox/*').trim()).toBe('');
    });

    it('is unsupported on remote hosts', async () => {
      const { src, sandboxDir } = await setup();
      await expect(
        prepareWorkspace({ ...common, remote: true, mode: 'worktree', source: src, sandboxDir }),
      ).rejects.toBeInstanceOf(AboxError);
    });

    it('cleanupWorkspace removes worktree and unused branch', async () => {
      const { src, sandboxDir } = await setup();
      const r = await prepareWorkspace({ ...common, mode: 'worktree', source: src, sandboxDir });
      await cleanupWorkspace(r.record);
      expect(existsSync(join(sandboxDir, 'worktree'))).toBe(false);
      expect(git(src, 'branch', '--list', 'abox/*').trim()).toBe('');
      expect(git(src, 'worktree', 'list')).not.toContain('worktree');
    });
  });

  describe('clone', () => {
    it('creates an independent repo without hooks or remote, delivered as copy', async () => {
      const { src, sandboxDir } = await setup();
      const marker = join(sandboxDir, '..', 'clone-hook-ran');
      await write(join(src, '.git/hooks/post-checkout'), `#!/bin/sh\ntouch ${marker}\n`, 0o755);
      await chmod(join(src, '.git/hooks/post-checkout'), 0o755);
      await write(join(src, '.git/hooks/pre-commit'), `#!/bin/sh\ntouch ${marker}\n`, 0o755);
      await chmod(join(src, '.git/hooks/pre-commit'), 0o755);
      await write(join(src, 'untracked.txt'), 'x');

      const r = await prepareWorkspace({ ...common, mode: 'clone', source: src, sandboxDir });
      const staging = join(sandboxDir, 'staging');
      expect(r.delivery).toEqual({ kind: 'copy', hostPath: staging, sandboxPath: '/workspace' });
      expect(git(staging, 'branch', '--show-current').trim()).toBe('abox/ab12cd34');
      expect(headOf(staging)).toBe(headOf(src));
      expect(git(staging, 'remote').trim()).toBe('');
      expect(await readFile(join(staging, 'src/a.txt'), 'utf8')).toBe('alpha\nbeta\n');
      expect(existsSync(join(staging, 'untracked.txt'))).toBe(false);
      const hooks = existsSync(join(staging, '.git/hooks'))
        ? await readdir(join(staging, '.git/hooks'))
        : [];
      expect(hooks.filter((h) => !h.endsWith('.sample'))).toEqual([]);
      expect(markerAbsent(marker)).toBe(true);
      expect(r.record.baseline).toMatchObject({
        kind: 'git',
        gitDir: join(sandboxDir, 'baseline.git'),
        commit: headOf(src),
      });
      expect(git(join(sandboxDir, 'baseline.git'), 'cat-file', '-t', headOf(src)).trim()).toBe(
        'commit',
      );
      // sandbox repo does not share object files with the source (no hardlinks)
      const objs = execFileSync('find', [
        join(staging, '.git/objects'),
        '-type',
        'f',
        '-links',
        '+1',
      ]).toString();
      expect(objs.trim()).toBe('');
      expect(r.record.branch).toBe('abox/ab12cd34');
    });

    it('works for remote hosts too (staging uploaded by the provider)', async () => {
      const { src, sandboxDir } = await setup();
      const r = await prepareWorkspace({
        ...common,
        remote: true,
        mode: 'clone',
        source: src,
        sandboxDir,
      });
      expect(r.delivery.kind).toBe('copy');
    });
  });

  describe('copy / sync', () => {
    it('does not follow symlinks, keeps them as links, skips special files, honours exclude', async () => {
      const root = await tmp();
      const outside = join(root, 'outside-secret.txt');
      await writeFile(outside, 'TOP-SECRET-CONTENT-12345');
      const src = join(root, 'proj');
      await write(join(src, 'a.txt'), 'a');
      await write(join(src, 'run.sh'), '#!/bin/sh\n', 0o755);
      await chmod(join(src, 'run.sh'), 0o755);
      await write(join(src, 'skipme/x.txt'), 'x');
      await write(join(src, 'deep/log/app.log'), 'log');
      await symlink(outside, join(src, 'link-to-secret'));
      await symlink(root, join(src, 'link-to-dir'));
      await symlink('a.txt', join(src, 'inner-link'));
      execFileSync('mkfifo', [join(src, 'fifo')]);

      const r = await prepareWorkspace({
        ...common,
        mode: 'copy',
        source: src,
        sandboxDir: join(root, 'sb'),
        exclude: ['skipme/', '*.log'],
      });
      const staging = join(root, 'sb', 'staging');
      expect(r.delivery).toEqual({ kind: 'copy', hostPath: staging, sandboxPath: '/workspace' });
      expect((await lstat(join(staging, 'link-to-secret'))).isSymbolicLink()).toBe(true);
      expect((await lstat(join(staging, 'link-to-dir'))).isSymbolicLink()).toBe(true);
      expect(await readFile(join(staging, 'inner-link'), 'utf8')).toBe('a');
      expect(existsSync(join(staging, 'fifo'))).toBe(false);
      expect(existsSync(join(staging, 'skipme'))).toBe(false);
      expect(existsSync(join(staging, 'deep/log/app.log'))).toBe(false);
      expect((await stat(join(staging, 'run.sh'))).mode & 0o111).not.toBe(0);
      // no copy of the outside file content anywhere in staging
      const grep = spawnSync('grep', ['-rl', 'TOP-SECRET-CONTENT', staging], { encoding: 'utf8' });
      expect(grep.stdout.trim()).toBe('');
      expect(r.warnings.join('\n')).toMatch(/symlink\(s\) point outside/);
      // manifest
      const m = JSON.parse(await readFile(r.record.manifest!.path, 'utf8')) as {
        entries: Record<string, { type: string; target?: string; sha256?: string }>;
      };
      expect(m.entries['link-to-secret']).toMatchObject({ type: 'symlink', target: outside });
      expect(m.entries['a.txt']).toMatchObject({ type: 'file' });
      expect(m.entries['a.txt']?.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(m.entries['skipme/x.txt']).toBeUndefined();
    });

    it('default excludes nothing and warns that .git was copied', async () => {
      const { src, sandboxDir } = await setup();
      const r = await prepareWorkspace({ ...common, mode: 'copy', source: src, sandboxDir });
      expect(existsSync(join(sandboxDir, 'staging/.git'))).toBe(true);
      expect(r.warnings.join('\n')).toMatch(/\.git was copied/);
      expect(r.record.sourceGit?.head).toBe(headOf(src));
      expect(r.record.manifest?.files).toBeGreaterThan(0);
    });

    it('exclude .git keeps history out of the sandbox', async () => {
      const { src, sandboxDir } = await setup();
      await prepareWorkspace({
        ...common,
        mode: 'sync',
        remote: true,
        source: src,
        sandboxDir,
        exclude: ['.git'],
      });
      expect(existsSync(join(sandboxDir, 'staging/.git'))).toBe(false);
      expect(existsSync(join(sandboxDir, 'staging/src/a.txt'))).toBe(true);
    });

    it('cleans up on failure', async () => {
      const { sandboxDir, root } = await setup();
      await mkdir(join(root, 'nogit'), { recursive: true });
      await expect(
        prepareWorkspace({ ...common, mode: 'clone', source: join(root, 'nogit'), sandboxDir }),
      ).rejects.toMatchObject({ code: 'invalid_input' });
      expect(existsSync(join(sandboxDir, 'staging'))).toBe(false);
    });
  });
});
