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

/** A byte count in the template syntax the memory field accepts (`6g`, `512m`): the largest unit that divides it exactly. */
export function formatSizeSpec(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  for (const [unit, size] of [
    ['t', 1024 ** 4],
    ['g', 1024 ** 3],
    ['m', 1024 ** 2],
    ['k', 1024],
  ] as const) {
    if (bytes >= size && bytes % size === 0) return `${bytes / size}${unit}`;
  }
  return String(bytes);
}

/** A duration in the syntax the lifetime field accepts (`2h`, `30m`, `1d`): the largest unit that divides it exactly. */
export function formatDurationSpec(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  for (const [unit, size] of [
    ['d', 86_400_000],
    ['h', 3_600_000],
    ['m', 60_000],
    ['s', 1000],
  ] as const) {
    if (ms >= size && ms % size === 0) return `${ms / size}${unit}`;
  }
  return `${ms}ms`;
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

/** CPU use for display: `0.4 %`, `12 %`, `250 %` (100 % = one core fully busy). */
export function formatCpuPercent(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '-';
  if (n < 10) return `${n.toFixed(1)} %`;
  return `${Math.round(n)} %`;
}

/**
 * Live memory use against the configured limit: `64 MiB / 256 MiB`. The limit the backend reports is
 * preferred (it is what is enforced); a missing one falls back to the configured value, and 0 / unknown to just the use.
 */
export function formatMemoryUsage(
  used: number,
  limit: number | null | undefined,
  configured?: number,
): string {
  const cap = limit && limit > 0 ? limit : configured && configured > 0 ? configured : undefined;
  return cap ? `${formatBytes(used)} / ${formatBytes(cap)}` : formatBytes(used);
}

/** Fill level 0..1 of a usage bar (clamped); `cpuLimit` is the number of cpus the sandbox may use. */
export function usageFraction(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.min(1, Math.max(0, value / max));
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

/** Local time of day `HH:MM:SS` (stable, locale independent). */
export function formatClock(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Control characters, bidi overrides and zero-width / invisible format characters: the C0/C1 controls,
// U+00AD (soft hyphen), U+061C (Arabic letter mark), U+180E, U+200B-U+200F (zero-width, LRM/RLM),
// U+2028/U+2029 (line / paragraph separator), U+202A-U+202E (embeddings and overrides), U+2060-U+2064
// (word joiner, invisible operators), U+2066-U+2069 (isolates), U+206A-U+206F (deprecated format characters),
// U+FEFF (BOM / zero-width no-break space), U+FFF9-U+FFFB (interlinear annotation) and the tag characters
// U+E0000-U+E007F. Newlines and tabs stay.
const CONTROL_RE = new RegExp(
  // eslint-disable-next-line no-control-regex
  '[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u00ad\\u061c\\u180e\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u206f\\ufeff\\ufff9-\\ufffb\\u{e0000}-\\u{e007f}]',
  'gu',
);

/**
 * Makes text from a project file or an agent safe to read: control characters, bidi overrides and
 * zero-width characters become visible escapes (a template could otherwise hide or reorder lines
 * in the review). Newlines and tabs stay. Same rules as `safe` of the CLI, plus the invisible format
 * characters listed above. Use it for everything an agent, a project file or a remote host wrote.
 */
export function safeText(text: string): string {
  return text.replace(CONTROL_RE, (c) => {
    const code = c.codePointAt(0) ?? 0;
    if (code < 0x100) return `\\x${code.toString(16).padStart(2, '0')}`;
    if (code > 0xffff) return `\\u{${code.toString(16)}}`;
    return `\\u${code.toString(16).padStart(4, '0')}`;
  });
}

/**
 * Neutralised and shortened for one line (a table cell, a toast, a title): newlines become spaces, at most
 * `max` characters (code points) stay and an ellipsis marks the cut. The complete text belongs in a
 * scrollable block (`ScrollText`), never in a cell.
 */
export function safeInline(text: string, max = 200): string {
  const one = safeText(text.replace(/\s*[\r\n]+\s*/g, ' ')).trim();
  const chars = [...one];
  return chars.length > max ? `${chars.slice(0, Math.max(1, max - 1)).join('')}…` : one;
}
