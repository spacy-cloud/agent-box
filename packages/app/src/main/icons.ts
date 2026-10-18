import { nativeImage } from 'electron';
import { TRAY_ALERT_ICON_PNG, TRAY_ICON_PNG, WINDOW_ICON_PNG } from './icon-data';

/** The abox logo mark for the window (64 px). */
export function windowIcon(): Electron.NativeImage {
  return nativeImage.createFromBuffer(Buffer.from(WINDOW_ICON_PNG, 'base64'));
}

/** The logo mark for the tray (32 px); `alert` adds a red dot while approvals are waiting. */
export function trayIcon(alert: boolean): Electron.NativeImage {
  return nativeImage.createFromBuffer(
    Buffer.from(alert ? TRAY_ALERT_ICON_PNG : TRAY_ICON_PNG, 'base64'),
  );
}
