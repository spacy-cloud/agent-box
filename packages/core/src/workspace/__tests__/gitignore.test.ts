import { mkdir, symlink, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  compileGitignoreSet,
  GITIGNORE_LIMITS,
  GitignoreSession,
  type PathIgnoreMatcher,
} from '../gitignore.js';
import { readTrackedPaths } from '../gitindex.js';
import { walkTree } from '../safefs.js';
import { git, tmp, useTempCleanup, write } from './helpers.js';

useTempCleanup();

/** Files (relative paths) of a tree after the `.gitignore` rules, `.git` left out of the list. */
async function walkFiles(root: string, session = new GitignoreSession()): Promise<string[]> {
  const files: string[] = [];
  await walkTree(
    root,
    {
      file(rel) {
        files.push(rel);
      },
    },
    { gitMode: 'visit', gitignore: session },
  );
  return files.filter((f) => !f.startsWith('.git/')).sort();
}

/** What git itself says: tracked files plus untracked files that are not ignored. */
function gitFiles(root: string): string[] {
  return git(root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard')
    .split('\0')
    .filter(Boolean)
    .sort();
}

async function makeTree(files: Record<string, string>): Promise<string> {
  const root = await tmp('abox-gi-');
  git(root, 'init', '-q', '-b', 'main');
  for (const [p, c] of Object.entries(files)) await write(join(root, p), c);
  return root;
}

describe('gitignore matching agrees with git', () => {
  const cases: Array<{ name: string; files: Record<string, string>; ignores?: number }> = [
    {
      name: 'names, wildcards, anchoring, directories only, negation, escapes',
      files: {
        '.gitignore': [
          '# comment',
          '',
          '*.log',
          'build/',
          '/rootonly.txt',
          'docs/*.md',
          '!docs/keep.md',
          '**/cache',
          'a/**/z',
          'tmp/**',
          '\\#hash',
          '\\!bang',
          'trail\\ ',
          '[abc].txt',
          'file?.txt',
          '[!x]y',
          '[[:digit:]].dat',
          'x[0-9]y',
          'ends-with-space   ',
        ].join('\n'),
        'a.log': '',
        'src/b.log': '',
        'src/build/out.txt': '',
        'src/buildfile': '',
        build: 'a file named build',
        'rootonly.txt': '',
        'sub/rootonly.txt': '',
        'docs/one.md': '',
        'docs/keep.md': '',
        'docs/deep/two.md': '',
        'cache/x': '',
        'p/q/cache': '',
        'p/cache.txt': '',
        'a/z': '',
        'a/b/z': '',
        'a/b/c/z': '',
        'a/zz': '',
        'tmp/f': '',
        'tmp/d/g': '',
        'tmp.txt': '',
        '#hash': '',
        '!bang': '',
        'trail ': '',
        trail: '',
        'a.txt': '',
        'd.txt': '',
        'file1.txt': '',
        'file12.txt': '',
        zy: '',
        xy: '',
        '5.dat': '',
        'x.dat': '',
        x5y: '',
        'ends-with-space': '',
        'keep.txt': 'kept',
      },
    },
    {
      name: 'nested .gitignore files with negation and anchoring relative to their directory',
      files: {
        '.gitignore': '*.tmp\n/top\n',
        top: '',
        'sub/top': '',
        'sub/.gitignore': '!important.tmp\n/local\n*.o\n',
        'sub/important.tmp': '',
        'sub/other.tmp': '',
        'sub/local': '',
        'sub/deep/.gitignore': 'local\n!x.o\n/y.o\n',
        'sub/deep/x.o': '',
        'sub/deep/y.o': '',
        'sub/deep/z.o': '',
        'sub/deep/local/f': '',
        'sub/deep/more/local': '',
        'sub/local2': '',
        'sub/deep/more/y.o': '',
        'plain.tmp': '',
      },
    },
    {
      name: 'a file below an ignored directory cannot be re-included',
      files: {
        '.gitignore': 'out/\n!out/keep.txt\nvendor/*\n!vendor/keep.txt\n!vendor/dir\n',
        'out/keep.txt': '',
        'out/other.txt': '',
        'vendor/keep.txt': '',
        'vendor/other.txt': '',
        'vendor/dir/inner.txt': '',
      },
    },
    {
      name: 'double asterisks',
      files: {
        '.gitignore': '**/gen/**\n**/*.snap\nlogs/**/debug\n/**/only-here/\n',
        'gen/a': '',
        gen2: '',
        'x/gen/b': '',
        'x/gen/y/c': '',
        'x/t.snap': '',
        't.snap': '',
        'logs/debug': '',
        'logs/a/debug': '',
        'logs/a/b/debug': '',
        'logs/a/debuggy': '',
        'q/only-here/f': '',
        'only-here/f': '',
        'q/r/s/only-here': '',
      },
    },
    {
      name: 'CRLF line ends, UTF-8 BOM and trailing blanks',
      files: {
        '.gitignore': '﻿*.bak\r\n# c\r\nsecret.txt\r\n\r\ndist/ \r\n',
        'a.bak': '',
        'secret.txt': '',
        'dist/x': '',
        'ok.txt': '',
      },
    },
    {
      name: 'patterns that can never match are harmless',
      files: {
        '.gitignore': 'a//b\n[abc\n\\\n!\n/\n[[:nosuch:]]\n',
        'a/b': '',
        abc: '',
        '[abc': '',
        x: '',
      },
      ignores: 0,
    },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const root = await makeTree(c.files);
      const files = await walkFiles(root);
      expect(files).toEqual(gitFiles(root));
      // the fixture does ignore something (the comparison is not between two full lists)
      expect(Object.keys(c.files).length - files.length).toBeGreaterThanOrEqual(c.ignores ?? 3);
    });
  }

  it('.git/info/exclude applies, with the lowest precedence', async () => {
    const root = await makeTree({
      '.gitignore': '!shown.txt\n',
      'hidden.txt': '',
      'shown.txt': '',
      'sub/hidden.txt': '',
      'plain.txt': '',
    });
    await write(join(root, '.git/info/exclude'), 'hidden.txt\nshown.txt\n');
    const files = await walkFiles(root);
    expect(files).toEqual(gitFiles(root));
    expect(files).toContain('shown.txt');
    expect(files).not.toContain('hidden.txt');
    expect(files).not.toContain('sub/hidden.txt');
  });

  for (const version of [2, 3, 4]) {
    it(`tracked files are kept even if a rule matches them (index version ${version})`, async () => {
      const root = await makeTree({
        '.gitignore': '*.env\ndist/\nvendor/\n',
        'a.env': 'x',
        'dist/bundle.js': 'x',
        'dist/untracked.js': 'x',
        'vendor/lib/one.js': 'x',
        'vendor/lib/two.js': 'x',
        'vendor/other/three.js': 'x',
        'src/main.ts': 'x',
        'src/b.env': 'x',
      });
      git(root, 'add', '-f', 'a.env', 'dist/bundle.js', 'vendor/lib/one.js', 'src/main.ts');
      git(root, 'add', '.gitignore');
      if (version === 3) git(root, 'update-index', '--skip-worktree', 'src/main.ts');
      if (version === 4) git(root, 'update-index', '--index-version', '4');
      const files = await walkFiles(root);
      expect(files).toEqual(gitFiles(root));
      expect(files).toEqual(
        expect.arrayContaining(['a.env', 'dist/bundle.js', 'vendor/lib/one.js', 'src/main.ts']),
      );
      for (const gone of [
        'dist/untracked.js',
        'vendor/lib/two.js',
        'vendor/other/three.js',
        'src/b.env',
      ])
        expect(files).not.toContain(gone);
    });
  }

  it('reads the index of a repository with many paths (index version 4, long common prefixes)', async () => {
    const files: Record<string, string> = { '.gitignore': 'generated/\n' };
    for (let i = 0; i < 60; i++) {
      files[`generated/module-${i}/deeply/nested/dir/file-${i}.txt`] = 'x';
      files[`src/module-${i}/deeply/nested/dir/file-${i}.txt`] = 'x';
    }
    const root = await makeTree(files);
    git(root, 'add', '-f', '.');
    git(root, 'update-index', '--index-version', '4');
    const r = await readTrackedPaths(root);
    expect('tracked' in r).toBe(true);
    if ('tracked' in r) {
      expect([...r.tracked.files].sort()).toEqual(
        git(root, 'ls-files', '-z').split('\0').filter(Boolean).sort(),
      );
      expect(r.tracked.dirs.has('generated/module-3/deeply')).toBe(true);
    }
  });

  it('reads a sha-256 repository and a linked worktree', async () => {
    const root = await tmp('abox-gi-');
    git(root, 'init', '-q', '-b', 'main', '--object-format=sha256');
    await write(join(root, 'f.txt'), 'x');
    await write(join(root, 'sub/g.txt'), 'x');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'c');
    const r = await readTrackedPaths(root);
    expect('tracked' in r && [...r.tracked.files].sort()).toEqual(['f.txt', 'sub/g.txt']);

    const wt = join(await tmp('abox-gi-'), 'wt');
    git(root, 'worktree', 'add', '-q', wt);
    const w = await readTrackedPaths(wt);
    expect('tracked' in w && [...w.tracked.files].sort()).toEqual(['f.txt', 'sub/g.txt']);
  });

  it('a folder without a repository tracks nothing', async () => {
    const root = await tmp('abox-gi-');
    expect(await readTrackedPaths(root)).toEqual({ none: true });
  });
});

describe('GitignoreSession', () => {
  it('never applies a .gitignore that is a symbolic link, and says so', async () => {
    const root = await tmp('abox-gi-');
    const outside = await tmp('abox-gi-');
    await write(join(outside, 'rules'), '*\n');
    await write(join(root, 'a.txt'), '');
    await symlink(join(outside, 'rules'), join(root, '.gitignore'));
    const session = new GitignoreSession();
    expect(await walkFiles(root, session)).toEqual(['a.txt']);
    expect(session.allWarnings()).toEqual(['.gitignore is a symbolic link and was not applied']);
  });

  it('does not read through a linked directory or .git/info/exclude link', async () => {
    const root = await tmp('abox-gi-');
    const outside = await tmp('abox-gi-');
    await write(join(outside, 'sub/.gitignore'), '*\n');
    await write(join(outside, 'exclude'), 'a.txt\n');
    await write(join(root, 'a.txt'), '');
    await symlink(join(outside, 'sub'), join(root, 'linked'));
    await mkdir(join(root, '.git/info'), { recursive: true });
    await symlink(join(outside, 'exclude'), join(root, '.git/info/exclude'));
    const session = new GitignoreSession();
    expect(await walkFiles(root, session)).toEqual(['a.txt']);
    expect(session.warnings.join('\n')).toContain('.git/info/exclude is a symbolic link');
  });

  it('skips a huge .gitignore, one with too many patterns, and over-long patterns', async () => {
    const root = await tmp('abox-gi-');
    await write(join(root, 'huge/.gitignore'), '');
    await truncate(join(root, 'huge/.gitignore'), GITIGNORE_LIMITS.fileBytes + 1);
    await write(join(root, 'huge/a.txt'), '');
    const many = Array.from({ length: GITIGNORE_LIMITS.fileRules + 1 }, (_, i) => `p${i}`).join(
      '\n',
    );
    await write(join(root, 'many/.gitignore'), `${many}\n*.txt\n`);
    await write(join(root, 'many/a.txt'), '');
    await write(
      join(root, 'long/.gitignore'),
      `${'x'.repeat(GITIGNORE_LIMITS.patternChars + 1)}\n*.txt\n`,
    );
    await write(join(root, 'long/a.txt'), '');
    await write(join(root, 'long/b.dat'), '');
    const session = new GitignoreSession();
    const files = await walkFiles(root, session);
    expect(files).toContain('huge/a.txt');
    expect(files).toContain('many/a.txt');
    expect(files).not.toContain('long/a.txt'); // the other pattern of the file still applies
    expect(files).toContain('long/b.dat');
    const w = session.allWarnings().join('\n');
    expect(w).toContain('huge/.gitignore is larger than');
    expect(w).toContain('many/.gitignore has more than');
    expect(w).toContain('long/.gitignore: 1 pattern(s) skipped');
  });

  it('stops reading files beyond the total budget and caps the warnings', async () => {
    const root = await tmp('abox-gi-');
    for (let i = 0; i < 60; i++) await write(join(root, `d${i}/.gitignore`), 'x\n');
    // the budget is spent already (tiny files in this number would only make the test slow)
    const session = new GitignoreSession();
    session.filesLoaded = GITIGNORE_LIMITS.files;
    await walkFiles(root, session);
    expect(session.warnings.length).toBe(20);
    expect(session.allWarnings().at(-1)).toBe('40 more .gitignore warning(s) not shown');
  });

  it('is not misled by pathological patterns (bounded work)', async () => {
    const root = await tmp('abox-gi-');
    const evil = `${'a*'.repeat(40)}b`;
    const manyStars = `${'**/'.repeat(30)}x`;
    await write(
      join(root, '.gitignore'),
      `${evil}\n${manyStars}\n[${'a-z'.repeat(100)}]${'*'.repeat(50)}q\n`,
    );
    const name = 'a'.repeat(250);
    await write(join(root, name), '');
    for (let i = 0; i < 40; i++) await write(join(root, `${'d/'.repeat(i)}${name}`), '');
    const started = Date.now();
    const files = await walkFiles(root);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(files.length).toBe(41);
  });

  it('leaves .git and everything below it alone, even for patterns that match it', async () => {
    const root = await makeTree({ '.gitignore': '.*\n*\n!*/\n', 'a.txt': '', 'sub/b.txt': '' });
    await write(join(root, '.git/hooks/pre-commit'), 'x');
    await write(join(root, '.git/.gitignore'), 'config\n');
    await write(join(root, 'nested/.git/config'), 'x');
    const seen: string[] = [];
    await walkTree(
      root,
      {
        file(rel) {
          seen.push(rel);
        },
      },
      { gitMode: 'visit', gitignore: new GitignoreSession() },
    );
    expect(seen).toContain('.git/hooks/pre-commit');
    expect(seen).toContain('.git/.gitignore');
    expect(seen).toContain('.git/config');
    expect(seen).toContain('nested/.git/config');
    expect(seen).not.toContain('a.txt');
  });
});

describe('compileGitignoreSet', () => {
  const set = (files: Record<string, string>, infoExclude?: string): PathIgnoreMatcher =>
    compileGitignoreSet(new Map(Object.entries(files)), infoExclude ? { infoExclude } : {});

  it('answers like a walk: nested files, negation, and everything below an ignored directory', () => {
    const m = set({ '': '*.log\nbuild/\n', sub: '!keep.log\n/local\n' }, 'secret\n');
    expect(m('a.log', false)).toBe(true);
    expect(m('sub/a.log', false)).toBe(true);
    expect(m('sub/keep.log', false)).toBe(false);
    expect(m('keep.log', false)).toBe(true);
    expect(m('build', true)).toBe(true);
    expect(m('build', false)).toBe(false);
    expect(m('build/deep/file.txt', false)).toBe(true);
    expect(m('sub/local', false)).toBe(true);
    expect(m('sub/x/local', false)).toBe(false);
    expect(m('secret', false)).toBe(true);
    expect(m('src/secret', false)).toBe(true);
    expect(m('src/main.ts', false)).toBe(false);
  });

  it('never evaluates .git entries', () => {
    const m = set({ '': '*\n' });
    expect(m('.git', true)).toBe(false);
    expect(m('x/.git/config', false)).toBe(false);
    expect(m('x.txt', false)).toBe(true);
  });
});
