import { opendir, lstat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Template auto-detection from project marker files.
 *
 * The detection is read-only and bounded: it looks at the names in the top level of the project
 * folder and at a few well-known files below `src-tauri/`, nothing else. No file is opened, no
 * directory is walked, no project code is executed, and symbolic links are never followed (a
 * marker that is a link does not count, a link in place of a known subdirectory is not entered).
 * The matching itself ({@link matchMarkers}) is pure.
 */

/** Most top-level entries looked at (a folder with more is cut off and reported as `truncated`). */
export const MAX_DETECT_ENTRIES = 5000;

/** Longest marker file name that is kept (anything longer cannot be a marker). */
const MAX_NAME_LENGTH = 255;

/** Known subdirectories and the marker files looked for in them (by name, never by listing). */
const SUBDIR_MARKERS: Readonly<Record<string, readonly string[]>> = {
  'src-tauri': ['tauri.conf.json', 'Cargo.toml'],
};

/** Top-level files that are markers on their own. */
const TOP_LEVEL_MARKERS: ReadonlySet<string> = new Set([
  'pubspec.yaml',
  'Cargo.toml',
  'tauri.conf.json',
  'package.json',
  'pyproject.toml',
  'uv.lock',
  'composer.json',
]);

/** `file` / `dir` for a real file / directory; a symbolic link (or anything else) is `other`. */
async function entryKind(
  dir: string,
  entry: { name: string; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean },
): Promise<'file' | 'dir' | 'other'> {
  if (entry.isFile()) return 'file';
  if (entry.isDirectory()) return 'dir';
  if (entry.isSymbolicLink()) return 'other';
  // some file systems do not report the type while listing: ask without following links
  try {
    const st = await lstat(join(dir, entry.name));
    return st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'other';
  } catch {
    return 'other';
  }
}

/** What a scan found: marker paths relative to the folder (`/`-separated), sorted. `*.php` is reported by its real name. */
export interface FoundMarkers {
  files: string[];
  /** The top level had more entries than {@link MAX_DETECT_ENTRIES}; markers further down the listing may be missing. */
  truncated: boolean;
}

/**
 * Looks for the marker files in `dir`. Only the top level is listed (at most {@link MAX_DETECT_ENTRIES}
 * entries, streamed) and a few fixed paths are `lstat`ed. Only regular files count as markers.
 */
export async function scanProjectMarkers(dir: string): Promise<FoundMarkers> {
  const files = new Set<string>();
  const subdirs: string[] = [];
  let php: string | undefined;
  let seen = 0;
  let truncated = false;
  const handle = await opendir(dir);
  try {
    for await (const entry of handle) {
      if (++seen > MAX_DETECT_ENTRIES) {
        truncated = true;
        break;
      }
      const name = entry.name;
      if (name.length > MAX_NAME_LENGTH) continue;
      const relevant =
        TOP_LEVEL_MARKERS.has(name) || /\.php$/i.test(name) || Object.hasOwn(SUBDIR_MARKERS, name);
      if (!relevant) continue;
      const kind = await entryKind(dir, entry);
      if (kind === 'file') {
        if (TOP_LEVEL_MARKERS.has(name)) files.add(name);
        else if (/\.php$/i.test(name) && (php === undefined || name < php)) php = name;
      } else if (kind === 'dir' && Object.hasOwn(SUBDIR_MARKERS, name)) {
        subdirs.push(name);
      }
    }
  } finally {
    // `break` already closed the handle; closing twice would throw
    await handle.close().catch(() => undefined);
  }
  if (php !== undefined) files.add(php);
  for (const sub of subdirs) {
    for (const marker of SUBDIR_MARKERS[sub]!) {
      try {
        if ((await lstat(join(dir, sub, marker))).isFile()) files.add(`${sub}/${marker}`);
      } catch {
        /* not there (or not readable): not a marker */
      }
    }
  }
  return { files: [...files].sort(), truncated };
}

/** A template that the markers point to. */
export interface MarkerCandidate {
  template: string;
  /** Higher wins; the order of candidates is by priority, then by name. */
  priority: number;
  /** Marker paths that matched, relative to the folder. */
  markers: string[];
  /** One line for people, English (the GUI builds its own text from `markers`). */
  reason: string;
}

interface Rule {
  template: string;
  priority: number;
  /** Every group needs a match; a group matches when any of its alternatives was found. */
  groups: ReadonlyArray<ReadonlyArray<string | RegExp>>;
  /** What the markers mean, for the reason text. */
  describe: string;
}

/**
 * The rules, strongest first. A Tauri project is also a Rust and usually a Node project, so the more
 * specific template ranks higher and the others stay as alternatives.
 */
const RULES: readonly Rule[] = [
  {
    template: 'tauri-dev',
    priority: 100,
    groups: [
      ['tauri.conf.json', 'src-tauri/tauri.conf.json'],
      ['Cargo.toml', 'src-tauri/Cargo.toml'],
    ],
    describe: 'a Tauri app',
  },
  {
    template: 'flutter-dev',
    priority: 90,
    groups: [['pubspec.yaml']],
    describe: 'a Dart / Flutter project',
  },
  {
    template: 'rust-dev',
    priority: 80,
    groups: [['Cargo.toml']],
    describe: 'a Rust crate',
  },
  {
    template: 'php-dev',
    priority: 75,
    groups: [['composer.json']],
    describe: 'a PHP project',
  },
  {
    template: 'py-uv',
    priority: 70,
    groups: [['pyproject.toml', 'uv.lock']],
    describe: 'a Python project',
  },
  {
    template: 'node-dev',
    priority: 60,
    groups: [['package.json']],
    describe: 'a Node.js project',
  },
  {
    template: 'php-dev',
    priority: 20,
    groups: [[/\.php$/i]],
    describe: 'PHP sources',
  },
];

function matching(found: readonly string[], alt: string | RegExp): string[] {
  return typeof alt === 'string'
    ? found.filter((f) => f === alt)
    : found.filter((f) => alt.test(f));
}

/**
 * Templates the markers point to, best first (one entry per template: its strongest rule). Pure;
 * knows nothing about which templates exist or are allowed.
 */
export function matchMarkers(found: readonly string[]): MarkerCandidate[] {
  const best = new Map<string, MarkerCandidate>();
  for (const rule of RULES) {
    const markers: string[] = [];
    let ok = true;
    for (const group of rule.groups) {
      const hit = group.flatMap((alt) => matching(found, alt));
      if (hit.length === 0) {
        ok = false;
        break;
      }
      markers.push(...hit);
    }
    if (!ok) continue;
    const unique = [...new Set(markers)];
    const prev = best.get(rule.template);
    if (prev && prev.priority >= rule.priority) continue;
    best.set(rule.template, {
      template: rule.template,
      priority: rule.priority,
      markers: unique,
      reason: `found ${joinWords(unique)} (${rule.describe})`,
    });
  }
  return [...best.values()].sort(
    (a, b) => b.priority - a.priority || a.template.localeCompare(b.template),
  );
}

function joinWords(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
