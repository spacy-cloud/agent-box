import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { AboxError } from '@abox/core';
import type { ResolvedTemplate } from '@abox/core';

/** Largest project file we are willing to copy into a build context. */
export const MAX_PROJECT_FILE_BYTES = 16 * 1024 * 1024;

/** The files of a Python project that are template build input. Nothing else is read or copied. */
export interface ProjectFiles {
  /** Absolute project directory on the host. */
  dir: string;
  pyproject: Buffer;
  /** Present when the project is locked; then dependencies are installed at prepare time. */
  lock?: Buffer;
  pyprojectSha256: string;
  lockSha256?: string;
}

export interface LoadProjectOptions {
  /** Base for a relative `python.project` when the template has no source path. Default: cwd. */
  projectBase?: string;
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

async function readRegular(file: string, what: string): Promise<Buffer | undefined> {
  let st;
  try {
    st = await fs.lstat(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new AboxError('invalid_input', `Cannot read ${what} (${file}): ${(e as Error).message}`, {
      cause: e,
    });
  }
  if (!st.isFile()) {
    // Symlinks are refused on purpose: a template must not smuggle other host files into the image.
    throw new AboxError(
      'invalid_input',
      `${what} must be a regular file, not a symlink or directory: ${file}`,
    );
  }
  if (st.size > MAX_PROJECT_FILE_BYTES) {
    throw new AboxError(
      'invalid_input',
      `${what} is larger than ${MAX_PROJECT_FILE_BYTES} bytes: ${file}`,
    );
  }
  return fs.readFile(file);
}

/** Resolves `template.python.project` to an absolute directory (relative paths: template file dir). */
export function projectDir(
  template: ResolvedTemplate,
  opts: LoadProjectOptions = {},
): string | undefined {
  const rel = template.python?.project;
  if (rel === undefined) return undefined;
  if (path.isAbsolute(rel)) return path.normalize(rel);
  const base = template.source.path
    ? path.dirname(template.source.path)
    : (opts.projectBase ?? process.cwd());
  return path.resolve(base, rel);
}

/**
 * Reads `pyproject.toml` (required) and `uv.lock` (optional) of the template's project.
 * Returns undefined when the template has no `python.project`.
 */
export async function loadProject(
  template: ResolvedTemplate,
  opts: LoadProjectOptions = {},
): Promise<ProjectFiles | undefined> {
  const dir = projectDir(template, opts);
  if (dir === undefined) return undefined;
  const pyproject = await readRegular(path.join(dir, 'pyproject.toml'), 'pyproject.toml');
  if (!pyproject) {
    throw new AboxError(
      'invalid_input',
      `python.project "${template.python?.project}" has no pyproject.toml (looked in ${dir})`,
      {
        hint: 'Point python.project at the directory that contains pyproject.toml (and uv.lock).',
      },
    );
  }
  const lock = await readRegular(path.join(dir, 'uv.lock'), 'uv.lock');
  return {
    dir,
    pyproject,
    ...(lock ? { lock } : {}),
    pyprojectSha256: sha256Hex(pyproject),
    ...(lock ? { lockSha256: sha256Hex(lock) } : {}),
  };
}
