import { createHash } from 'node:crypto';

/**
 * Deterministic JSON: object keys sorted, `undefined` properties dropped,
 * no whitespace. Used for hashing (approval request binding, audit chain).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value)) ?? 'null';
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'number' && !Number.isFinite(value)) return null;
    return value;
  }
  if (typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    return canonicalize((value as { toJSON(): unknown }).toJSON());
  }
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : canonicalize(v)));
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const v = (value as Record<string, unknown>)[key];
    if (v === undefined || typeof v === 'function' || typeof v === 'symbol') continue;
    out[key] = canonicalize(v);
  }
  return out;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** sha256 hex over the canonical JSON of `value`. */
export function hashJson(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
