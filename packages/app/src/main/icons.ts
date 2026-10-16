import { nativeImage } from 'electron';

/**
 * Draws the app / tray icon procedurally (raw BGRA bitmap), so there are no binary assets to ship.
 * `alert` adds a red dot for pending approvals.
 */
export function drawIcon(size: number, alert: boolean): Electron.NativeImage {
  const buf = Buffer.alloc(size * size * 4);
  const set = (x: number, y: number, r: number, g: number, b: number, a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const o = (y * size + x) * 4;
    buf[o] = b;
    buf[o + 1] = g;
    buf[o + 2] = r;
    buf[o + 3] = a;
  };
  const radius = size * 0.2;
  const inRounded = (x: number, y: number): boolean => {
    const cx = Math.min(Math.max(x, radius), size - 1 - radius);
    const cy = Math.min(Math.max(y, radius), size - 1 - radius);
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (inRounded(x, y)) set(x, y, 0x1f, 0x4e, 0x8c);
    }
  }
  // an open box outline in white: the "sandbox"
  const m = Math.round(size * 0.26);
  const t = Math.max(2, Math.round(size * 0.09));
  for (let y = m; y < size - m; y++) {
    for (let x = m; x < size - m; x++) {
      const border = x < m + t || x >= size - m - t || y >= size - m - t;
      const lid = y < m + t && (x < m + t * 2 || x >= size - m - t * 2);
      if (border || lid) set(x, y, 255, 255, 255);
    }
  }
  if (alert) {
    const cx = size * 0.76;
    const cy = size * 0.24;
    const rr = size * 0.22;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= rr ** 2) set(x, y, 0xd9, 0x2d, 0x20);
      }
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}
