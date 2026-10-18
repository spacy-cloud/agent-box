import { Menu, Notification, Tray, app } from 'electron';
import type { ApprovalView } from '@abox/core';
import type { Locale } from '../shared/ipc';
import { trayIcon } from './icons';
import { mt } from './i18n';

export interface TrayHandlers {
  showWindow(): void;
  showApprovals(approvalId?: string): void;
  quit(): void;
}

/**
 * Tray icon, launcher badge and desktop notification for pending approvals. Every part degrades
 * gracefully: without a tray host (many Wayland setups, CI) or notification daemon the app still works,
 * and the pending count stays visible in the window.
 */
export class TrayController {
  private tray: Tray | null = null;
  private count = 0;
  readonly trayAvailable: boolean;
  readonly notificationsAvailable: boolean;

  constructor(
    private locale: Locale,
    private readonly handlers: TrayHandlers,
  ) {
    this.notificationsAvailable = Notification.isSupported();
    try {
      this.tray = new Tray(trayIcon(false));
      this.tray.on('click', () => handlers.showWindow());
      this.refresh();
    } catch {
      this.tray = null;
    }
    this.trayAvailable = this.tray !== null;
  }

  setLocale(l: Locale): void {
    this.locale = l;
    this.refresh();
  }

  update(pending: ApprovalView[], fresh: ApprovalView[]): void {
    this.count = pending.length;
    this.refresh();
    try {
      app.setBadgeCount(this.count);
    } catch {
      /* not supported on this desktop */
    }
    if (fresh.length > 0 && this.notificationsAvailable) this.notify(fresh);
  }

  private refresh(): void {
    if (!this.tray) return;
    try {
      this.tray.setImage(trayIcon(this.count > 0));
      this.tray.setToolTip(
        this.count > 0
          ? mt(this.locale, 'main.tray.tooltipPending', { count: this.count })
          : mt(this.locale, 'main.tray.tooltip'),
      );
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

  private notify(fresh: ApprovalView[]): void {
    try {
      const first = fresh[0]!;
      // Agent-written text is shown as plain text only and kept short; the real decision happens in the GUI.
      const n = new Notification({
        title: mt(this.locale, 'main.notification.title', { count: fresh.length }),
        body: mt(this.locale, 'main.notification.body', {
          agent: first.requester.slice(0, 60),
          kind: first.kind,
        }),
        silent: false,
      });
      n.on('click', () => this.handlers.showApprovals(first.id));
      n.show();
    } catch {
      /* no notification service */
    }
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }
}
