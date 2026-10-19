import { describe, expect, it } from 'vitest';
import {
  MAX_LOG_LINES,
  MAX_LOG_LINE_CHARS,
  appendLine,
  cleanLine,
  finishLog,
  startLog,
} from '../../src/shared/build-log';

describe('build log', () => {
  it('keeps the newest lines and counts the ones that fell out', () => {
    let log = startLog(1000, false);
    for (let i = 0; i < MAX_LOG_LINES + 25; i++) log = appendLine(log, `line ${i}`);
    expect(log.lines).toHaveLength(MAX_LOG_LINES);
    expect(log.dropped).toBe(25);
    expect(log.lines[0]).toBe('line 25');
    expect(log.lines.at(-1)).toBe(`line ${MAX_LOG_LINES + 24}`);
  });

  it('neutralises control and bidi characters and cuts very long lines', () => {
    expect(cleanLine('a\u001b[31mred‮b\r')).toBe('a\\x1b[31mred\\u202eb');
    const long = cleanLine('x'.repeat(MAX_LOG_LINE_CHARS + 500));
    expect([...long].length).toBeLessThanOrEqual(MAX_LOG_LINE_CHARS + 2);
    expect(long.endsWith(' …')).toBe(true);
  });

  it('records the outcome: the manager duration on success, the measured one on failure', () => {
    const started = appendLine(startLog(1000, true), 'step 1');
    const ok = finishLog(started, {
      ok: true,
      now: 9000,
      image: 'abox/x:1',
      cached: false,
      durationMs: 4200,
    });
    expect(ok).toMatchObject({
      status: 'done',
      durationMs: 4200,
      image: 'abox/x:1',
      cached: false,
      update: true,
    });
    const bad = finishLog(started, { ok: false, now: 3500, error: 'boom\u0007' });
    expect(bad).toMatchObject({ status: 'failed', durationMs: 2500, error: 'boom\\x07' });
    expect(bad.lines).toEqual(['step 1']);
  });
});
