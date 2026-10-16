/**
 * Hardening of the app itself: strict CSP, own protocol for the renderer files (no `file://`, no remote
 * content), blocked navigation / new windows / webviews / permissions.
 */
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { app, protocol, session } from 'electron';
import type { Session, WebContents } from 'electron';
import { isAllowedUrl, resolveAppFile } from './guard';

export const APP_SCHEME = 'abox-app';
export const APP_HOST = 'app';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const APP_URL = `${APP_ORIGIN}/index.html`;

/** Production CSP: only our own bundled script/style files; nothing inline, no eval, no network. */
export const PRODUCTION_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
  "media-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** Dev server needs inline preamble scripts, websockets and eval-free HMR; used only with `electron-vite dev`. */
const DEV_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self' ws://localhost:* http://localhost:*",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/** Must run before `app.ready`. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: false } },
  ]);
}

const SECURITY_HEADERS = {
  'Content-Security-Policy': PRODUCTION_CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export function registerAppProtocol(root: string): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== APP_HOST) return new Response('forbidden', { status: 403 });
    const file = resolveAppFile(root, url.pathname);
    if (!file) return new Response('forbidden', { status: 403 });
    try {
      const body = await readFile(file);
      return new Response(new Uint8Array(body), {
        status: 200,
        headers: {
          ...SECURITY_HEADERS,
          'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
        },
      });
    } catch {
      return new Response('not found', { status: 404, headers: SECURITY_HEADERS });
    }
  });
}

/** Denies every permission request (camera, notifications from the page, clipboard-read, …). */
export function lockDownSession(ses: Session, devOrigin: string | null): void {
  ses.setPermissionRequestHandler((_wc, _perm, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  // Nothing may leave the app: only our own scheme (and the dev server in dev) may be requested.
  ses.webRequest.onBeforeRequest((details, callback) => {
    const u = details.url;
    const ok =
      u.startsWith(`${APP_SCHEME}://`) ||
      u.startsWith('devtools://') ||
      u.startsWith('data:') ||
      u.startsWith('blob:') ||
      (devOrigin !== null &&
        (u.startsWith(devOrigin) || u.startsWith(devOrigin.replace('http', 'ws'))));
    callback({ cancel: !ok });
  });
  if (devOrigin) {
    ses.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [DEV_CSP] },
      });
    });
  }
}

/** Applied to every WebContents the app ever creates. */
export function hardenWebContents(contents: WebContents, allowedOrigins: string[]): void {
  const allowed = (url: string): boolean => isAllowedUrl(url, allowedOrigins);
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event, url) => {
    // Only a reload of our own page is fine; everything else (links, forms, window.location) is blocked.
    if (!allowed(url) || url !== contents.getURL()) event.preventDefault();
  });
  contents.on('will-frame-navigate', (event) => {
    if (!allowed(event.url) || !event.isMainFrame) event.preventDefault();
  });
  contents.on('will-redirect', (event, url) => {
    if (!allowed(url)) event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

export function rendererRoot(): string {
  return join(app.getAppPath(), 'out', 'renderer');
}

export function lockDownDefaultSession(devOrigin: string | null): void {
  lockDownSession(session.defaultSession, devOrigin);
}
