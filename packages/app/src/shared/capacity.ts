/**
 * Presentation logic for host capacity and the fit estimate: which tone a bar or banner gets and which numbers go
 * into which sentence. Pure and free of React, so it can be tested on its own; the texts are in the i18n catalogs.
 */
import type { FitEstimate, HostCapacity } from './types';

/** A bar turns amber above this share (percent) ... */
export const BAR_WARN_PERCENT = 80;
/** ... and red above this one. */
export const BAR_DANGER_PERCENT = 95;

export type BarTone = 'ok' | 'warn' | 'danger';

export function barTone(percent: number | null): BarTone {
  if (percent === null) return 'ok';
  if (percent > BAR_DANGER_PERCENT) return 'danger';
  if (percent > BAR_WARN_PERCENT) return 'warn';
  return 'ok';
}

export interface LiveBar {
  /** 0..100, whole number; null when not known. */
  percent: number | null;
  /** Used and total in the unit of the bar (cpus, bytes); null when not known. */
  used: number | null;
  total: number | null;
}

export interface LiveBars {
  cpu: LiveBar | null;
  ram: LiveBar | null;
}

const pct = (part: number, whole: number): number =>
  whole > 0 ? Math.min(100, Math.round((part / whole) * 100)) : 0;

/**
 * What the Hosts view draws for the live utilisation of a machine; `null` for a bar whose numbers are not known
 * (then the view says "unknown" instead of drawing an empty bar).
 */
export function liveBars(c: HostCapacity | undefined): LiveBars {
  if (!c || !c.live.available) return { cpu: null, ram: null };
  const l = c.live;
  const ncpu = c.capacity.cpus;
  const cpu: LiveBar | null =
    l.cpuPercent !== null
      ? {
          percent: Math.round(l.cpuPercent),
          used: ncpu !== null ? (l.cpuPercent / 100) * ncpu : null,
          total: ncpu,
        }
      : null;
  const total = l.memoryTotalBytes ?? c.capacity.memoryBytes;
  const ram: LiveBar | null =
    l.memoryUsedBytes !== null && total !== null && total > 0
      ? { percent: pct(l.memoryUsedBytes, total), used: l.memoryUsedBytes, total }
      : null;
  return { cpu, ram };
}

/** Share of the machine that abox's sandboxes have reserved (limits, not use); null when the size is unknown. */
export function reservedShare(c: HostCapacity | undefined): {
  cpu: number | null;
  ram: number | null;
} {
  if (!c) return { cpu: null, ram: null };
  const { cpus, memoryBytes } = c.capacity;
  return {
    cpu: cpus !== null && cpus > 0 ? pct(c.abox.reserved.cpus, cpus) : null,
    ram:
      memoryBytes !== null && memoryBytes > 0
        ? pct(c.abox.reserved.memoryBytes, memoryBytes)
        : null,
  };
}

/** What the estimate banner under "Resources and network" says. */
export interface FitBanner {
  tone: 'info' | 'warn' | 'danger';
  /** Blocks "Next": a host or profile limit would be exceeded. */
  blocks: boolean;
  /**
   * i18n key of the headline and its parameters. `by` is the i18n key of the limiting resource, to be translated
   * and passed as the parameter `by`; absent when nothing limits it.
   */
  headline: { key: string; params: Record<string, string | number>; by?: string };
  /** Second sentence: reserved with the planned sandbox / in use now; null when nothing is known. */
  detail: { key: string; params: Record<string, string | number> } | null;
  /** Warnings (message codes of the manager) shown as list items. */
  warnings: Array<{ code: string; message: string }>;
  /** Reasons of the blocking limits (English, from the manager's policy check). */
  blocked: Array<{ field: string; reason: string; hint: string | undefined }>;
}

const fmtPct = (n: number | null): string => (n === null ? '?' : String(n));

/**
 * Chooses the sentences of the banner. `host` is the label of the host (`this computer` for local). The headline
 * says how often the sandbox fits and what limits that; the detail says what is reserved with it and what the
 * machine uses now. A ceiling from limits, not a speed promise: the view adds that note.
 */
export function fitBanner(e: FitEstimate, host: string): FitBanner {
  const blocks = e.blocked.length > 0;
  const tone: FitBanner['tone'] = blocks ? 'danger' : e.tone === 'warn' ? 'warn' : 'info';
  let headline: FitBanner['headline'];
  if (blocks) {
    headline = { key: 'new.fit.blocked', params: { host } };
  } else if (e.fits === null) {
    headline = { key: 'new.fit.unknown', params: { host } };
  } else if (e.fits === 0) {
    const b = e.limitedBy;
    const by = limitedByKey(e);
    // what is missing decides the sentence: over-booking the machine, no memory free right now, or a limit
    headline =
      b?.source === 'live'
        ? { key: 'new.fit.noneLive', params: { host } }
        : by && (b?.source === 'limit' || b?.source === 'profile')
          ? { key: 'new.fit.noneBy', params: { host }, by }
          : { key: 'new.fit.none', params: { host } };
  } else {
    const by = limitedByKey(e);
    headline = {
      key: by ? 'new.fit.fitsBy' : 'new.fit.fits',
      params: { host, count: e.fits },
      ...(by ? { by } : {}),
    };
  }
  const r = e.projection.reservedPercent;
  const u = e.projection.usedPercent;
  const reserved = r.cpu !== null || r.memory !== null;
  const used = u.cpu !== null || u.memory !== null;
  let detail: FitBanner['detail'] = null;
  if (reserved && used) {
    detail = {
      key: 'new.fit.detail',
      params: {
        rcpu: fmtPct(r.cpu),
        rram: fmtPct(r.memory),
        ucpu: fmtPct(u.cpu),
        uram: fmtPct(u.memory),
      },
    };
  } else if (reserved) {
    detail = {
      key: 'new.fit.detailReserved',
      params: { rcpu: fmtPct(r.cpu), rram: fmtPct(r.memory) },
    };
  }
  return {
    tone,
    blocks,
    headline,
    detail,
    warnings: e.warnings.filter((w) => w.code !== 'capacity_unknown' || e.fits === null),
    blocked: e.blocked.map((b) => ({ field: b.field, reason: b.reason, hint: b.hint })),
  };
}

/** i18n key of the resource/limit that decides how often the sandbox fits. */
function limitedByKey(e: FitEstimate): string {
  const b = e.limitedBy;
  if (!b) return '';
  if (b.source === 'profile') return 'new.fit.by.profileSandboxes';
  if (b.source === 'limit') {
    return b.resource === 'sandboxes'
      ? 'new.fit.by.limitSandboxes'
      : b.resource === 'cpu'
        ? 'new.fit.by.limitCpu'
        : 'new.fit.by.limitMemory';
  }
  if (b.source === 'live') return b.resource === 'cpu' ? 'new.fit.by.cpu' : 'new.fit.by.liveMemory';
  return b.resource === 'cpu' ? 'new.fit.by.cpu' : 'new.fit.by.memory';
}
