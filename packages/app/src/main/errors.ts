import { isAboxError } from '@abox/core';
import { ZodError } from 'zod';
import type { IpcErrorData } from '../shared/ipc';

/** Converts any thrown value into plain data that can cross the IPC boundary (no stack traces). */
export function toIpcError(e: unknown): IpcErrorData {
  if (isAboxError(e)) {
    return {
      code: e.code,
      message: e.message,
      ...(e.hint ? { hint: e.hint } : {}),
      ...(e.issues.length > 0
        ? {
            issues: e.issues.map((i) => ({
              ...(i.path ? { path: i.path } : {}),
              message: i.message,
            })),
          }
        : {}),
      ...(e.details ? { details: safeDetails(e.details) } : {}),
    };
  }
  if (e instanceof ZodError) {
    return {
      code: 'invalid_input',
      message: 'invalid input',
      issues: e.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    };
  }
  const message = e instanceof Error ? e.message : String(e);
  return { code: 'internal', message };
}

function safeDetails(d: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(d));
  } catch {
    return undefined;
  }
}
