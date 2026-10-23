import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { basename, join, relative, resolve as resolvePath, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AboxError, isAboxError, type ErrorIssue } from '../errors.js';
import { canonicalJson } from '../state/canonical.js';
import type { TemplateSourceKind } from '../types.js';
import { MAX_SKILL_MD_BYTES, SKILL_NAME_RE, parseSkillMd, skillInvalidError } from './parse.js';

/**
 * Absolute path of the builtin skills (`packages/core/skills`). Like the builtin templates, both the
 * TypeScript source and the build sit two levels below the package root.
 */
export const builtinSkillsDir: string = resolvePath(
  fileURLToPath(new URL('../../skills/', import.meta.url)),
);

/** Where project skills live, relative to the project directory. */
export const PROJECT_SKILL_DIR = '.sandbox/skills';
/** At most this many files in one skill folder (`SKILL.md` included). */
export const MAX_SKILL_FILES = 100;
/** At most this many bytes in one skill folder. */
export const MAX_SKILL_BYTES = 1024 * 1024;
/** Deepest directory nesting inside a skill folder. */
export const MAX_SKILL_DEPTH = 8;
/** File and directory names inside a skill: no spaces or shell specials, not `.` or `..`. */
const SKILL_FILE_NAME_RE = /^(?!\.\.?$)[A-Za-z0-9._-]{1,128}$/;
/** Left out of a skill silently (a skill folder may be a git checkout). */
const IGNORED_NAMES = new Set(['.git']);

/** Lookup order: first match wins (the same as for templates). */
const PRECEDENCE: readonly TemplateSourceKind[] = ['project', 'user', 'builtin'];

export interface SkillFile {
  /** Relative to the skill folder, `/`-separated (`scripts/run.sh`). */
  path: string;
  size: number;
  executable: boolean;
}

/** A skill folder that passed every check, with its files read into memory. */
export interface ResolvedSkill {
  name: string;
  description: string;
  /** The optional front matter keys as written. */
  frontMatter: Record<string, unknown>;
  /** The instructions (Markdown after the front matter). */
  body: string;
  source: { kind: TemplateSourceKind; path: string };
  files: SkillFile[];
  totalBytes: number;
  /**
   * sha256 hex over the skill name and every file (relative path, executable bit, content). Trust
   * of a project skill is bound to it.
   */
  contentHash: string;
  /** File contents, keyed like `files[].path`. */
  contents: Map<string, Buffer>;
}

export interface SkillSummary {
  name: string;
  description: string;
  source: { kind: TemplateSourceKind; path: string };
  /** Lower-precedence skills with the same name that this one hides. */
  shadows: Array<{ kind: TemplateSourceKind; path: string }>;
  fileCount: number;
  totalBytes: number;
  contentHash: string;
}

export interface SkillProblem {
  kind: TemplateSourceKind;
  path: string;
  /** The folder name (the name the skill would have). */
  name: string;
  error: AboxError;
}

export interface SkillCatalogOptions {
  /** Project root; skills are read from `<projectDir>/.sandbox/skills/<name>/`. */
  projectDir?: string;
  /** Personal skills, normally `~/.config/abox/skills`. */
  userDir?: string;
  /** Override for tests; defaults to `builtinSkillsDir`. */
  builtinDir?: string;
}

export class SkillCatalog {
  constructor(private readonly opts: SkillCatalogOptions = {}) {}

  /** Valid skills, one entry per name (highest precedence), sorted by name. */
  async list(): Promise<SkillSummary[]> {
    return (await this.listAll()).skills;
  }

  /** Like `list()` but also reports folders that failed to load. */
  async listAll(): Promise<{ skills: SkillSummary[]; problems: SkillProblem[] }> {
    const { byName, problems } = await this.load();
    const skills: SkillSummary[] = [];
    for (const [name, entries] of [...byName.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const winner = entries[0]!;
      skills.push({
        name,
        description: winner.description,
        source: winner.source,
        shadows: entries.slice(1).map((e) => e.source),
        fileCount: winner.files.length,
        totalBytes: winner.totalBytes,
        contentHash: winner.contentHash,
      });
    }
    return { skills, problems };
  }

  /** The skill of that name (project > user > builtin). A broken folder that outranks it is reported as such. */
  async get(name: string): Promise<ResolvedSkill> {
    const { byName, problems } = await this.load();
    const entries = byName.get(name);
    const winnerRank = entries?.length ? PRECEDENCE.indexOf(entries[0]!.source.kind) : Infinity;
    const broken = problems.find((p) => p.name === name && PRECEDENCE.indexOf(p.kind) < winnerRank);
    if (broken) throw broken.error;
    if (!entries?.length) {
      const known = [...byName.keys()].sort();
      throw new AboxError('not_found', `Skill "${name}" not found`, {
        hint: known.length
          ? `Available skills: ${known.join(', ')}`
          : 'No skills found; check `abox skill ls`.',
        details: { name },
      });
    }
    return entries[0]!;
  }

  /** Lower-precedence skills of the same name that the winner hides. */
  async getShadowed(name: string): Promise<Array<{ kind: TemplateSourceKind; path: string }>> {
    const { byName } = await this.load();
    return (byName.get(name) ?? []).slice(1).map((e) => e.source);
  }

  // -------------------------------------------------------------------------

  private dirs(): Array<{ kind: TemplateSourceKind; dir: string }> {
    const out: Array<{ kind: TemplateSourceKind; dir: string }> = [];
    if (this.opts.projectDir)
      out.push({ kind: 'project', dir: join(this.opts.projectDir, PROJECT_SKILL_DIR) });
    if (this.opts.userDir) out.push({ kind: 'user', dir: this.opts.userDir });
    out.push({ kind: 'builtin', dir: this.opts.builtinDir ?? builtinSkillsDir });
    return out;
  }

  /** Reads all locations. Skill folders are small; reloading keeps the catalog free of stale state. */
  private async load(): Promise<{
    byName: Map<string, ResolvedSkill[]>;
    problems: SkillProblem[];
  }> {
    const byName = new Map<string, ResolvedSkill[]>();
    const problems: SkillProblem[] = [];
    for (const { kind, dir } of this.dirs()) {
      let entries;
      try {
        entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
          a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
        );
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') continue;
        throw new AboxError(
          'internal',
          `Cannot read skill directory ${dir}: ${(e as Error).message}`,
          {
            cause: e,
          },
        );
      }
      for (const d of entries) {
        const path = join(dir, d.name);
        if (d.isSymbolicLink()) {
          // Never followed (a repository must not point abox at other folders), but not silently ignored.
          problems.push({
            kind,
            path,
            name: d.name,
            error: skillInvalidError(
              [{ message: 'the skill folder is a symbolic link; copy the folder instead' }],
              path,
            ),
          });
          continue;
        }
        if (!d.isDirectory()) continue; // a README next to the skill folders
        try {
          const skill = await loadSkillDir(path, kind);
          const list = byName.get(skill.name) ?? [];
          list.push(skill);
          byName.set(skill.name, list);
        } catch (e) {
          if (!isAboxError(e)) throw e;
          problems.push({ kind, path, name: d.name, error: e });
        }
      }
    }
    return { byName, problems };
  }
}

/**
 * Loads and checks one skill folder (`abox skill validate <folder>`, and every catalog entry). Throws
 * `skill_invalid` with every problem found, `not_found` when the folder does not exist.
 */
export async function loadSkillDir(dir: string, kind: TemplateSourceKind): Promise<ResolvedSkill> {
  const root = resolvePath(dir);
  let st;
  try {
    st = await lstat(root);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT')
      throw new AboxError('not_found', `Skill folder not found: ${root}`, {
        details: { path: root },
      });
    throw e;
  }
  if (st.isSymbolicLink())
    throw skillInvalidError(
      [{ message: 'the skill folder is a symbolic link; copy the folder instead' }],
      root,
    );
  if (!st.isDirectory())
    throw new AboxError('invalid_input', `Not a folder: ${root}`, {
      hint: 'A skill is a folder with a SKILL.md in it; pass the folder.',
    });
  const folder = basename(root);
  const issues: ErrorIssue[] = [];
  if (!SKILL_NAME_RE.test(folder))
    issues.push({
      message: `folder name "${folder}" is not a valid skill name (^[a-z0-9]([a-z0-9-]{0,62})$)`,
    });

  const realRoot = await realpath(root);
  const files: SkillFile[] = [];
  const contents = new Map<string, Buffer>();
  let totalBytes = 0;
  let stopped = false;
  const walk = async (abs: string, rel: string, depth: number): Promise<void> => {
    let names: string[];
    try {
      names = (await readdir(abs)).sort();
    } catch (e) {
      issues.push({ path: rel || '.', message: `cannot read the folder: ${(e as Error).message}` });
      return;
    }
    for (const name of names) {
      if (stopped) return;
      if (IGNORED_NAMES.has(name)) continue;
      const relPath = rel ? `${rel}/${name}` : name;
      if (!SKILL_FILE_NAME_RE.test(name)) {
        issues.push({
          path: relPath,
          message:
            'file and folder names in a skill may only contain letters, digits, ".", "_" and "-"',
        });
        continue;
      }
      const full = join(abs, name);
      let s = await lstat(full);
      let source = full;
      if (s.isSymbolicLink()) {
        // A link to a file inside the skill is delivered as a copy; anything else is refused.
        let target: string;
        try {
          target = await realpath(full);
        } catch {
          issues.push({ path: relPath, message: 'symbolic link to a file that does not exist' });
          continue;
        }
        if (target !== realRoot && !target.startsWith(realRoot + sep)) {
          issues.push({
            path: relPath,
            message: `symbolic link points outside the skill folder (to ${relative(realRoot, target)}); copy the file instead`,
          });
          continue;
        }
        s = await stat(target);
        if (!s.isFile()) {
          issues.push({
            path: relPath,
            message: 'symbolic link to a folder; only links to files are allowed',
          });
          continue;
        }
        source = target;
      }
      if (s.isDirectory()) {
        if (depth >= MAX_SKILL_DEPTH) {
          issues.push({
            path: relPath,
            message: `folders are nested deeper than ${MAX_SKILL_DEPTH} levels`,
          });
          continue;
        }
        await walk(full, relPath, depth + 1);
        continue;
      }
      if (!s.isFile()) {
        issues.push({
          path: relPath,
          message: 'not a regular file (sockets, pipes and devices are not allowed)',
        });
        continue;
      }
      if (files.length >= MAX_SKILL_FILES) {
        issues.push({
          path: relPath,
          message: `a skill may have at most ${MAX_SKILL_FILES} files`,
        });
        stopped = true;
        return;
      }
      if (totalBytes + s.size > MAX_SKILL_BYTES) {
        issues.push({
          path: relPath,
          message: `the skill is larger than ${MAX_SKILL_BYTES / 1024} KiB; keep large references out of it`,
        });
        stopped = true;
        return;
      }
      const data = await readFile(source);
      totalBytes += data.length;
      files.push({ path: relPath, size: data.length, executable: (s.mode & 0o111) !== 0 });
      contents.set(relPath, data);
    }
  };
  await walk(realRoot, '', 0);

  const md = contents.get('SKILL.md');
  let parsed: ReturnType<typeof parseSkillMd> | undefined;
  if (!md) {
    if (!issues.some((i) => i.path === 'SKILL.md'))
      issues.push({ path: 'SKILL.md', message: 'the skill folder has no SKILL.md' });
  } else if (md.length > MAX_SKILL_MD_BYTES) {
    issues.push({
      path: 'SKILL.md',
      message: `SKILL.md is larger than ${MAX_SKILL_MD_BYTES / 1024} KiB`,
    });
  } else {
    const text = md.toString('utf8');
    if (Buffer.compare(Buffer.from(text, 'utf8'), md) !== 0)
      issues.push({ path: 'SKILL.md', message: 'SKILL.md is not valid UTF-8 text' });
    else {
      parsed = parseSkillMd(text, folder);
      if (!parsed.ok) issues.push(...parsed.issues);
    }
  }
  if (issues.length > 0 || !parsed?.ok) throw skillInvalidError(issues, root);

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const contentHash = createHash('sha256')
    .update(
      canonicalJson({
        name: parsed.skill.frontMatter.name,
        files: files.map((f) => [
          f.path,
          f.executable,
          createHash('sha256').update(contents.get(f.path)!).digest('hex'),
        ]),
      }),
    )
    .digest('hex');
  return {
    name: parsed.skill.frontMatter.name,
    description: parsed.skill.frontMatter.description,
    frontMatter: parsed.skill.frontMatter.extra,
    body: parsed.skill.body,
    source: { kind, path: root },
    files,
    totalBytes,
    contentHash,
    contents,
  };
}
