import { join } from 'node:path';
import { BrowserWindow, app, nativeTheme } from 'electron';
import type { AboxRuntime } from '@abox/runtime';
import type { ApprovalView } from '@abox/core';
import type { EventPayloads, EventChannel, Locale } from '../shared/ipc';
import { registerIpc } from './ipc';
import { drawIcon } from './icons';
import { Monitor } from './monitor';
import { originOf } from './guard';
import { openRuntime } from './runtime';
import {
  APP_ORIGIN,
  APP_URL,
  hardenWebContents,
  lockDownDefaultSession,
  registerAppProtocol,
  registerAppScheme,
  rendererRoot,
} from './security';
import { GuiSettings, resolveLocale } from './settings';
import { TrayController } from './tray';

registerAppScheme();
app.enableSandbox();

// Tests (and CLI-style isolation) point everything below one directory.
const aboxHome = process.env['ABOX_HOME'];
if (aboxHome && aboxHome.trim() !== '') app.setPath('userData', join(aboxHome, 'gui'));

const devUrl = !app.isPackaged ? process.env['ELECTRON_RENDERER_URL'] : undefined;
const devOrigin = devUrl ? originOf(devUrl) : null;
const allowedOrigins = devOrigin ? [devOrigin] : [APP_ORIGIN];

let mainWindow: BrowserWindow | null = null;
let runtime: AboxRuntime | null = null;
let runtimeError: string | null = null;
let monitor: Monitor | null = null;
let tray: TrayController | null = null;
let settings: GuiSettings;
let locale: Locale = 'de';
let quitting = false;
let pendingApprovals = 0;

function send<E extends EventChannel>(channel: E, payload: EventPayloads[E]): void {
  const w = mainWindow;
  if (w && !w.isDestroyed() && !w.webContents.isDestroyed()) w.webContents.send(channel, payload);
}

function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function showApprovals(approvalId?: string): void {
  showWindow();
  send('evt:navigate', { view: 'approvals', ...(approvalId ? { approvalId } : {}) });
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'abox',
    icon: drawIcon(64, false),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#14171c' : '#f6f7f9',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      spellcheck: false,
      navigateOnDragDrop: false,
      safeDialogs: true,
      devTools: !app.isPackaged,
    },
  });
  mainWindow = win;
  win.setMenuBarVisibility(false);
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  void win.loadURL(devUrl ?? APP_URL);
}

function onApprovals(pending: ApprovalView[], fresh: ApprovalView[]): void {
  pendingApprovals = pending.length;
  tray?.update(pending, fresh);
}

async function boot(): Promise<void> {
  settings = new GuiSettings(app.getPath('userData'));
  locale = resolveLocale(settings.locale, process.env['ABOX_GUI_LOCALE'], app.getLocale());

  lockDownDefaultSession(devOrigin);
  if (!devUrl) registerAppProtocol(rendererRoot());

  try {
    runtime = await openRuntime(process.env);
  } catch (e) {
    runtimeError = e instanceof Error ? e.message : String(e);
  }

  tray = new TrayController(locale, {
    showWindow,
    showApprovals,
    quit: () => app.quit(),
  });

  registerIpc({
    getWindow: () => mainWindow,
    allowedOrigins,
    getRuntime: () => runtime,
    runtimeError: () => runtimeError,
    appInfo: () => ({
      version: app.getVersion(),
      platform: process.platform,
      contextId: 'human',
      locale,
      trayAvailable: tray?.trayAvailable ?? false,
      notificationsAvailable: tray?.notificationsAvailable ?? false,
    }),
    setLocale: (l) => {
      locale = l;
      settings.setLocale(l);
      tray?.setLocale(l);
    },
    poke: () => monitor?.poke('local'),
    progress: (key, line) => send('evt:progress', { key, line }),
  });

  if (runtime) {
    monitor = new Monitor({
      abox: runtime.abox,
      intervalMs: Number(process.env['ABOX_GUI_POLL_MS'] ?? 2000) || 2000,
      onChanged: (ev) => send('evt:changed', ev),
      onApprovals,
    });
    monitor.start();
  }

  createWindow();
}

app.on('web-contents-created', (_e, contents) => hardenWebContents(contents, allowedOrigins));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  void app.whenReady().then(boot);
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    if (quitting) return;
    quitting = true;
    monitor?.stop();
    tray?.destroy();
    void runtime?.close().catch(() => undefined);
  });
}

// Exposed for diagnostics via `electronApp.evaluate` in tests only through the main module scope.
export function pendingApprovalCount(): number {
  return pendingApprovals;
}
