import { LineCounter, isMap, isScalar, isSeq, parseDocument, type Document } from 'yaml';
import type { ZodType } from 'zod';
import { AboxError, type ErrorIssue } from '../errors.js';
import type { TemplateSpec } from '../types.js';
import { templateSchema } from './schema.js';

export interface ParseTemplateOptions {
  /** File path, only used in error messages. */
  path?: string;
}

/** Hard cap for template files; real templates are a few hundred bytes. */
export const MAX_TEMPLATE_BYTES = 512 * 1024;

/**
 * Parses and validates a template file. Throws `AboxError('template_invalid')` whose
 * `issues` carry the field path plus 1-based line/column of the offending YAML node.
 */
export function parseTemplateYaml(text: string, opts: ParseTemplateOptions = {}): TemplateSpec {
  const issues = collectIssues(text);
  if ('spec' in issues) return issues.spec;
  throw templateInvalidError(issues.issues, opts.path);
}

/** Like `parseTemplateYaml` but returns the issues instead of throwing. */
export function safeParseTemplateYaml(
  text: string,
): { ok: true; spec: TemplateSpec } | { ok: false; issues: ErrorIssue[] } {
  const r = collectIssues(text);
  return 'spec' in r ? { ok: true, spec: r.spec } : { ok: false, issues: r.issues };
}

/** Builds the standard `template_invalid` error from positioned issues. */
export function templateInvalidError(issues: ErrorIssue[], path?: string): AboxError {
  const first = issues[0];
  const where = first ? formatIssueLocation(first) : '';
  const more = issues.length > 1 ? ` (+${issues.length - 1} more)` : '';
  const file = path ? ` ${path}` : '';
  return new AboxError(
    'template_invalid',
    `Invalid template${file}: ${where ? `${where}: ` : ''}${first?.message ?? 'unknown problem'}${more}`,
    {
      issues,
      details: path ? { path } : undefined,
      hint: 'Fix the listed fields; `abox template validate <file>` shows all problems with line numbers.',
    },
  );
}

/** `resources.memory (line 12, column 11)` */
export function formatIssueLocation(issue: ErrorIssue): string {
  const parts: string[] = [];
  if (issue.path) parts.push(issue.path);
  if (issue.line !== undefined)
    parts.push(`line ${issue.line}${issue.column !== undefined ? `, column ${issue.column}` : ''}`);
  if (parts.length === 2) return `${parts[0]} (${parts[1]})`;
  return parts[0] ?? '';
}

/**
 * Adds `line`/`column` to issues that only carry a dotted `path` (e.g. problems found
 * by `resolveTemplate` or `validateTemplate` on the original file text). Issues whose
 * path cannot be found keep pointing at the nearest existing parent node.
 */
export function annotateIssuePositions(text: string, issues: ErrorIssue[]): ErrorIssue[] {
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc, uniqueKeys: true, prettyErrors: false });
  if (doc.errors.length > 0) return issues;
  return issues.map((i) => {
    if (i.line !== undefined || !i.path) return i;
    const pos = locate(doc, lc, parsePathString(i.path), 'value');
    return pos ? { ...i, line: pos.line, column: pos.column } : i;
  });
}

// ---------------------------------------------------------------------------

type PathSeg = string | number;

function collectIssues(text: string): { spec: TemplateSpec } | { issues: ErrorIssue[] } {
  if (Buffer.byteLength(text) > MAX_TEMPLATE_BYTES) {
    return { issues: [{ message: `template is larger than ${MAX_TEMPLATE_BYTES} bytes` }] };
  }
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc, uniqueKeys: true, prettyErrors: false });

  if (doc.errors.length > 0) {
    return {
      issues: doc.errors.map((e) => {
        const p = e.linePos?.[0] ?? (e.pos ? lc.linePos(e.pos[0]) : undefined);
        return {
          message: firstLine(e.message),
          ...(p ? { line: p.line, column: p.col } : {}),
        } satisfies ErrorIssue;
      }),
    };
  }
  if (doc.contents === null || doc.contents === undefined) {
    return { issues: [{ message: 'template file is empty', line: 1, column: 1 }] };
  }
  if (!isMap(doc.contents)) {
    const pos = locate(doc, lc, [], 'value');
    return {
      issues: [
        { message: 'template must be a YAML mapping (key: value pairs) at the top level', ...pos },
      ],
    };
  }

  let data: unknown;
  try {
    data = doc.toJS({ maxAliasCount: 100 });
  } catch (e) {
    return {
      issues: [
        { message: firstLine(e instanceof Error ? e.message : String(e)), line: 1, column: 1 },
      ],
    };
  }

  const parsed = templateSchema.safeParse(data);
  if (parsed.success) return { spec: parsed.data };

  const out: ErrorIssue[] = [];
  for (const zi of parsed.error.issues) {
    const base = zi.path as PathSeg[];
    if (zi.code === 'unrecognized_keys') {
      for (const key of zi.keys) {
        const path = [...base, key];
        out.push({
          path: formatPath(path),
          message: unknownKeyMessage(base, key),
          ...locate(doc, lc, path, 'key'),
        });
      }
      continue;
    }
    if (zi.code === 'invalid_key') {
      const nested = (zi as { issues?: Array<{ message: string }> }).issues?.[0]?.message;
      out.push({
        path: formatPath(base),
        message: `invalid key "${String(base[base.length - 1])}": ${nested ?? zi.message}`,
        ...locate(doc, lc, base, 'key'),
      });
      continue;
    }
    let message = zi.message;
    if (zi.code === 'invalid_type' && valueAt(data, base) === undefined) {
      message = `missing required field "${String(base[base.length - 1])}"`;
    } else if (zi.code === 'invalid_value' && zi.message.startsWith('Invalid option')) {
      message = `${zi.message.replace(/^Invalid option: /, 'invalid value: ')}`;
    }
    out.push({ path: formatPath(base), message, ...locate(doc, lc, base, 'value') });
  }
  return { issues: out };
}

function firstLine(s: string): string {
  return s.split('\n')[0]!.trim();
}

function valueAt(data: unknown, path: PathSeg[]): unknown {
  let cur: unknown = data;
  for (const seg of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[String(seg)];
  }
  return cur;
}

/** `resources.memory`, `mounts[0].target`. */
export function formatPath(path: ReadonlyArray<PropertyKey>): string {
  let out = '';
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else out += out ? `.${String(seg)}` : String(seg);
  }
  return out;
}

function parsePathString(path: string): PathSeg[] {
  const out: PathSeg[] = [];
  for (const part of path.split('.')) {
    const m = /^([^[\]]*)((?:\[\d+\])*)$/.exec(part);
    if (!m) {
      out.push(part);
      continue;
    }
    if (m[1]) out.push(m[1]);
    for (const idx of m[2]!.matchAll(/\[(\d+)\]/g)) out.push(Number(idx[1]));
  }
  return out;
}

/**
 * Finds the YAML node for a path and returns its 1-based position. When the path does not
 * exist (missing required field), the nearest existing ancestor is used.
 */
function locate(
  doc: Document,
  lc: LineCounter,
  path: PathSeg[],
  target: 'key' | 'value',
): { line: number; column: number } | undefined {
  let node: unknown = doc.contents;
  let offset: number | undefined = (doc.contents as { range?: [number, number, number] } | null)
    ?.range?.[0];
  for (let i = 0; i < path.length; i++) {
    const seg = path[i]!;
    const last = i === path.length - 1;
    if (isMap(node)) {
      const pair = node.items.find((p) => isScalar(p.key) && String(p.key.value) === String(seg));
      if (!pair) break;
      const keyOff = (pair.key as { range?: [number, number, number] }).range?.[0];
      const valOff = (pair.value as { range?: [number, number, number] } | null)?.range?.[0];
      offset = last && target === 'key' ? keyOff : (valOff ?? keyOff);
      node = pair.value;
    } else if (isSeq(node)) {
      const item = node.items[Number(seg)];
      if (item === undefined) break;
      offset = (item as { range?: [number, number, number] } | null)?.range?.[0] ?? offset;
      node = item;
    } else {
      break;
    }
  }
  if (offset === undefined) return { line: 1, column: 1 };
  const p = lc.linePos(offset);
  return { line: p.line, column: p.col };
}

// ---------------------------------------------------------------------------
// "Did you mean" for unknown keys, derived from the schema itself
// ---------------------------------------------------------------------------

type AnyDef = {
  type?: string;
  innerType?: ZodType;
  element?: ZodType;
  shape?: Record<string, ZodType>;
};

function defOf(s: ZodType): AnyDef {
  return (s as unknown as { def: AnyDef }).def;
}

function knownKeysAt(path: PathSeg[]): string[] {
  let cur: ZodType | undefined = templateSchema;
  for (const seg of path) {
    cur = unwrap(cur);
    if (!cur) return [];
    const d = defOf(cur);
    if (d.type === 'array' && typeof seg === 'number') cur = d.element;
    else if (d.type === 'object' && d.shape) cur = d.shape[String(seg)];
    else return [];
  }
  cur = unwrap(cur);
  const d = cur ? defOf(cur) : undefined;
  return d?.type === 'object' && d.shape ? Object.keys(d.shape) : [];
}

function unwrap(s: ZodType | undefined): ZodType | undefined {
  let cur = s;
  for (let i = 0; cur && i < 5; i++) {
    const d = defOf(cur);
    if ((d.type === 'optional' || d.type === 'default' || d.type === 'nullable') && d.innerType)
      cur = d.innerType;
    else break;
  }
  return cur;
}

function unknownKeyMessage(parent: PathSeg[], key: string): string {
  const known = knownKeysAt(parent);
  const where = parent.length ? ` in "${formatPath(parent)}"` : '';
  if (known.length === 0) return `unknown field "${key}"${where}`;
  const best = known
    .map((k) => ({ k, d: editDistance(k.toLowerCase(), key.toLowerCase()) }))
    .sort((a, b) => a.d - b.d)[0];
  const suggestion =
    best && best.d <= Math.max(2, Math.floor(key.length / 3)) ? ` - did you mean "${best.k}"?` : '';
  return `unknown field "${key}"${where}${suggestion} (known fields: ${known.join(', ')})`;
}

function editDistance(a: string, b: string): number {
  const dp: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length]!;
}
