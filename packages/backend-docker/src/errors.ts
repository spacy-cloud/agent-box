import { AboxError } from '@abox/core';

interface EngineError {
  statusCode?: number;
  code?: string;
  syscall?: string;
  reason?: string;
  message?: string;
  json?: { message?: string };
  name?: string;
}

const CONNECTION_CODES = new Set([
  'ECONNREFUSED',
  'ENOENT',
  'EACCES',
  'EPERM',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENOTFOUND',
  'ENOTDIR',
]);

export function isAbortError(e: unknown): boolean {
  return (
    e instanceof Error && (e.name === 'AbortError' || (e as { code?: string }).code === 'ABORT_ERR')
  );
}

/** HTTP status code of an engine error, if it is one. */
export function statusOf(e: unknown): number | undefined {
  return typeof e === 'object' && e !== null ? (e as EngineError).statusCode : undefined;
}

function engineMessage(e: EngineError): string {
  return e.json?.message ?? e.reason ?? e.message ?? String(e);
}

/**
 * Translate an engine/transport error into an AboxError with a stable code.
 * Connection failures become `backend_unavailable`.
 */
export function mapEngineError(e: unknown, socket?: string): AboxError {
  if (e instanceof AboxError) return e;
  const err = (typeof e === 'object' && e !== null ? e : { message: String(e) }) as EngineError;
  const where = socket ? ` at ${socket}` : '';
  // A local file operation (e.g. lstat of a host path that does not exist) is not a socket problem.
  if (err.code && err.syscall && err.syscall !== 'connect' && err.statusCode === undefined) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR')
      return new AboxError('not_found', err.message ?? String(e), { cause: e });
    if (err.code === 'EACCES' || err.code === 'EPERM')
      return new AboxError('invalid_input', err.message ?? String(e), { cause: e });
  }
  if (err.code && CONNECTION_CODES.has(err.code) && err.statusCode === undefined) {
    const hint =
      err.code === 'EACCES' || err.code === 'EPERM'
        ? 'No permission on the engine socket. Note: membership of the docker group is root-equivalent on the host; prefer a rootless engine.'
        : err.code === 'ENOENT' || err.code === 'ENOTDIR'
          ? 'The engine socket does not exist. Is Docker/Podman running (systemctl --user start podman.socket)?'
          : 'Is the container engine running and reachable?';
    return new AboxError(
      'backend_unavailable',
      `Cannot reach the container engine${where}: ${err.code}`,
      {
        hint,
        cause: e,
      },
    );
  }
  const msg = engineMessage(err);
  switch (err.statusCode) {
    case 404:
      return new AboxError('not_found', msg, { cause: e });
    case 409:
      return new AboxError('conflict', msg, { cause: e });
    case 304:
      return new AboxError('conflict', msg, { cause: e });
    default:
      return new AboxError('backend_error', msg, {
        cause: e,
        ...(err.statusCode !== undefined ? { details: { statusCode: err.statusCode } } : {}),
      });
  }
}
