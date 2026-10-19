import {
  AboxError,
  ERROR_CODES,
  isAboxError,
  type ErrorCode,
  type ErrorCodeInfo,
  type ErrorIssue,
} from '@abox/core';

/** Codes of the CLI's own failures on top of the core's `ErrorCode`s. */
export type CliErrorCode = ErrorCode | 'check_failed';

export const CLI_EXIT_CODES: Record<CliErrorCode, number> = { ...ERROR_CODES, check_failed: 1 };

/** Documentation of the codes only the CLI uses (the others are in `ERROR_CODE_INFO` of the core). */
export const CLI_ONLY_ERROR_INFO: Record<Exclude<CliErrorCode, ErrorCode>, ErrorCodeInfo> = {
  check_failed: {
    meaning:
      'A check (`abox doctor`, `abox audit verify`) ran and found problems; the report is in `details`. Never returned by MCP tools.',
    hint: 'Read the report in `details` (or the human output) and fix what it names.',
  },
};

/** A failure the CLI itself detected (a check found problems, ...), same shape as `AboxError`. */
export class CliError extends Error {
  readonly code: CliErrorCode;
  readonly hint?: string;
  readonly issues: ErrorIssue[];
  readonly details?: Record<string, unknown>;

  constructor(
    code: CliErrorCode,
    message: string,
    opts: { hint?: string; issues?: ErrorIssue[]; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.hint = opts.hint;
    this.issues = opts.issues ?? [];
    this.details = opts.details;
  }

  get exitCode(): number {
    return CLI_EXIT_CODES[this.code];
  }
}

/** Ends the program with this exit code; whatever has to be printed was printed already. */
export class CliExit extends Error {
  constructor(readonly exitCode: number) {
    super(`exit ${exitCode}`);
    this.name = 'CliExit';
  }
}

export interface ErrorBody {
  ok: false;
  code: CliErrorCode;
  message: string;
  hint?: string;
  issues?: ErrorIssue[];
  details?: Record<string, unknown>;
}

const SOCKET_ERRNOS = new Set([
  'ENOENT',
  'ECONNREFUSED',
  'EACCES',
  'EPERM',
  'ENOTSOCK',
  'ECONNRESET',
]);

function errnoOf(e: unknown): string | undefined {
  const seen = new Set<unknown>();
  let cur: unknown = e;
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur);
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string' && /^E[A-Z]+$/.test(code)) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Turns anything thrown into the stable error body and its exit code. */
export function describeError(e: unknown): { body: ErrorBody; exitCode: number } {
  if (isAboxError(e) || e instanceof CliError) {
    const body: ErrorBody = { ok: false, code: e.code, message: e.message };
    if (e.hint) body.hint = e.hint;
    if (e.issues.length > 0) body.issues = e.issues;
    if (e.details && Object.keys(e.details).length > 0) body.details = e.details;
    return { body, exitCode: e.exitCode };
  }
  const message = e instanceof Error ? e.message : String(e);
  const errno = errnoOf(e);
  if (errno && SOCKET_ERRNOS.has(errno) && /connect|socket|docker|podman|engine/i.test(message)) {
    return {
      body: {
        ok: false,
        code: 'backend_unavailable',
        message: `cannot reach the container engine: ${message}`,
        hint: 'Is Docker/Podman running? Check DOCKER_HOST and the socket permissions; "abox doctor" shows details.',
      },
      exitCode: CLI_EXIT_CODES.backend_unavailable,
    };
  }
  return { body: { ok: false, code: 'internal', message }, exitCode: CLI_EXIT_CODES.internal };
}

export { AboxError };
