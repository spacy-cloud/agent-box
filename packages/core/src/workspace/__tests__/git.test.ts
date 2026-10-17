import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildGitArgv, driverNeutralizingEnv, runGit } from '../git.js';
import { compileExcludes } from '../glob.js';
import { makeRepo, tmp, useTempCleanup, write } from './helpers.js';

useTempCleanup();

describe('driverNeutralizingEnv', () => {
  it('lists every filter/diff/merge driver of the repository config, also odd subsection names', async () => {
    const root = await tmp();
    const repo = await makeRepo(join(root, 'r'));
    execFileSync('git', ['config', 'filter.a.b=c.clean', 'x'], { cwd: repo });
    execFileSync('git', ['config', 'filter.lfs.clean', 'git-lfs clean -- %f'], { cwd: repo });
    execFileSync('git', ['config', 'filter.lfs.required', 'true'], { cwd: repo });
    execFileSync('git', ['config', 'diff.pdf.textconv', 'pdftotext'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'kept'], { cwd: repo });
    const env = await driverNeutralizingEnv(join(repo, '.git'));
    const pairs = new Map<string, string>();
    for (let i = 0; i < Number(env['GIT_CONFIG_COUNT']); i++)
      pairs.set(env[`GIT_CONFIG_KEY_${i}`]!, env[`GIT_CONFIG_VALUE_${i}`]!);
    expect(pairs.get('filter.lfs.clean')).toBe('');
    expect(pairs.get('filter.lfs.required')).toBe('false');
    expect(pairs.get('diff.pdf.textconv')).toBe('');
    expect([...pairs.keys()].some((k) => k.startsWith('user.'))).toBe(false);
    expect(await driverNeutralizingEnv(join(repo, 'nope.git'))).toEqual({});
  });

  it('is empty for a repository without drivers', async () => {
    const root = await tmp();
    const repo = await makeRepo(join(root, 'r'));
    expect(await driverNeutralizingEnv(join(repo, '.git'))).toEqual({});
  });
});

describe('runGit hardening', () => {
  it('builds hardened argv', () => {
    const argv = buildGitArgv(['status'], { gitDir: '/g', workTree: '/w' });
    expect(argv).toEqual(
      expect.arrayContaining([
        'core.hooksPath=/dev/null',
        'core.fsmonitor=false',
        'core.untrackedCache=false',
        'protocol.file.allow=user',
        '--git-dir=/g',
        '--work-tree=/w',
      ]),
    );
    expect(argv.slice(-1)).toEqual(['status']);
  });

  it('ignores repository config that would execute commands (canary: plain git does run it)', async () => {
    const root = await tmp();
    const repo = await makeRepo(join(root, 'r'));
    const mark = join(root, 'canary');
    const mark2 = join(root, 'hardened');
    await write(
      join(repo, '.git/config'),
      (await import('node:fs/promises').then((m) =>
        m.readFile(join(repo, '.git/config'), 'utf8'),
      )) + `[core]\n\tfsmonitor = touch ${mark}\n`,
    );
    await write(join(repo, '.git/hooks/post-checkout'), `#!/bin/sh\ntouch ${mark}\n`, 0o755);
    await chmod(join(repo, '.git/hooks/post-checkout'), 0o755);

    // canary: an un-hardened invocation executes the sandbox-controlled fsmonitor
    execFileSync('git', ['--git-dir', join(repo, '.git'), '--work-tree', repo, 'status'], {
      env: {
        PATH: process.env['PATH'] ?? '',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
      },
      stdio: 'ignore',
    });
    expect(existsSync(mark)).toBe(true);

    // hardened: different marker, same attack
    await write(
      join(repo, '.git/config'),
      `[core]\n\trepositoryformatversion = 0\n\tfsmonitor = touch ${mark2}\n\thooksPath = ${join(repo, '.git/hooks')}\n`,
    );
    await runGit(['status', '--porcelain'], { gitDir: join(repo, '.git'), workTree: repo });
    await runGit(['checkout', '-q', '--', '.'], { gitDir: join(repo, '.git'), workTree: repo });
    expect(existsSync(mark2)).toBe(false);
  });

  it('does not inherit dangerous environment', async () => {
    const root = await tmp();
    const repo = await makeRepo(join(root, 'r'));
    const mark = join(root, 'ext-diff');
    await write(join(root, 'ext.sh'), `#!/bin/sh\ntouch ${mark}\n`, 0o755);
    await chmod(join(root, 'ext.sh'), 0o755);
    process.env['GIT_EXTERNAL_DIFF'] = join(root, 'ext.sh');
    process.env['GIT_PAGER'] = `touch ${mark}`;
    try {
      await write(join(repo, 'README.md'), 'changed\n');
      const r = await runGit(['diff', '--no-ext-diff'], {
        gitDir: join(repo, '.git'),
        workTree: repo,
      });
      expect(r.stdout).toContain('+changed');
      expect(existsSync(mark)).toBe(false);
      await expect(
        runGit(['diff'], { gitDir: join(repo, '.git'), workTree: repo }),
      ).rejects.toMatchObject({ code: 'backend_error' });
      expect(existsSync(mark)).toBe(false);
    } finally {
      delete process.env['GIT_EXTERNAL_DIFF'];
      delete process.env['GIT_PAGER'];
    }
  });

  it('rejects NUL in arguments and reports failures as AboxError', async () => {
    await expect(runGit(['status', 'a\0b'])).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(runGit(['rev-parse', 'nope'], { gitDir: '/nonexistent' })).rejects.toMatchObject({
      code: 'backend_error',
    });
  });
});

describe('exclude patterns', () => {
  const m = compileExcludes(['node_modules/', '*.log', '/build', 'src/gen', '**/cache', 'a/**/z']);
  it('matches', () => {
    expect(m('node_modules', true)).toBe(true);
    expect(m('node_modules', false)).toBe(false);
    expect(m('pkg/node_modules', true)).toBe(true);
    expect(m('x/y/app.log', false)).toBe(true);
    expect(m('build', true)).toBe(true);
    expect(m('sub/build', true)).toBe(false);
    expect(m('src/gen', false)).toBe(true);
    expect(m('other/src/gen', false)).toBe(false);
    expect(m('deep/er/cache', true)).toBe(true);
    expect(m('cache', true)).toBe(true);
    expect(m('a/b/c/z', false)).toBe(true);
    expect(m('a/z', false)).toBe(true);
    expect(m('README.md', false)).toBe(false);
  });
  it('rejects bad patterns', () => {
    expect(() => compileExcludes([''])).toThrow();
    expect(() => compileExcludes(['a\0b'])).toThrow();
  });
});
