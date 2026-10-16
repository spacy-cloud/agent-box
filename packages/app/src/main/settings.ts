import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { LOCALES } from '../shared/ipc';
import type { Locale } from '../shared/ipc';

interface StoredSettings {
  locale?: Locale;
  closeToTray?: boolean;
}

/** Small per-user GUI preferences (language, close to tray). The manager's own config lives elsewhere. */
export class GuiSettings {
  private readonly file: string;
  private data: StoredSettings = {};

  constructor(userDataDir: string) {
    this.file = join(userDataDir, 'gui-settings.json');
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as {
        locale?: unknown;
        closeToTray?: unknown;
      };
      if (typeof raw.locale === 'string' && (LOCALES as readonly string[]).includes(raw.locale)) {
        this.data.locale = raw.locale as Locale;
      }
      if (typeof raw.closeToTray === 'boolean') this.data.closeToTray = raw.closeToTray;
    } catch {
      /* first start or unreadable: defaults */
    }
  }

  get locale(): Locale | undefined {
    return this.data.locale;
  }

  /** Default: closing the window quits the app. */
  get closeToTray(): boolean {
    return this.data.closeToTray === true;
  }

  setLocale(l: Locale): void {
    this.data.locale = l;
    this.save();
  }

  setCloseToTray(on: boolean): void {
    this.data.closeToTray = on;
    this.save();
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      writeFileSync(this.file, JSON.stringify(this.data), { mode: 0o600 });
    } catch {
      /* preferences are a convenience; never fail the UI because of them */
    }
  }
}

/** German is the default; an English system locale selects English. `ABOX_GUI_LOCALE` forces one (tests). */
export function resolveLocale(
  stored: Locale | undefined,
  env: string | undefined,
  system: string,
): Locale {
  if (env && (LOCALES as readonly string[]).includes(env)) return env as Locale;
  if (stored) return stored;
  return system.toLowerCase().startsWith('en') ? 'en' : 'de';
}
