/**
 * Read-only diagnostics for the end-to-end tests: with `ABOX_GUI_PROBE=1` the tray state and the notifications
 * the app would show are kept on `globalThis.__aboxProbe`, where `electronApp.evaluate` can read them (a CI
 * desktop has neither a tray host nor a notification daemon). Nothing is written anywhere and nothing reads the
 * probe in the app itself. The renderer can not reach the main process's globals.
 */
export interface Probe {
  tray: { count: number; tooltip: string };
  notifications: Array<{ kind: string; title: string; body: string; target: unknown }>;
}

const enabled = process.env['ABOX_GUI_PROBE'] === '1';

function probe(): Probe | null {
  if (!enabled) return null;
  const g = globalThis as { __aboxProbe?: Probe };
  g.__aboxProbe ??= { tray: { count: 0, tooltip: '' }, notifications: [] };
  return g.__aboxProbe;
}

export function probeTray(count: number, tooltip: string): void {
  const p = probe();
  if (p) p.tray = { count, tooltip };
}

export function probeNotification(n: Probe['notifications'][number]): void {
  probe()?.notifications.push(n);
}
