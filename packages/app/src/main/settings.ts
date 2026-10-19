import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DEFAULT_NOTIFICATION_PREFS, LOCALES, NOTIFICATION_KINDS } from '../shared/ipc';
import type { Locale, NotificationKind, NotificationPrefs } from '../shared/ipc';

interface StoredSettings {
  locale?: Locale;
  closeToTray?: boolean;
  /** Notification kinds the user switched on or off; a missing kind is on. */
  notifications?: Partial<NotificationPrefs>;
  /** Project folders used for templates, most recent first. */
  recentProjects?: string[];
}

const MAX_RECENT_PROJECTS = 8;

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
        notifications?: unknown;
        recentProjects?: unknown;
      };
      if (typeof raw.locale === 'string' && (LOCALES as readonly string[]).includes(raw.locale)) {
        this.data.locale = raw.locale as Locale;
      }
      if (typeof raw.closeToTray === 'boolean') this.data.closeToTray = raw.closeToTray;
      if (typeof raw.notifications === 'object' && raw.notifications !== null) {
        const stored = raw.notifications as Record<string, unknown>;
        const prefs: Partial<NotificationPrefs> = {};
        for (const kind of NOTIFICATION_KINDS) {
          if (typeof stored[kind] === 'boolean') prefs[kind] = stored[kind];
        }
        this.data.notifications = prefs;
      }
      if (Array.isArray(raw.recentProjects)) {
        this.data.recentProjects = raw.recentProjects
          .filter(
            (p): p is string => typeof p === 'string' && p.startsWith('/') && p.length <= 4096,
          )
          .slice(0, MAX_RECENT_PROJECTS);
      }
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

  /** Which desktop notifications are on (default: all of them). */
  get notifications(): NotificationPrefs {
    return { ...DEFAULT_NOTIFICATION_PREFS, ...(this.data.notifications ?? {}) };
  }

  /** Project folders used for templates, most recent first. */
  get recentProjects(): string[] {
    return [...(this.data.recentProjects ?? [])];
  }

  addRecentProject(dir: string): void {
    this.data.recentProjects = [
      dir,
      ...(this.data.recentProjects ?? []).filter((p) => p !== dir),
    ].slice(0, MAX_RECENT_PROJECTS);
    this.save();
  }

  setLocale(l: Locale): void {
    this.data.locale = l;
    this.save();
  }

  setCloseToTray(on: boolean): void {
    this.data.closeToTray = on;
    this.save();
  }

  setNotifications(change: Partial<Record<NotificationKind, boolean | undefined>>): void {
    const next: Partial<NotificationPrefs> = { ...(this.data.notifications ?? {}) };
    for (const kind of NOTIFICATION_KINDS) {
      const v = change[kind];
      if (typeof v === 'boolean') next[kind] = v;
    }
    this.data.notifications = next;
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
