import { AboxError, isAboxError } from '@abox/core';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Result shaping for every tool: `structuredContent` is `{ ok, code?, message, ...data }` with snake_case
 * keys and ISO timestamps; `content` carries a short text rendering (including the essential data) for
 * clients that only show text. Errors are tool results with `isError: true`, never JSON-RPC errors.
 */

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export interface ToolOutcome {
  ok: boolean;
  /** Error / status code (`policy_denied`, `timeout`, ...). */
  code?: string;
  message: string;
  data?: Record<string, unknown>;
  /** Extra lines appended to the text rendering (e.g. command output, file content). */
  text?: string;
  isError?: boolean;
}

const CAMEL_KEY = /^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+$/;

function snakeKey(k: string): string {
  return CAMEL_KEY.test(k) ? k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`) : k;
}

/** camelCase keys -> snake_case, `...At` millisecond timestamps -> ISO strings. Values are never touched otherwise. */
export function toWire(value: unknown, depth = 0): Json {
  if (depth > 12) return null;
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (Array.isArray(value)) return value.map((v) => toWire(v, depth + 1));
  if (typeof value === 'object') {
    const out: { [k: string]: Json } = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined || typeof v === 'function') continue;
      if (typeof v === 'number' && /At$/.test(k) && k.length > 2 && Number.isFinite(v) && v > 0) {
        out[snakeKey(k)] = new Date(v).toISOString();
      } else {
        out[snakeKey(k)] = toWire(v, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

export function renderResult(o: ToolOutcome): CallToolResult {
  const structured: Record<string, Json> = {
    ok: o.ok,
    ...(o.code ? { code: o.code } : {}),
    message: o.message,
    ...((toWire(o.data ?? {}) as Record<string, Json>) ?? {}),
  };
  // `ok`, `code` and `message` always win over same-named data keys.
  structured['ok'] = o.ok;
  structured['message'] = o.message;
  if (o.code) structured['code'] = o.code;
  const head = o.ok ? o.message : `${o.code ? `[${o.code}] ` : ''}${o.message}`;
  const text = o.text ? `${head}\n${o.text}` : head;
  return {
    content: [{ type: 'text', text }],
    structuredContent: structured,
    ...(o.isError ? { isError: true } : {}),
  };
}

export const ok = (
  message: string,
  data?: Record<string, unknown>,
  text?: string,
): ToolOutcome => ({
  ok: true,
  message,
  ...(data ? { data } : {}),
  ...(text ? { text } : {}),
});

export function fail(
  code: string,
  message: string,
  data?: Record<string, unknown>,
  text?: string,
): ToolOutcome {
  return {
    ok: false,
    code,
    message,
    isError: true,
    ...(data ? { data } : {}),
    ...(text ? { text } : {}),
  };
}

const DEFAULT_HINTS: Partial<Record<string, string>> = {
  not_found: 'Check the id with sandbox_list. You only see your own sandboxes.',
  policy_denied:
    'Do not work around this. Use access_request (kind network|mount|resources|ttl) or tell the human what is blocked; policy_show lists your limits.',
  approval_denied:
    'A human denied this request. Do not retry the same request; adjust it or tell the human.',
  approval_expired:
    'Nobody decided in time (counts as denied). Ask the human to be ready, then repeat the call.',
  untrusted_template:
    'This project template has not been approved. Ask the human to approve it (abox approvals), or use a built-in template from template_list.',
  invalid_input: 'Fix the listed fields and call again.',
  unsupported: 'The backend cannot do this. Choose another approach or a different template.',
  backend_unavailable: 'The backend is not reachable. Ask the human to run: abox doctor',
  host_unreachable: 'The host is not reachable. Ask the human to run: abox doctor',
  timeout:
    'Raise the timeout deliberately, or run it with sandbox_process_start and read sandbox_process_logs.',
};

export function errorOutcome(e: unknown): ToolOutcome {
  if (isAboxError(e)) return aboxErrorOutcome(e);
  // Unknown failures: do not leak internals to the agent; the human sees them on stderr.
  process.stderr.write(
    `abox-mcp: unexpected error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`,
  );
  return fail(
    'internal',
    'internal error in the abox MCP server (details were logged on the server side)',
  );
}

function aboxErrorOutcome(e: AboxError): ToolOutcome {
  const hint = e.hint ?? DEFAULT_HINTS[e.code];
  const details = e.details ?? {};
  const reasons = Array.isArray(details['reasons']) ? (details['reasons'] as unknown[]) : undefined;
  const lines: string[] = [];
  if (reasons?.length) for (const r of reasons) lines.push(`- ${String(r)}`);
  for (const i of e.issues) lines.push(`- ${i.path ? `${i.path}: ` : ''}${i.message}`);
  if (hint) lines.push(`Hint: ${hint}`);
  return fail(
    e.code,
    e.message,
    {
      ...(hint ? { hint } : {}),
      ...(e.issues.length ? { issues: e.issues } : {}),
      ...(Object.keys(details).length ? { details } : {}),
    },
    lines.join('\n') || undefined,
  );
}

/** Used for argument problems detected by the MCP layer itself (conversion, mutual exclusion). */
export function invalidInput(message: string, hint?: string): AboxError {
  return new AboxError('invalid_input', message, hint ? { hint } : {});
}

/** UTF-8 safe cut to at most `maxBytes` bytes. */
export function truncateText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  // do not cut inside a multi-byte sequence
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return { text: buf.subarray(0, end).toString('utf8'), truncated: true };
}
