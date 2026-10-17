import de from './de.json';
import en from './en.json';
import type { Locale } from '../../shared/ipc';

export type Catalog = Record<string, string>;
export const catalogs: Record<Locale, Catalog> = { de, en };

export type Params = Record<string, string | number>;

/**
 * Looks a key up in the catalog of `locale` (fallback: German, then the key itself). With a numeric
 * `count` param the suffixes `_one` / `_other` are tried first (`approvals.pending_one`).
 */
export function translate(locale: Locale, key: string, params: Params = {}): string {
  const table = catalogs[locale];
  let raw: string | undefined;
  if (typeof params['count'] === 'number') {
    const suffix = params['count'] === 1 ? '_one' : '_other';
    raw = table[key + suffix] ?? catalogs.de[key + suffix];
  }
  raw ??= table[key] ?? catalogs.de[key];
  if (raw === undefined) return key;
  return raw.replace(/\{(\w+)\}/g, (_, k: string) => (k in params ? String(params[k]) : `{${k}}`));
}

export type TFn = (key: string, params?: Params) => string;
