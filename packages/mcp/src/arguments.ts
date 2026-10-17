import type { z } from 'zod';

/**
 * Tool inputs are strict: a parameter a tool does not know is an error, never silently dropped
 * (an agent that writes `branch` instead of `branch_name`, or `overrides.project_dir`, would
 * otherwise get a result that ignores part of what it asked for). This module turns zod's
 * `unrecognized_keys` issues into a message that names the key and suggests the closest valid one.
 */

/** The parts of a zod 4 schema this module walks (`schema.def`). */
interface SchemaNode {
  def: {
    type: string;
    shape?: Record<string, SchemaNode>;
    element?: SchemaNode;
    innerType?: SchemaNode;
  };
}

const WRAPPERS = new Set(['optional', 'nullable', 'default', 'prefault', 'readonly']);

function unwrap(node: SchemaNode | undefined): SchemaNode | undefined {
  let cur = node;
  while (cur && WRAPPERS.has(cur.def.type)) cur = cur.def.innerType;
  return cur;
}

/** Keys the object schema at `path` accepts (`undefined` when `path` does not lead to an object). */
export function validKeysAt(
  schema: z.ZodType,
  path: ReadonlyArray<PropertyKey>,
): string[] | undefined {
  let cur = unwrap(schema as unknown as SchemaNode);
  for (const seg of path) {
    if (!cur) return undefined;
    if (cur.def.type === 'object') cur = unwrap(cur.def.shape?.[String(seg)]);
    else if (cur.def.type === 'array') cur = unwrap(cur.def.element);
    else return undefined;
  }
  return cur?.def.type === 'object' ? Object.keys(cur.def.shape ?? {}) : undefined;
}

function distance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j]!;
      prev[j] = Math.min(up + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length]!;
}

const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** The valid key closest to `key` (spelling, `camelCase` vs `snake_case`, a truncated name), if any is close. */
export function closestKey(key: string, valid: readonly string[]): string | undefined {
  const k = squash(key);
  if (k === '') return undefined;
  let best: { key: string; score: number } | undefined;
  for (const v of valid) {
    const w = squash(v);
    let score: number;
    if (w === k) score = 0;
    else if (k.length >= 3 && (w.startsWith(k) || k.startsWith(w))) score = 1;
    else {
      const d = distance(k, w);
      score = d <= Math.max(2, Math.floor(Math.max(k.length, w.length) / 3)) ? 1 + d : Infinity;
    }
    if (score !== Infinity && (!best || score < best.score)) best = { key: v, score };
  }
  return best?.key;
}

export interface ArgumentProblem {
  message: string;
  hint: string;
}

/**
 * Message and hint for a failed parse that contains unknown parameters; `undefined` when the only
 * problems are other ones (those keep the SDK's own wording).
 */
export function describeUnknownParameters(
  schema: z.ZodType,
  issues: ReadonlyArray<z.core.$ZodIssue>,
): ArgumentProblem | undefined {
  const lines: string[] = [];
  const hints: string[] = [];
  for (const issue of issues) {
    if (issue.code !== 'unrecognized_keys') continue;
    const valid = validKeysAt(schema, issue.path);
    const where = issue.path.length > 0 ? ` in ${issue.path.map(String).join('.')}` : '';
    for (const key of issue.keys) {
      const full = [...issue.path.map(String), key].join('.');
      const guess = valid ? closestKey(key, valid) : undefined;
      lines.push(
        `unknown parameter "${full}"${guess ? ` (did you mean "${[...issue.path.map(String), guess].join('.')}"?)` : ''}`,
      );
      if (!guess && valid && valid.length > 0)
        hints.push(`Valid parameters${where || ' of this tool'}: ${valid.join(', ')}.`);
    }
  }
  if (lines.length === 0) return undefined;
  // Other problems of the same call are reported too, so one round trip fixes everything.
  for (const issue of issues) {
    if (issue.code === 'unrecognized_keys') continue;
    const at = issue.path.length > 0 ? `${issue.path.map(String).join('.')}: ` : '';
    lines.push(`${at}${issue.message}`);
  }
  return {
    message: `invalid arguments: ${lines.join('; ')}`,
    hint: [
      'Unknown parameters are rejected, not ignored: nothing was done. Fix the name and call again.',
      ...new Set(hints),
    ].join(' '),
  };
}
