import { createHash } from 'node:crypto';
import { constants as fsc } from 'node:fs';
import { lstat, open, readdir, readlink, realpath } from 'node:fs/promises';
import { basename, dirname, resolve as resolvePath, sep } from 'node:path';
import { AboxError } from '../errors.js';
import type { BuildContextInfo, TemplateSourceKind } from '../types.js';

/**
 * The build context of a template with its own Dockerfile.
 *
 * The container backends send the whole directory of the Dockerfile to the engine (every file,
 * symlinks as symlinks, nothing excluded on our side) and the Dockerfile can `COPY`/`ADD` any of
 * it, so what a template does depends on all of it. This module hashes exactly that set the way
 * the backend packs it: names, types, modes, link targets and the content of every file. The digest
 * goes into the template's hashes (trust, approval digest, image cache key); the Dockerfile text and
 * the file list are what a reviewer sees.
 */

/** Largest Dockerfile whose text is kept for the review; bigger ones are refused. */
export const MAX_DOCKERFILE_BYTES = 256 * 1024;
/** More entries or bytes than this in the context are refused (nothing could review them). */
export const MAX_CONTEXT_ENTRIES = 100_000;
export const MAX_CONTEXT_BYTES = 1024 ** 3;
/** Files listed (with size and hash) in the review material; the digest always covers all of them. */
export const MAX_LISTED_FILES = 500;

type ContextFile = BuildContextInfo['files'][number];

function invalid(message: string, hint?: string): AboxError {
  return new AboxError('template_invalid', message, {
    issues: [{ path: 'base.dockerfile', message }],
    ...(hint ? { hint } : {}),
  });
}

const sha = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

/** Path of the Dockerfile of a template: relative to the template file (as the backend resolves it). */
export function dockerfilePathOf(
  dockerfile: string,
  templatePath: string | undefined,
): string | undefined {
  if (dockerfile.startsWith('/')) return dockerfile;
  return templatePath ? resolvePath(dirname(templatePath), dockerfile) : undefined;
}

/**
 * Where a Dockerfile may live: project templates only inside their project (the directory that
 * holds `.sandbox`), so a repository cannot make abox send an arbitrary directory to the engine.
 * User and builtin templates are the user's own.
 */
export async function assertContextAllowed(
  contextDir: string,
  source: { kind: TemplateSourceKind; path?: string },
): Promise<void> {
  if (source.kind !== 'project' || !source.path) return;
  const projectRoot = dirname(dirname(source.path));
  let real: string;
  let root: string;
  try {
    [real, root] = await Promise.all([realpath(contextDir), realpath(projectRoot)]);
  } catch {
    return; // missing paths are reported by the walk itself
  }
  if (real !== root && !real.startsWith(root.endsWith(sep) ? root : root + sep)) {
    throw invalid(
      `the build context ${contextDir} (the directory of the Dockerfile) is outside the project ${projectRoot}`,
      'A project template may only use a Dockerfile inside its own project.',
    );
  }
}

/**
 * Hash and describe the build context of the Dockerfile at `dockerfilePath`. Symlinks are never
 * followed and files are opened with O_NOFOLLOW, like the backend's packer.
 */
export async function collectBuildContext(dockerfilePath: string): Promise<BuildContextInfo> {
  const dir = dirname(dockerfilePath);
  const dockerfile = basename(dockerfilePath);
  let rootStat;
  try {
    rootStat = await lstat(dir);
  } catch {
    throw invalid(`build context ${dir} not found`);
  }
  if (!rootStat.isDirectory())
    throw invalid(`build context ${dir} is not a directory (symlinks are not followed)`);
  let dfStat;
  try {
    dfStat = await lstat(dockerfilePath);
  } catch {
    throw invalid(`Dockerfile not found: ${dockerfilePath}`);
  }
  if (!dfStat.isFile())
    throw invalid(`Dockerfile ${dockerfilePath} is not a regular file (symlinks are not followed)`);
  if (dfStat.size > MAX_DOCKERFILE_BYTES)
    throw invalid(`Dockerfile ${dockerfilePath} is larger than ${MAX_DOCKERFILE_BYTES} bytes`);

  const lines: string[] = [];
  const files: ContextFile[] = [];
  let totalBytes = 0;
  let entries = 0;
  let dockerfileText = '';
  const tooBig = (): AboxError =>
    invalid(
      `the build context ${dir} is too large to review (more than ${MAX_CONTEXT_ENTRIES} entries or ${MAX_CONTEXT_BYTES} bytes)`,
      'Put the Dockerfile and the files it needs into a dedicated directory.',
    );

  const walk = async (abs: string, rel: string): Promise<void> => {
    const children = (await readdir(abs)).sort();
    for (const child of children) {
      const childRel = rel ? `${rel}/${child}` : child;
      const childAbs = `${abs}/${child}`;
      let st;
      try {
        st = await lstat(childAbs);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw e;
      }
      if (++entries > MAX_CONTEXT_ENTRIES) throw tooBig();
      if (st.isDirectory()) {
        lines.push(JSON.stringify(['d', childRel, st.mode & 0o1777]));
        await walk(childAbs, childRel);
      } else if (st.isSymbolicLink()) {
        const target = await readlink(childAbs);
        lines.push(JSON.stringify(['l', childRel, target]));
        files.push({ path: childRel, type: 'symlink', size: 0, sha256: sha(target), target });
      } else if (st.isFile()) {
        let fh;
        try {
          fh = await open(childAbs, fsc.O_RDONLY | fsc.O_NOFOLLOW);
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code === 'ELOOP' || code === 'ENOENT') continue; // swapped for a symlink / vanished
          throw e;
        }
        try {
          const fst = await fh.stat();
          if (!fst.isFile() || fst.ino !== st.ino || fst.dev !== st.dev) continue;
          totalBytes += fst.size;
          if (totalBytes > MAX_CONTEXT_BYTES) throw tooBig();
          const hash = createHash('sha256');
          const keep: Buffer[] = [];
          let size = 0;
          const buf = Buffer.allocUnsafe(256 * 1024);
          for (;;) {
            const { bytesRead } = await fh.read(buf, 0, buf.length, null);
            if (bytesRead === 0) break;
            const chunk = buf.subarray(0, bytesRead);
            hash.update(chunk);
            size += bytesRead;
            if (childRel === dockerfile && size <= MAX_DOCKERFILE_BYTES)
              keep.push(Buffer.from(chunk));
          }
          if (childRel === dockerfile) dockerfileText = Buffer.concat(keep).toString('utf8');
          const digest = hash.digest('hex');
          lines.push(JSON.stringify(['f', childRel, st.mode & 0o1777, size, digest]));
          files.push({ path: childRel, type: 'file', size, sha256: digest });
        } finally {
          await fh.close();
        }
      }
      // sockets, FIFOs and devices are not sent
    }
  };
  await walk(dir, '');
  if (files.every((f) => f.path !== dockerfile))
    throw invalid(`Dockerfile not found: ${dockerfilePath}`);

  const digest = sha([JSON.stringify(['dockerfile', dockerfile]), ...lines].join('\n'));
  const listed = files.slice(0, MAX_LISTED_FILES);
  return {
    dir,
    dockerfile,
    digest,
    dockerfileText,
    files: listed,
    fileCount: files.length,
    totalBytes,
    filesTruncated: files.length > listed.length,
  };
}

/** Context of the Dockerfile `dockerfile` (as written in `base.dockerfile`) of a template file. */
export async function buildContextOf(
  dockerfile: string,
  source: { kind: TemplateSourceKind; path?: string },
): Promise<BuildContextInfo> {
  const path = dockerfilePathOf(dockerfile, source.path);
  if (!path) throw invalid('base.dockerfile needs the template file path to find the Dockerfile');
  await assertContextAllowed(dirname(path), source);
  return collectBuildContext(path);
}
