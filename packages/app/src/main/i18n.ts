import type { Locale } from '../shared/ipc';
import de from '../renderer/i18n/de.json';
import en from '../renderer/i18n/en.json';

const tables: Record<Locale, Record<string, string>> = { de, en };

/** Strings of the main process (tray, notifications). Keys live under `main.` in the shared catalogs. */
export function mt(
  locale: Locale,
  key: string,
  params: Record<string, string | number> = {},
): string {
  const raw = tables[locale][key] ?? tables.de[key] ?? key;
  return raw.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? `{${k}}`));
}
