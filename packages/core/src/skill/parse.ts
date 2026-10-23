import { LineCounter, isMap, isScalar, parseDocument } from 'yaml';
import { AboxError, type ErrorIssue } from '../errors.js';
import { TEMPLATE_NAME_RE } from '../template/schema.js';

/**
 * `SKILL.md`: YAML front matter between two `---` lines, then the Markdown instructions. The same
 * format as Claude Code / Agent Skills, checked strictly: `name` and `description` are required,
 * every other key must be one of the known ones.
 */

/** Skill names follow the template name rules (and must equal the folder name). */
export const SKILL_NAME_RE = TEMPLATE_NAME_RE;
/** The description is what an agent sees in the index; Agent Skills allow at most 1024 characters. */
export const MAX_SKILL_DESCRIPTION = 1024;
/** Hard cap for `SKILL.md` itself. */
export const MAX_SKILL_MD_BYTES = 256 * 1024;
/** Front matter keys besides `name` and `description` (Agent Skills and Claude Code). */
export const SKILL_OPTIONAL_KEYS: readonly string[] = [
  'license',
  'compatibility',
  'metadata',
  'allowed-tools',
  'version',
  'model',
  'argument-hint',
  'disable-model-invocation',
  'user-invocable',
  'when_to_use',
];

export interface SkillFrontMatter {
  name: string;
  description: string;
  /** The optional keys as written (`license`, `allowed-tools`, ...). */
  extra: Record<string, unknown>;
}

export interface ParsedSkillMd {
  frontMatter: SkillFrontMatter;
  /** The Markdown after the front matter. */
  body: string;
}

const FENCE = /^---[ \t]*$/;

/** Builds the standard `skill_invalid` error. */
export function skillInvalidError(issues: ErrorIssue[], dir?: string): AboxError {
  const first = issues[0];
  const where = first?.path
    ? `${first.path}${first.line !== undefined ? `:${first.line}${first.column !== undefined ? `:${first.column}` : ''}` : ''}: `
    : '';
  const more = issues.length > 1 ? ` (+${issues.length - 1} more)` : '';
  return new AboxError(
    'skill_invalid',
    `Invalid skill${dir ? ` ${dir}` : ''}: ${where}${first?.message ?? 'unknown problem'}${more}`,
    {
      issues,
      ...(dir ? { details: { path: dir } } : {}),
      hint: 'Fix the listed problems; `abox skill validate <name|folder>` shows all of them.',
    },
  );
}

/**
 * Parses and checks `SKILL.md`. `folder` is the name of the skill folder, which `name` must equal.
 * Returns the issues instead of throwing; their `path` is `SKILL.md` and line/column point into it.
 */
export function parseSkillMd(
  text: string,
  folder: string,
): { ok: true; skill: ParsedSkillMd } | { ok: false; issues: ErrorIssue[] } {
  const at = (message: string, line?: number, column?: number): ErrorIssue => ({
    path: 'SKILL.md',
    ...(line !== undefined ? { line } : {}),
    ...(column !== undefined ? { column } : {}),
    message,
  });
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (!FENCE.test(lines[0] ?? '')) {
    return {
      ok: false,
      issues: [
        at(
          'SKILL.md must start with YAML front matter: a line "---", then name: and description:, then "---"',
          1,
          1,
        ),
      ],
    };
  }
  const end = lines.findIndex((l, i) => i > 0 && FENCE.test(l));
  if (end < 0)
    return { ok: false, issues: [at('the front matter is not closed by a line "---"', 1, 1)] };
  const yamlText = lines.slice(1, end).join('\n');
  const body = lines
    .slice(end + 1)
    .join('\n')
    .trim();
  // Line numbers of the front matter are shifted by the opening fence.
  const shift = (line: number): number => line + 1;

  const lc = new LineCounter();
  const doc = parseDocument(yamlText, { lineCounter: lc, uniqueKeys: true, prettyErrors: false });
  if (doc.errors.length > 0) {
    return {
      ok: false,
      issues: doc.errors.map((e) => {
        const p = e.linePos?.[0] ?? (e.pos ? lc.linePos(e.pos[0]) : undefined);
        return at(e.message.split('\n')[0]!.trim(), p ? shift(p.line) : 2, p?.col);
      }),
    };
  }
  if (!isMap(doc.contents))
    return {
      ok: false,
      issues: [at('the front matter must be YAML key: value pairs (name, description)', 2, 1)],
    };
  const issues: ErrorIssue[] = [];
  const positionOf = (key: string, of: 'key' | 'value'): { line: number; column: number } => {
    const pair = (doc.contents as { items: Array<{ key: unknown; value: unknown }> }).items.find(
      (p) => isScalar(p.key) && String(p.key.value) === key,
    );
    const node = (of === 'value' ? (pair?.value ?? pair?.key) : pair?.key) as
      { range?: [number, number, number] } | undefined;
    const off = node?.range?.[0];
    if (off === undefined) return { line: 2, column: 1 };
    const p = lc.linePos(off);
    return { line: shift(p.line), column: p.col };
  };
  let data: Record<string, unknown>;
  try {
    data = doc.toJS({ maxAliasCount: 10 }) as Record<string, unknown>;
  } catch (e) {
    return { ok: false, issues: [at(e instanceof Error ? e.message : String(e), 2, 1)] };
  }
  const known = ['name', 'description', ...SKILL_OPTIONAL_KEYS];
  for (const key of Object.keys(data)) {
    if (!known.includes(key)) {
      const p = positionOf(key, 'key');
      issues.push(
        at(`unknown front matter key "${key}" (known: ${known.join(', ')})`, p.line, p.column),
      );
    }
  }
  const name = data['name'];
  if (name === undefined) issues.push(at('missing required key "name"', 2, 1));
  else if (typeof name !== 'string') {
    const p = positionOf('name', 'value');
    issues.push(at('name must be a string', p.line, p.column));
  } else if (!SKILL_NAME_RE.test(name)) {
    const p = positionOf('name', 'value');
    issues.push(
      at(
        `name "${name}" must match ^[a-z0-9]([a-z0-9-]{0,62})$ (lowercase letters, digits and "-", max 63 characters)`,
        p.line,
        p.column,
      ),
    );
  } else if (name !== folder) {
    const p = positionOf('name', 'value');
    issues.push(
      at(
        `name "${name}" differs from the folder name "${folder}"; rename one of them`,
        p.line,
        p.column,
      ),
    );
  }
  const description = data['description'];
  if (description === undefined) issues.push(at('missing required key "description"', 2, 1));
  else if (typeof description !== 'string' || description.trim().length === 0) {
    const p = positionOf('description', 'value');
    issues.push(
      at(
        'description must be a non-empty string: what the skill does and when to use it',
        p.line,
        p.column,
      ),
    );
  } else if (description.length > MAX_SKILL_DESCRIPTION) {
    const p = positionOf('description', 'value');
    issues.push(
      at(
        `description is ${description.length} characters long; at most ${MAX_SKILL_DESCRIPTION} are allowed`,
        p.line,
        p.column,
      ),
    );
  }
  for (const key of ['license', 'compatibility', 'version', 'model', 'argument-hint']) {
    if (data[key] !== undefined && typeof data[key] !== 'string') {
      const p = positionOf(key, 'value');
      issues.push(at(`${key} must be a string`, p.line, p.column));
    }
  }
  const metadata = data['metadata'];
  if (
    metadata !== undefined &&
    (metadata === null ||
      typeof metadata !== 'object' ||
      Array.isArray(metadata) ||
      Object.values(metadata).some((v) => typeof v !== 'string'))
  ) {
    const p = positionOf('metadata', 'value');
    issues.push(at('metadata must be a map of strings', p.line, p.column));
  }
  const tools = data['allowed-tools'];
  if (
    tools !== undefined &&
    typeof tools !== 'string' &&
    !(Array.isArray(tools) && tools.every((t) => typeof t === 'string'))
  ) {
    const p = positionOf('allowed-tools', 'value');
    issues.push(at('allowed-tools must be a string or a list of strings', p.line, p.column));
  }
  if (body.length === 0)
    issues.push(at('SKILL.md has no instructions after the front matter', shift(end) + 1));
  if (issues.length > 0) return { ok: false, issues };
  const extra: Record<string, unknown> = {};
  for (const key of SKILL_OPTIONAL_KEYS) if (data[key] !== undefined) extra[key] = data[key];
  return {
    ok: true,
    skill: {
      frontMatter: { name: name as string, description: description as string, extra },
      body,
    },
  };
}
