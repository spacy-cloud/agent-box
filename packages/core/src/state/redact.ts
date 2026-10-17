/**
 * Redaction of secrets before anything is persisted or logged.
 * Best effort: key-name based (`redact`) plus exact known values (`redactValues`).
 */

export const REDACTED = '[redacted]';

/** Keys whose values are never persisted in audit details. */
export const SENSITIVE_KEY =
  /token|secret|password|passphrase|authorization|cookie|private.?key|credential/i;

/** Known secret values shorter than this are ignored (they would mangle ordinary text). */
const MIN_SECRET_LENGTH = 4;
const MAX_DEPTH = 32;

function walk(
  value: unknown,
  leaf: (s: string) => string,
  byKey: boolean,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (typeof value === 'string') return leaf(value);
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return value;
  if (depth > MAX_DEPTH) return '[max-depth]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  try {
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Error) {
      return { name: value.name, message: leaf(value.message) };
    }
    if (ArrayBuffer.isView(value)) return `[binary ${value.byteLength} bytes]`;
    if (Array.isArray(value)) return value.map((v) => walk(v, leaf, byKey, seen, depth + 1));
    if (value instanceof Map) return walk(Object.fromEntries(value), leaf, byKey, seen, depth + 1);
    if (value instanceof Set) return walk([...value], leaf, byKey, seen, depth + 1);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined || typeof v === 'function' || typeof v === 'symbol') continue;
      out[k] = byKey && SENSITIVE_KEY.test(k) ? REDACTED : walk(v, leaf, byKey, seen, depth + 1);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/**
 * Deep copy of `value` where the value of every key matching {@link SENSITIVE_KEY}
 * is replaced by `"[redacted]"`. Handles arrays, Maps, Sets, Errors, cycles.
 */
export function redact<T = unknown>(value: T): T {
  return walk(value, (s) => s, true, new WeakSet(), 0) as T;
}

/** Replace every occurrence of a known secret value inside a string. */
export function redactString(text: string, knownSecretValues: Iterable<string>): string {
  const secrets = [...new Set(knownSecretValues)].filter((s) => s.length >= MIN_SECRET_LENGTH);
  secrets.sort((a, b) => b.length - a.length);
  let out = text;
  for (const secret of secrets) out = out.split(secret).join(REDACTED);
  return out;
}

/**
 * Deep copy of `value` where every occurrence of a known secret value
 * (inside any string, e.g. a command line or an error message) is masked.
 */
export function redactValues<T = unknown>(value: T, knownSecretValues: Iterable<string>): T {
  const secrets = [...knownSecretValues];
  return walk(value, (s) => redactString(s, secrets), false, new WeakSet(), 0) as T;
}
