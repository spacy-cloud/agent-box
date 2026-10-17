/**
 * Error codes are part of the public interface (CLI exit codes, MCP results).
 * Exit codes: 0 ok, 1 internal, 2 input, 3 policy/approval denied, 4 backend error, 5 timeout.
 */
export const ERROR_CODES = {
  invalid_input: 2,
  template_invalid: 2,
  not_found: 2,
  unsupported: 2,
  conflict: 2,
  policy_denied: 3,
  approval_required: 3,
  approval_denied: 3,
  approval_expired: 3,
  untrusted_template: 3,
  backend_error: 4,
  backend_unavailable: 4,
  host_unreachable: 4,
  timeout: 5,
  internal: 1,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export interface ErrorIssue {
  /** Field path, e.g. `resources.memory`. */
  path?: string;
  /** 1-based line in the source file, when known. */
  line?: number;
  column?: number;
  message: string;
}

export class AboxError extends Error {
  readonly code: ErrorCode;
  /** Actionable next step for humans and agents. */
  readonly hint?: string;
  readonly issues: ErrorIssue[];
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    opts: {
      hint?: string;
      issues?: ErrorIssue[];
      details?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'AboxError';
    this.code = code;
    this.hint = opts.hint;
    this.issues = opts.issues ?? [];
    this.details = opts.details;
  }

  get exitCode(): number {
    return ERROR_CODES[this.code];
  }

  toJSON(): Record<string, unknown> {
    return {
      ok: false,
      code: this.code,
      message: this.message,
      ...(this.hint ? { hint: this.hint } : {}),
      ...(this.issues.length ? { issues: this.issues } : {}),
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export function isAboxError(e: unknown): e is AboxError {
  return e instanceof AboxError;
}

/** Wrap unknown errors so every surface can report a stable code. */
export function toAboxError(e: unknown, fallback: ErrorCode = 'internal'): AboxError {
  if (e instanceof AboxError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  return new AboxError(fallback, msg, { cause: e });
}
