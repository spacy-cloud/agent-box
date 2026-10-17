/**
 * Project folders: the directory whose `.sandbox/*.yaml` files are project templates. The folder comes
 * from a native dialog or the recent-folders list, but every call is checked again here, like the CLI
 * checks a human `--project` (the manager canonicalises it with `canonicalizePath`, physical `..`
 * semantics, no control characters), plus two checks of the app: it must be an existing directory, and a
 * `.sandbox` that is a symbolic link is not followed. Nothing but `.sandbox/*.yaml` of that directory is
 * ever read (the manager's catalog skips symlinked files).
 */
import { lstat, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AboxError, canonicalizePath } from '@abox/core';

/** The canonical path of an existing project folder; throws `invalid_input` otherwise. */
export async function resolveProjectDir(dir: string): Promise<string> {
  if (!dir.startsWith('/')) {
    throw new AboxError('invalid_input', 'the project folder must be an absolute path');
  }
  const canonical = canonicalizePath(dir, { home: homedir(), cwd: '/' });
  let st;
  try {
    st = await stat(canonical);
  } catch {
    throw new AboxError('invalid_input', `the project folder ${canonical} does not exist`);
  }
  if (!st.isDirectory()) {
    throw new AboxError('invalid_input', `${canonical} is not a directory`);
  }
  try {
    if ((await lstat(join(canonical, '.sandbox'))).isSymbolicLink()) {
      throw new AboxError(
        'invalid_input',
        `${join(canonical, '.sandbox')} is a symbolic link; abox does not follow it`,
        { hint: 'Make .sandbox a real directory inside the project.' },
      );
    }
  } catch (e) {
    if (e instanceof AboxError) throw e;
    /* no .sandbox directory: the project simply has no templates */
  }
  return canonical;
}

/** `{ projectDir }` for the manager when a folder was given, else nothing. */
export async function projectOption(dir: string | undefined): Promise<{ projectDir?: string }> {
  return dir === undefined ? {} : { projectDir: await resolveProjectDir(dir) };
}
