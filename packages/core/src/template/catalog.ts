import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AboxError, isAboxError } from '../errors.js';
import type {
  BackendKind,
  IsolationLevel,
  NetworkMode,
  ResolvedTemplate,
  TemplateSourceKind,
  TemplateSpec,
} from '../types.js';
import { parseDocument } from 'yaml';
import { MAX_TEMPLATE_BYTES, parseTemplateYaml, templateInvalidError } from './parse.js';
import { buildContextOf } from './context.js';
import { resolveTemplate, type ParentTemplate, type TemplateLookup } from './resolve.js';

/**
 * Absolute path of the builtin templates (`packages/core/templates`). Both
 * `src/template/catalog.ts` and `dist/template/catalog.js` sit two levels below
 * the package root, so the same relative path works for TypeScript sources and the build.
 */
export const builtinTemplatesDir: string = resolvePath(
  fileURLToPath(new URL('../../templates/', import.meta.url)),
);

/** Lookup order: first match wins. */
const PRECEDENCE: readonly TemplateSourceKind[] = ['project', 'user', 'builtin'];

export interface TemplateCatalogOptions {
  /** Project root; templates are read from `<projectDir>/.sandbox/*.yaml|yml`. */
  projectDir?: string;
  /** Personal templates, normally `~/.config/abox/templates`. */
  userDir?: string;
  /** Override for tests; defaults to `builtinTemplatesDir`. */
  builtinDir?: string;
}

export interface TemplateSummary {
  name: string;
  description: string;
  /** From `labels['use-for']`. */
  useFor?: string;
  backend: BackendKind;
  isolation: IsolationLevel;
  networkMode: NetworkMode;
  source: { kind: TemplateSourceKind; path: string };
  /** Lower-precedence templates with the same name that this one hides. */
  shadows: Array<{ kind: TemplateSourceKind; path: string }>;
}

export interface TemplateProblem {
  kind: TemplateSourceKind;
  path: string;
  error: AboxError;
  /** Names this broken file claims: its file name stem and, when readable, its top-level `name:`. */
  names?: string[];
}

interface Entry {
  kind: TemplateSourceKind;
  path: string;
  text: string;
  spec: TemplateSpec;
}

const YAML_FILE_RE = /\.ya?ml$/i;

export class TemplateCatalog {
  constructor(private readonly opts: TemplateCatalogOptions = {}) {}

  /** Valid templates, one entry per name (highest precedence), sorted by name. */
  async list(): Promise<TemplateSummary[]> {
    return (await this.listAll()).templates;
  }

  /** Like `list()` but also reports files that failed to parse or resolve. */
  async listAll(): Promise<{ templates: TemplateSummary[]; problems: TemplateProblem[] }> {
    const { byName, problems } = await this.load();
    const templates: TemplateSummary[] = [];
    for (const [name, entries] of [...byName.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const winner = entries[0]!;
      try {
        const r = await this.resolveEntry(winner);
        templates.push({
          name,
          description: r.description,
          ...(r.labels['use-for'] ? { useFor: r.labels['use-for'] } : {}),
          backend: r.backend,
          isolation: r.isolation,
          networkMode: r.network.mode,
          source: { kind: winner.kind, path: winner.path },
          shadows: entries.slice(1).map((e) => ({ kind: e.kind, path: e.path })),
        });
      } catch (e) {
        if (!isAboxError(e)) throw e;
        problems.push({ kind: winner.kind, path: winner.path, error: e });
      }
    }
    return { templates, problems };
  }

  /** Resolves a template by name (project > user > builtin), including `extends`. */
  async get(name: string): Promise<ResolvedTemplate> {
    const { byName, problems } = await this.load();
    const entries = byName.get(name);
    // A broken file for this name (that outranks the best valid one) is reported as such, never as "not found":
    // `template_invalid` with the file, line and column of every problem.
    const winnerRank = entries?.length ? PRECEDENCE.indexOf(entries[0]!.kind) : Infinity;
    const broken = problems.find(
      (p) => p.names?.includes(name) && PRECEDENCE.indexOf(p.kind) < winnerRank,
    );
    if (broken) throw invalidFromProblem(broken, name);
    if (!entries?.length) {
      const known = [...byName.keys()].sort();
      throw new AboxError('not_found', `Template "${name}" not found`, {
        hint: known.length
          ? `Available templates: ${known.join(', ')}`
          : 'No templates found; check `abox template ls`.',
        details: { name },
      });
    }
    return this.resolveEntry(entries[0]!);
  }

  /** Loads and resolves one template file (e.g. for `abox template validate <file>`). */
  async loadFile(path: string, kind: TemplateSourceKind): Promise<ResolvedTemplate> {
    const entry = await readEntry(resolvePath(path), kind);
    return this.resolveEntry(entry);
  }

  // -------------------------------------------------------------------------

  private dirs(): Array<{ kind: TemplateSourceKind; dir: string }> {
    const out: Array<{ kind: TemplateSourceKind; dir: string }> = [];
    if (this.opts.projectDir)
      out.push({ kind: 'project', dir: join(this.opts.projectDir, '.sandbox') });
    if (this.opts.userDir) out.push({ kind: 'user', dir: this.opts.userDir });
    out.push({ kind: 'builtin', dir: this.opts.builtinDir ?? builtinTemplatesDir });
    return out;
  }

  /** Reads all locations. Files are small; reloading on every call keeps the catalog free of stale state. */
  private async load(): Promise<{ byName: Map<string, Entry[]>; problems: TemplateProblem[] }> {
    const byName = new Map<string, Entry[]>();
    const problems: TemplateProblem[] = [];
    for (const { kind, dir } of this.dirs()) {
      let names: string[];
      try {
        // Only regular files; symlinks are skipped so a repository cannot make abox read arbitrary files.
        names = (await readdir(dir, { withFileTypes: true }))
          .filter((d) => d.isFile() && YAML_FILE_RE.test(d.name))
          .map((d) => d.name)
          .sort();
      } catch (e) {
        if (
          (e as NodeJS.ErrnoException).code === 'ENOENT' ||
          (e as NodeJS.ErrnoException).code === 'ENOTDIR'
        )
          continue;
        throw new AboxError(
          'internal',
          `Cannot read template directory ${dir}: ${(e as Error).message}`,
          { cause: e },
        );
      }
      const seenHere = new Set<string>();
      for (const file of names) {
        const path = join(dir, file);
        try {
          const entry = await readEntry(path, kind);
          if (seenHere.has(entry.spec.name)) {
            throw new AboxError(
              'template_invalid',
              `Duplicate template name "${entry.spec.name}" in ${dir}`,
              {
                issues: [
                  {
                    path: 'name',
                    message: `another file in this directory already defines "${entry.spec.name}"`,
                  },
                ],
              },
            );
          }
          seenHere.add(entry.spec.name);
          const list = byName.get(entry.spec.name) ?? [];
          list.push(entry);
          byName.set(entry.spec.name, list);
        } catch (e) {
          if (!isAboxError(e)) throw e;
          problems.push({ kind, path, error: e, names: await claimedNames(path) });
        }
      }
    }
    // Entries were appended in precedence order (project, user, builtin).
    return { byName, problems };
  }

  /** The entry `from.spec.extends` names: same precedence level or below, never the entry itself. */
  private async findParent(
    from: { kind: TemplateSourceKind; path?: string },
    name: string,
  ): Promise<Entry | undefined> {
    const { byName } = await this.load();
    const candidates = byName.get(name) ?? [];
    // A template may only extend templates at its own precedence level or below (a user
    // template never depends on a repository's .sandbox directory), and never itself.
    const allowed = PRECEDENCE.slice(PRECEDENCE.indexOf(from.kind));
    return candidates.find(
      (c) => allowed.includes(c.kind) && !(c.kind === from.kind && c.path === from.path),
    );
  }

  /**
   * The resolved template that `name` extends (the one a review compares against), or undefined
   * when it extends nothing or the parent cannot be found or resolved.
   */
  async getParent(name: string): Promise<ResolvedTemplate | undefined> {
    const { byName } = await this.load();
    const entry = byName.get(name)?.[0];
    if (!entry?.spec.extends) return undefined;
    const parent = await this.findParent(entry, entry.spec.extends);
    if (!parent) return undefined;
    try {
      return await this.resolveEntry(parent);
    } catch (e) {
      if (isAboxError(e)) return undefined;
      throw e;
    }
  }

  private async resolveEntry(entry: Entry): Promise<ResolvedTemplate> {
    const lookup: TemplateLookup = async (name, from): Promise<ParentTemplate | undefined> => {
      const found = await this.findParent(from, name);
      return found
        ? {
            spec: found.spec,
            source: { kind: found.kind, path: found.path },
            contentText: found.text,
          }
        : undefined;
    };
    return resolveTemplate(entry.spec, {
      source: { kind: entry.kind, path: entry.path },
      contentText: entry.text,
      lookup,
      buildContext: buildContextOf,
    });
  }
}

/** Turns a catalog problem into the `template_invalid` error a create/show/build of that name gets. */
function invalidFromProblem(p: TemplateProblem, name: string): AboxError {
  const e = p.error;
  if (e.code === 'template_invalid' && e.issues.length > 0) {
    return templateInvalidError(e.issues, p.path);
  }
  return new AboxError('template_invalid', `Invalid template ${p.path}: ${e.message}`, {
    issues: e.issues.length > 0 ? e.issues : [{ message: e.message }],
    details: { path: p.path, name },
    ...(e.hint ? { hint: e.hint } : {}),
  });
}

/** File name stem and (best effort) the top-level `name:` of a file that failed to load. */
async function claimedNames(path: string): Promise<string[]> {
  const names: string[] = [];
  const stem = path.split('/').pop()?.replace(YAML_FILE_RE, '');
  if (stem) names.push(stem);
  try {
    const st = await stat(path);
    if (st.isFile() && st.size <= MAX_TEMPLATE_BYTES) {
      const declared: unknown = parseDocument(await readFile(path, 'utf8'), {
        prettyErrors: false,
      }).get('name');
      if (typeof declared === 'string' && declared.length <= 64 && !names.includes(declared))
        names.push(declared);
    }
  } catch {
    /* unreadable or unparseable: the stem is all we know */
  }
  return names;
}

async function readEntry(path: string, kind: TemplateSourceKind): Promise<Entry> {
  let st;
  try {
    st = await stat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT')
      throw new AboxError('not_found', `Template file not found: ${path}`, { details: { path } });
    throw e;
  }
  if (!st.isFile()) throw new AboxError('invalid_input', `Not a regular file: ${path}`);
  if (st.size > MAX_TEMPLATE_BYTES) {
    throw new AboxError(
      'template_invalid',
      `Template file ${path} is larger than ${MAX_TEMPLATE_BYTES} bytes`,
    );
  }
  const text = await readFile(path, 'utf8');
  const spec = parseTemplateYaml(text, { path });
  return { kind, path, text, spec };
}
