import { Menu, Tray, app, nativeImage } from 'electron';
import type { ApprovalView } from '@abox/core';
import type { Locale } from '../shared/ipc';
import { trayIcon } from './icons';
import { mt } from './i18n';
import { probeTray } from './probe';
import { drawCountBadge } from './tray-badge';

export interface TrayHandlers {
  showWindow(): void;
  showApprovals(approvalId?: string): void;
  quit(): void;
}

/**
 * Tray icon (with the number of pending approvals drawn on it), tooltip, menu and launcher badge. Every part
 * degrades gracefully: without a tray host (many Wayland setups, CI) the app still works, and the pending count
 * stays visible in the window. Desktop notifications are `notifier.ts`.
 */
export class TrayController {
  private tray: Tray | null = null;
  private count = 0;
  readonly trayAvailable: boolean;
  private readonly icons = new Map<number, Electron.NativeImage>();

  constructor(
    private locale: Locale,
    private readonly handlers: TrayHandlers,
  ) {
    try {
      this.tray = new Tray(trayIcon(false));
      // With requests waiting a click goes straight to them.
      this.tray.on('click', () =>
        this.count > 0 ? handlers.showApprovals() : handlers.showWindow(),
      );
    } catch {
      this.tray = null;
    }
    this.trayAvailable = this.tray !== null;
    this.refresh();
  }

  setLocale(l: Locale): void {
    this.locale = l;
    this.refresh();
  }

  /** The pending approvals changed. */
  update(pending: readonly ApprovalView[]): void {
    this.count = pending.length;
    this.refresh();
    try {
      app.setBadgeCount(this.count);
    } catch {
      /* not supported on this desktop */
    }
  }

  /** The icon for `count` pending approvals: the plain mark, or with the count drawn on it. */
  private iconFor(count: number): Electron.NativeImage {
    if (count <= 0) return trayIcon(false);
    const key = Math.min(count, 10);
    let img = this.icons.get(key);
    if (!img) {
      try {
        const base = trayIcon(false);
        const { width, height } = base.getSize();
        // toBitmap() is BGRA on the little-endian machines Electron runs on
        img = nativeImage.createFromBitmap(drawCountBadge(base.toBitmap(), width, key), {
          width,
          height,
        });
      } catch {
        img = trayIcon(true); // the red dot
      }
      this.icons.set(key, img);
    }
    return img;
  }

  private refresh(): void {
    const tooltip =
      this.count > 0
        ? mt(this.locale, 'main.tray.tooltipPending', { count: this.count })
        : mt(this.locale, 'main.tray.tooltip');
    probeTray(this.count, tooltip);
    if (!this.tray) return;
    try {
      this.tray.setImage(this.iconFor(this.count));
      this.tray.setToolTip(tooltip);
      this.tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: mt(this.locale, 'main.tray.open'), click: () => this.handlers.showWindow() },
          {
            label: mt(this.locale, 'main.tray.approvals', { count: this.count }),
            click: () => this.handlers.showApprovals(),
          },
          { type: 'separator' },
          { label: mt(this.locale, 'main.tray.quit'), click: () => this.handlers.quit() },
        ]),
      );
    } catch {
      /* tray vanished (e.g. the shell restarted) */
    }
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }
}
