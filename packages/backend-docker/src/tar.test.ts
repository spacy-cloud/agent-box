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

describe('readFirstEntry', () => {
  it('caps the content and reports the full size', async () => {
    const buf = await tarFromEntries([{ name: 'f', data: Buffer.alloc(10_000, 7) }]);
    const r = await readFirstEntry(Readable.from([buf]), 100);
    expect(r).toMatchObject({ type: 'file', size: 10_000, truncated: true });
    expect(r?.data.length).toBe(100);
  });
});
