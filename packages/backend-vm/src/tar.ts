import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  rm,
  symlink,
  utimes,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, resolve as resolvePath, sep } from 'node:path';
import { AboxError } from '@abox/core';
import { errno, isInside } from './fsutil.js';

/**
 * Minimal tar writer (ustar + pax long names) and a defensive extractor.
 *
 * Used for `copyIn` / `copyOut` / workspace delivery. The writer reads host files without
 * following symlinks. The extractor handles archives produced by the (untrusted) guest:
 * it rejects absolute and `..` paths, never writes through symlinks, drops setuid/setgid bits,
 * skips device/FIFO/socket entries and skips symlinks that point outside the extracted tree.
 */

const BLOCK = 512;

function octal(value: number, width: number): Buffer {
  const s = value.toString(8).padStart(width - 1, '0');
  if (s.length > width - 1)
    throw new AboxError('invalid_input', `value ${value} does not fit a tar header field`);
  return Buffer.from(`${s}\0`, 'ascii');
}

function writeStr(buf: Buffer, off: number, width: number, s: string): void {
  const b = Buffer.from(s, 'utf8');
  b.copy(buf, off, 0, Math.min(b.length, width));
}

interface HeaderFields {
  name: string;
  mode: number;
  size: number;
  mtime: number;
  type: string;
  linkname?: string;
}

function makeHeader(f: HeaderFields): Buffer {
  const h = Buffer.alloc(BLOCK);
  writeStr(h, 0, 100, f.name);
  octal(f.mode & 0o7777, 8).copy(h, 100);
  octal(0, 8).copy(h, 108); // uid
  octal(0, 8).copy(h, 116); // gid
  octal(f.size, 12).copy(h, 124);
  octal(Math.max(0, Math.floor(f.mtime)), 12).copy(h, 136);
  h.fill(0x20, 148, 156); // checksum placeholder: spaces
  h.write(f.type, 156, 1, 'ascii');
  if (f.linkname) writeStr(h, 157, 100, f.linkname);
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return h;
}

function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body) + 1;
  while (String(len).length + Buffer.byteLength(body) !== len)
    len = String(len).length + Buffer.byteLength(body);
  return Buffer.from(`${len}${body}`, 'utf8');
}

function pad(n: number): Buffer {
  const rest = n % BLOCK;
  return rest === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - rest);
}

function* entryHeaders(f: HeaderFields): Generator<Buffer> {
  const nameBytes = Buffer.byteLength(f.name);
  const linkBytes = f.linkname ? Buffer.byteLength(f.linkname) : 0;
  if (nameBytes > 100 || linkBytes > 100) {
    const records: Buffer[] = [];
    if (nameBytes > 100) records.push(paxRecord('path', f.name));
    if (linkBytes > 100 && f.linkname) records.push(paxRecord('linkpath', f.linkname));
    const data = Buffer.concat(records);
    yield makeHeader({
      name: 'PaxHeaders/entry',
      mode: 0o644,
      size: data.length,
      mtime: f.mtime,
      type: 'x',
    });
    yield data;
    yield pad(data.length);
    yield makeHeader({
      ...f,
      name: f.name.slice(0, 99),
      ...(f.linkname ? { linkname: f.linkname.slice(0, 99) } : {}),
    });
    return;
  }
  yield makeHeader(f);
}

export interface TarWriteOptions {
  /** Entries (relative paths, `/`-separated) for which this returns true are left out. */
  exclude?: (relPath: string) => boolean;
  /** Called for entries that can not be archived (sockets, devices, ...). */
  onSkip?: (relPath: string, reason: string) => void;
}

/**
 * Archives the CONTENTS of directory `root` (entries are named `./a/b`; no entry for the root itself).
 * Symlinks are archived as symlinks. Yields chunks of at most 64 KiB.
 */
export async function* tarDirectory(
  root: string,
  opts: TarWriteOptions = {},
): AsyncGenerator<Buffer> {
  const exclude = opts.exclude ?? (() => false);
  async function* walk(abs: string, rel: string): AsyncGenerator<Buffer> {
    const names = (await readdir(abs)).sort();
    for (const name of names) {
      const childAbs = join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      if (exclude(childRel)) continue;
      const st = await lstat(childAbs);
      const tarName = `./${childRel}`;
      const mtime = st.mtimeMs / 1000;
      if (st.isDirectory()) {
        yield* entryHeaders({ name: `${tarName}/`, mode: st.mode, size: 0, mtime, type: '5' });
        yield* walk(childAbs, childRel);
      } else if (st.isSymbolicLink()) {
        const target = await readlink(childAbs);
        yield* entryHeaders({
          name: tarName,
          mode: 0o777,
          size: 0,
          mtime,
          type: '2',
          linkname: target,
        });
      } else if (st.isFile()) {
        yield* entryHeaders({ name: tarName, mode: st.mode, size: st.size, mtime, type: '0' });
        yield* fileBody(childAbs, st.size);
      } else {
        opts.onSkip?.(childRel, 'not a regular file, directory or symlink');
      }
    }
  }
  yield* walk(root, '');
  yield Buffer.alloc(BLOCK * 2);
}

/** Streams exactly `size` bytes of a file (zero-padded if it shrank, truncated if it grew) plus block padding. */
async function* fileBody(path: string, size: number): AsyncGenerator<Buffer> {
  let sent = 0;
  let stream: ReturnType<Awaited<ReturnType<typeof open>>['createReadStream']> | undefined;
  try {
    const fh = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    stream = fh.createReadStream({ highWaterMark: 64 * 1024 });
    for await (const chunk of stream) {
      const b = chunk as Buffer;
      const room = size - sent;
      if (room <= 0) break;
      const part = b.length > room ? b.subarray(0, room) : b;
      sent += part.length;
      yield part;
    }
  } catch (e) {
    if (errno(e) !== 'ELOOP') throw e;
  } finally {
    stream?.destroy();
  }
  if (sent < size) {
    let missing = size - sent;
    while (missing > 0) {
      const n = Math.min(missing, 64 * 1024);
      yield Buffer.alloc(n);
      missing -= n;
    }
  }
  yield pad(size);
}

/** Archives a single regular file or symlink under the entry name `name`. */
export async function* tarSingle(path: string, name: string): AsyncGenerator<Buffer> {
  const st = await lstat(path);
  if (st.isFile()) {
    yield* entryHeaders({
      name,
      mode: st.mode,
      size: st.size,
      mtime: st.mtimeMs / 1000,
      type: '0',
    });
    yield* fileBody(path, st.size);
  } else if (st.isSymbolicLink()) {
    yield* entryHeaders({
      name,
      mode: 0o777,
      size: 0,
      mtime: st.mtimeMs / 1000,
      type: '2',
      linkname: await readlink(path),
    });
  } else {
    throw new AboxError(
      'invalid_input',
      `'${path}' is neither a regular file, a directory nor a symlink`,
    );
  }
  yield Buffer.alloc(BLOCK * 2);
}

// ---------------------------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------------------------

export interface ExtractOptions {
  /** Abort when the archive contains more than this many bytes of file data. */
  maxBytes?: number;
  onSkip?: (path: string, reason: string) => void;
}

export interface ExtractResult {
  files: number;
  dirs: number;
  symlinks: number;
  skipped: number;
  bytes: number;
}

interface ParsedHeader {
  name: string;
  mode: number;
  size: number;
  mtime: number;
  type: string;
  linkname: string;
}

function readOctal(buf: Buffer, off: number, len: number): number {
  const raw = buf.subarray(off, off + len);
  // GNU base-256 encoding for huge values
  if (raw[0] !== undefined && (raw[0] & 0x80) !== 0) {
    let v = 0;
    for (let i = 1; i < raw.length; i++) v = v * 256 + (raw[i] as number);
    return v;
  }
  const s = raw.toString('ascii').replace(/\0.*$/, '').trim();
  return s === '' ? 0 : parseInt(s, 8);
}

function readStr(buf: Buffer, off: number, len: number): string {
  const raw = buf.subarray(off, off + len);
  const nul = raw.indexOf(0);
  return raw.subarray(0, nul < 0 ? raw.length : nul).toString('utf8');
}

function parsePax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let pos = 0;
  while (pos < data.length) {
    const sp = data.indexOf(0x20, pos);
    if (sp < 0) break;
    const len = parseInt(data.subarray(pos, sp).toString('ascii'), 10);
    if (!Number.isFinite(len) || len <= 0 || pos + len > data.length) break;
    const rec = data.subarray(sp + 1, pos + len - 1).toString('utf8');
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    pos += len;
  }
  return out;
}

/** Pull-based reader over an async iterable of chunks. */
class ChunkReader {
  private buf: Buffer = Buffer.alloc(0);
  private done = false;
  private readonly it: AsyncIterator<Buffer>;

  constructor(source: AsyncIterable<Buffer>) {
    this.it = source[Symbol.asyncIterator]();
  }

  private async fill(): Promise<boolean> {
    if (this.done) return false;
    const r = await this.it.next();
    if (r.done) {
      this.done = true;
      return false;
    }
    this.buf = this.buf.length === 0 ? r.value : Buffer.concat([this.buf, r.value]);
    return true;
  }

  /** Exactly `n` bytes, or fewer at the end of the stream. */
  async take(n: number): Promise<Buffer> {
    while (this.buf.length < n) {
      if (!(await this.fill())) break;
    }
    const out = this.buf.subarray(0, Math.min(n, this.buf.length));
    this.buf = this.buf.subarray(out.length);
    return out;
  }

  /** Up to `max` bytes (at least one unless the stream ended). */
  async takeSome(max: number): Promise<Buffer> {
    if (this.buf.length === 0) await this.fill();
    const out = this.buf.subarray(0, Math.min(max, this.buf.length));
    this.buf = this.buf.subarray(out.length);
    return out;
  }

  async skip(n: number): Promise<void> {
    let left = n;
    while (left > 0) {
      const b = await this.takeSome(left);
      if (b.length === 0) throw new AboxError('backend_error', 'unexpected end of the tar stream');
      left -= b.length;
    }
  }

  async drain(): Promise<void> {
    while (await this.fill()) this.buf = Buffer.alloc(0);
  }
}

/** Normalizes an archive member name to a relative POSIX path, or undefined if it is unsafe/empty. */
function safeRelative(name: string): string | undefined {
  if (name.includes('\0')) return undefined;
  const n = posix.normalize(name.replace(/^(\.\/)+/, ''));
  if (n === '.' || n === '') return '';
  if (n.startsWith('/') || n === '..' || n.startsWith('../') || posix.isAbsolute(n))
    return undefined;
  return n.replace(/\/+$/, '');
}

/**
 * Extracts `source` below `dest`. With `singleFile: true` the archive must hold one regular
 * file (or symlink) which becomes `dest` itself (parent directory must exist).
 */
export async function extractTar(
  source: AsyncIterable<Buffer>,
  dest: string,
  opts: ExtractOptions & { singleFile?: boolean } = {},
): Promise<ExtractResult> {
  const root = resolvePath(dest);
  const reader = new ChunkReader(source);
  const result: ExtractResult = { files: 0, dirs: 0, symlinks: 0, skipped: 0, bytes: 0 };
  const maxBytes = opts.maxBytes ?? 64 * 1024 ** 3;
  const dirModes: Array<{ path: string; mode: number; mtime: number }> = [];
  let pax: Record<string, string> = {};
  let longName: string | undefined;
  let longLink: string | undefined;
  let singleDone = false;

  if (!opts.singleFile) await mkdir(root, { recursive: true });

  const skip = (path: string, reason: string): void => {
    result.skipped++;
    opts.onSkip?.(path, reason);
  };

  /** Makes sure every ancestor of `abs` (below root) is a real directory; creates missing ones. */
  const ensureParents = async (abs: string): Promise<void> => {
    const rel = abs.slice(root.length + 1);
    const parts = rel.split(sep).slice(0, -1);
    let cur = root;
    for (const part of parts) {
      cur = join(cur, part);
      const st = await lstat(cur).catch(() => undefined);
      if (!st) {
        await mkdir(cur, { mode: 0o755 });
      } else if (!st.isDirectory()) {
        throw new AboxError(
          'backend_error',
          `archive entry would pass through a non-directory (${rel})`,
        );
      }
    }
  };

  for (;;) {
    const head = await reader.take(BLOCK);
    if (head.length < BLOCK) break;
    if (head.every((b) => b === 0)) break; // end-of-archive marker
    const type = String.fromCharCode(head[156] ?? 0x30);
    const h: ParsedHeader = {
      name: readStr(head, 0, 100),
      mode: readOctal(head, 100, 8),
      size: readOctal(head, 124, 12),
      mtime: readOctal(head, 136, 12),
      type: type === '\0' ? '0' : type,
      linkname: readStr(head, 157, 100),
    };
    const prefix = readStr(head, 345, 155);
    if (prefix && head.subarray(257, 262).toString('ascii') === 'ustar')
      h.name = `${prefix}/${h.name}`;
    const dataBlocks = Math.ceil(h.size / BLOCK) * BLOCK;

    if (h.type === 'x' || h.type === 'g' || h.type === 'L' || h.type === 'K') {
      const data = await reader.take(h.size);
      await reader.skip(dataBlocks - h.size);
      if (h.type === 'x') pax = { ...pax, ...parsePax(data) };
      else if (h.type === 'L') longName = data.toString('utf8').replace(/\0.*$/s, '');
      else if (h.type === 'K') longLink = data.toString('utf8').replace(/\0.*$/s, '');
      continue;
    }

    const name = pax['path'] ?? longName ?? h.name;
    const linkname = pax['linkpath'] ?? longLink ?? h.linkname;
    const size = pax['size'] !== undefined ? Number(pax['size']) : h.size;
    pax = {};
    longName = undefined;
    longLink = undefined;
    const bodyBlocks = Math.ceil(size / BLOCK) * BLOCK;

    const rel = safeRelative(name);
    if (rel === undefined)
      throw new AboxError(
        'backend_error',
        `unsafe path in archive: ${JSON.stringify(name).slice(0, 120)}`,
      );

    const finishBody = async (): Promise<void> => {
      await reader.skip(bodyBlocks);
    };

    if (opts.singleFile) {
      if (singleDone) {
        await finishBody();
        continue;
      }
      if (h.type !== '0' && h.type !== '2') {
        await finishBody();
        continue;
      }
      singleDone = true;
      await rm(root, { force: true, recursive: false }).catch(() => undefined);
      if (h.type === '2') {
        await symlink(linkname, root);
        result.symlinks++;
      } else {
        result.bytes += size;
        await writeBody(reader, root, size, h.mode, h.mtime);
        result.files++;
      }
      continue;
    }

    if (rel === '') {
      await finishBody();
      continue; // the root entry itself
    }
    const abs = join(root, ...rel.split('/'));
    if (!isInside(root, abs) || abs === root)
      throw new AboxError('backend_error', `unsafe path in archive: ${rel}`);

    switch (h.type) {
      case '5': {
        await ensureParents(abs);
        const st = await lstat(abs).catch(() => undefined);
        if (st && !st.isDirectory()) await rm(abs, { force: true });
        await mkdir(abs, { recursive: false, mode: 0o700 }).catch((e: unknown) => {
          if (errno(e) !== 'EEXIST') throw e;
        });
        dirModes.push({ path: abs, mode: h.mode & 0o777, mtime: h.mtime });
        result.dirs++;
        break;
      }
      case '0':
      case '7': {
        await ensureParents(abs);
        result.bytes += size;
        if (result.bytes > maxBytes)
          throw new AboxError(
            'backend_error',
            `archive larger than the limit of ${maxBytes} bytes`,
          );
        await rm(abs, { force: true, recursive: false }).catch(() => undefined);
        await writeBody(reader, abs, size, h.mode, h.mtime);
        result.files++;
        break;
      }
      case '2': {
        await ensureParents(abs);
        const target = linkname;
        const resolved = posix.normalize(posix.join(posix.dirname(rel), target));
        if (
          target === '' ||
          target.includes('\0') ||
          posix.isAbsolute(target) ||
          resolved === '..' ||
          resolved.startsWith('../')
        ) {
          skip(rel, `symlink target '${target.slice(0, 80)}' points outside the copied tree`);
          break;
        }
        await rm(abs, { force: true, recursive: false }).catch(() => undefined);
        await symlink(target, abs);
        result.symlinks++;
        break;
      }
      default:
        skip(rel, `unsupported entry type '${h.type}'`);
        await finishBody();
        continue;
    }
    if (h.type === '2' || h.type === '5') await finishBody();
  }
  await reader.drain();
  // directory modes last: a read-only directory must not stop us from filling it
  for (const d of dirModes.reverse()) {
    await chmod(d.path, (d.mode | 0o700) & 0o777).catch(() => undefined);
    await utimes(d.path, d.mtime, d.mtime).catch(() => undefined);
  }
  return result;
}

async function writeBody(
  reader: ChunkReader,
  abs: string,
  size: number,
  mode: number,
  mtime: number,
): Promise<void> {
  const fh = await open(
    abs,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    let left = size;
    while (left > 0) {
      const b = await reader.takeSome(Math.min(left, 1024 * 1024));
      if (b.length === 0) throw new AboxError('backend_error', 'unexpected end of the tar stream');
      await fh.write(b);
      left -= b.length;
    }
    await fh.chmod(mode & 0o777);
    await fh.utimes(mtime, mtime);
  } finally {
    await fh.close();
  }
  await reader.skip(Math.ceil(size / BLOCK) * BLOCK - size);
}

/** Resolves `dest` and rejects when it lies in a place where we must not create things. */
export function assertHostDestination(dest: string): string {
  const abs = resolvePath(dest);
  if (abs === '/' || dirname(abs) === abs)
    throw new AboxError('invalid_input', 'refusing to use / as destination');
  if (isAbsolute(dest) === false && abs.length === 0)
    throw new AboxError('invalid_input', 'empty destination');
  return abs;
}
