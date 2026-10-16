import { AboxError, parseDuration, parseSize } from '@abox/core';

export function invalid(message: string, hint?: string): AboxError {
  return new AboxError('invalid_input', message, hint ? { hint } : {});
}

/** `30s`, `2h`, `1h30m` or plain milliseconds with `ms` suffix -> milliseconds. */
export function durationMs(value: string, flag: string): number {
  const ms = /^(\d+)ms$/.exec(value.trim());
  if (ms) return Number(ms[1]);
  try {
    return parseDuration(value);
  } catch (e) {
    throw invalid(`${flag}: ${(e as Error).message}`);
  }
}

export function sizeBytes(value: string, flag: string): number {
  try {
    return parseSize(value);
  } catch (e) {
    throw invalid(`${flag}: ${(e as Error).message}`);
  }
}

export function positiveNumber(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0)
    throw invalid(`${flag}: expected a positive number, got "${value}"`);
  return n;
}

export function positiveInt(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0)
    throw invalid(`${flag}: expected a positive integer, got "${value}"`);
  return n;
}

export function commaList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  return list
    .flatMap((v) => v.split(','))
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** `K=V` pairs -> record. Values may contain `=`. */
export function parseEnvPairs(pairs: string[] | undefined): Record<string, string> | undefined {
  if (!pairs || pairs.length === 0) return undefined;
  const env: Record<string, string> = {};
  for (const p of pairs) {
    const i = p.indexOf('=');
    if (i <= 0) throw invalid(`--env: expected KEY=VALUE, got "${p}"`);
    env[p.slice(0, i)] = p.slice(i + 1);
  }
  return env;
}

/** Commander collector for repeatable options. */
export function collect(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

/** `--since 1h` (relative) or an ISO date/time -> epoch ms. */
export function parseSince(value: string, now: number): number {
  const rel = /^(?:\d+[smhd])+$/.exec(value.trim());
  if (rel) return now - parseDuration(value);
  const t = Date.parse(value);
  if (Number.isNaN(t)) {
    throw invalid(`--since: expected a duration like 1h or an ISO date, got "${value}"`);
  }
  return t;
}

/** `HOST:PORT`, `[::1]:PORT` or `:PORT` -> parts. */
export function parseListen(value: string): { host: string; port: number } {
  const m = /^(?:\[([^\]]+)\]|([^:]*)):(\d{1,5})$/.exec(value.trim());
  if (!m) throw invalid(`--http: expected HOST:PORT (e.g. 127.0.0.1:8765), got "${value}"`);
  const port = Number(m[3]);
  if (port > 65535) throw invalid(`--http: port out of range: ${port}`);
  return { host: (m[1] ?? m[2] ?? '') || '127.0.0.1', port };
}

export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'localhost' || h === '::1' || /^127(?:\.\d{1,3}){3}$/.test(h);
}
