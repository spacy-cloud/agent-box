import { join } from 'node:path';
import { BrowserWindow, app, nativeTheme } from 'electron';
import { AboxError } from '@abox/core';
import type { AboxRuntime } from '@abox/runtime';
import type { ApprovalView } from '@abox/core';
import type { EventPayloads, EventChannel, Locale } from '../shared/ipc';
import { registerIpc } from './ipc';
import type { IpcHandle } from './ipc';
import { Askpass } from './askpass';
import { openSshPty, sshLabel } from './ssh-pty';
import { TtyManager, backendFromTtySession } from './tty';
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
let stopTtlWatch: (() => void) | null = null;
let tray: TrayController | null = null;
let settings: GuiSettings;
let locale: Locale = 'de';
let quitting = false;
let pendingApprovals = 0;
let ipc: IpcHandle | null = null;

const requireRuntime = (): AboxRuntime => {
  if (!runtime) {
    throw new AboxError('backend_unavailable', runtimeError ?? 'The manager is not available');
  }
  return runtime;
};

/**
 * Passphrase / PIN prompts of ssh sessions are answered in a dialog of the window (see `askpass.ts`), so they
 * never happen unseen in the background nor inside a terminal.
 */
const askpass = new Askpass({
  onRequest: (ev) => {
    showWindow();
    send('evt:askpass', ev);
  },
  onEnd: (id) => send('evt:askpass-end', { id }),
});

/** Terminals: sandbox shells through the manager, ssh through the system `ssh` in a pty. */
const tty = new TtyManager({
  send: (channel, payload) => send(channel, payload),
  openSandbox: async (id, size) => {
    const session = await requireRuntime().abox.attach({ contextId: 'human' }, id, size);
    return backendFromTtySession(session, id);
  },
  openSsh: async (hostId, size) => {
    const rt = requireRuntime();
    const profile = rt.hostRegistry.require(hostId);
    if (profile.kind !== 'ssh') {
      throw new AboxError('invalid_input', `"${hostId}" is the local host, not an ssh host`);
    }
    // Per session: its own token for the helper, revoked when ssh ends.
    const session = askpass.forSession(sshLabel(profile));
    return openSshPty({ profile, env: rt.hostsEnv, size, askpass: session });
  },
});

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
  // Optional: the close button hides the window and the tray icon brings it back. Only with a tray icon,
  // otherwise the window could not be restored (a second start of abox also shows it again).
  win.on('close', (e) => {
    if (!quitting && settings.closeToTray && tray?.trayAvailable) {
      e.preventDefault();
      win.hide();
    }
  });
  // A reload or closing the window ends every terminal session that belongs to it.
  win.webContents.on('did-start-loading', () => {
    askpass.cancelAll();
    tty.closeAll();
  });
  win.on('closed', () => {
    askpass.cancelAll();
    tty.closeAll();
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

  try {
    await askpass.start();
  } catch (e) {
    // Without the helper ssh asks in the terminal as before; nothing else depends on it.
    console.error(
      `ssh passphrase dialog unavailable: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  ipc = registerIpc({
    tty,
    askpass,
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
      closeToTray: settings.closeToTray,
    }),
    setCloseToTray: (on) => settings.setCloseToTray(on),
    recentProjects: () => settings.recentProjects,
    rememberProject: (dir) => settings.addRecentProject(dir),
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
    // Expired sandboxes are stopped on time while the GUI runs, not only when a command happens to.
    stopTtlWatch = runtime.abox.startTtlWatcher();
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
    stopTtlWatch?.();
    tty.closeAll();
    askpass.dispose();
    tray?.destroy();
    void ipc?.shutdown().catch(() => undefined);
    void runtime?.close().catch(() => undefined);
  });
}

// Exposed for diagnostics via `electronApp.evaluate` in tests only through the main module scope.
export function pendingApprovalCount(): number {
  return pendingApprovals;
}
