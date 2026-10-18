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

/** Name suffixes that stand for the local machine or an internal network, never for a public destination. */
const INTERNAL_SUFFIXES: readonly string[] = [
  'localhost',
  'local',
  'localdomain',
  'internal',
  'intranet',
  'lan',
  'home.arpa',
];
/** Cloud metadata endpoints that are reachable by name (the addresses are blocked by the proxy as well). */
const METADATA_HOSTS: readonly string[] = [
  'metadata.google.internal',
  'metadata.goog',
  'instance-data.ec2.internal',
  'metadata.tencentyun.com',
];

/** True for `1.2.3.4`, `1.2`, `0x7f.1`, `2130706433`: a name whose last label is a number (an address in disguise). */
function looksLikeAddress(host: string): boolean {
  const last = host.slice(host.lastIndexOf('.') + 1);
  return /^(0x[0-9a-f]*|\d+)$/.test(last);
}

/**
 * Why a destination from the network log can not be allowed for a sandbox by a quick decision ("allow once",
 * "allow permanently" in the log), or `undefined` when it can. `pattern` is a destination as the allowlist
 * takes it: `host`, `host:port` or `*.host`.
 *
 * Refused: anything that is not a valid destination pattern, IP addresses (also written as numbers), the names of
 * the local machine and internal networks, and the names of cloud metadata services. The proxy blocks private and
 * metadata addresses by itself whatever the allowlist says (`blockPrivate`); this is the explanation before a rule is
 * even written. A range of private addresses is only ever opened by a private-address exception, which is a
 * separate request that always needs a human.
 */
export function networkDestinationProblem(pattern: string): string | undefined {
  const norm = normalizeDomainPattern(pattern);
  if (norm === undefined)
    return 'this is not a valid domain name (a host name like pypi.org, optionally host:port or *.example.org)';
  const { host: withWildcard } = splitPort(norm);
  const host = withWildcard.startsWith('*.') ? withWildcard.slice(2) : withWildcard;
  if (looksLikeAddress(host))
    return 'IP addresses cannot be allowed here: use the host name (the proxy never connects to private or metadata addresses)';
  if (METADATA_HOSTS.includes(host) || METADATA_HOSTS.some((m) => m.endsWith(`.${host}`)))
    return 'cloud metadata services are never allowed';
  if (INTERNAL_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`)))
    return 'names of the local machine and of internal networks are never allowed here (the proxy blocks private addresses)';
  return undefined;
}

/** Second-level labels that are part of a public suffix under a country code (`co.uk`, `com.au`, ...). */
const SECOND_LEVEL_LABELS: readonly string[] = [
  'co',
  'com',
  'org',
  'net',
  'gov',
  'edu',
  'ac',
  'or',
  'ne',
  'go',
  'gob',
  'nom',
];

/**
 * The wildcard that covers every subdomain of the parent of `host` (`registry.example.org` -> `*.example.org`),
 * or `undefined` when none is sensible: a name with only two labels has no useful parent, and the parent of
 * `shop.example.co.uk` would be a public suffix (heuristic: a short second-level label under a two-letter country
 * code). A wildcard is always an explicit, warned-about choice; it is never the default.
 */
export function wildcardFor(host: string): string | undefined {
  const labels = host.toLowerCase().split('.');
  if (labels.length < 3) return undefined;
  const parent = labels.slice(1);
  if (
    parent.length === 2 &&
    parent[1]!.length === 2 &&
    SECOND_LEVEL_LABELS.includes(parent[0]!) &&
    normalizeDomainPattern(`*.${parent.join('.')}`) !== undefined
  )
    return undefined;
  const pattern = normalizeDomainPattern(`*.${parent.join('.')}`);
  return pattern !== undefined && networkDestinationProblem(pattern) === undefined
    ? pattern
    : undefined;
}
