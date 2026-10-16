import { createWriteStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dialog, clipboard, ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import type { z } from 'zod';
import { IPC } from '../shared/ipc';
import type { IpcChannel, IpcErrorData, IpcResult, Locale } from '../shared/ipc';
import type { AppInfo, Outputs, SaveResult } from '../shared/types';
import { toIpcError } from './errors';
import { senderAllowed } from './guard';
import { createManagerHandlers } from './service';
import type { ManagerChannel, ManagerHandlers, ServiceRuntime } from './service';

type Input<C extends IpcChannel> = z.output<(typeof IPC)[C]>;

export interface IpcDeps {
  getWindow(): BrowserWindow | null;
  allowedOrigins: string[];
  getRuntime(): (ServiceRuntime & { abox: ServiceRuntime['abox'] }) | null;
  runtimeError(): string | null;
  appInfo(): Omit<AppInfo, 'managerError' | 'paths'>;
  setLocale(l: Locale): void;
  /** The GUI changed something itself: refresh now. */
  poke(): void;
  progress(key: string, line: string): void;
}

const WRITE_CHANNELS = new Set<IpcChannel>([
  'sandboxes:start',
  'sandboxes:stop',
  'sandboxes:remove',
  'sandboxes:extend',
  'sandboxes:create',
  'snapshots:create',
  'snapshots:restore',
  'approvals:approve',
  'approvals:deny',
  'policy:set',
  'reconcile:run',
  'tokens:create',
  'tokens:revoke',
]);

export function registerIpc(d: IpcDeps): () => void {
  let handlers: ManagerHandlers | null = null;
  let handlersFor: object | null = null;
  const managerHandlers = (): ManagerHandlers => {
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
    if (!handlers || handlersFor !== rt) {
      handlers = createManagerHandlers(rt);
      handlersFor = rt;
    }
    return handlers;
  };

  const electronHandlers: {
    [C in Exclude<IpcChannel, ManagerChannel>]: (
      input: Input<C>,
    ) => Promise<Outputs[C]> | Outputs[C];
  } = {
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
    'audit:exportSave': async (filter): Promise<SaveResult> => {
      const rt = d.getRuntime();
      if (!rt) throw new Error('manager not available');
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
        const eh = electronHandlers as Record<string, ((i: unknown) => unknown) | undefined>;
        const local = eh[channel];
        const data = local
          ? await local(input)
          : await (
              managerHandlers() as unknown as Record<
                string,
                (i: unknown, c: typeof ctx) => Promise<unknown>
              >
            )[channel]!(input, ctx);
        if (WRITE_CHANNELS.has(channel)) d.poke();
        return { ok: true, data };
      } catch (e) {
        const ipc = (e as { ipc?: IpcErrorData }).ipc;
        return { ok: false, error: ipc ?? toIpcError(e) };
      }
    });
  }
  return () => {
    for (const c of channels) ipcMain.removeHandler(c);
  };
}
