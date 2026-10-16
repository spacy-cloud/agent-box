/** Pure formatting helpers shared by the views (no locale-dependent output except via the callers' labels). */

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const total = Math.floor(ms / 1000);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '-';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

/** Remaining TTL computed against a local clock so the countdown ticks without polling. */
export function remainingMs(expiresAt: number, now: number): number {
  return Math.max(0, expiresAt - now);
}

export function shortId(id: string): string {
  const slash = id.lastIndexOf('/');
  return slash >= 0 ? id.slice(slash + 1) : id;
}

export function ownerLabelKind(owner: string): 'human' | 'agent' | 'system' {
  if (owner === 'human') return 'human';
  if (owner === 'system') return 'system';
  return 'agent';
}

/** Local date-time `YYYY-MM-DD HH:MM:SS` (stable, locale independent). */
export function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Control characters, bidi overrides and zero-width characters.
const CONTROL_RE = new RegExp(
  // eslint-disable-next-line no-control-regex
  '[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069]',
  'g',
);

/**
 * Makes text from a project file or an agent safe to read: control characters, bidi overrides and
 * zero-width characters become visible escapes (a template could otherwise hide or reorder lines
 * in the review). Newlines and tabs stay. Same rules as `safe` of the CLI.
 */
export function safeText(text: string): string {
  return text.replace(CONTROL_RE, (c) => {
    const code = c.codePointAt(0) ?? 0;
    return code < 0x100
      ? `\\x${code.toString(16).padStart(2, '0')}`
      : `\\u${code.toString(16).padStart(4, '0')}`;
  });
}
