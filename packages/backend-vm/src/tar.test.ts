import { execFileSync, spawnSync } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
  chmod,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeExcludeMatcher } from './fsutil.js';
import { extractTar, tarDirectory, tarSingle } from './tar.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'abox-tar-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function collect(it: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of it) parts.push(c);
  return Buffer.concat(parts);
}

async function* chunked(buf: Buffer, size = 700): AsyncGenerator<Buffer> {
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size);
}

// -- hand-made (hostile) archives ----------------------------------------------------------

function header(name: string, type: string, size = 0, linkname = '', mode = 0o644): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100);
  h.write(mode.toString(8).padStart(7, '0') + '\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.fill(0x20, 148, 156);
  h.write(type, 156);
  h.write(linkname, 157, 100);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}
const body = (s: string): Buffer => {
  const b = Buffer.from(s);
  return Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
};
const END = Buffer.alloc(1024);

describe('tar writer and extractor', () => {
  it('round-trips a tree: files, empty dirs, modes, symlinks, long names, binary data', async () => {
    const src = join(root, 'src');
    await mkdir(join(src, 'a', 'b'), { recursive: true });
    await mkdir(join(src, 'empty'));
    await writeFile(join(src, 'top.txt'), 'top');
    await writeFile(join(src, 'a', 'mid.txt'), '');
    const bin = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 256));
    await writeFile(join(src, 'a', 'b', 'data.bin'), bin);
    await writeFile(join(src, 'exec.sh'), '#!/bin/sh\n', { mode: 0o755 });
    await chmod(join(src, 'exec.sh'), 0o755);
    await symlink('a/mid.txt', join(src, 'rel-link'));
    const longDir = 'd'.repeat(90);
    await mkdir(join(src, longDir, longDir), { recursive: true });
    await writeFile(join(src, longDir, longDir, 'f'.repeat(120) + '.txt'), 'long');
    await writeFile(join(src, 'ünï cödé \n newline.txt'), 'u');

    const dest = join(root, 'dest');
    const res = await extractTar(chunked(await collect(tarDirectory(src))), dest);
    expect(res.skipped).toBe(0);
    expect((await readFile(join(dest, 'top.txt'))).toString()).toBe('top');
    expect((await readFile(join(dest, 'a', 'b', 'data.bin'))).equals(bin)).toBe(true);
    expect((await stat(join(dest, 'a', 'mid.txt'))).size).toBe(0);
    expect((await stat(join(dest, 'exec.sh'))).mode & 0o777).toBe(0o755);
    expect(await readlink(join(dest, 'rel-link'))).toBe('a/mid.txt');
    expect((await lstat(join(dest, 'empty'))).isDirectory()).toBe(true);
    expect(await readFile(join(dest, longDir, longDir, 'f'.repeat(120) + '.txt'), 'utf8')).toBe(
      'long',
    );
    expect(await readFile(join(dest, 'ünï cödé \n newline.txt'), 'utf8')).toBe('u');
  });

  it('produces archives that GNU/BSD tar reads (ustar + pax long names)', async () => {
    const src = join(root, 'src');
    await mkdir(join(src, 'x'.repeat(100)), { recursive: true });
    await writeFile(join(src, 'x'.repeat(100), 'y'.repeat(130)), 'data');
    await writeFile(join(src, 'plain'), 'plain');
    await symlink('plain', join(src, 'l'.repeat(110)));
    const tarFile = join(root, 'out.tar');
    await writeFile(tarFile, await collect(tarDirectory(src)));
    const listing = execFileSync('tar', ['-tf', tarFile], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
    expect(listing).toContain('./plain');
    expect(listing).toContain(`./${'x'.repeat(100)}/${'y'.repeat(130)}`);
    const out = join(root, 'extracted');
    await mkdir(out);
    execFileSync('tar', ['-xf', tarFile, '-C', out]);
    expect(await readFile(join(out, 'x'.repeat(100), 'y'.repeat(130)), 'utf8')).toBe('data');
    expect(await readlink(join(out, 'l'.repeat(110)))).toBe('plain');
  });

  it('reads pax archives made by GNU tar (what the guest produces)', async () => {
    const src = join(root, 'guest');
    await mkdir(join(src, 'sub'), { recursive: true });
    await writeFile(join(src, 'sub', 'n'.repeat(150)), 'long-name');
    await writeFile(join(src, 'sub', 'a.txt'), 'a');
    await symlink('a.txt', join(src, 'sub', 'ok'));
    await symlink('/etc/passwd', join(src, 'abs'));
    await symlink('../../outside', join(src, 'sub', 'up'));
    const r = spawnSync(
      'tar',
      ['--format=posix', '--hard-dereference', '-C', src, '-cf', '-', '.'],
      { maxBuffer: 1 << 24 },
    );
    expect(r.status).toBe(0);
    const dest = join(root, 'dest');
    const skipped: string[] = [];
    await extractTar(chunked(r.stdout), dest, { onSkip: (p) => skipped.push(p) });
    expect(await readFile(join(dest, 'sub', 'n'.repeat(150)), 'utf8')).toBe('long-name');
    expect(await readlink(join(dest, 'sub', 'ok'))).toBe('a.txt');
    expect((await readdir(dest)).sort()).toEqual(['sub']); // 'abs' dropped
    expect((await readdir(join(dest, 'sub'))).sort()).toEqual(['a.txt', 'n'.repeat(150), 'ok']);
    expect(skipped.sort()).toEqual(['abs', 'sub/up']);
  });

  it("symlinks: 'preserve' keeps absolute and escaping links (private scratch tree of the export)", async () => {
    const src = join(root, 'guest-links');
    await mkdir(join(src, 'sub'), { recursive: true });
    await symlink('/etc/passwd', join(src, 'abs'));
    await symlink('../../outside', join(src, 'sub', 'up'));
    const r = spawnSync(
      'tar',
      ['--format=posix', '--hard-dereference', '-C', src, '-cf', '-', '.'],
      { maxBuffer: 1 << 24 },
    );
    expect(r.status).toBe(0);
    const dest = join(root, 'dest-links');
    const skipped: string[] = [];
    await extractTar(chunked(r.stdout), dest, {
      symlinks: 'preserve',
      onSkip: (p) => skipped.push(p),
    });
    expect(await readlink(join(dest, 'abs'))).toBe('/etc/passwd');
    expect(await readlink(join(dest, 'sub', 'up'))).toBe('../../outside');
    expect(skipped).toEqual([]);
  });

  it('single-file mode writes the entry to the destination path', async () => {
    await writeFile(join(root, 'one.bin'), 'x'.repeat(1500), { mode: 0o640 });
    const dest = join(root, 'copy.bin');
    await writeFile(dest, 'old');
    await extractTar(chunked(await collect(tarSingle(join(root, 'one.bin'), 'whatever'))), dest, {
      singleFile: true,
    });
    expect(await readFile(dest, 'utf8')).toBe('x'.repeat(1500));
    expect((await stat(dest)).mode & 0o777).toBe(0o640);
  });

  describe('hostile archives', () => {
    const extract = (parts: Buffer[], dest = join(root, 'dest')): ReturnType<typeof extractTar> =>
      extractTar(chunked(Buffer.concat(parts)), dest);

    it('rejects absolute paths and parent traversal', async () => {
      await expect(extract([header('/etc/evil', '0', 1), body('x'), END])).rejects.toThrow(
        /unsafe path/,
      );
      await expect(extract([header('../evil', '0', 1), body('x'), END])).rejects.toThrow(
        /unsafe path/,
      );
      await expect(extract([header('a/../../evil', '0', 1), body('x'), END])).rejects.toThrow(
        /unsafe path/,
      );
      await expect(readFile(join(root, 'evil'))).rejects.toThrow();
    });

    it('never writes through a symlink that was created earlier in the same archive', async () => {
      const outside = join(root, 'outside');
      await mkdir(outside);
      // Absolute and escaping symlinks are not materialized at all, so 'l/pwn' becomes a plain
      // directory entry inside the destination instead of landing in `outside`.
      const dest = join(root, 'dest');
      await extractTar(
        chunked(
          Buffer.concat([header('l', '2', 0, outside), header('l/pwn', '0', 1), body('x'), END]),
        ),
        dest,
      );
      expect(await readdir(outside)).toEqual([]);
      expect((await lstat(join(dest, 'l'))).isDirectory()).toBe(true);
      const dest2 = join(root, 'dest2');
      await extractTar(
        chunked(
          Buffer.concat([
            header('d/', '5'),
            header('d/l', '2', 0, '../..'),
            header('d/l/pwn', '0', 1),
            body('x'),
            END,
          ]),
        ),
        dest2,
      );
      expect(await readdir(outside)).toEqual([]);
      expect((await lstat(join(dest2, 'd', 'l'))).isDirectory()).toBe(true);
      // a symlink that is allowed (inside the tree) must still not be walked through when it points at a file
      await expect(
        extractTar(
          chunked(
            Buffer.concat([
              header('f', '0', 1),
              body('x'),
              header('f/inner', '0', 1),
              body('y'),
              END,
            ]),
          ),
          join(root, 'dest3'),
        ),
      ).rejects.toThrow(/non-directory/);
    });

    it('does not follow a pre-existing destination symlink for files', async () => {
      const dest = join(root, 'dest');
      await mkdir(dest);
      await writeFile(join(root, 'victim'), 'safe');
      await symlink(join(root, 'victim'), join(dest, 'f'));
      await extract([header('f', '0', 3), body('bad'), END], dest);
      expect(await readFile(join(root, 'victim'), 'utf8')).toBe('safe'); // the link was replaced, not followed
      expect(await readFile(join(dest, 'f'), 'utf8')).toBe('bad');
    });

    it('drops setuid/setgid bits, devices, fifos and hard links', async () => {
      const skipped: string[] = [];
      const dest = join(root, 'dest');
      await extractTar(
        chunked(
          Buffer.concat([
            header('suid', '0', 1, '', 0o4755),
            body('x'),
            header('dev', '3'),
            header('fifo', '6'),
            header('hard', '1', 0, 'suid'),
            END,
          ]),
        ),
        dest,
        { onSkip: (p) => skipped.push(p) },
      );
      expect((await stat(join(dest, 'suid'))).mode & 0o7777).toBe(0o755);
      expect(skipped.sort()).toEqual(['dev', 'fifo', 'hard']);
      expect((await readdir(dest)).sort()).toEqual(['suid']);
    });

    describe('symlink chains', () => {
      // d/sub -> .., s -> d/sub, t -> s/..: each target is inside lexically, together they leave.
      const chain = [
        header('d/', '5'),
        header('d/sub', '2', 0, '..'),
        header('s', '2', 0, 'd/sub'),
        header('t', '2', 0, 's/..'),
      ];

      it('drops the link whose chain leads out of the destination, keeps the others', async () => {
        const dest = join(root, 'dest');
        const skipped: string[] = [];
        const res = await extractTar(chunked(Buffer.concat([...chain, END])), dest, {
          onSkip: (p) => skipped.push(p),
        });
        expect(skipped).toEqual(['t']);
        await expect(lstat(join(dest, 't'))).rejects.toThrow();
        expect(await readlink(join(dest, 's'))).toBe('d/sub');
        expect(res.symlinks).toBe(2);
      });

      it('catches it when the redirecting link is made after the one it redirects', async () => {
        const dest = join(root, 'dest');
        const [d, sub, s, t] = chain as [Buffer, Buffer, Buffer, Buffer];
        const skipped: string[] = [];
        await extractTar(chunked(Buffer.concat([d, sub, t, s, END])), dest, {
          onSkip: (p) => skipped.push(p),
        });
        expect(skipped).toEqual(['t']);
        await expect(lstat(join(dest, 't'))).rejects.toThrow();
      });

      it("keeps everything in 'preserve' mode (scratch tree, links never followed)", async () => {
        const dest = join(root, 'dest');
        const skipped: string[] = [];
        await extractTar(chunked(Buffer.concat([...chain, END])), dest, {
          symlinks: 'preserve',
          onSkip: (p) => skipped.push(p),
        });
        expect(await readlink(join(dest, 't'))).toBe('s/..');
        expect(skipped).toEqual([]);
      });

      it('keeps harmless chains, loops and dangling links', async () => {
        const dest = join(root, 'dest');
        const skipped: string[] = [];
        await extractTar(
          chunked(
            Buffer.concat([
              header('d/', '5'),
              header('d/f', '0', 1),
              body('F'),
              header('d/self', '2', 0, '.'),
              header('l1', '2', 0, 'd/self/f'),
              header('l2', '2', 0, 'l1'),
              header('a', '2', 0, 'b'),
              header('b', '2', 0, 'a'),
              header('dangling', '2', 0, 'nowhere/further/..'),
              END,
            ]),
          ),
          dest,
          { onSkip: (p) => skipped.push(p) },
        );
        expect(skipped).toEqual([]);
        expect(await readFile(join(dest, 'l2'), 'utf8')).toBe('F');
      });
    });

    it('leaves out names with a backslash and extracts the rest', async () => {
      const dest = join(root, 'dest');
      const skipped: string[] = [];
      await extractTar(
        chunked(
          Buffer.concat([
            header('./ok.txt', '0', 2),
            body('ok'),
            header('./we\\ird.txt', '0', 3),
            body('bad'),
            header('./d\\ir/', '5'),
            header('./d\\ir/inner', '0', 3),
            body('bad'),
            header('./tail.txt', '0', 4),
            body('tail'),
            END,
          ]),
        ),
        dest,
        { onSkip: (p, why) => skipped.push(`${p}: ${why}`) },
      );
      expect((await readdir(dest)).sort()).toEqual(['ok.txt', 'tail.txt']);
      expect(skipped.map((x) => x.split(':')[0])).toEqual(['we\\ird.txt', 'd\\ir/', 'd\\ir/inner']);
      expect(skipped[0]).toMatch(/backslash/);
    });

    it('still writes a single file whose own name has a backslash to the destination', async () => {
      await writeFile(join(root, 'we\\ird'), 'single');
      const dest = join(root, 'copy');
      await extractTar(chunked(await collect(tarSingle(join(root, 'we\\ird'), 'we\\ird'))), dest, {
        singleFile: true,
      });
      expect(await readFile(dest, 'utf8')).toBe('single');
    });

    it('enforces the size limit and detects truncated streams', async () => {
      await expect(
        extractTar(
          chunked(Buffer.concat([header('big', '0', 2000), body('x'.repeat(2000)), END])),
          join(root, 'd1'),
          { maxBytes: 1000 },
        ),
      ).rejects.toThrow(/larger than/);
      await expect(
        extractTar(
          chunked(Buffer.concat([header('cut', '0', 2000), Buffer.alloc(100)])),
          join(root, 'd2'),
        ),
      ).rejects.toThrow(/unexpected end/);
    });

    it('fills read-only directories first; the owner always keeps rwx so the copy stays usable', async () => {
      const dest = join(root, 'dest');
      await extract(
        [header('ro/', '5', 0, '', 0o555), header('ro/f', '0', 1), body('x'), END],
        dest,
      );
      expect(await readFile(join(dest, 'ro', 'f'), 'utf8')).toBe('x');
      expect((await stat(join(dest, 'ro'))).mode & 0o777).toBe(0o755);
    });
  });
});

describe('makeExcludeMatcher', () => {
  it('matches names at any depth and anchored paths', () => {
    const m = makeExcludeMatcher(['node_modules', '*.log', 'build/cache', '/top']);
    expect(m('node_modules')).toBe(true);
    expect(m('a/b/node_modules/x')).toBe(true);
    expect(m('x/y.log')).toBe(true);
    expect(m('build/cache')).toBe(true);
    expect(m('build/cache/deep/file')).toBe(true);
    expect(m('build/other')).toBe(false);
    expect(m('sub/build/cache')).toBe(false);
    expect(m('top/a')).toBe(true);
    expect(m('src/main.ts')).toBe(false);
    expect(makeExcludeMatcher(undefined)('anything')).toBe(false);
    expect(makeExcludeMatcher([])('anything')).toBe(false);
  });
});
