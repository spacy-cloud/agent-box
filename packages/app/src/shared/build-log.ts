/**
 * The log of a template build as the Templates view keeps it: bounded (the newest lines win, the number of
 * dropped lines is counted), every line neutralised (the output is written by the template author and the
 * registries it talks to), and the outcome of the last build. Pure functions; the store is in the renderer.
 */
import { safeText } from './format';

/** Most lines kept per template; a build prints a few hundred, a noisy one thousands. */
export const MAX_LOG_LINES = 2000;
/** Longest line kept (code points); longer ones are cut and marked. */
export const MAX_LOG_LINE_CHARS = 1000;

export type BuildStatus = 'running' | 'done' | 'failed';

export interface BuildLog {
  status: BuildStatus;
  /** Wall clock time (ms since epoch) the build was started. */
  startedAt: number;
  /** Set when it ended: the manager's duration on success, the measured one on failure. */
  durationMs?: number;
  lines: string[];
  /** Lines that fell out of the buffer at the start. */
  dropped: number;
  /** `--update` was requested. */
  update: boolean;
  image?: string;
  cached?: boolean;
  /** Message of the failure (neutralised). */
  error?: string;
}

export function startLog(now: number, update: boolean): BuildLog {
  return { status: 'running', startedAt: now, lines: [], dropped: 0, update };
}

/** One line of output, made safe to show and cut to {@link MAX_LOG_LINE_CHARS}. */
export function cleanLine(line: string): string {
  const text = safeText(line.replace(/\r/g, '').trimEnd());
  const chars = [...text];
  return chars.length > MAX_LOG_LINE_CHARS
    ? `${chars.slice(0, MAX_LOG_LINE_CHARS).join('')} …`
    : text;
}

export function appendLine(log: BuildLog, line: string): BuildLog {
  const lines = [...log.lines, cleanLine(line)];
  const extra = lines.length - MAX_LOG_LINES;
  return extra > 0
    ? { ...log, lines: lines.slice(extra), dropped: log.dropped + extra }
    : { ...log, lines };
}

export function finishLog(
  log: BuildLog,
  end:
    | { ok: true; now: number; image: string; cached: boolean; durationMs: number }
    | { ok: false; now: number; error: string },
): BuildLog {
  if (end.ok) {
    return {
      ...log,
      status: 'done',
      durationMs: end.durationMs,
      image: end.image,
      cached: end.cached,
    };
  }
  return {
    ...log,
    status: 'failed',
    durationMs: Math.max(0, end.now - log.startedAt),
    error: cleanLine(end.error),
  };
}
