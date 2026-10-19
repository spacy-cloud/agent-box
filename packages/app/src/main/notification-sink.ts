import { Notification } from 'electron';
import { probeNotification } from './probe';
import type { NotificationSink, NotificationSpec } from './notifier';

/** Notifications that are shown and not yet closed: Electron drops a notification (and its click handler) that is garbage collected. */
const MAX_LIVE = 20;

/**
 * The desktop end of the notifier: an Electron `Notification` (freedesktop notification on Linux). No buttons: see
 * the rules in `notifier.ts`; a click only opens the view. Without a notification service nothing is shown and
 * nothing throws.
 */
export class ElectronNotificationSink implements NotificationSink {
  private readonly live = new Set<Electron.Notification>();
  readonly supported: boolean;

  constructor() {
    try {
      this.supported = Notification.isSupported();
    } catch {
      this.supported = false;
    }
  }

  show(spec: NotificationSpec, onClick: () => void): void {
    probeNotification({
      kind: spec.kind,
      title: spec.title,
      body: spec.body,
      target: spec.target,
    });
    if (!this.supported) return;
    const n = new Notification({
      title: spec.title,
      body: spec.body,
      silent: false,
      urgency: 'normal',
    });
    const forget = () => this.live.delete(n);
    n.on('click', () => {
      forget();
      onClick();
    });
    n.on('close', forget);
    n.on('failed', forget);
    this.live.add(n);
    if (this.live.size > MAX_LIVE) {
      const oldest = this.live.values().next().value;
      if (oldest) this.live.delete(oldest);
    }
    n.show();
  }
}
