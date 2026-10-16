import { domainToASCII } from 'node:url';

/**
 * Network destination patterns: `example.org` (exact) and `*.example.org`
 * (any subdomain, not the apex). Always compared lower-case, IDN as punycode.
 */

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Normalizes a destination pattern. Returns undefined when it is not a valid
 * pattern. A bare `*`, `*.tld` (single label after the wildcard), single-label
 * names and anything with a scheme, port, path or whitespace are invalid.
 */
export function normalizeDomainPattern(entry: string): string | undefined {
  let s = entry.trim().toLowerCase();
  if (s.endsWith('.')) s = s.slice(0, -1);
  if (s === '' || s.length > 260) return undefined;
  let wildcard = false;
  if (s.startsWith('*.')) {
    wildcard = true;
    s = s.slice(2);
  }
  // domainToASCII() parses URL-ish input leniently ("x.org/path" -> "x.org"); refuse such input up front.
  if (!/^[^\s/\\:?#@%[\]<>()'"*]+$/u.test(s)) return undefined;
  const ascii = domainToASCII(s);
  if (ascii === '' || ascii.length > 253) return undefined;
  const labels = ascii.split('.');
  if (labels.length < 2) return undefined;
  if (!labels.every((l) => LABEL.test(l))) return undefined;
  return wildcard ? `*.${ascii}` : ascii;
}

/**
 * True when `requested` (normalized pattern) is covered by one of the
 * `allowed` entries (normalized patterns, or the single entry `*` = anything).
 * A wildcard request is only covered by an equal or broader wildcard.
 */
export function domainCovered(requested: string, allowed: readonly string[]): boolean {
  for (const a of allowed) {
    if (a === '*' || a === requested) return true;
    if (a.startsWith('*.')) {
      const suffix = a.slice(1); // ".example.org"
      const base = requested.startsWith('*.') ? requested.slice(1) : requested;
      if (base.endsWith(suffix) && base.length > suffix.length) return true;
    }
  }
  return false;
}
