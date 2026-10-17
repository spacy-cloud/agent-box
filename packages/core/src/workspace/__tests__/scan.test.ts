import { symlink, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AboxError } from '../../errors.js';
import { compileExcludes } from '../glob.js';
import { prepareWorkspace } from '../prepare.js';
import {
  copyLimitError,
  describeScan,
  formatCount,
  scanTree,
  WORKSPACE_COPY_LIMITS,
} from '../scan.js';
import { tmp, useTempCleanup, write } from './helpers.js';

useTempCleanup();

const GIB = 1024 ** 3;

/** `count` sparse files of `size` bytes each (truncate: no data is written, the walk sees the apparent size). */
async function sparseFiles(dir: string, count: number, size: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const p = join(dir, `big-${i}.bin`);
    await write(p, '');
    await truncate(p, size);
  }
}

describe('scanTree', () => {
  it('counts files, directories, links and bytes without reading anything', async () => {
    const root = await tmp();
    await write(join(root, 'a.txt'), 'abc');
    await write(join(root, 'd/b.txt'), 'hello');
    await write(join(root, 'd/e/c.txt'), '');
    await symlink('a.txt', join(root, 'link'));
    const r = await scanTree(root);
    expect(r).toMatchObject({
      files: 3,
      bytes: 8,
      directories: 2,
      symlinks: 1,
      entries: 6,
      skipped: 0,
      excluded: 0,
    });
    expect(r.stoppedBy).toBeUndefined();
    expect(describeScan(r)).toBe('3 files, 8 B');
  });

  it('never follows symbolic links: a link to a huge directory counts as one entry', async () => {
    const root = await tmp();
    const outside = await tmp();
    await sparseFiles(outside, 3, GIB);
    await write(join(outside, 'sub/x'), 'x');
    await symlink(outside, join(root, 'dirlink'));
    await symlink(join(outside, 'big-0.bin'), join(root, 'filelink'));
    await write(join(root, 'own.txt'), '12');
    const r = await scanTree(root);
    expect(r.bytes).toBe(2);
    expect(r.files).toBe(1);
    expect(r.symlinks).toBe(2);
    expect(r.directories).toBe(0);
  });

  it('applies the exclude patterns of the copy and the .git mode', async () => {
    const root = await tmp();
    await write(join(root, 'src/a.ts'), 'aa');
    await write(join(root, 'node_modules/x/index.js'), 'x'.repeat(1000));
    await write(join(root, 'debug.log'), 'l');
    await write(join(root, '.git/config'), 'cfg');
    const all = await scanTree(root);
    expect(all.bytes).toBe(2 + 1000 + 1 + 3);
    const some = await scanTree(root, { exclude: compileExcludes(['node_modules', '*.log']) });
    expect(some.bytes).toBe(2 + 3);
    expect(some.excluded).toBe(2);
    const noGit = await scanTree(root, { gitMode: 'skip' });
    expect(noGit.bytes).toBe(2 + 1000 + 1);
  });

  it('skips files the copy would skip (larger than the per-file limit) and special files', async () => {
    const root = await tmp();
    await write(join(root, 'ok'), 'ok');
    await sparseFiles(root, 1, 100);
    const r = await scanTree(root, { maxFileBytes: 50 });
    expect(r.files).toBe(1);
    expect(r.skipped).toBe(1);
  });

  it('stops at once when the byte limit is exceeded, without walking the rest', async () => {
    const root = await tmp();
    // 20 sparse files of 4 GiB (apparent): 80 GiB > the 64 GiB hard limit, plus a wide tree behind it
    await sparseFiles(root, 20, 4 * GIB - 1);
    for (let i = 0; i < 300; i++) await write(join(root, `later/d${i}/f.txt`), 'x');
    const started = Date.now();
    const r = await scanTree(root);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r.stoppedBy).toBe('bytes');
    expect(r.bytes).toBeGreaterThan(WORKSPACE_COPY_LIMITS.maxTotalBytes);
    // the 300 directories behind the files were not visited
    expect(r.directories).toBeLessThan(300);
  });

  it('stops when the entry limit is exceeded and reports lower bounds', async () => {
    const root = await tmp();
    for (let i = 0; i < 40; i++) await write(join(root, `d${i}/f.txt`), 'x');
    const r = await scanTree(root, { stopAbove: { entries: 10 } });
    expect(r.stoppedBy).toBe('entries');
    expect(r.entries).toBeGreaterThan(10);
    expect(r.entries).toBeLessThan(80);
  });

  it('stops at an excessive depth', async () => {
    const root = await tmp();
    await write(join(root, 'a/b/c/d/e/f.txt'), 'x');
    const r = await scanTree(root, { maxDepth: 2 });
    expect(r.stoppedBy).toBe('depth');
  });

  it('reports progress and the final numbers', async () => {
    const root = await tmp();
    for (let i = 0; i < 5; i++) await write(join(root, `d${i}/f.txt`), '12345');
    const seen: Array<{ files: number; bytes: number }> = [];
    const r = await scanTree(root, { progressIntervalMs: 0, onProgress: (p) => seen.push(p) });
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.at(-1)).toMatchObject({ files: 5, bytes: 25 });
    expect(r.files).toBe(5);
  });

  it('can be cancelled', async () => {
    const root = await tmp();
    await write(join(root, 'a'), 'a');
    const ctl = new AbortController();
    ctl.abort();
    await expect(scanTree(root, { signal: ctl.signal })).rejects.toMatchObject({
      message: 'create cancelled',
    });
  });

  it('a missing root is an error, an unreadable subdirectory is only skipped', async () => {
    await expect(scanTree(join(await tmp(), 'nope'))).rejects.toThrow();
  });
});

describe('copy limit message', () => {
  it('names the folder, the size found so far and the limit in human units, and says what to do', () => {
    const e = copyLimitError(
      '/home/u/big',
      {
        entries: 10,
        files: 9,
        bytes: 65 * GIB,
        directories: 1,
        symlinks: 0,
        skipped: 0,
        excluded: 0,
        durationMs: 5,
        stoppedBy: 'bytes',
      },
      'copy',
    );
    expect(e).toBeInstanceOf(AboxError);
    expect(e.code).toBe('invalid_input');
    expect(e.message).toBe(
      'workspace folder /home/u/big is larger than the copy limit (65 GiB found so far, limit 64 GiB)',
    );
    expect(e.hint).toContain('Choose the project folder itself');
    expect(e.hint).toContain('"mount" or "clone"');
    expect(e.hint).toContain('--exclude node_modules');
    // not the export-direction wording
    expect(`${e.message} ${e.hint}`).not.toContain('sandbox produced');
    expect(`${e.message} ${e.hint}`).not.toContain('68719476736');
  });

  it('entry limit and number formatting', () => {
    const e = copyLimitError('/x', {
      entries: 2_000_001,
      files: 0,
      bytes: 0,
      directories: 0,
      symlinks: 0,
      skipped: 0,
      excluded: 0,
      durationMs: 1,
      stoppedBy: 'entries',
    });
    expect(e.message).toContain('2 000 001 entries found so far, limit 2 000 000');
    expect(formatCount(1234567)).toBe('1 234 567');
  });
});

describe('prepareWorkspace (copy): fast failure and feedback', () => {
  const common = { access: 'rw' as const, remote: false, sandboxPath: '/workspace' };

  it('fails within seconds for a folder beyond the hard limit, before anything is copied', async () => {
    const root = await tmp();
    const src = join(root, 'huge');
    await sparseFiles(src, 18, 4 * GIB - 1);
    const sandboxDir = join(root, 'sb', 'ab12cd34');
    const lines: string[] = [];
    const started = Date.now();
    const err = await prepareWorkspace({
      ...common,
      mode: 'copy',
      source: src,
      sandboxDir,
      onProgress: (l) => lines.push(l),
    }).catch((e: unknown) => e);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(err).toBeInstanceOf(AboxError);
    expect((err as AboxError).code).toBe('invalid_input');
    expect((err as AboxError).message).toMatch(
      /^workspace folder .*huge is larger than the copy limit \(\d+ GiB found so far, limit 64 GiB\)$/,
    );
    expect(lines.some((l) => l.startsWith('workspace: '))).toBe(true);
    // nothing was copied (the staging directory was never created)
    await expect(
      import('node:fs/promises').then((f) => f.stat(join(sandboxDir, 'staging'))),
    ).rejects.toThrow();
  });

  it('emits scan, copy and baseline progress with byte numbers', async () => {
    const root = await tmp();
    const src = join(root, 'proj');
    await write(join(src, 'a.txt'), 'a'.repeat(2048));
    await write(join(src, 'b/c.txt'), 'c'.repeat(4096));
    const lines: Array<{ line: string; info?: unknown }> = [];
    await prepareWorkspace({
      ...common,
      mode: 'copy',
      source: src,
      sandboxDir: join(root, 'sb', 'ab12cd34'),
      onProgress: (line, info) => lines.push({ line, info }),
    });
    const text = lines.map((l) => l.line);
    expect(text).toContain('workspace: 2 files, 6.0 KiB');
    expect(text).toContain('copied workspace: 2 files, 6.0 KiB');
    const copied = lines.find((l) => l.line.startsWith('copied workspace'));
    expect(copied?.info).toEqual({ phase: 'copy', done: 6144, total: 6144 });
  });

  it('reuses a scan taken by the caller and honours the exclude patterns', async () => {
    const root = await tmp();
    const src = join(root, 'proj');
    await write(join(src, 'a.txt'), 'a');
    await write(join(src, 'node_modules/m.js'), 'm'.repeat(5000));
    const lines: string[] = [];
    await prepareWorkspace({
      ...common,
      mode: 'copy',
      source: src,
      exclude: ['node_modules'],
      sandboxDir: join(root, 'sb', 'ab12cd34'),
      onProgress: (l) => lines.push(l),
    });
    expect(lines).toContain('workspace: 1 file, 1 B');
  });

  it('is cancelled by the signal and rolls back', async () => {
    const root = await tmp();
    const src = join(root, 'proj');
    await write(join(src, 'a.txt'), 'a');
    const ctl = new AbortController();
    ctl.abort();
    const sandboxDir = join(root, 'sb', 'ab12cd34');
    await expect(
      prepareWorkspace({ ...common, mode: 'copy', source: src, sandboxDir, signal: ctl.signal }),
    ).rejects.toMatchObject({ message: 'create cancelled' });
    await expect(
      import('node:fs/promises').then((f) => f.stat(join(sandboxDir, 'staging'))),
    ).rejects.toThrow();
  });

  it('a non-git mount that would need a baseline snapshot beyond the limit fails fast with its own hint', async () => {
    const root = await tmp();
    const src = join(root, 'huge');
    await sparseFiles(src, 18, 4 * GIB - 1);
    const err = (await prepareWorkspace({
      ...common,
      mode: 'mount',
      source: src,
      sandboxDir: join(root, 'sb', 'ab12cd34'),
    }).catch((e: unknown) => e)) as AboxError;
    expect(err.code).toBe('invalid_input');
    expect(err.message).toContain('larger than the limit for a baseline snapshot');
    expect(err.hint).toContain('Mount a git repository');
  });
});
