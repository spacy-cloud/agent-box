import { domainToASCII } from 'node:url';

/**
 * Network destination patterns: `example.org` (exact) and `*.example.org`
 * (any subdomain, not the apex). Always compared lower-case, IDN as punycode.
 */

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Ports an allowlist entry without an explicit `:port` allows (same as the proxy: `DEFAULT_PORTS`). */
export const DEFAULT_ALLOW_PORTS: readonly number[] = Object.freeze([80, 443]);

/**
 * Normalizes a destination pattern. Returns undefined when it is not a valid
 * pattern. A bare `*`, `*.tld` (single label after the wildcard), single-label
 * names and anything with a scheme, path or whitespace are invalid. An optional
 * `:port` (1..65535) is kept: `host:port` allows exactly that port, a pattern
 * without port the default ports 80 and 443 (see docs/internal/proxy-contract.md).
 */
export function normalizeDomainPattern(entry: string): string | undefined {
  let s = entry.trim().toLowerCase();
  let port: string | undefined;
  const colon = s.indexOf(':');
  if (colon >= 0) {
    // Only one colon, followed by a canonical decimal port; IPv6 literals and URLs never get here.
    const portText = s.slice(colon + 1);
    if (!/^[1-9]\d{0,4}$/.test(portText) || Number(portText) > 65535) return undefined;
    port = portText;
    s = s.slice(0, colon);
  }
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
  const host = wildcard ? `*.${ascii}` : ascii;
  return port === undefined ? host : `${host}:${port}`;
}

/** Splits a normalized pattern into host part and optional port. */
function splitPort(pattern: string): { host: string; port?: number } {
  const i = pattern.lastIndexOf(':');
  return i < 0
    ? { host: pattern }
    : { host: pattern.slice(0, i), port: Number(pattern.slice(i + 1)) };
}

function hostCovered(requested: string, allowedHost: string): boolean {
  if (allowedHost === '*' || allowedHost === requested) return true;
  if (allowedHost.startsWith('*.')) {
    const suffix = allowedHost.slice(1); // ".example.org"
    const base = requested.startsWith('*.') ? requested.slice(1) : requested;
    if (base.endsWith(suffix) && base.length > suffix.length) return true;
  }
  return false;
}

/**
 * True when `requested` (normalized pattern) is covered by the `allowed`
 * entries (normalized patterns, or the single entry `*` = anything on any port).
 * A wildcard request is only covered by an equal or broader wildcard.
 *
 * Ports follow the proxy: an entry without port covers ports 80 and 443 only,
 * `host:port` covers exactly that port. A request without port means "80 and
 * 443" and is covered when both are (possibly by separate `host:80`/`host:443` entries);
 * `host:port` is covered by `host` only when the port is 80 or 443.
 */
export function domainCovered(requested: string, allowed: readonly string[]): boolean {
  const req = splitPort(requested);
  const ports = req.port === undefined ? DEFAULT_ALLOW_PORTS : [req.port];
  return ports.every((port) =>
    allowed.some((a) => {
      if (a === '*') return true;
      const al = splitPort(a);
      const portOk = al.port === undefined ? DEFAULT_ALLOW_PORTS.includes(port) : al.port === port;
      return portOk && hostCovered(req.host, al.host);
    }),
  );
}
