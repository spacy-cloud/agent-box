/**
 * Sandboxed preload (CommonJS, single bundled file). Exposes `window.abox` with exactly two functions:
 * `invoke` for the known request channels and `on` for the known push channels. No Node or Electron
 * objects reach the page. Argument validation happens in the main process (Zod); here the channel name
 * is checked against the allow-list so a compromised page cannot call arbitrary IPC channels.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import { EVENT_CHANNELS, IPC_CHANNEL_NAMES } from '../shared/channels';

const requestChannels = new Set<string>(IPC_CHANNEL_NAMES);
const eventChannels = new Set<string>(EVENT_CHANNELS);

contextBridge.exposeInMainWorld('abox', {
  invoke(channel: string, input?: unknown) {
    if (!requestChannels.has(channel)) {
      return Promise.resolve({
        ok: false,
        error: {
          code: 'invalid_input',
          message: `unknown channel ${String(channel).slice(0, 64)}`,
        },
      });
    }
    return ipcRenderer.invoke(channel, input);
  },
  on(channel: string, listener: (payload: unknown) => void) {
    if (!eventChannels.has(channel) || typeof listener !== 'function') return () => undefined;
    const wrapped = (_e: IpcRendererEvent, payload: unknown) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
});
