import type { DoctorCheck, DoctorSeverity } from '@abox/core';
import { oneLine } from './format.js';

type Style = (kind: 'bold' | 'dim' | 'red' | 'yellow' | 'green', text: string) => string;

const MARKS: Record<DoctorSeverity, { mark: string; color: 'green' | 'dim' | 'yellow' | 'red' }> = {
  ok: { mark: '✓', color: 'green' },
  info: { mark: 'i', color: 'dim' },
  warning: { mark: '!', color: 'yellow' },
  error: { mark: '✗', color: 'red' },
};

/** The severity of a check, also for reports from an older core that only has `level`. */
export function severityOf(
  c: Pick<DoctorCheck, 'level'> & { severity?: DoctorSeverity },
): DoctorSeverity {
  return c.severity ?? (c.level === 'warn' ? 'warning' : c.level);
}

/** Word-wraps `text` to `width` columns; continuation lines are indented by `indent`. */
export function wrapText(text: string, width: number, indent: string): string[] {
  const words = oneLine(text).split(' ').filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if (line !== '' && indent.length + line.length + 1 + w.length > width) {
      lines.push(line);
      line = w;
    } else line = line === '' ? w : `${line} ${w}`;
  }
  if (line !== '') lines.push(line);
  return lines.length > 0 ? lines : [''];
}

/** A wrapped paragraph: first line after `first`, the others under `indent` (same width). */
function paragraph(text: string, first: string, indent: string, width: number): string[] {
  return wrapText(text, width, indent).map((l, i) => `${i === 0 ? first : indent}${l}`);
}

export interface DoctorRenderOptions {
  /** Also print the raw detail lines of checks that are ok or info. */
  verbose: boolean;
  /** Terminal width to wrap at. */
  width: number;
  style: Style;
}

/**
 * Text output of `abox doctor`: one marked summary line per check (`✓` ok, `i` info, `!` warning,
 * `✗` failed), then the advisory notes, the hint and, for anything that is not ok or with `--verbose`,
 * the detail lines, all indented and wrapped.
 */
export function renderDoctorChecks(checks: readonly DoctorCheck[], o: DoctorRenderOptions): string {
  const width = Math.max(40, Math.min(o.width, 100));
  const out: string[] = [];
  let hiddenDetails = false;
  for (const c of checks) {
    const sev = severityOf(c);
    const { mark, color } = MARKS[sev];
    out.push(...paragraph(c.title, `${o.style(color, mark)} `, '    ', width));
    for (const n of c.notes ?? []) {
      const m = MARKS[n.severity];
      out.push(...paragraph(n.message, `    ${o.style(m.color, m.mark)} `, '      ', width));
    }
    const details = c.details ?? (c.detail ? c.detail.split(/\r?\n/) : []);
    const showDetails = sev === 'warning' || sev === 'error' || o.verbose;
    if (details.length > 0 && !showDetails) hiddenDetails = true;
    if (details.length > 0 && showDetails)
      for (const d of details) out.push(...paragraph(d, '    · ', '      ', width));
    if (c.hint && sev !== 'ok')
      out.push(...paragraph(c.hint, `    ${o.style('dim', 'hint:')} `, '          ', width));
  }
  if (hiddenDetails)
    out.push('', o.style('dim', 'Run "abox doctor --verbose" for the full details.'));
  return `${out.join('\n')}\n`;
}

/** "7 ok, 2 info, 1 warning" (zero counts left out, `ok` always shown). */
export function summaryText(summary: Record<DoctorSeverity, number>): string {
  const parts = [`${summary.ok} ok`];
  if (summary.info > 0) parts.push(`${summary.info} info`);
  if (summary.warning > 0)
    parts.push(`${summary.warning} warning${summary.warning === 1 ? '' : 's'}`);
  if (summary.error > 0) parts.push(`${summary.error} failed`);
  return parts.join(', ');
}
