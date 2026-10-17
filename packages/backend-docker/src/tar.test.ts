import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import tar from 'tar-stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  extractArchiveSafe,
  makeExcluder,
  packHostPath,
  readFirstEntry,
  tarEntries,
  tarFromEntries,
} from './tar.js';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'abox-tar-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function listArchive(stream: Readable): Promise<
  Array<{
    name: string;
    type: string;
    linkname?: string;
    uid?: number;
    mode?: number;
    data?: string;
  }>
> {
  const out = [];
  for await (const e of tarEntries(stream)) {
    const chunks: Buffer[] = [];
    for await (const c of e) chunks.push(c as Buffer);
    out.push({
      name: e.header.name,
      type: e.header.type,
      ...(e.header.linkname ? { linkname: e.header.linkname } : {}),
      uid: e.header.uid,
      mode: e.header.mode,
      data: Buffer.concat(chunks).toString(),
    });
  }
  return out;
}

async function evil(
  entries: Array<{
    name: string;
    type?: 'file' | 'symlink' | 'directory' | 'link';
    linkname?: string;
    data?: string;
  }>,
): Promise<Readable> {
  const pack = tar.pack();
  for (const e of entries) {
    await new Promise<void>((res, rej) => {
      const h = {
        name: e.name,
        type: e.type ?? 'file',
        linkname: e.linkname,
        mode: e.type === 'directory' ? 0o755 : 0o644,
        size: e.type && e.type !== 'file' ? 0 : (e.data ?? '').length,
      };
      const cb = (err?: Error | null): void => (err ? rej(err) : res());
      if (h.type === 'file') pack.entry(h, e.data ?? '', cb);
      else pack.entry(h, cb);
    });
  }
  pack.finalize();
  return Readable.from(pack);
}

describe('packHostPath', () => {
  it('archives symlinks as symlinks and never reads through them', async () => {
    const outside = path.join(dir, 'outside.txt');
    await fs.writeFile(outside, 'TOP SECRET');
    const src = path.join(dir, 'src');
    await fs.mkdir(path.join(src, 'sub'), { recursive: true });
    await fs.writeFile(path.join(src, 'a.txt'), 'hello');
    await fs.symlink(outside, path.join(src, 'abs-link'));
    await fs.symlink('../outside.txt', path.join(src, 'sub', 'rel-link'));
    await fs.symlink(dir, path.join(src, 'dir-link'));
    const entries = await listArchive(packHostPath(src, 'workspace', { uid: 1234, gid: 1234 }));
    const names = entries.map((e) => e.name);
    expect(names).toContain('workspace/a.txt');
    const abs = entries.find((e) => e.name === 'workspace/abs-link');
    expect(abs?.type).toBe('symlink');
    expect(abs?.linkname).toBe(outside);
    expect(abs?.data).toBe('');
    expect(entries.find((e) => e.name === 'workspace/dir-link')?.type).toBe('symlink');
    expect(names.some((n) => n.startsWith('workspace/dir-link/'))).toBe(false);
    expect(JSON.stringify(entries)).not.toContain('TOP SECRET');
    expect(entries.every((e) => e.uid === 1234)).toBe(true);
  });

  it('rejects a symlink as the source itself', async () => {
    await fs.writeFile(path.join(dir, 't'), 'x');
    await fs.symlink(path.join(dir, 't'), path.join(dir, 'l'));
    await expect(
      listArchive(packHostPath(path.join(dir, 'l'), 'x', { uid: 1, gid: 1 })),
    ).rejects.toThrow(/symlink/);
  });

  it('drops setuid bits, skips fifos and honours excludes', async () => {
    const src = path.join(dir, 's');
    await fs.mkdir(path.join(src, 'node_modules', 'x'), { recursive: true });
    await fs.writeFile(path.join(src, 'node_modules', 'x', 'f'), 'n');
    await fs.writeFile(path.join(src, 'suid'), 'x');
    await fs.chmod(path.join(src, 'suid'), 0o4755);
    await fs.writeFile(path.join(src, 'keep.log'), 'x');
    const entries = await listArchive(
      packHostPath(src, 'w', { uid: 1, gid: 1, exclude: ['node_modules', '*.log'] }),
    );
    const names = entries.map((e) => e.name);
    expect(names).toEqual(['w/', 'w/suid']);
    expect(entries.find((e) => e.name === 'w/suid')?.mode).toBe(0o755);
  });

  it('packs a single file and directory contents at the root', async () => {
    await fs.writeFile(path.join(dir, 'one'), 'content');
    expect(
      (await listArchive(packHostPath(path.join(dir, 'one'), 'renamed', { uid: 5, gid: 5 }))).map(
        (e) => e.name,
      ),
    ).toEqual(['renamed']);
    await fs.mkdir(path.join(dir, 'd'));
    await fs.writeFile(path.join(dir, 'd', 'f'), 'x');
    expect(
      (await listArchive(packHostPath(path.join(dir, 'd'), '', { uid: 0, gid: 0 }))).map(
        (e) => e.name,
      ),
    ).toEqual(['f']);
  });
});

describe('makeExcluder', () => {
  it('matches names at any depth, anchored paths and globs', () => {
    const ex = makeExcluder(['node_modules/', 'build/out', '*.tmp', '/top']);
    expect(ex('node_modules')).toBe(true);
    expect(ex('a/b/node_modules')).toBe(true);
    expect(ex('build/out')).toBe(true);
    expect(ex('x/build/out')).toBe(false);
    expect(ex('deep/f.tmp')).toBe(true);
    expect(ex('top')).toBe(true);
    expect(ex('src/index.ts')).toBe(false);
  });
});

describe('extractArchiveSafe', () => {
  it('extracts a directory, preserving relative symlinks as symlinks', async () => {
    const dest = path.join(dir, 'out');
    await extractArchiveSafe(
      await evil([
        { name: 'ws/', type: 'directory' },
        { name: 'ws/a.txt', data: 'A' },
        { name: 'ws/sub/', type: 'directory' },
        { name: 'ws/sub/link', type: 'symlink', linkname: '../a.txt' },
      ]),
      dest,
    );
    expect(await fs.readFile(path.join(dest, 'a.txt'), 'utf8')).toBe('A');
    expect(await fs.readlink(path.join(dest, 'sub', 'link'))).toBe('../a.txt');
  });

  it('extracts a single file to exactly hostPath', async () => {
    const dest = path.join(dir, 'new', 'name.txt');
    await extractArchiveSafe(await evil([{ name: 'remote.txt', data: 'X' }]), dest);
    expect(await fs.readFile(dest, 'utf8')).toBe('X');
  });

  for (const [label, entries] of [
    [
      '".." traversal',
      [
        { name: 'ws/', type: 'directory' as const },
        { name: 'ws/../../escape.txt', data: 'x' },
      ],
    ],
    ['absolute entry name', [{ name: '/etc/escape.txt', data: 'x' }]],
    [
      'two top-level entries',
      [
        { name: 'a/', type: 'directory' as const },
        { name: 'b/f', data: 'x' },
      ],
    ],
    [
      'absolute symlink target',
      [
        { name: 'ws/', type: 'directory' as const },
        { name: 'ws/l', type: 'symlink' as const, linkname: '/etc/passwd' },
      ],
    ],
    [
      'symlink escaping the root',
      [
        { name: 'ws/', type: 'directory' as const },
        { name: 'ws/l', type: 'symlink' as const, linkname: '../../x' },
      ],
    ],
    [
      'hardlink to outside',
      [
        { name: 'ws/', type: 'directory' as const },
        { name: 'ws/h', type: 'link' as const, linkname: '/etc/passwd' },
      ],
    ],
  ] as const) {
    it(`refuses ${label}`, async () => {
      const dest = path.join(dir, 'out');
      await expect(extractArchiveSafe(await evil([...entries]), dest)).rejects.toMatchObject({
        code: 'policy_denied',
      });
      await expect(fs.access(path.join(dir, 'escape.txt'))).rejects.toThrow();
    });
  }

  it('does not write through a symlink planted earlier in the same archive', async () => {
    const victim = path.join(dir, 'victim');
    await fs.mkdir(victim);
    const dest = path.join(dir, 'out');
    // "sub" is a symlink to ".." (lexically inside), then a file is written below it.
    await expect(
      extractArchiveSafe(
        await evil([
          { name: 'ws/', type: 'directory' },
          { name: 'ws/sub', type: 'symlink', linkname: '..' },
          { name: 'ws/sub/pwn.txt', data: 'x' },
        ]),
        dest,
      ),
    ).rejects.toMatchObject({ code: 'policy_denied' });
    await expect(fs.access(path.join(dir, 'pwn.txt'))).rejects.toThrow();
  });

  it('refuses to extract into a symlinked destination directory component below the root', async () => {
    const dest = path.join(dir, 'out');
    await fs.mkdir(dest);
    await fs.symlink(dir, path.join(dest, 'sub'));
    await expect(
      extractArchiveSafe(
        await evil([
          { name: 'ws/', type: 'directory' },
          { name: 'ws/sub/pwn.txt', data: 'x' },
        ]),
        dest,
      ),
    ).rejects.toMatchObject({ code: 'policy_denied' });
    await expect(fs.access(path.join(dir, 'pwn.txt'))).rejects.toThrow();
  });

  it('replaces an existing symlink target instead of following it', async () => {
    const dest = path.join(dir, 'out');
    await fs.mkdir(dest);
    const outside = path.join(dir, 'outside.txt');
    await fs.writeFile(outside, 'original');
    await fs.symlink(outside, path.join(dest, 'f'));
    await extractArchiveSafe(
      await evil([
        { name: 'ws/', type: 'directory' },
        { name: 'ws/f', data: 'new' },
      ]),
      dest,
    );
    expect(await fs.readFile(outside, 'utf8')).toBe('original');
    expect(await fs.readFile(path.join(dest, 'f'), 'utf8')).toBe('new');
  });
});

describe("extractArchiveSafe with symlinks: 'preserve' (private scratch tree for the export)", () => {
  it('recreates absolute and escaping links as links, without following them', async () => {
    const outside = path.join(dir, 'outside');
    await fs.mkdir(outside);
    const dest = path.join(dir, 'out');
    await extractArchiveSafe(
      await evil([
        { name: 'ws/', type: 'directory' },
        { name: 'ws/abs', type: 'symlink', linkname: outside },
        { name: 'ws/up', type: 'symlink', linkname: '../../x' },
        { name: 'ws/a.txt', data: 'A' },
      ]),
      dest,
      { symlinks: 'preserve' },
    );
    expect(await fs.readlink(path.join(dest, 'abs'))).toBe(outside);
    expect(await fs.readlink(path.join(dest, 'up'))).toBe('../../x');
    expect(await fs.readdir(outside)).toEqual([]);
    expect(await fs.readFile(path.join(dest, 'a.txt'), 'utf8')).toBe('A');
  });

  it('still refuses to write through a link, and an empty target', async () => {
    const outside = path.join(dir, 'outside');
    await fs.mkdir(outside);
    await expect(
      extractArchiveSafe(
        await evil([
          { name: 'ws/', type: 'directory' },
          { name: 'ws/abs', type: 'symlink', linkname: outside },
          { name: 'ws/abs/pwn.txt', data: 'x' },
        ]),
        path.join(dir, 'out'),
        { symlinks: 'preserve' },
      ),
    ).rejects.toMatchObject({ code: 'policy_denied' });
    await expect(fs.access(path.join(outside, 'pwn.txt'))).rejects.toThrow();
    await expect(
      extractArchiveSafe(
        await evil([
          { name: 'ws/', type: 'directory' },
          { name: 'ws/l', type: 'symlink', linkname: '' },
        ]),
        path.join(dir, 'out2'),
        { symlinks: 'preserve' },
      ),
    ).rejects.toMatchObject({ code: 'policy_denied' });
  });

  it('is opt-in: the default still refuses an absolute link', async () => {
    await expect(
      extractArchiveSafe(
        await evil([
          { name: 'ws/', type: 'directory' },
          { name: 'ws/l', type: 'symlink', linkname: '/etc/passwd' },
        ]),
        path.join(dir, 'out'),
      ),
    ).rejects.toMatchObject({ code: 'policy_denied' });
  });
});

describe('extractArchiveSafe: symlink chains', () => {
  // d/sub -> .., s -> d/sub, t -> s/..: each target is inside lexically, together they leave.
  const chain = [
    { name: 'ws/', type: 'directory' as const },
    { name: 'ws/d/', type: 'directory' as const },
    { name: 'ws/d/sub', type: 'symlink' as const, linkname: '..' },
    { name: 'ws/s', type: 'symlink' as const, linkname: 'd/sub' },
    { name: 'ws/t', type: 'symlink' as const, linkname: 's/..' },
  ];

  it('refuses a chain whose end leads out of the destination, and removes the link', async () => {
    const dest = path.join(dir, 'out');
    await expect(extractArchiveSafe(await evil(chain), dest)).rejects.toMatchObject({
      code: 'policy_denied',
      message: expect.stringContaining('through other links'),
    });
    await expect(fs.lstat(path.join(dest, 't'))).rejects.toThrow();
  });

  it('catches it when the redirecting link comes after the one it redirects', async () => {
    const dest = path.join(dir, 'out');
    const [ws, d, sub, s, t] = chain;
    await expect(
      extractArchiveSafe(await evil([ws!, d!, sub!, t!, s!]), dest),
    ).rejects.toMatchObject({ code: 'policy_denied' });
  });

  it('catches a link that goes through a link that points elsewhere inside first', async () => {
    const dest = path.join(dir, 'out');
    await expect(
      extractArchiveSafe(
        await evil([
          { name: 'ws/', type: 'directory' },
          { name: 'ws/a/', type: 'directory' },
          { name: 'ws/a/b/', type: 'directory' },
          { name: 'ws/up', type: 'symlink', linkname: '../..' },
          { name: 'ws/a/b/x', type: 'symlink', linkname: '../../up/..' },
        ]),
        dest,
      ),
    ).rejects.toMatchObject({ code: 'policy_denied' });
  });

  it('keeps harmless chains and links to links', async () => {
    const dest = path.join(dir, 'out');
    await extractArchiveSafe(
      await evil([
        { name: 'ws/', type: 'directory' },
        { name: 'ws/d/', type: 'directory' },
        { name: 'ws/d/f.txt', data: 'F' },
        { name: 'ws/d/self', type: 'symlink', linkname: '.' },
        { name: 'ws/l1', type: 'symlink', linkname: 'd/self/f.txt' },
        { name: 'ws/l2', type: 'symlink', linkname: 'l1' },
        { name: 'ws/loop-a', type: 'symlink', linkname: 'loop-b' },
        { name: 'ws/loop-b', type: 'symlink', linkname: 'loop-a' },
        { name: 'ws/dangling', type: 'symlink', linkname: 'nowhere/further/..' },
      ]),
      dest,
    );
    expect(await fs.readFile(path.join(dest, 'l2'), 'utf8')).toBe('F');
    expect(await fs.readlink(path.join(dest, 'dangling'))).toBe('nowhere/further/..');
  });

  it("leaves the chain alone in 'preserve' mode (private scratch tree, links never followed)", async () => {
    const dest = path.join(dir, 'out');
    await extractArchiveSafe(await evil(chain), dest, { symlinks: 'preserve' });
    expect(await fs.readlink(path.join(dest, 't'))).toBe('s/..');
  });

  it('does not write through any link of the chain', async () => {
    const dest = path.join(dir, 'out');
    await expect(
      extractArchiveSafe(
        await evil([
          { name: 'ws/', type: 'directory' },
          { name: 'ws/d/', type: 'directory' },
          { name: 'ws/d/sub', type: 'symlink', linkname: '..' },
          { name: 'ws/s', type: 'symlink', linkname: 'd/sub' },
          { name: 'ws/s/inside.txt', data: 'x' },
        ]),
        dest,
      ),
    ).rejects.toMatchObject({ code: 'policy_denied' });
    await expect(fs.access(path.join(dest, 'inside.txt'))).rejects.toThrow();
  });
});

describe('extractArchiveSafe: hardlinks', () => {
  const body = 'x'.repeat(1000);
  const withLinks = (
    n: number,
  ): Array<{ name: string; type?: 'link'; linkname?: string; data?: string }> => [
    { name: 'ws/big', data: body },
    ...Array.from({ length: n }, (_, i) => ({
      name: `ws/h${i}`,
      type: 'link' as const,
      linkname: 'ws/big',
    })),
  ];

  it('stores a file with several names once (real hardlinks)', async () => {
    const dest = path.join(dir, 'out');
    await extractArchiveSafe(await evil(withLinks(3)), dest);
    const first = await fs.stat(path.join(dest, 'big'));
    expect(first.nlink).toBe(4);
    expect(await fs.readFile(path.join(dest, 'h2'), 'utf8')).toBe(body);
  });

  it('refuses hardlinks that add up to more than the limit', async () => {
    const dest = path.join(dir, 'out');
    await expect(
      extractArchiveSafe(await evil(withLinks(5)), dest, { maxHardlinkBytes: 2500 }),
    ).rejects.toMatchObject({
      code: 'policy_denied',
      message: expect.stringContaining('hardlinks'),
    });
  });

  it("with 'preserve' the links beyond the limit are left out and reported", async () => {
    const dest = path.join(dir, 'out');
    const skipped: Array<[string, string]> = [];
    await extractArchiveSafe(await evil(withLinks(5)), dest, {
      symlinks: 'preserve',
      maxHardlinkBytes: 2500,
      onSkip: (p, r) => skipped.push([p, r]),
    });
    expect((await fs.readdir(dest)).sort()).toEqual(['big', 'h0', 'h1']);
    expect(skipped.map(([p]) => p)).toEqual(['h2', 'h3', 'h4']);
    expect(skipped[0]?.[1]).toMatch(/hardlink/);
  });

  it("with 'preserve' a hardlink to something that was not extracted is left out, not fatal", async () => {
    const dest = path.join(dir, 'out');
    const skipped: string[] = [];
    await extractArchiveSafe(
      await evil([
        { name: 'ws/', type: 'directory' },
        { name: 'ws/ok.txt', data: 'ok' },
        { name: 'ws/h', type: 'link', linkname: 'ws/fifo-that-was-skipped' },
        { name: 'ws/self', type: 'link', linkname: 'ws/self' },
        { name: 'ws/out', type: 'link', linkname: 'elsewhere/x' },
      ]),
      dest,
      { symlinks: 'preserve', onSkip: (p) => skipped.push(p) },
    );
    expect(skipped.sort()).toEqual(['h', 'out', 'self']);
    expect(await fs.readdir(dest)).toEqual(['ok.txt']);
  });
});

describe('extractArchiveSafe: names with a backslash', () => {
  const entries = [
    { name: 'ws/', type: 'directory' as const },
    { name: 'ws/ok.txt', data: 'ok' },
    { name: 'ws/we\\ird.txt', data: 'bad' },
    { name: 'ws/d\\ir/', type: 'directory' as const },
    { name: 'ws/d\\ir/inner.txt', data: 'bad' },
    { name: 'ws/ln', type: 'link' as const, linkname: 'ws/we\\ird.txt' },
    { name: 'ws/tail.txt', data: 'tail' },
  ];

  it("'preserve' (export): leaves them out, reports them and extracts the rest", async () => {
    const dest = path.join(dir, 'out');
    const skipped: Array<[string, string]> = [];
    await extractArchiveSafe(await evil(entries), dest, {
      symlinks: 'preserve',
      onSkip: (p, r) => skipped.push([p, r]),
    });
    expect((await fs.readdir(dest)).sort()).toEqual(['ok.txt', 'tail.txt']);
    expect(skipped.map(([p]) => p)).toEqual(['we\\ird.txt', 'd\\ir', 'd\\ir/inner.txt', 'ln']);
    expect(skipped[0]?.[1]).toMatch(/backslash/);
  });

  it("'refuse' (copy for the user) still refuses the archive", async () => {
    const dest = path.join(dir, 'out');
    await expect(extractArchiveSafe(await evil(entries), dest)).rejects.toMatchObject({
      code: 'policy_denied',
      message: expect.stringContaining('non-portable'),
    });
  });
});

describe('readFirstEntry', () => {
  it('caps the content and reports the full size', async () => {
    const buf = await tarFromEntries([{ name: 'f', data: Buffer.alloc(10_000, 7) }]);
    const r = await readFirstEntry(Readable.from([buf]), 100);
    expect(r).toMatchObject({ type: 'file', size: 10_000, truncated: true });
    expect(r?.data.length).toBe(100);
  });
});
