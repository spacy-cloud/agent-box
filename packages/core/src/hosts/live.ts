import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { AboxError } from '../errors.js';
import { run } from './exec.js';
import type { HostProfile } from './model.js';
import { buildSshArgs, sshBinary, type HostsEnv } from './ssh-args.js';

/**
 * Live utilisation of a whole host (everything that runs there, not only abox), read from `/proc`.
 * Only numbers are read: load average, memory totals, the aggregate cpu counters and the cpu count.
 * No process list, no file names, no user data. Anything that cannot be read is `null` (never guessed).
 */
export interface HostLiveUsage {
  /** When the sample was taken (epoch ms). */
  ts: number;
  /** Share of all cpus that was busy between two `/proc/stat` readings (0..100); null when unknown. */
  cpuPercent: number | null;
  /** Load average over 1, 5 and 15 minutes; null when unknown. */
  load: { m1: number; m5: number; m15: number } | null;
  /** `MemTotal` in bytes. */
  memoryTotalBytes: number | null;
  /** `MemAvailable` in bytes (memory a new workload can get without swapping); null on kernels without it. */
  memoryAvailableBytes: number | null;
  /** Logical cpus as the kernel counts them. */
  cpus: number | null;
  /** Where the numbers come from. */
  source: 'local' | 'ssh';
}

export type HostLiveResult = { ok: true; usage: HostLiveUsage } | { ok: false; reason: string };

/** The aggregate counters of the first line of `/proc/stat`, in clock ticks. */
export interface CpuTimes {
  total: number;
  idle: number;
}

const KIB = 1024;

/** `0.52 0.58 0.59 1/467 12345` -> the three averages. */
export function parseLoadavg(text: string): { m1: number; m5: number; m15: number } | undefined {
  const m = /^\s*(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)(?:\s|$)/.exec(text);
  if (!m) return undefined;
  return { m1: Number(m[1]), m5: Number(m[2]), m15: Number(m[3]) };
}

/** `MemTotal` and `MemAvailable` of `/proc/meminfo` in bytes; a missing field is left out. */
export function parseMeminfo(text: string): { totalBytes?: number; availableBytes?: number } {
  const out: { totalBytes?: number; availableBytes?: number } = {};
  for (const line of text.split('\n')) {
    const m = /^(MemTotal|MemAvailable):\s+(\d+)\s*(kB)?\s*$/.exec(line);
    if (!m) continue;
    const bytes = Number(m[2]) * (m[3] === undefined ? 1 : KIB);
    if (!Number.isSafeInteger(bytes)) continue;
    if (m[1] === 'MemTotal') out.totalBytes = bytes;
    else out.availableBytes = bytes;
  }
  return out;
}

/**
 * The aggregate `cpu ` line of `/proc/stat`: `cpu user nice system idle iowait irq softirq steal [guest guest_nice]`.
 * `guest` time is already part of `user`, so it is not added again. Idle counts `idle` and `iowait`.
 */
export function parseCpuStat(line: string): CpuTimes | undefined {
  const m = /^cpu\s+(\d+(?:\s+\d+){3,9})\s*$/.exec(line.trim());
  if (!m) return undefined;
  const f = m[1]!.split(/\s+/).map(Number);
  if (f.some((n) => !Number.isFinite(n))) return undefined;
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = f;
  return {
    total: user + nice + system + idle + iowait + irq + softirq + steal,
    idle: idle + iowait,
  };
}

/** Busy share (0..100, one decimal) between two readings; null when the counters did not advance. */
export function cpuPercentBetween(a: CpuTimes, b: CpuTimes): number | null {
  const total = b.total - a.total;
  const idle = b.idle - a.idle;
  if (!(total > 0) || idle < 0) return null;
  const busy = Math.min(100, Math.max(0, ((total - idle) / total) * 100));
  return Math.round(busy * 10) / 10;
}

/** Number of `cpuN` lines of `/proc/stat`. */
export function countCpusInStat(text: string): number | null {
  const n = text.split('\n').filter((l) => /^cpu\d+\s/.test(l)).length;
  return n > 0 ? n : null;
}

/** Number of `processor` lines of `/proc/cpuinfo` (or the bare number a `grep -c` printed). */
export function parseCpuCount(text: string): number | null {
  const t = text.trim();
  if (/^\d{1,5}$/.test(t)) return Number(t) > 0 ? Number(t) : null;
  const n = text.split('\n').filter((l) => /^processor\s*:/.test(l)).length;
  return n > 0 ? n : null;
}

function usageFrom(
  parts: {
    stat1?: string | undefined;
    stat2?: string | undefined;
    loadavg?: string | undefined;
    meminfo?: string | undefined;
    cpus?: number | null | undefined;
  },
  ts: number,
  source: HostLiveUsage['source'],
): HostLiveUsage | undefined {
  const a = parts.stat1 !== undefined ? parseCpuStat(parts.stat1) : undefined;
  const b = parts.stat2 !== undefined ? parseCpuStat(parts.stat2) : undefined;
  const mem = parts.meminfo !== undefined ? parseMeminfo(parts.meminfo) : {};
  const load = parts.loadavg !== undefined ? parseLoadavg(parts.loadavg) : undefined;
  const cpuPercent = a && b ? cpuPercentBetween(a, b) : null;
  // Nothing at all that /proc told us: not a Linux host, or a restricted one.
  if (!load && mem.totalBytes === undefined && cpuPercent === null) return undefined;
  return {
    ts,
    cpuPercent,
    load: load ?? null,
    memoryTotalBytes: mem.totalBytes ?? null,
    memoryAvailableBytes: mem.availableBytes ?? null,
    cpus: parts.cpus ?? null,
    source,
  };
}

// ---------------------------------------------------------------------------
// this machine
// ---------------------------------------------------------------------------

export interface LocalLiveOptions {
  /** Time between the two `/proc/stat` readings (default 300 ms). */
  sampleMs?: number;
  /** Reads a file as text (tests); default `fs.readFile`. */
  read?: (path: string) => Promise<string>;
  now?: () => number;
  platform?: NodeJS.Platform;
}

/** Live utilisation of this machine from `/proc` (Linux only). Takes about `sampleMs`. */
export async function readLocalLive(opts: LocalLiveOptions = {}): Promise<HostLiveResult> {
  const read = opts.read ?? ((p: string) => readFile(p, 'utf8'));
  if ((opts.platform ?? process.platform) !== 'linux') {
    return { ok: false, reason: 'live utilisation is only read on Linux (/proc)' };
  }
  try {
    const first = await read('/proc/stat');
    await sleep(opts.sampleMs ?? 300);
    const second = await read('/proc/stat');
    const [loadavg, meminfo] = await Promise.all([
      read('/proc/loadavg').catch(() => undefined),
      read('/proc/meminfo').catch(() => undefined),
    ]);
    const head = (t: string): string => t.split('\n', 1)[0] ?? '';
    const usage = usageFrom(
      {
        stat1: head(first),
        stat2: head(second),
        loadavg,
        meminfo,
        cpus: countCpusInStat(second),
      },
      (opts.now ?? Date.now)(),
      'local',
    );
    return usage ? { ok: true, usage } : { ok: false, reason: '/proc has no usable numbers' };
  } catch (e) {
    return { ok: false, reason: `cannot read /proc: ${(e as Error).message}`.slice(0, 200) };
  }
}

// ---------------------------------------------------------------------------
// an ssh host
// ---------------------------------------------------------------------------

/**
 * The remote command: a FIXED script, nothing is interpolated (no host name, no path, no user input).
 * It reads two samples of the aggregate cpu counters half a second apart, the load average, `MemTotal` /
 * `MemAvailable` and the cpu count, and prints them below marker lines. It runs as `sh -c '<script>'` on one
 * line without single quotes or `!` so any login shell hands it through unchanged. Where `/proc` is missing
 * (not Linux) the script prints only the marker for `uname`.
 */
export function liveScript(): string {
  return [
    'echo abox.uname; uname -s;',
    'if [ -r /proc/stat ] && [ -r /proc/meminfo ]; then',
    'echo abox.stat1; head -n 1 /proc/stat;',
    'sleep 0.5 2>/dev/null || sleep 1;',
    'echo abox.stat2; head -n 1 /proc/stat;',
    'echo abox.loadavg; cat /proc/loadavg 2>/dev/null;',
    'echo abox.meminfo; grep -E "^(MemTotal|MemAvailable):" /proc/meminfo;',
    'echo abox.cpus; grep -c "^processor" /proc/cpuinfo 2>/dev/null;',
    'fi;',
  ].join(' ');
}

export function liveCommand(): string {
  const script = liveScript();
  if (script.includes("'") || script.includes('!')) {
    throw new AboxError('internal', 'live script must not contain single quotes or "!"');
  }
  return `sh -c '${script}'`;
}

const MARKERS = ['uname', 'stat1', 'stat2', 'loadavg', 'meminfo', 'cpus'] as const;
type Marker = (typeof MARKERS)[number];

/** Splits the output of `liveScript()` into its sections; lines before the first marker (rc files) are ignored. */
export function parseLiveSections(stdout: string): Partial<Record<Marker, string>> {
  const out: Partial<Record<Marker, string>> = {};
  let current: Marker | undefined;
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const m = /^abox\.([a-z0-9]+)$/.exec(line);
    if (m && (MARKERS as readonly string[]).includes(m[1]!)) {
      current = m[1] as Marker;
      out[current] = '';
      continue;
    }
    if (current !== undefined && (out[current]?.length ?? 0) < 4096) out[current] += `${line}\n`;
  }
  return out;
}

/** Interprets the output of the remote script. Pure. */
export function parseLiveOutput(stdout: string, ts: number): HostLiveResult {
  const s = parseLiveSections(stdout);
  const os = (s.uname ?? '').trim();
  if (s.stat1 === undefined || s.meminfo === undefined) {
    return {
      ok: false,
      reason:
        os && os !== 'Linux' ? `${os.slice(0, 40)}: no /proc` : 'the host has no readable /proc',
    };
  }
  const first = (t: string | undefined): string => (t ?? '').split('\n', 1)[0] ?? '';
  const usage = usageFrom(
    {
      stat1: first(s.stat1),
      stat2: first(s.stat2),
      loadavg: s.loadavg,
      meminfo: s.meminfo,
      cpus: s.cpus !== undefined ? parseCpuCount(s.cpus) : null,
    },
    ts,
    'ssh',
  );
  return usage ? { ok: true, usage } : { ok: false, reason: '/proc has no usable numbers' };
}

export interface RemoteLiveOptions {
  /** Kills the ssh call after this long (default: connect timeout + 20 s). */
  timeoutMs?: number;
}

function sshReason(stderr: string, timedOut: boolean, code: number | null): string {
  if (timedOut) return 'timeout';
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(stderr))
    return 'host key not trusted';
  if (/Permission denied|Too many authentication failures|Authentication failed/i.test(stderr))
    return 'login failed';
  const last = stderr.trim().split('\n').slice(-1)[0] ?? '';
  // eslint-disable-next-line no-control-regex
  return last.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 160) || `ssh exited with ${code}`;
}

/**
 * Live utilisation of an ssh host with ONE ssh call over the hardened connection (same options and
 * known_hosts handling as every other abox ssh call; an untrusted or changed host key fails). Output is
 * bounded, the call has a timeout, and the command is the constant `liveCommand()`.
 */
export async function readRemoteLive(
  profile: HostProfile,
  env: HostsEnv,
  opts: RemoteLiveOptions = {},
): Promise<HostLiveResult> {
  const args = buildSshArgs(profile, env, { mode: 'batch', remoteCommand: liveCommand() });
  const now = env.now ?? Date.now;
  let res;
  try {
    res = await run(sshBinary(env), args, {
      timeoutMs: opts.timeoutMs ?? ((env.connectTimeoutSec ?? 10) + 20) * 1000,
      maxBytes: 16 * 1024,
    });
  } catch (e) {
    return { ok: false, reason: `cannot run ssh: ${(e as Error).message}`.slice(0, 200) };
  }
  if (res.code !== 0 && !res.stdout.includes('abox.')) {
    return { ok: false, reason: sshReason(res.stderr, res.timedOut, res.code) };
  }
  return parseLiveOutput(res.stdout, now());
}
