import { createHash } from 'node:crypto';

/** Deterministic JSON: object keys sorted, `undefined` dropped. Arrays keep their order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = sortKeys(v);
    }
    return out;
  }
  return value;
}

/**
 * sha256 hex over the canonical JSON of a request digest object. An approval is
 * bound to this hash: any change of template, paths, network, secrets,
 * resources, ... yields a different hash and needs a new decision.
 */
export function hashRequestDigest(requestDigest: unknown): string {
  return createHash('sha256').update(canonicalJson(requestDigest), 'utf8').digest('hex');
}
