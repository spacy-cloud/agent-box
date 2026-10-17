import { join, normalize, sep } from 'node:path';

/**
 * Origin of a URL as `scheme://host[:port]`. `URL.origin` is the string "null" for non-special schemes such as
 * our `abox-app://`, so it cannot be used to recognise our own pages.
 */
export function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

export function isAllowedUrl(url: string, allowedOrigins: readonly string[]): boolean {
  const o = originOf(url);
  return o !== null && allowedOrigins.includes(o);
}

/** Resolves a request path below `root`; returns null for anything that would escape it. */
export function resolveAppFile(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const rel = decoded === '/' || decoded === '' ? '/index.html' : decoded;
  const full = normalize(join(root, rel));
  const base = normalize(root.endsWith(sep) ? root : root + sep);
  return full.startsWith(base) ? full : null;
}

export interface SenderLike {
  sender: unknown;
  senderFrame: { url: string; parent: unknown } | null;
}

/** A call must come from the top-level frame of our own window and our own origin. */
export function senderAllowed(
  ev: SenderLike,
  win: { isDestroyed(): boolean; webContents: unknown } | null,
  allowedOrigins: readonly string[],
): boolean {
  if (!win || win.isDestroyed()) return false;
  if (ev.sender !== win.webContents) return false;
  const frame = ev.senderFrame;
  if (!frame || frame.parent !== null) return false;
  return isAllowedUrl(frame.url, allowedOrigins);
}
