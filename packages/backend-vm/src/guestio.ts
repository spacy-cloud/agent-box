import { lstat, mkdir } from 'node:fs/promises';
import { dirname, resolve as resolvePath } from 'node:path';
import { AboxError, type DirEntry } from '@abox/core';
import { makeExcludeMatcher, mapFsError } from './fsutil.js';
import {
  removeGuestPath,
  runInGuest,
  streamGuestFile,
  uploadDirOf,
  uploadToGuest,
  type GuestRunResult,
} from './guest.js';
import type { QgaClient } from './qga.js';
import { extractTar, tarDirectory, tarSingle } from './tar.js';

/** File APIs of the sandbox, implemented with commands run as the sandbox user inside the guest. */

const INLINE_LIMIT = 256 * 1024;

const text = (b: Buffer): string => b.toString('utf8').trim();

/** Maps a failed helper script to a stable AboxError. */
function scriptError(r: GuestRunResult, what: string): AboxError {
  const msg = text(r.stderr).slice(0, 400);
  if (r.exitCode === 44 || /No such file or directory/.test(msg))
    return new AboxError('not_found', `${what}: no such file or directory`);
  if (r.exitCode === 45 || /Is a directory|Not a directory/.test(msg)) {
    return new AboxError(
      'invalid_input',
      `${what}: ${r.exitCode === 45 ? 'is a directory / not a directory' : msg}`,
    );
  }
  if (r.exitCode === 46 || /Permission denied/.test(msg))
    return new AboxError('backend_error', `${what}: permission denied in the sandbox`);
  return new AboxError('backend_error', `${what}: exit ${r.exitCode}${msg ? `: ${msg}` : ''}`);
}

export async function guestReadFile(
  qga: QgaClient,
  user: string,
  path: string,
  maxBytes: number,
): Promise<{ data: Buffer; truncated: boolean; size: number }> {
  const r = await runInGuest(
    qga,
    {
      user,
      bulk: maxBytes > 4 * 1024 * 1024,
      argv: [
        '/bin/sh',
        '-c',
        '[ -e "$1" ] || [ -L "$1" ] || exit 44; [ -d "$1" ] && exit 45; [ -r "$1" ] || exit 46; stat -L -c %s -- "$1" && head -c "$2" -- "$1"',
        'sh',
        path,
        String(Math.max(0, Math.floor(maxBytes))),
      ],
    },
    { maxOutputBytes: maxBytes + 64 },
  );
  if (r.exitCode !== 0) throw scriptError(r, `reading '${path}'`);
  const nl = r.stdout.indexOf(0x0a);
  const size = Number(r.stdout.subarray(0, nl).toString('ascii'));
  if (nl < 0 || !Number.isFinite(size))
    throw new AboxError('backend_error', `reading '${path}': unexpected helper output`);
  const data = r.stdout.subarray(nl + 1);
  return {
    data: data.length > maxBytes ? data.subarray(0, maxBytes) : data,
    truncated: size > maxBytes,
    size,
  };
}

export async function guestWriteFile(
  qga: QgaClient,
  user: string,
  path: string,
  data: Buffer,
  mode?: number,
): Promise<void> {
  const script =
    'mkdir -p -- "$(dirname -- "$1")" && cat > "$1" && { [ -z "$2" ] || chmod -- "$2" "$1"; }';
  const modeArg = mode === undefined ? '' : (mode & 0o7777).toString(8);
  let upload: string | undefined;
  try {
    let r: GuestRunResult;
    if (data.length <= INLINE_LIMIT) {
      r = await runInGuest(
        qga,
        { user, argv: ['/bin/sh', '-c', script, 'sh', path, modeArg], stdin: data },
        {},
      );
    } else {
      upload = await uploadToGuest(qga, [data]);
      r = await runInGuest(
        qga,
        { user, argv: ['/bin/sh', '-c', script, 'sh', path, modeArg], stdinFile: upload },
        {},
      );
    }
    if (r.exitCode !== 0) throw scriptError(r, `writing '${path}'`);
  } finally {
    if (upload) await removeGuestPath(qga, uploadDirOf(upload)).catch(() => undefined);
  }
}

export async function guestListDir(
  qga: QgaClient,
  user: string,
  path: string,
): Promise<DirEntry[]> {
  const r = await runInGuest(
    qga,
    {
      user,
      argv: [
        '/bin/sh',
        '-c',
        '[ -e "$1" ] || exit 44; [ -d "$1" ] || exit 45; find "$1" -mindepth 1 -maxdepth 1 -printf \'%f\\0%y\\0%s\\0%m\\0%T@\\0\'',
        'sh',
        path,
      ],
    },
    {},
  );
  if (r.exitCode !== 0) throw scriptError(r, `listing '${path}'`);
  const parts = r.stdout.toString('utf8').split('\0');
  const out: DirEntry[] = [];
  for (let i = 0; i + 5 <= parts.length; i += 5) {
    const [name, y, size, mode, mtime] = parts.slice(i, i + 5) as [
      string,
      string,
      string,
      string,
      string,
    ];
    if (name === undefined || mtime === undefined) break;
    out.push({
      name,
      type: y === 'f' ? 'file' : y === 'd' ? 'dir' : y === 'l' ? 'symlink' : 'other',
      size: Number(size),
      mode: parseInt(mode, 8),
      mtimeMs: Math.round(Number(mtime) * 1000),
    });
  }
  return out;
}

export interface CopyInOptions {
  exclude?: string[];
}

/** Copies a host file or directory to `sandboxPath` (which becomes the copy, like `cp -a src dst`). */
export async function guestCopyIn(
  qga: QgaClient,
  user: string,
  hostPath: string,
  sandboxPath: string,
  opts: CopyInOptions = {},
): Promise<void> {
  const src = resolvePath(hostPath);
  let st;
  try {
    st = await lstat(src);
  } catch (e) {
    throw mapFsError(e, `host path '${hostPath}'`);
  }
  let upload: string | undefined;
  try {
    if (st.isDirectory()) {
      const matcher = makeExcludeMatcher(opts.exclude);
      upload = await uploadToGuest(qga, tarDirectory(src, { exclude: matcher }));
      const r = await runInGuest(
        qga,
        {
          user,
          argv: [
            '/bin/sh',
            '-c',
            'mkdir -p -- "$1" && tar -xpf - -C "$1" --no-same-owner',
            'sh',
            sandboxPath,
          ],
          stdinFile: upload,
        },
        {},
      );
      if (r.exitCode !== 0) throw scriptError(r, `copying into '${sandboxPath}'`);
    } else if (st.isFile() || st.isSymbolicLink()) {
      upload = await uploadToGuest(qga, tarSingle(src, 'entry'));
      const r = await runInGuest(
        qga,
        {
          user,
          // extract into a private temp dir, then move the single entry into place
          argv: [
            '/bin/sh',
            '-c',
            't=$(mktemp -d) && tar -xpf - -C "$t" --no-same-owner && mkdir -p -- "$(dirname -- "$1")" && rm -rf -- "$1" && mv -- "$t/entry" "$1"; rc=$?; rm -rf -- "$t"; exit $rc',
            'sh',
            sandboxPath,
          ],
          stdinFile: upload,
        },
        {},
      );
      if (r.exitCode !== 0) throw scriptError(r, `copying into '${sandboxPath}'`);
    } else {
      throw new AboxError(
        'invalid_input',
        `host path '${hostPath}' is neither a file, a directory nor a symlink`,
      );
    }
  } finally {
    if (upload) await removeGuestPath(qga, uploadDirOf(upload)).catch(() => undefined);
  }
}

/** Copies a sandbox file or directory to `hostPath` (which becomes the copy). The archive is untrusted input. */
export async function guestCopyOut(
  qga: QgaClient,
  user: string,
  sandboxPath: string,
  hostPath: string,
  onSkip?: (path: string, reason: string) => void,
  symlinks?: 'refuse' | 'preserve',
): Promise<void> {
  const kind = await runInGuest(
    qga,
    {
      user,
      argv: [
        '/bin/sh',
        '-c',
        'if [ -d "$1" ]; then echo d; elif [ -e "$1" ] || [ -L "$1" ]; then echo f; else exit 44; fi',
        'sh',
        sandboxPath,
      ],
    },
    {},
  );
  if (kind.exitCode !== 0) throw scriptError(kind, `copying out '${sandboxPath}'`);
  const isDir = text(kind.stdout) === 'd';
  const dest = resolvePath(hostPath);
  await mkdir(dirname(dest), { recursive: true }).catch((e: unknown) => {
    throw mapFsError(e, `destination '${hostPath}'`);
  });
  const tarArgv = isDir
    ? ['/bin/sh', '-c', 'tar --format=posix --hard-dereference -C "$1" -cf - .', 'sh', sandboxPath]
    : [
        '/bin/sh',
        '-c',
        'tar --format=posix --hard-dereference -C "$(dirname -- "$1")" -cf - -- "$(basename -- "$1")"',
        'sh',
        sandboxPath,
      ];
  const run = await runInGuest(qga, { user, bulk: true, argv: tarArgv }, { keepOutput: true });
  const dir = run.dir as string;
  try {
    if (run.exitCode !== 0 && run.exitCode !== 1) {
      // exit 1 = "some files differ while reading" (still a usable archive); everything else is fatal
      const err = await runInGuest(
        qga,
        { user: 'root', argv: ['/bin/sh', '-c', 'head -c 400 -- "$1"', 'sh', `${dir}/err`] },
        {},
      );
      throw new AboxError(
        'backend_error',
        `archiving '${sandboxPath}' failed (exit ${run.exitCode}): ${text(err.stdout)}`,
      );
    }
    try {
      await extractTar(streamGuestFile(qga, `${dir}/out`), dest, {
        singleFile: !isDir,
        ...(onSkip ? { onSkip } : {}),
        ...(symlinks ? { symlinks } : {}),
      });
    } catch (e) {
      throw e instanceof AboxError ? e : mapFsError(e, `writing '${hostPath}'`);
    }
  } finally {
    await removeGuestPath(qga, dir).catch(() => undefined);
  }
}
