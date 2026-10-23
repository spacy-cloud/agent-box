import { z } from 'zod';

/**
 * Error codes are part of the public interface (CLI exit codes, MCP results).
 * Exit codes: 0 ok, 1 internal, 2 input, 3 policy/approval denied, 4 backend error, 5 timeout.
 */
export const ERROR_CODES = {
  invalid_input: 2,
  template_invalid: 2,
  skill_invalid: 2,
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

/** What each process exit code of the CLI stands for (the codes above map onto 1 to 5). */
export const EXIT_CODE_MEANING: Readonly<Record<number, string>> = {
  0: 'Success.',
  1: 'Internal error, or a check (`abox doctor`, `abox audit verify`) found problems.',
  2: 'Invalid input; also an unknown id, an operation the backend does not support, or a conflict with the current state.',
  3: 'Denied by policy, approval denied or expired, or a confirmation is missing (use `--yes`).',
  4: 'Backend or host unavailable or failed.',
  5: 'Timeout.',
};

/** What a code means and what to do about it. Source of the generated `docs/errors.md`. */
export interface ErrorCodeInfo {
  /** When the code is used. */
  meaning: string;
  /** The advice a caller typically gets (a concrete error usually carries a more specific `hint`). */
  hint: string;
}

/** Documentation of every code; the compiler refuses a new code without an entry. */
export const ERROR_CODE_INFO: Record<ErrorCode, ErrorCodeInfo> = {
  invalid_input: {
    meaning:
      'A parameter, option or file is malformed, missing or unknown (an MCP tool also rejects parameters it does not have).',
    hint: 'Fix the fields listed in `issues` (or named in the message) and call again.',
  },
  template_invalid: {
    meaning:
      'A template file does not validate; `issues` carry path, line and column, `details.path` the file.',
    hint: 'Fix the template (`abox template validate <name>` shows every problem) and try again.',
  },
  skill_invalid: {
    meaning:
      'A skill folder does not validate (front matter, name, size, links); `issues` carry the file in `path` and, for SKILL.md, line and column, `details.path` the folder.',
    hint: 'Fix the skill (`abox skill validate <name|folder>` shows every problem) and try again.',
  },
  not_found: {
    meaning:
      'The sandbox, process, snapshot, template, skill or approval does not exist, or it belongs to someone else (indistinguishable on purpose).',
    hint: 'Check the id with `abox ls` (MCP: `sandbox_list`); an agent only sees its own sandboxes.',
  },
  unsupported: {
    meaning:
      'The backend or host cannot do this (for example snapshots on a backend without them).',
    hint: 'Choose another approach or a template with a backend that supports it.',
  },
  conflict: {
    meaning:
      'The operation clashes with the current state, for example the sandbox is in the wrong state or a human has taken it over (`details.reason: "human_attached"`).',
    hint: 'Wait and retry, or bring the sandbox into the expected state first.',
  },
  policy_denied: {
    meaning:
      'The policy forbids the request (`details.reasons` lists every reason; deny always wins), or a human-only operation was attempted by an agent.',
    hint: 'Do not work around it: stay within the limits of the profile, or ask the human to change the policy (`abox policy edit`).',
  },
  approval_required: {
    meaning:
      'The operation needs a human confirmation that was not given (a CLI command without `--yes` on a non-interactive terminal).',
    hint: 'Repeat the command with `--yes`, or run it in a terminal and answer the prompt.',
  },
  approval_denied: {
    meaning: 'A human denied the approval request, or an identical request was denied recently.',
    hint: 'Do not retry the same request; adjust it or ask the human.',
  },
  approval_expired: {
    meaning: 'Nobody decided in time; an undecided approval counts as denied.',
    hint: 'Ask the human to be ready, then repeat the request.',
  },
  untrusted_template: {
    meaning: 'A project template whose current content a human has not approved yet.',
    hint: 'Review and approve it (`abox template review <name>`, `abox approvals approve <id>`), or use a built-in template.',
  },
  backend_error: {
    meaning:
      'The backend (container engine, VM, process runner) failed to carry out the operation.',
    hint: 'Read the message and `abox doctor`; fix the cause and retry.',
  },
  backend_unavailable: {
    meaning: 'The backend is not reachable (engine not running, socket not accessible).',
    hint: 'Start the container engine and check its socket permissions; `abox doctor` shows details.',
  },
  host_unreachable: {
    meaning: 'A remote host cannot be reached or does not answer in time.',
    hint: 'Check the host profile and the network (`abox host test <name>`, `abox doctor`).',
  },
  timeout: {
    meaning:
      'The operation ran into its time limit (a command killed by its timeout reports exit code 137).',
    hint: 'Raise the timeout deliberately, or run the command as a background process and read its logs.',
  },
  internal: {
    meaning:
      'An unexpected failure inside abox; details are logged on the server side, not sent to agents.',
    hint: 'Run `abox doctor`; if it persists, report the message with the steps to reproduce it.',
  },
};

const issueSchema = z.strictObject({
  path: z.string().optional().describe('Field path, for example `resources.memory`.'),
  line: z.number().int().positive().optional().describe('1-based line in the source file.'),
  column: z.number().int().positive().optional().describe('1-based column in the source file.'),
  message: z.string().describe('What is wrong.'),
});

/**
 * The failure envelope: `{ok:false,code,message,...}` printed by `abox --json` and, with the same keys,
 * returned as `structuredContent` by the MCP tools. `codes` defaults to the core codes; the CLI passes
 * its own set (it adds `check_failed`). Source of `docs/error-envelope.schema.json`.
 */
export function errorEnvelopeSchema(codes: readonly string[] = Object.keys(ERROR_CODES)) {
  return z.object({
    ok: z.literal(false),
    code: z.enum(codes as [string, ...string[]]).describe('Stable error code, see docs/errors.md.'),
    message: z.string().describe('Human-readable description of the failure.'),
    hint: z.string().optional().describe('Actionable next step.'),
    issues: z.array(issueSchema).optional().describe('Field-level problems, when there are some.'),
    details: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Structured extras, for example `reasons` of a policy denial.'),
  });
}

/** The envelope as a JSON Schema document (draft 2020-12). */
export function errorEnvelopeJsonSchema(codes?: readonly string[]): Record<string, unknown> {
  return z.toJSONSchema(errorEnvelopeSchema(codes), { io: 'output' }) as Record<string, unknown>;
}

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
