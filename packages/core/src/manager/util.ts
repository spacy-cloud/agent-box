import { randomBytes } from 'node:crypto';
import type { z } from 'zod';
import { AboxError } from '../errors.js';
import type { ErrorIssue } from '../errors.js';
import { redactString } from '../state/redact.js';

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

export function newShortId(): string {
  return randomBytes(4).toString('hex');
}

export const SHORT_ID_RE = /^[0-9a-f]{8}$/;
export const SANDBOX_ID_RE = /^[a-z0-9][a-z0-9-]{0,30}\/[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;

/** Quote for POSIX sh. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Cut a string to at most `maxBytes` UTF-8 bytes without producing a broken trailing character. */
export function truncateUtf8(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean; bytes: number } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return { text, truncated: false, bytes: buf.length };
  let end = maxBytes;
  // step back over UTF-8 continuation bytes so the cut lies on a character boundary
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return { text: buf.subarray(0, end).toString('utf8'), truncated: true, bytes: buf.length };
}

const CMD_SECRET_RES: RegExp[] = [
  /((?:token|secret|password|passwd|passphrase|api[-_]?key|apikey|auth|authorization|credential)[A-Za-z0-9_-]*)(=|:\s*|\s+)(?:Bearer\s+|Basic\s+)?[^\s'"]{3,}/gi,
  /(--?(?:token|secret|password|passwd|passphrase|api-key|apikey|auth|authorization)[A-Za-z0-9_-]*)(=|\s+)[^\s'"]+/gi,
  /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g,
];

/**
 * Best-effort redaction of a command line before it is written to the audit log or the process
 * registry: known secret values, `--token=…`/`password=…` shapes and well-known token formats.
 */
export function redactCommandText(text: string, known: Iterable<string>, maxLen = 2000): string {
  let out = redactString(text, known);
  out = out.replace(CMD_SECRET_RES[0]!, '$1$2[redacted]');
  out = out.replace(CMD_SECRET_RES[1]!, '$1$2[redacted]');
  out = out.replace(CMD_SECRET_RES[2]!, '[redacted]');
  return out.length > maxLen ? `${out.slice(0, maxLen)}…[+${out.length - maxLen} chars]` : out;
}

/** Display form of an exec request (argv joined with quoting, or the shell command). */
export function commandDisplay(req: {
  argv?: string[] | undefined;
  command?: string | undefined;
}): string {
  if (req.argv)
    return req.argv.map((a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : shQuote(a))).join(' ');
  return req.command ?? '';
}

/** Zod validation at the facade boundary: stable `invalid_input` with field paths. */
export function parseInput<T extends z.ZodType>(
  schema: T,
  value: unknown,
  what: string,
): z.infer<T> {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  const issues: ErrorIssue[] = r.error.issues.map((i) => ({
    path: i.path.map(String).join('.'),
    message: i.message,
  }));
  const first = issues[0];
  throw new AboxError(
    'invalid_input',
    `invalid ${what}: ${first?.path ? `${first.path}: ` : ''}${first?.message ?? 'unknown problem'}${issues.length > 1 ? ` (+${issues.length - 1} more)` : ''}`,
    { issues, hint: `Fix the listed fields of the ${what}.` },
  );
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
