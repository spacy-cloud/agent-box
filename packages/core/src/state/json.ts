/** Helpers for JSON text columns. */

export function toJson(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

export function fromJson<T>(text: unknown, fallback: T): T {
  if (typeof text !== 'string') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** node:sqlite returns null-prototype rows; copy into a plain typed object source. */
export type Row = Record<string, unknown>;

export function num(v: unknown): number {
  return typeof v === 'bigint' ? Number(v) : (v as number);
}

export function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : num(v);
}

export function strOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}
