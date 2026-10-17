import { IpcError } from '../shared/constants';
import type { IpcChannel, IpcInput } from '../shared/ipc';
import type { AboxBridge, IpcOutput } from '../shared/types';

declare global {
  interface Window {
    abox: AboxBridge;
  }
}

/** Calls one IPC channel; failures arrive as `IpcError` (code, message, hint, issues). */
export async function call<C extends IpcChannel>(
  channel: C,
  input?: IpcInput<C>,
): Promise<IpcOutput<C>> {
  const res = await window.abox.invoke(channel, input);
  if (!res.ok) throw new IpcError(res.error);
  return res.data;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
