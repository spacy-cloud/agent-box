import { AboxError } from '../errors.js';

/**
 * Minimal gitignore-like exclude patterns used for workspace copies and exports.
 *
 * Semantics (documented, intentionally small):
 * - Paths are relative to the tree root and `/`-separated.
 * - A pattern without a `/` (other than a trailing one) matches an entry with that
 *   name at any depth (`node_modules`, `*.log`).
 * - A pattern with a leading or inner `/` is anchored at the tree root (`/build`, `src/gen`).
 * - A trailing `/` restricts the pattern to directories.
 * - `*` matches within one path segment, `?` one character, `**` any number of segments
 *   (`a/**\/b`, `**\/cache`).
 * - Excluding a directory excludes its whole subtree. There is no negation (`!`).
 */
export type ExcludeMatcher = (relPath: string, isDir: boolean) => boolean;

interface CompiledPattern {
  re: RegExp;
  dirOnly: boolean;
}

function escapeRe(ch: string): string {
  return ch.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');
}

function compile(pattern: string): CompiledPattern {
  if (!pattern || pattern.includes('\0') || pattern.includes('\n')) {
    throw new AboxError('invalid_input', `invalid exclude pattern: ${JSON.stringify(pattern)}`);
  }
  let p = pattern;
  const dirOnly = p.endsWith('/');
  if (dirOnly) p = p.slice(0, -1);
  let anchored = false;
  if (p.startsWith('/')) {
    anchored = true;
    p = p.replace(/^\/+/, '');
  }
  if (p.includes('/')) anchored = true;
  if (!p)
    throw new AboxError('invalid_input', `invalid exclude pattern: ${JSON.stringify(pattern)}`);

  let body = '';
  for (let i = 0; i < p.length; i++) {
    const ch = p[i] as string;
    if (ch === '*') {
      if (p[i + 1] === '*') {
        // `**/` = zero or more directories; trailing `**` = anything
        if (p[i + 2] === '/') {
          body += '(?:.*/)?';
          i += 2;
        } else {
          body += '.*';
          i += 1;
        }
      } else {
        body += '[^/]*';
      }
    } else if (ch === '?') {
      body += '[^/]';
    } else {
      body += escapeRe(ch);
    }
  }
  const re = new RegExp(anchored ? `^${body}$` : `(?:^|/)${body}$`);
  return { re, dirOnly };
}

/** Compiles patterns into a matcher. An empty list matches nothing. */
export function compileExcludes(patterns: readonly string[] | undefined): ExcludeMatcher {
  const compiled = (patterns ?? []).map(compile);
  if (compiled.length === 0) return () => false;
  return (relPath, isDir) => {
    for (const c of compiled) {
      if (c.dirOnly && !isDir) continue;
      if (c.re.test(relPath)) return true;
    }
    return false;
  };
}
