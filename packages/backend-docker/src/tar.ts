import { constants as fsc, createWriteStream, type Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import tar from 'tar-stream';
import { AboxError } from '@abox/core';

type HeaderArg = Parameters<tar.Pack['entry']>[0];
type TarSource = tar.Extract extends AsyncIterable<infer S> ? S : never;

// ---------------------------------------------------------------------------
// Small in-memory archives
// ---------------------------------------------------------------------------

export interface MemEntry {
  /** Path inside the archive (relative). */
  name: string;
  type?: 'file' | 'directory';
  data?: Buffer;
  mode?: number;
  uid?: number;
  gid?: number;
}

/** Build a tar archive from in-memory entries. */
export async function tarFromEntries(entries: MemEntry[]): Promise<Buffer> {
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  const done = (async () => {
    for await (const c of pack) chunks.push(c as Buffer);
  })();
  for (const e of entries) {
    const header: HeaderArg = {
      name: e.type === 'directory' && !e.name.endsWith('/') ? `${e.name}/` : e.name,
      type: e.type ?? 'file',
      mode: e.mode ?? (e.type === 'directory' ? 0o755 : 0o644),
      uid: e.uid ?? 0,
      gid: e.gid ?? 0,
      mtime: new Date(),
    };
    if (e.type === 'directory') {
      await new Promise<void>((res, rej) => pack.entry(header, (err) => (err ? rej(err) : res())));
    } else {
      const data = e.data ?? Buffer.alloc(0);
      header.size = data.length;
      await new Promise<void>((res, rej) =>
        pack.entry(header, data, (err) => (err ? rej(err) : res())),
      );
    }
  }
  pack.finalize();
  await done;
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Host -> archive (never follows symlinks)
// ---------------------------------------------------------------------------

/** gitignore-lite matcher: `name` (any depth), `a/b` (from the root), `*`, `**`, `?`; trailing `/` ignored. */
export function makeExcluder(patterns: string[] | undefined): (rel: string) => boolean {
  const list = (patterns ?? [])
    .map((p) => p.trim().replace(/^\.\//, '').replace(/\/+$/, ''))
    .filter((p) => p.length > 0 && !p.startsWith('#'));
  const rx = list.map((p) => {
    const anchored = p.includes('/');
    const body = p
      .replace(/^\//, '')
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '\uE000')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]')
      .replace(/\uE000/g, '.*');
    return new RegExp(anchored ? `^${body}$` : `(^|/)${body}$`);
  });
  return (rel) => rx.some((r) => r.test(rel));
}

export interface PackOptions {
  uid: number;
  gid: number;
  exclude?: string[];
}

/**
 * Archive a host file or directory under the name `destName` (empty: the directory's content at
 * the archive root).
 * Symlinks are archived as symlinks and never followed; files are opened with O_NOFOLLOW and
 * verified after opening, so nothing outside `hostPath` is ever read. Sockets, FIFOs and devices
 * are skipped. setuid/setgid bits are dropped. All entries are owned by `opts.uid:opts.gid`.
 */
export function packHostPath(hostPath: string, destName: string, opts: PackOptions): Readable {
  const pack = tar.pack();
  const excluded = makeExcluder(opts.exclude);
  const ownership = { uid: opts.uid, gid: opts.gid, uname: '', gname: '' };

  const addNode = async (abs: string, name: string, rel: string, st: Stats): Promise<void> => {
    if (st.isDirectory()) {
      if (name !== '') {
        await new Promise<void>((res, rej) =>
          pack.entry(
            {
              name: `${name}/`,
              type: 'directory',
              mode: st.mode & 0o1777,
              mtime: st.mtime,
              ...ownership,
            },
            (err) => (err ? rej(err) : res()),
          ),
        );
      }
      const children = (await fs.readdir(abs)).sort();
      for (const child of children) {
        const childRel = rel ? `${rel}/${child}` : child;
        if (excluded(childRel)) continue;
        const childAbs = path.join(abs, child);
        let cst;
        try {
          cst = await fs.lstat(childAbs);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; // vanished
          throw e;
        }
        await addNode(childAbs, name ? `${name}/${child}` : child, childRel, cst);
      }
    } else if (st.isSymbolicLink()) {
      const linkname = await fs.readlink(abs);
      await new Promise<void>((res, rej) =>
        pack.entry(
          { name, type: 'symlink', linkname, mode: 0o777, mtime: st.mtime, ...ownership },
          (err) => (err ? rej(err) : res()),
        ),
      );
    } else if (st.isFile()) {
      let fh;
      try {
        fh = await fs.open(abs, fsc.O_RDONLY | fsc.O_NOFOLLOW);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'ELOOP' || code === 'ENOENT') return; // replaced by a symlink / vanished meanwhile
        throw e;
      }
      try {
        const fst = await fh.stat();
        if (!fst.isFile() || fst.ino !== st.ino || fst.dev !== st.dev) return; // swapped under us
        const size = fst.size;
        const entry = pack.entry(
          { name, type: 'file', size, mode: fst.mode & 0o1777, mtime: fst.mtime, ...ownership },
          () => undefined,
        );
        const finished = new Promise<void>((res, rej) => {
          entry.once('finish', res);
          entry.once('error', rej);
          entry.once('close', () => rej(new Error('Archive stream closed before the entry ended')));
        });
        finished.catch(() => undefined); // handled below (or by the pack.destroy in the catch-all)
        let remaining = size;
        const buf = Buffer.allocUnsafe(Math.min(Math.max(size, 1), 256 * 1024));
        while (remaining > 0) {
          const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, remaining), null);
          const chunk =
            bytesRead > 0
              ? Buffer.from(buf.subarray(0, bytesRead))
              : Buffer.alloc(Math.min(buf.length, remaining));
          remaining -= chunk.length; // a file that shrank is zero-padded to its declared size
          if (!entry.write(chunk)) await drained(entry);
          if (entry.destroyed) throw new Error('Archive stream closed before the entry ended');
        }
        entry.end(undefined);
        await finished;
      } finally {
        await fh.close();
      }
    }
    // sockets, FIFOs, devices: skipped
  };

  void (async () => {
    try {
      const st = await fs.lstat(hostPath);
      if (st.isSymbolicLink()) {
        throw new AboxError('invalid_input', `Refusing to copy a symlink as source: ${hostPath}`, {
          hint: 'Pass the real path of the file or directory.',
        });
      }
      const name = destName.replace(/^\/+/, '').replace(/\/+$/, '');
      await addNode(hostPath, name, '', st);
      pack.finalize();
    } catch (e) {
      pack.destroy(e instanceof Error ? e : new Error(String(e)));
    }
  })();
  return Readable.from(pack);
}

// ---------------------------------------------------------------------------
// Archive iteration
// ---------------------------------------------------------------------------

/** Resolve when `stream` can take more data, or has been destroyed/errored (never hangs). */
function drained(stream: NodeJS.WritableStream): Promise<void> {
  return new Promise<void>((resolve) => {
    const events = ['drain', 'close', 'error'];
    const done = (): void => {
      for (const ev of events) stream.removeListener(ev, done);
      resolve();
    };
    for (const ev of events) stream.once(ev, done);
  });
}

/**
 * Iterate over the entries of a tar stream. Each entry must be consumed before advancing.
 *
 * The feeding loop must always settle: when the consumer stops early (a rejected entry, `return()`)
 * the extractor is destroyed while the feeder may be waiting for a `drain` that will then never
 * come. Waiting therefore also ends on `close`/`error`, and the loop stops once the extractor is
 * gone. (Whether a destroyed streamx stream still emits `drain` differs between Node versions.)
 */
export async function* tarEntries(source: Readable): AsyncGenerator<TarSource> {
  const extract = tar.extract();
  const feed = (async () => {
    try {
      for await (const chunk of source) {
        if (extract.destroyed) break;
        if (!extract.write(chunk as Buffer)) await drained(extract);
        if (extract.destroyed) break;
      }
      if (!extract.destroyed) extract.end(undefined);
    } catch (e) {
      extract.destroy(e instanceof Error ? e : new Error(String(e)));
    }
  })();
  try {
    for await (const entry of extract) yield entry;
  } finally {
    source.destroy();
    extract.destroy();
    await feed;
  }
}

/** Drain a stream completely. */
async function drain(s: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of s) void _;
}

/**
 * Rewrite the ownership of every entry of an archive to `uid:gid` (names, modes, links and content
 * stay as they are). Used to hand an image directory such as the home to another numeric user
 * without needing any capability inside the container. Errors of `source` surface on the result.
 */
export function reownArchive(source: Readable, ids: { uid: number; gid: number }): Readable {
  const pack = tar.pack();
  void (async () => {
    try {
      for await (const entry of tarEntries(source)) {
        const h = { ...entry.header, uid: ids.uid, gid: ids.gid, uname: '', gname: '' };
        const isFile = h.type === 'file' || h.type === 'contiguous-file' || !h.type;
        if (!isFile || !h.size) {
          await drain(entry);
          await new Promise<void>((res, rej) =>
            pack.entry({ ...h, size: 0 }, (err) => (err ? rej(err) : res())),
          );
          continue;
        }
        const out = pack.entry(h, () => undefined);
        const finished = new Promise<void>((res, rej) => {
          out.once('finish', res);
          out.once('error', rej);
          out.once('close', () => rej(new Error('Archive stream closed before the entry ended')));
        });
        finished.catch(() => undefined);
        for await (const chunk of entry) {
          if (!out.write(chunk as Buffer)) await drained(out);
          if (out.destroyed) throw new Error('Archive stream closed before the entry ended');
        }
        out.end(undefined);
        await finished;
      }
      pack.finalize();
    } catch (e) {
      pack.destroy(e instanceof Error ? e : new Error(String(e)));
    }
  })();
  return Readable.from(pack);
}

export interface SingleFile {
  type: 'file' | 'symlink' | 'directory' | 'other';
  size: number;
  mode: number;
  /** Owner of the entry as recorded in the archive. */
  uid: number;
  linkname?: string;
  /** First `maxBytes` of the content (files only). */
  data: Buffer;
  truncated: boolean;
}

/** Read the first entry of an archive, at most `maxBytes` of content. Aborts the stream afterwards. */
export async function readFirstEntry(
  source: Readable,
  maxBytes: number,
): Promise<SingleFile | undefined> {
  const gen = tarEntries(source);
  try {
    const { value: entry, done } = await gen.next();
    if (done || !entry) return undefined;
    const h = entry.header;
    if (
      h.type === 'file' ||
      h.type === 'contiguous-file' ||
      h.type === undefined ||
      h.type === null
    ) {
      const size = h.size ?? 0;
      const chunks: Buffer[] = [];
      let got = 0;
      for await (const c of entry) {
        const b = c as Buffer;
        if (got < maxBytes) {
          const take = b.subarray(0, maxBytes - got);
          chunks.push(take);
          got += take.length;
        }
        if (got >= maxBytes) break;
      }
      return {
        type: 'file',
        size,
        mode: h.mode ?? 0,
        uid: h.uid ?? 0,
        data: Buffer.concat(chunks),
        truncated: size > got,
      };
    }
    const base = {
      size: h.size ?? 0,
      mode: h.mode ?? 0,
      uid: h.uid ?? 0,
      data: Buffer.alloc(0),
      truncated: false,
    };
    await drain(entry);
    if (h.type === 'symlink') return { type: 'symlink', linkname: h.linkname ?? '', ...base };
    if (h.type === 'directory') return { type: 'directory', ...base };
    return { type: 'other', ...base };
  } finally {
    await gen.return(undefined).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Archive -> host (safe extraction)
// ---------------------------------------------------------------------------

function escapes(msg: string): AboxError {
  return new AboxError('policy_denied', `Refusing to extract archive: ${msg}`, {
    hint: 'The sandbox produced an archive entry that would write or link outside the destination.',
  });
}

/** Split and validate an archive entry name; returns its segments (without empty and `.`). */
function entrySegments(name: string): string[] {
  if (name.includes('\0')) throw escapes('NUL in entry name');
  if (name.startsWith('/') || /^[A-Za-z]:[\\/]/.test(name) || name.includes('\\'))
    throw escapes(`absolute or non-portable entry name "${name}"`);
  const segs = name.split('/').filter((s) => s !== '' && s !== '.');
  if (segs.some((s) => s === '..')) throw escapes(`entry name "${name}" contains ".."`);
  return segs;
}

async function lstatOrUndefined(p: string): Promise<Stats | undefined> {
  try {
    return await fs.lstat(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

/**
 * Extract an archive produced by the engine for ONE path into `hostPath`: the single top-level
 * entry of the archive becomes `hostPath` itself (a directory's content is merged into it).
 *
 * Safety: entry names must be relative without `..`; every ancestor directory below the root is
 * checked with lstat to be a real directory (never a symlink), so an earlier symlink entry can
 * never redirect a later write; files are created with O_EXCL after removing what was there;
 * symlinks must be relative and stay inside the destination; hardlinks are copied; special
 * files are skipped; setuid/setgid bits are dropped.
 */
export async function extractArchiveSafe(source: Readable, hostPath: string): Promise<void> {
  const dest = path.resolve(hostPath);
  let top: string | undefined;
  let rootKind: 'dir' | 'file' | undefined;
  let rootReal = '';
  const dirModes: Array<{ p: string; mode: number; mtime: Date | undefined }> = [];

  const ensureRootDir = async (): Promise<void> => {
    const st = await lstatOrUndefined(dest);
    if (st && !st.isDirectory()) {
      if (st.isSymbolicLink()) throw escapes(`destination ${dest} is a symlink`);
      throw new AboxError('conflict', `Destination exists and is not a directory: ${dest}`);
    }
    if (!st) await fs.mkdir(dest, { recursive: true, mode: 0o755 });
    rootReal = await fs.realpath(dest);
  };

  const safeParent = async (segs: string[]): Promise<string> => {
    // Walk all ancestors under the root; none may be a symlink.
    let cur = rootReal;
    for (const seg of segs.slice(0, -1)) {
      cur = path.join(cur, seg);
      const st = await lstatOrUndefined(cur);
      if (!st) await fs.mkdir(cur, { mode: 0o755 });
      else if (!st.isDirectory())
        throw escapes(`"${cur}" is not a real directory (symlink or file in path)`);
    }
    return cur;
  };

  const gen = tarEntries(source);
  try {
    for await (const entry of gen) {
      const h = entry.header;
      const segs = entrySegments(h.name);
      if (segs.length === 0) {
        await drain(entry);
        continue;
      }
      if (top === undefined) {
        top = segs[0];
        const isDir = h.type === 'directory' || segs.length > 1;
        if (isDir) {
          rootKind = 'dir';
          await ensureRootDir();
        } else {
          rootKind = 'file';
          const parent = path.dirname(dest);
          await fs.mkdir(parent, { recursive: true });
          rootReal = await fs.realpath(parent);
        }
      } else if (segs[0] !== top) {
        throw escapes(`archive has more than one top-level entry ("${top}" and "${segs[0]}")`);
      }
      const rel = segs.slice(1);

      if (rootKind === 'file') {
        if (rel.length > 0) throw escapes('archive entry below a non-directory root');
        if (
          h.type !== 'file' &&
          h.type !== 'contiguous-file' &&
          h.type !== undefined &&
          h.type !== null
        ) {
          await drain(entry);
          if (h.type === 'symlink')
            throw new AboxError(
              'unsupported',
              'Copying a symlink out of a sandbox is not supported',
            );
          continue;
        }
        const target = path.join(rootReal, path.basename(dest));
        await writeFileEntry(entry, target, h.mode ?? 0o644, h.mtime);
        continue;
      }

      if (rel.length === 0) {
        // the root directory entry itself
        if (h.type === 'directory')
          dirModes.push({ p: rootReal, mode: (h.mode ?? 0o755) & 0o777, mtime: h.mtime });
        await drain(entry);
        continue;
      }

      const parent = await safeParent(rel);
      const target = path.join(parent, rel[rel.length - 1] as string);
      const rootPrefix = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;
      if (!target.startsWith(rootPrefix)) throw escapes(`"${target}" is outside the destination`);

      switch (h.type) {
        case 'directory': {
          const st = await lstatOrUndefined(target);
          if (st && !st.isDirectory()) await fs.unlink(target);
          if (!st || !st.isDirectory()) await fs.mkdir(target, { mode: 0o700 });
          dirModes.push({ p: target, mode: (h.mode ?? 0o755) & 0o777, mtime: h.mtime });
          await drain(entry);
          break;
        }
        case 'symlink': {
          await drain(entry);
          const linkname = h.linkname ?? '';
          if (linkname === '' || linkname.startsWith('/') || linkname.includes('\0'))
            throw escapes(`symlink "${h.name}" has an absolute or empty target "${linkname}"`);
          const resolved = path.posix.normalize(path.posix.join(...rel.slice(0, -1), linkname));
          if (resolved === '..' || resolved.startsWith('../'))
            throw escapes(`symlink "${h.name}" -> "${linkname}" points outside the destination`);
          const st = await lstatOrUndefined(target);
          if (st) {
            if (st.isDirectory())
              throw new AboxError('conflict', `Cannot replace directory with symlink: ${target}`);
            await fs.unlink(target);
          }
          await fs.symlink(linkname, target);
          break;
        }
        case 'link': {
          await drain(entry);
          const lsegs = entrySegments(h.linkname ?? '');
          if (lsegs[0] !== top || lsegs.length < 2)
            throw escapes(`hardlink "${h.name}" targets outside the archive root`);
          const lparent = await safeParent(lsegs.slice(1));
          const src = path.join(lparent, lsegs[lsegs.length - 1] as string);
          const sst = await lstatOrUndefined(src);
          if (!sst || !sst.isFile())
            throw escapes(`hardlink "${h.name}" does not target an extracted file`);
          const st = await lstatOrUndefined(target);
          if (st) await fs.unlink(target);
          await fs.copyFile(src, target, fsc.COPYFILE_EXCL);
          await fs.chmod(target, (h.mode ?? 0o644) & 0o777);
          break;
        }
        case 'file':
        case 'contiguous-file':
        case undefined:
        case null: {
          await writeFileEntry(entry, target, h.mode ?? 0o644, h.mtime);
          break;
        }
        default:
          await drain(entry); // devices, FIFOs: skipped
      }
    }
    if (top === undefined)
      throw new AboxError('not_found', 'The sandbox returned an empty archive');
    for (const d of dirModes.reverse()) {
      await fs.chmod(d.p, d.mode);
      if (d.mtime) await fs.utimes(d.p, d.mtime, d.mtime);
    }
  } finally {
    await gen.return(undefined).catch(() => undefined);
  }
}

async function writeFileEntry(
  entry: TarSource,
  target: string,
  mode: number,
  mtime: Date | undefined,
): Promise<void> {
  const st = await lstatOrUndefined(target);
  if (st) {
    if (st.isDirectory())
      throw new AboxError('conflict', `Cannot replace directory with file: ${target}`);
    await fs.unlink(target);
  }
  await pipeline(
    entry as AsyncIterable<Buffer>,
    createWriteStream(target, { flags: 'wx', mode: mode & 0o777 }),
  );
  await fs.chmod(target, mode & 0o777);
  if (mtime) await fs.utimes(target, mtime, mtime);
}
