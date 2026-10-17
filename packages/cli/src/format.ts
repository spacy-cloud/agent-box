/** Output helpers: sanitising, tables, durations. No colours here (see `Cli.style`). */

// Control characters, bidi overrides and zero-width characters.
const CONTROL_RE = new RegExp(
  // eslint-disable-next-line no-control-regex
  '[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069]',
  'g',
);

/**
 * Makes text safe to print on a terminal: control characters (including ESC, so no ANSI
 * sequences), bidi overrides and zero-width characters are replaced by visible escapes.
 * Newlines and tabs stay. Use it for everything an agent, a project file or a remote host wrote.
 */
export function safe(text: string): string {
  return text.replace(CONTROL_RE, (c) => {
    const code = c.codePointAt(0) ?? 0;
    return code < 0x100
      ? `\\x${code.toString(16).padStart(2, '0')}`
      : `\\u${code.toString(16).padStart(4, '0')}`;
  });
}

/** One-line variant of {@link safe}: newlines become spaces. */
export function oneLine(text: string): string {
  return safe(text.replace(/\s*[\r\n]+\s*/g, ' ')).trim();
}

export function truncate(text: string, max: number): string {
  if (max <= 1 || text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return '-';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalS = Math.round(ms / 1000);
  if (totalS < 60) return `${totalS}s`;
  const m = Math.floor(totalS / 60);
  if (m < 60) return `${m}m${String(totalS % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d${String(h % 24).padStart(2, '0')}h`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

export function formatTime(ts: number | null | undefined): string {
  if (ts === null || ts === undefined) return '-';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** `in 14m`, `3m ago`, `expired`. */
export function formatRelative(ts: number, now: number): string {
  const delta = ts - now;
  const abs = formatDuration(Math.abs(delta));
  return delta >= 0 ? `in ${abs}` : `${abs} ago`;
}

export interface Column {
  header: string;
  /** Right-align (numbers). */
  right?: boolean;
  /** Maximum width; the last column is additionally limited by the terminal width. */
  max?: number;
}

/**
 * Plain-text table. Cells are sanitised and single-line. When `width` is given the last
 * column shrinks so that a row fits.
 */
export function renderTable(columns: Column[], rows: string[][], width?: number): string {
  const cells = rows.map((r) => columns.map((_, i) => oneLine(r[i] ?? '')));
  const widths = columns.map((c, i) => {
    let w = c.header.length;
    for (const r of cells) w = Math.max(w, (r[i] ?? '').length);
    return c.max ? Math.min(w, c.max) : w;
  });
  if (width && columns.length > 1) {
    const last = columns.length - 1;
    const used = widths.slice(0, last).reduce((a, b) => a + b + 2, 0);
    widths[last] = Math.max(columns[last]!.header.length, Math.min(widths[last]!, width - used));
  }
  const line = (r: string[]): string =>
    r
      .map((cell, i) => {
        const w = widths[i]!;
        const t = truncate(cell, w);
        if (i === r.length - 1 && !columns[i]!.right) return t;
        return columns[i]!.right ? t.padStart(w) : t.padEnd(w);
      })
      .join('  ')
      .trimEnd();
  return [line(columns.map((c) => c.header)), ...cells.map(line)].join('\n');
}

/** `key: value` block with aligned values. `undefined` values are skipped. */
export function renderKeyValues(pairs: Array<[string, string | undefined]>, indent = ''): string {
  const shown = pairs.filter((p): p is [string, string] => p[1] !== undefined);
  const w = Math.max(0, ...shown.map(([k]) => k.length));
  return shown
    .map(
      ([k, v]) =>
        `${indent}${`${k}:`.padEnd(w + 2)}${safe(v).replace(/\n/g, `\n${indent}${' '.repeat(w + 2)}`)}`,
    )
    .join('\n');
}
