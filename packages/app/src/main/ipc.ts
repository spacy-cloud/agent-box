import { createWriteStream, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { dialog, clipboard, ipcMain, shell } from 'electron';
import type { BrowserWindow } from 'electron';
import { AboxError } from '@abox/core';
import type { ProgressInfo } from '@abox/core';
import { renderDockerfile } from '@abox/backend-docker';
import type { AboxRuntime } from '@abox/runtime';
import type { z } from 'zod';
import { IPC } from '../shared/ipc';
import type {
  IpcChannel,
  IpcErrorData,
  IpcResult,
  Locale,
  NotificationKind,
  SetupWizardState,
} from '../shared/ipc';
import type { AppInfo, Outputs, SaveResult } from '../shared/types';
import { toIpcError } from './errors';
import { senderAllowed } from './guard';
import { createHostsService } from './hosts';
import { openPreview } from './preview';
import { resolveProjectDir } from './projects';
import type { HostsService } from './hosts';
import { createManagerHandlers } from './service';
import type { ManagerChannel, ManagerHandlers } from './service';
import { createTemplateHandlers } from './templates';
import type { TemplateChannel } from './templates';
import type { TtyManager } from './tty';
import type { Askpass } from './askpass';

type Input<C extends IpcChannel> = z.output<(typeof IPC)[C]>;

export interface IpcDeps {
  getWindow(): BrowserWindow | null;
  allowedOrigins: string[];
  getRuntime(): AboxRuntime | null;
  runtimeError(): string | null;
  appInfo(): Omit<AppInfo, 'managerError' | 'paths'>;
  setLocale(l: Locale): void;
  setCloseToTray(on: boolean): void;
  setSetupWizard(state: SetupWizardState): void;
  setNotifications(change: Partial<Record<NotificationKind, boolean | undefined>>): void;
  /** Recently used project folders of this user (most recent first) and a way to add one. */
  recentProjects(): string[];
  rememberProject(dir: string): void;
  /** Terminal sessions (sandbox shells and ssh) of this window. */
  tty: TtyManager;
  /** Answers to ssh passphrase prompts (`askpass:answer`). */
  askpass: Pick<Askpass, 'answer'>;
  /** The GUI changed something itself: refresh now. */
  poke(): void;
  progress(key: string, line: string, info?: ProgressInfo): void;
}

type HostChannel = Extract<IpcChannel, `hosts:${string}`>;

/** Channels served by the Electron main process itself (dialogs, clipboard, terminals, settings). */
type LocalChannel = Exclude<IpcChannel, ManagerChannel | TemplateChannel | HostChannel>;

const TEMPLATE_CHANNELS = new Set<string>([
  'templates:catalog',
  'templates:source',
  'templates:validate',
  'templates:save',
  'templates:build',
  'templates:test',
] satisfies TemplateChannel[]);

const WRITE_CHANNELS = new Set<IpcChannel>([
  'templates:save',
  'templates:build',
  'templates:test',
  'hosts:add',
  'hosts:update',
  'hosts:remove',
  'hosts:importApply',
  'sandboxes:start',
  'sandboxes:stop',
  'sandboxes:remove',
  'sandboxes:extend',
  'sandboxes:create',
  'network:allow',
  'snapshots:create',
  'snapshots:restore',
  'snapshots:delete',
  'snapshots:clone',
  'ports:add',
  'ports:remove',
  'approvals:approve',
  'approvals:deny',
  'policy:set',
  'reconcile:run',
  'caches:remove',
  'tokens:create',
  'tokens:revoke',
  'setup:apply',
]);

export interface IpcHandle {
  dispose(): void;
  /** Stops port forwards, removes scratch files. Called once on quit. */
  shutdown(): Promise<void>;
}

export function registerIpc(d: IpcDeps): IpcHandle {
  const need = (): AboxRuntime => {
    const rt = d.getRuntime();
    if (!rt) {
      const err = d.runtimeError();
      throw Object.assign(new Error(err ?? 'manager not available'), {
        ipc: {
          code: 'backend_unavailable',
          message: err ?? 'The manager is not available',
        } satisfies IpcErrorData,
      });
    }
    return rt;
  };
  let handlers: ManagerHandlers | null = null;
  let tpl: ReturnType<typeof createTemplateHandlers> | null = null;
  let hosts: HostsService | null = null;
  let handlersFor: object | null = null;
  const bind = (): void => {
    const rt = need();
    if (handlersFor === rt) return;
    handlers = createManagerHandlers(rt);
    tpl = createTemplateHandlers(rt);
    hosts?.shutdown();
    hosts = createHostsService(rt);
    handlersFor = rt;
  };
  const managerHandlers = (): ManagerHandlers => {
    bind();
    return handlers!;
  };
  const templateHandlers = (): NonNullable<typeof tpl> => {
    bind();
    return tpl!;
  };
  const hostsService = (): HostsService => {
    bind();
    return hosts!;
  };

  const electronHandlers: {
    [C in LocalChannel]: (input: Input<C>) => Promise<Outputs[C]> | Outputs[C];
  } = {
    'app:settings': (i) => {
      if (i.closeToTray !== undefined) d.setCloseToTray(i.closeToTray);
      if (i.setupWizard !== undefined) d.setSetupWizard(i.setupWizard);
      if (i.notifications) d.setNotifications(i.notifications);
      const now = d.appInfo();
      return {
        closeToTray: now.closeToTray,
        notifications: now.notifications,
        setupWizard: now.setupWizard,
      };
    },
    'projects:recent': () => existingFolders(d.recentProjects()),
    'projects:remember': async (i) => {
      const dir = await resolveProjectDir(i.dir);
      d.rememberProject(dir);
      return { dir, recent: existingFolders(d.recentProjects()) };
    },
    'files:copyIn': async (i) => {
      const win = d.getWindow();
      const opts = { properties: ['openFile' as const, 'openDirectory' as const] };
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
      const from = r.filePaths[0];
      if (r.canceled || !from) return { copied: null };
      await need().abox.copyIn({ contextId: 'human' }, i.id, from, i.sandboxPath);
      d.poke();
      return { copied: from };
    },
    'files:copyOut': async (i) => {
      const win = d.getWindow();
      const opts = { properties: ['openDirectory' as const, 'createDirectory' as const] };
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
      const dir = r.filePaths[0];
      if (r.canceled || !dir) return { copied: null };
      const target = join(dir, basename(i.sandboxPath.replace(/\/+$/, '')) || 'copy');
      await need().abox.copyOut({ contextId: 'human' }, i.id, i.sandboxPath, target);
      return { copied: target };
    },
    // The only way a URL leaves the app: the main process builds it from a forward of that sandbox (preview.ts).
    'ports:openPreview': (i) =>
      openPreview(
        { abox: need().abox, openExternal: (url) => shell.openExternal(url) },
        i.id,
        i.port,
      ),
    'askpass:answer': (i) => {
      d.askpass.answer(i.id, i.value);
    },
    'tty:open': (i) => d.tty.open(i),
    'tty:input': (i) => d.tty.input(i.sessionId, i.data),
    'tty:resize': (i) => d.tty.resize(i.sessionId, i.cols, i.rows),
    'tty:close': (i) => d.tty.close(i.sessionId),
    'templates:export': async (i): Promise<SaveResult> => {
      const dockerfile = i.format === 'dockerfile';
      let text = i.yaml;
      if (dockerfile) {
        const details = await need().abox.showTemplate({ contextId: 'human' }, i.name);
        if (details.template.backend !== 'docker' && details.template.backend !== 'podman') {
          throw new AboxError('unsupported', 'Only docker and podman templates have a Dockerfile');
        }
        text = renderDockerfile(details.template);
      }
      const win = d.getWindow();
      const base = i.name.replace(/[^A-Za-z0-9._-]/g, '_');
      const opts = { defaultPath: dockerfile ? `${base}.Dockerfile` : `${base}.yaml` };
      const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
      if (r.canceled || !r.filePath) return { saved: null };
      await writeFile(r.filePath, text.endsWith('\n') ? text : `${text}\n`, { mode: 0o600 });
      return { saved: r.filePath };
    },
    'app:info': () => {
      const rt = d.getRuntime();
      return {
        ...d.appInfo(),
        paths: rt
          ? {
              configDir: rt.paths.configDir,
              dataDir: rt.paths.dataDir,
              stateDb: rt.paths.stateDb,
              policyFile: rt.paths.policyFile,
            }
          : null,
        managerError: rt ? null : d.runtimeError(),
      };
    },
    'app:setLocale': (l) => d.setLocale(l),
    'app:copy': (text) => clipboard.writeText(text),
    'dialog:pickDirectory': async () => {
      const win = d.getWindow();
      const opts = { properties: ['openDirectory' as const] };
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
      return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
    },
    'export:save': async (i): Promise<SaveResult> => {
      const res = await managerHandlers()['export:run']({ id: i.id, format: i.format }, {});
      const win = d.getWindow();
      const ext = i.format === 'patch' ? 'patch' : 'diff';
      const opts = { defaultPath: `sandbox-${i.id.replace(/[^A-Za-z0-9._-]/g, '_')}.${ext}` };
      const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
      if (r.canceled || !r.filePath) return { saved: null };
      await writeFile(r.filePath, res.content ?? '', { mode: 0o600 });
      return { saved: r.filePath, count: res.files.length };
    },
    'changes:savePatch': async (i): Promise<SaveResult> => {
      const res = await need().abox.changesPatch({ contextId: 'human' }, i.id, {
        digest: i.digest,
        selection: i.selection,
      });
      const win = d.getWindow();
      const opts = {
        defaultPath: `sandbox-${i.id.replace(/[^A-Za-z0-9._-]/g, '_')}-selection.patch`,
      };
      const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
      if (r.canceled || !r.filePath) return { saved: null };
      await writeFile(r.filePath, res.patch, { mode: 0o600 });
      return { saved: r.filePath, count: res.plan.files.length };
    },
    'audit:exportSave': async (filter): Promise<SaveResult> => {
      const rt = need();
      const win = d.getWindow();
      const opts = { defaultPath: 'abox-audit.jsonl' };
      const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
      if (r.canceled || !r.filePath) return { saved: null };
      const stream = createWriteStream(r.filePath, { mode: 0o600 });
      try {
        const { order: _o, ...rest } = filter ?? {};
        const count = await rt.abox.exportAudit(
          { contextId: 'human' },
          JSON.parse(JSON.stringify(rest)),
          stream,
        );
        await new Promise<void>((resolve, reject) =>
          stream.end((err?: Error | null) => (err ? reject(err) : resolve())),
        );
        return { saved: r.filePath, count };
      } catch (e) {
        stream.destroy();
        throw e;
      }
    },
  };

  const channels = Object.keys(IPC) as IpcChannel[];
  for (const channel of channels) {
    ipcMain.handle(channel, async (ev, raw: unknown): Promise<IpcResult<unknown>> => {
      try {
        if (!senderAllowed(ev, d.getWindow(), d.allowedOrigins)) {
          return {
            ok: false,
            error: {
              code: 'policy_denied',
              message: 'IPC call from an untrusted frame was refused',
            },
          };
        }
        const parsed = IPC[channel].safeParse(raw);
        if (!parsed.success) {
          return {
            ok: false,
            error: {
              code: 'invalid_input',
              message: `invalid input for ${channel}`,
              issues: parsed.error.issues.map((i) => ({
                path: i.path.join('.'),
                message: i.message,
              })),
            },
          };
        }
        const input: unknown = parsed.data;
        const ctx = { onProgress: d.progress };
        const local = (electronHandlers as Record<string, ((i: unknown) => unknown) | undefined>)[
          channel
        ];
        let data: unknown;
        if (local) {
          data = await local(input);
        } else if (TEMPLATE_CHANNELS.has(channel)) {
          data = await (
            templateHandlers() as unknown as Record<
              string,
              (i: unknown, c: typeof ctx) => Promise<unknown>
            >
          )[channel]!(input, ctx);
        } else if (channel.startsWith('hosts:')) {
          data = await hostCall(hostsService(), channel as HostChannel, input);
        } else {
          data = await (
            managerHandlers() as unknown as Record<
              string,
              (i: unknown, c: typeof ctx) => Promise<unknown>
            >
          )[channel]!(input, ctx);
        }
        if (WRITE_CHANNELS.has(channel)) d.poke();
        return { ok: true, data };
      } catch (e) {
        const ipc = (e as { ipc?: IpcErrorData }).ipc;
        return { ok: false, error: ipc ?? toIpcError(e) };
      }
    });
  }
  return {
    dispose: () => {
      for (const c of channels) ipcMain.removeHandler(c);
    },
    shutdown: async () => {
      hosts?.shutdown();
      await tpl?.cleanup();
    },
  };
}

/** The folders in `dirs` that still exist (a recent folder may have been deleted since). */
function existingFolders(dirs: string[]): string[] {
  return dirs.filter((p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  });
}

/** Maps a hosts channel to the service call (input is already validated by the channel's Zod schema). */
function hostCall(svc: HostsService, channel: HostChannel, input: unknown): unknown {
  type In<C extends HostChannel> = z.output<(typeof IPC)[C]>;
  switch (channel) {
    case 'hosts:list':
      return svc.list();
    case 'hosts:add':
      return svc.add(input as In<'hosts:add'>);
    case 'hosts:update': {
      const i = input as In<'hosts:update'>;
      return svc.update(i.id, i.patch as Parameters<HostsService['update']>[1]);
    }
    case 'hosts:remove':
      return svc.remove((input as In<'hosts:remove'>).id);
    case 'hosts:test':
      return svc.test((input as In<'hosts:test'>).id);
    case 'hosts:importPreview':
      return svc.importPreview();
    case 'hosts:importApply':
      return svc.importApply((input as In<'hosts:importApply'>).ids);
    case 'hosts:keyCheck':
      return svc.keyCheck((input as In<'hosts:keyCheck'>).id);
    case 'hosts:keyTrust': {
      const i = input as In<'hosts:keyTrust'>;
      return svc.keyTrust(i.id, i.fingerprint);
    }
    case 'hosts:keyForget':
      return svc.keyForget((input as In<'hosts:keyForget'>).id);
    case 'hosts:forwards':
      return svc.forwards();
    case 'hosts:forwardStart': {
      const i = input as In<'hosts:forwardStart'>;
      return svc.forwardStart(i.id, i.name);
    }
    case 'hosts:forwardStop': {
      const i = input as In<'hosts:forwardStop'>;
      return svc.forwardStop(i.id, i.name);
    }
  }
}
