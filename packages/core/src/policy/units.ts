/**
 * Size and duration strings used in policy.yaml (`8g`, `512m`, `4h`, `30m`).
 * Kept local to the policy module so it has no dependency on the template parser.
 */

const SIZE_FACTORS: Readonly<Record<string, number>> = {
  '': 1,
  b: 1,
  k: 1024,
  kb: 1024,
  kib: 1024,
  m: 1024 ** 2,
  mb: 1024 ** 2,
  mib: 1024 ** 2,
  g: 1024 ** 3,
  gb: 1024 ** 3,
  gib: 1024 ** 3,
  t: 1024 ** 4,
  tb: 1024 ** 4,
  tib: 1024 ** 4,
};

const DURATION_FACTORS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/** Parses `8g`, `512m`, `1.5gb` (binary units). A bare number is bytes. Returns undefined when invalid. */
export function tryParseSize(input: string | number): number | undefined {
  if (typeof input === 'number') {
    return Number.isSafeInteger(input) && input > 0 ? input : undefined;
  }
  const m = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/i.exec(input.trim());
  if (!m) return undefined;
  const factor = SIZE_FACTORS[(m[2] ?? '').toLowerCase()];
  if (factor === undefined) return undefined;
  const bytes = Math.floor(Number(m[1]) * factor);
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : undefined;
}

/** Parses `4h`, `30m`, `1h30m`, `2d`. Returns milliseconds or undefined when invalid. */
export function tryParseDuration(input: string): number | undefined {
  const s = input.trim().toLowerCase();
  if (s === '') return undefined;
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h|d|w)/y;
  let total = 0;
  let pos = 0;
  while (pos < s.length) {
    re.lastIndex = pos;
    const m = re.exec(s);
    if (!m) return undefined;
    total += Number(m[1]) * (DURATION_FACTORS[m[2] as string] as number);
    pos = re.lastIndex;
  }
  const ms = Math.floor(total);
  return Number.isSafeInteger(ms) && ms > 0 ? ms : undefined;
}

export function parseSize(input: string | number): number {
  const v = tryParseSize(input);
  if (v === undefined)
    throw new RangeError(`invalid size "${String(input)}" (expected e.g. 512m, 8g)`);
  return v;
}

export function parseDuration(input: string): number {
  const v = tryParseDuration(input);
  if (v === undefined)
    throw new RangeError(`invalid duration "${input}" (expected e.g. 30m, 4h, 2d)`);
  return v;
}

/** Human-readable size, exact where possible (`8g`, `512m`), otherwise bytes. */
export function formatSize(bytes: number): string {
  const units: Array<[number, string]> = [
    [1024 ** 4, 't'],
    [1024 ** 3, 'g'],
    [1024 ** 2, 'm'],
    [1024, 'k'],
  ];
  for (const [factor, suffix] of units) {
    if (bytes >= factor && bytes % factor === 0) return `${bytes / factor}${suffix}`;
  }
  return `${bytes}b`;
}

/** Human-readable duration, exact where possible (`4h`, `90m`), otherwise ms. */
export function formatDuration(ms: number): string {
  const units: Array<[number, string]> = [
    [604_800_000, 'w'],
    [86_400_000, 'd'],
    [3_600_000, 'h'],
    [60_000, 'm'],
    [1000, 's'],
  ];
  for (const [factor, suffix] of units) {
    if (ms >= factor && ms % factor === 0) return `${ms / factor}${suffix}`;
  }
  return `${ms}ms`;
}
