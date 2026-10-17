// abox egress proxy: pure policy logic.
//
// This module has NO side effects and uses only Node built-ins. It is shared by
// `proxy.mjs` (the sidecar) and by `@abox/proxy` (src/index.ts) so that tests, the
// host-side tooling and the runtime all use exactly the same matching code.
//
// Contents:
//   - host normalisation (IDNA, trailing dot, IP literals, strict validation)
//   - allowlist compilation and matching
//   - IPv4 / IPv6 parsing, CIDR math (BigInt) and the blocked-address policy
//   - proxy request-target parsing (CONNECT authority, absolute-form http://)
//   - strict config validation
//
// Everything here fails closed: anything that cannot be parsed unambiguously is
// rejected (hosts) or treated as blocked (addresses).

import { domainToASCII } from 'node:url';

/** Ports allowed for allowlist entries that do not carry an explicit `:port`. */
export const DEFAULT_PORTS = Object.freeze([80, 443]);

// ---------------------------------------------------------------------------
// IP parsing / formatting
// ---------------------------------------------------------------------------

/**
 * Strict dotted-quad IPv4 parser. Only the canonical form is accepted (no octal,
 * hex, short forms and no leading zeros) because `getaddrinfo` would interpret
 * those ambiguously (`0177.1` = 127.0.0.1).
 * @returns {{ family: 4, value: bigint } | undefined}
 */
function parseIPv4(text) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!m) return undefined;
  let value = 0n;
  for (let i = 1; i <= 4; i++) {
    const part = /** @type {string} */ (m[i]);
    if (part.length > 1 && part.startsWith('0')) return undefined;
    const n = Number(part);
    if (n > 255) return undefined;
    value = (value << 8n) | BigInt(n);
  }
  return { family: 4, value };
}

/**
 * IPv6 parser (RFC 4291 text forms, including `::` and a dotted IPv4 tail).
 * Zone identifiers (`%eth0`) are rejected.
 * @returns {{ family: 6, value: bigint } | undefined}
 */
function parseIPv6(text) {
  if (text.includes('%') || !text.includes(':')) return undefined;
  let s = text;
  if (s.includes('.')) {
    const lastColon = s.lastIndexOf(':');
    const v4 = parseIPv4(s.slice(lastColon + 1));
    if (!v4) return undefined;
    const hi = Number(v4.value >> 16n).toString(16);
    const lo = Number(v4.value & 0xffffn).toString(16);
    s = `${s.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return undefined;
  const groups = (part) => (part === '' ? [] : part.split(':'));
  let all;
  if (halves.length === 2) {
    const head = groups(/** @type {string} */ (halves[0]));
    const tail = groups(/** @type {string} */ (halves[1]));
    if (head.length + tail.length > 7) return undefined;
    all = [...head, ...new Array(8 - head.length - tail.length).fill('0'), ...tail];
  } else {
    all = groups(s);
    if (all.length !== 8) return undefined;
  }
  let value = 0n;
  for (const g of all) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return undefined;
    value = (value << 16n) | BigInt(parseInt(g, 16));
  }
  return { family: 6, value };
}

/**
 * Parse an IPv4 or IPv6 literal (no brackets, no zone, no port).
 * @param {string} text
 * @returns {{ family: 4 | 6, value: bigint } | undefined}
 */
export function parseIp(text) {
  if (typeof text !== 'string') return undefined;
  return parseIPv4(text) ?? parseIPv6(text);
}

/**
 * Canonical text form: dotted quad, or RFC 5952 compressed lowercase IPv6.
 * @param {{ family: 4 | 6, value: bigint }} ip
 */
export function formatIp(ip) {
  if (ip.family === 4) {
    const v = ip.value;
    return `${(v >> 24n) & 255n}.${(v >> 16n) & 255n}.${(v >> 8n) & 255n}.${v & 255n}`;
  }
  const groups = [];
  for (let i = 7; i >= 0; i--) groups.push(Number((ip.value >> BigInt(i * 16)) & 0xffffn));
  // Find the longest run (>= 2) of zero groups to compress.
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8;) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = (g) => g.toString(16);
  if (bestLen < 2) return groups.map(hex).join(':');
  const head = groups.slice(0, bestStart).map(hex).join(':');
  const tail = groups
    .slice(bestStart + bestLen)
    .map(hex)
    .join(':');
  return `${head}::${tail}`;
}

// ---------------------------------------------------------------------------
// CIDR math + blocked-address policy
// ---------------------------------------------------------------------------

/**
 * Parse `a.b.c.d/len`, `v6/len` or a bare address (host route). Host bits are masked.
 * @param {string} text
 * @returns {{ family: 4 | 6, base: bigint, prefix: number } | undefined}
 */
export function parseCidr(text) {
  if (typeof text !== 'string') return undefined;
  const slash = text.indexOf('/');
  const addrText = slash === -1 ? text : text.slice(0, slash);
  const ip = parseIp(addrText);
  if (!ip) return undefined;
  const bits = ip.family === 4 ? 32 : 128;
  let prefix = bits;
  if (slash !== -1) {
    const p = text.slice(slash + 1);
    if (!/^(0|[1-9]\d{0,2})$/.test(p)) return undefined;
    prefix = Number(p);
    if (prefix > bits) return undefined;
  }
  const shift = BigInt(bits - prefix);
  return { family: ip.family, base: (ip.value >> shift) << shift, prefix };
}

/** @param {{ family: 4 | 6, base: bigint, prefix: number }} cidr */
function cidrContains(cidr, ip) {
  if (cidr.family !== ip.family) return false;
  const bits = cidr.family === 4 ? 32 : 128;
  const shift = BigInt(bits - cidr.prefix);
  return ip.value >> shift === cidr.base >> shift;
}

const cidr = (text) => /** @type {NonNullable<ReturnType<typeof parseCidr>>} */ (parseCidr(text));

/** Blocked IPv4 ranges (contract: "blockPrivate"). */
const BLOCKED_V4 = [
  ['0.0.0.0/8', 'this network'],
  ['10.0.0.0/8', 'private (RFC 1918)'],
  ['100.64.0.0/10', 'shared address space (CGNAT)'],
  ['127.0.0.0/8', 'loopback'],
  ['169.254.0.0/16', 'link-local / cloud metadata'],
  ['172.16.0.0/12', 'private (RFC 1918)'],
  ['192.0.0.0/24', 'IETF protocol assignments'],
  ['192.168.0.0/16', 'private (RFC 1918)'],
  ['198.18.0.0/15', 'benchmarking'],
  ['224.0.0.0/4', 'multicast'],
  ['240.0.0.0/4', 'reserved / broadcast'],
].map(([c, name]) => ({
  cidr: cidr(/** @type {string} */ (c)),
  name: /** @type {string} */ (name),
}));

/**
 * Blocked IPv6 ranges. IPv4-in-IPv6 forms with a *public* embedded IPv4 are allowed
 * (they are routed like that IPv4); embedded private IPv4 is checked separately via
 * `embeddedIPv4`.
 */
const BLOCKED_V6 = [
  ['::1/128', 'loopback'],
  ['::/128', 'unspecified'],
  // The deprecated IPv4-compatible form ::a.b.c.d is blocked as a whole.
  ['::/96', 'IPv4-compatible (deprecated)'],
  ['fc00::/7', 'unique local'],
  ['fe80::/10', 'link-local'],
  ['fec0::/10', 'site-local (deprecated)'],
  ['ff00::/8', 'multicast'],
  ['2001::/32', 'Teredo'],
  ['64:ff9b:1::/48', 'local-use NAT64'],
].map(([c, name]) => ({
  cidr: cidr(/** @type {string} */ (c)),
  name: /** @type {string} */ (name),
}));

const V6_MAPPED = cidr('::ffff:0:0/96');
const V6_TRANSLATED = cidr('::ffff:0:0:0/96'); // IPv4-translated (SIIT), RFC 2765
const V6_NAT64 = cidr('64:ff9b::/96');
const V6_6TO4 = cidr('2002::/16');

/**
 * IPv4 addresses embedded in an IPv6 address (mapped, translated, NAT64, 6to4).
 * @param {{ family: 6, value: bigint }} ip
 * @returns {{ family: 4, value: bigint } | undefined}
 */
function embeddedIPv4(ip) {
  if (
    cidrContains(V6_MAPPED, ip) ||
    cidrContains(V6_TRANSLATED, ip) ||
    cidrContains(V6_NAT64, ip)
  ) {
    return { family: 4, value: ip.value & 0xffffffffn };
  }
  if (cidrContains(V6_6TO4, ip)) return { family: 4, value: (ip.value >> 80n) & 0xffffffffn };
  return undefined;
}

/**
 * Name of the blocked range an address falls into, or undefined. Exceptions are not
 * applied here.
 * @param {{ family: 4 | 6, value: bigint }} ip
 */
function blockedRangeName(ip) {
  const table = ip.family === 4 ? BLOCKED_V4 : BLOCKED_V6;
  for (const entry of table) if (cidrContains(entry.cidr, ip)) return entry.name;
  return undefined;
}

/**
 * Why an address is blocked (or `undefined` if it may be contacted).
 *
 * @param {string} address IPv4/IPv6 literal as returned by the resolver
 * @param {readonly string[]} [exceptions] CIDRs that re-allow blocked ranges
 * @returns {string | undefined} human readable range name when blocked
 */
export function blockedReason(address, exceptions = []) {
  const ip = parseIp(address);
  if (!ip) return 'unparseable address'; // fail closed
  const excepted = exceptions.map((c) => parseCidr(c)).filter((c) => c !== undefined);
  const covered = (candidate) => excepted.some((c) => cidrContains(c, candidate));
  // An exception covering the literal address itself re-allows it entirely.
  if (covered(ip)) return undefined;
  // Every "view" of the address must pass: the address itself and, for IPv6, the
  // IPv4 address embedded in it (mapped / translated / NAT64 / 6to4).
  const views = [ip];
  if (ip.family === 6) {
    const embedded = embeddedIPv4(ip);
    if (embedded) views.push(embedded);
  }
  for (const view of views) {
    const name = blockedRangeName(view);
    if (name && !covered(view)) return view === ip ? name : `${name} (embedded in IPv6)`;
  }
  return undefined;
}

/**
 * True if the proxy must refuse to connect to `address` when `blockPrivate` is on.
 * @param {string} address
 * @param {readonly string[]} [exceptions] `privateExceptions` CIDRs
 */
export function isBlockedAddress(address, exceptions = []) {
  return blockedReason(address, exceptions) !== undefined;
}

// ---------------------------------------------------------------------------
// Host normalisation
// ---------------------------------------------------------------------------

/**
 * @typedef {{ ok: true, host: string, kind: 'name' | 'ipv4' | 'ipv6' }
 *   | { ok: false, reason: string }} HostResult
 */

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
// Characters that must never appear in a host: whitespace/control, URL delimiters,
// userinfo, percent-encoding and brackets (brackets are handled before this check).
// eslint-disable-next-line no-control-regex
const FORBIDDEN_HOST_CHARS = /[\u0000- \u007f\\/?#@%[\]:]/;

/**
 * Normalise and validate a destination host.
 *
 * Accepts: DNS names (Unicode or punycode, any case, one optional trailing dot),
 * canonical dotted-quad IPv4, IPv6 (optionally in brackets).
 * Rejects: userinfo, percent-encodings, ambiguous numeric hosts (`127.1`, `0x7f.1`,
 * `2130706433`, `010.0.0.1`), invalid labels, hosts > 253 characters.
 *
 * @param {unknown} raw
 * @returns {HostResult}
 */
export function normalizeHost(raw) {
  if (typeof raw !== 'string' || raw === '') return { ok: false, reason: 'empty host' };
  if (raw.length > 1024) return { ok: false, reason: 'host too long' };

  // IPv6 literal (bracketed, or bare when used outside of an authority).
  if (raw.startsWith('[') || (raw.includes(':') && !raw.includes('@'))) {
    const inner = raw.startsWith('[') ? (raw.endsWith(']') ? raw.slice(1, -1) : '') : raw;
    const ip = parseIPv6(inner);
    if (!ip) return { ok: false, reason: 'invalid host' };
    return { ok: true, host: formatIp(ip), kind: 'ipv6' };
  }
  if (raw.includes('@')) return { ok: false, reason: 'userinfo not allowed' };
  if (FORBIDDEN_HOST_CHARS.test(raw)) return { ok: false, reason: 'invalid characters in host' };

  let name = raw;
  if (name.endsWith('.')) name = name.slice(0, -1);
  if (name === '' || name.endsWith('.')) return { ok: false, reason: 'invalid host' };

  // Strict IPv4 or reject anything that merely looks numeric.
  if (/^[0-9.]+$/.test(name)) {
    const ip = parseIPv4(name);
    if (!ip) return { ok: false, reason: 'ambiguous numeric host' };
    return { ok: true, host: formatIp(ip), kind: 'ipv4' };
  }

  const ascii = domainToASCII(name); // IDNA (UTS #46) + lowercase; '' if invalid
  if (ascii === '') return { ok: false, reason: 'invalid host (IDNA)' };
  if (ascii.length > 253) return { ok: false, reason: 'host too long' };
  const labels = ascii.split('.');
  for (const label of labels) {
    if (label.length === 0 || label.length > 63 || !LABEL_RE.test(label)) {
      return { ok: false, reason: 'invalid host label' };
    }
  }
  // getaddrinfo would parse a numeric/hex last label as an IPv4 form (`1.2.0x3`).
  if (/^(0x[0-9a-f]*|[0-9]+)$/.test(/** @type {string} */ (labels[labels.length - 1]))) {
    return { ok: false, reason: 'ambiguous numeric host' };
  }
  return { ok: true, host: ascii, kind: 'name' };
}

/** Strict port parser: decimal 1..65535, no sign, no leading zeros. */
function parsePort(text) {
  if (!/^[1-9]\d{0,4}$/.test(text)) return undefined;
  const n = Number(text);
  return n <= 65535 ? n : undefined;
}

/**
 * Parse an authority (`host`, `host:port`, `[v6]`, `[v6]:port`).
 *
 * @param {string} authority
 * @param {number} [defaultPort] used when the authority carries no port; without it a
 *   missing port is an error (CONNECT requires an explicit port)
 * @returns {{ ok: true, host: string, port: number, kind: 'name' | 'ipv4' | 'ipv6' } | { ok: false, reason: string }}
 */
export function parseAuthority(authority, defaultPort) {
  if (typeof authority !== 'string' || authority === '') return { ok: false, reason: 'empty host' };
  if (authority.length > 1100) return { ok: false, reason: 'host too long' };
  if (authority.includes('@')) return { ok: false, reason: 'userinfo not allowed' };
  let hostPart;
  let portPart;
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    if (end === -1) return { ok: false, reason: 'invalid host' };
    hostPart = authority.slice(0, end + 1);
    const rest = authority.slice(end + 1);
    if (rest !== '') {
      if (!rest.startsWith(':')) return { ok: false, reason: 'invalid host' };
      portPart = rest.slice(1);
    }
  } else {
    const colon = authority.indexOf(':');
    if (colon === -1) {
      hostPart = authority;
    } else {
      if (authority.indexOf(':', colon + 1) !== -1) return { ok: false, reason: 'invalid host' };
      hostPart = authority.slice(0, colon);
      portPart = authority.slice(colon + 1);
    }
  }
  let port;
  if (portPart === undefined) {
    if (defaultPort === undefined) return { ok: false, reason: 'missing port' };
    port = defaultPort;
  } else {
    port = parsePort(portPart);
    if (port === undefined) return { ok: false, reason: 'invalid port' };
  }
  const host = normalizeHost(hostPart);
  if (!host.ok) return host;
  return { ok: true, host: host.host, port, kind: host.kind };
}

/**
 * Parse the request target of a plain HTTP proxy request (absolute-form only).
 *
 * @param {string} target the request-line target, e.g. `http://example.com/a?b=c`
 * @returns {{ ok: true, host: string, port: number, kind: 'name' | 'ipv4' | 'ipv6', path: string }
 *   | { ok: false, status: 400, reason: string }}
 */
export function parseProxyRequestUrl(target) {
  if (typeof target !== 'string') return { ok: false, status: 400, reason: 'bad request target' };
  const m = /^http:\/\/([^/?#]*)([^#]*)$/i.exec(target);
  if (!m) {
    if (target.startsWith('/')) return { ok: false, status: 400, reason: 'proxy request expected' };
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
      return { ok: false, status: 400, reason: 'only http:// absolute-form is supported' };
    }
    return { ok: false, status: 400, reason: 'bad request target' };
  }
  const authority = /** @type {string} */ (m[1]);
  const rest = /** @type {string} */ (m[2]);
  const parsed = parseAuthority(authority, 80);
  if (!parsed.ok) return { ok: false, status: 400, reason: parsed.reason };
  const path = rest === '' ? '/' : rest.startsWith('?') ? `/${rest}` : rest;
  return { ok: true, host: parsed.host, port: parsed.port, kind: parsed.kind, path };
}

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

/**
 * @typedef {{ host: string, kind: 'name' | 'ipv4' | 'ipv6', port: number | null, wildcard: boolean,
 *   entry: string }} AllowRule
 */

/**
 * Parse one allowlist entry: `host`, `*.host`, `host:port`, `*.host:port`, `1.2.3.4`,
 * `[::1]`, `[::1]:8443`.
 * @param {string} entry
 * @returns {{ ok: true, rule: AllowRule } | { ok: false, reason: string }}
 */
export function compileAllowEntry(entry) {
  if (typeof entry !== 'string' || entry === '')
    return { ok: false, reason: 'must be a non-empty string' };
  let rest = entry;
  let wildcard = false;
  if (rest.startsWith('*.')) {
    wildcard = true;
    rest = rest.slice(2);
  }
  let hostPart = rest;
  let port = null;
  if (rest.startsWith('[')) {
    const end = rest.indexOf(']');
    if (end === -1) return { ok: false, reason: 'invalid host' };
    hostPart = rest.slice(0, end + 1);
    const tail = rest.slice(end + 1);
    if (tail !== '') {
      if (!tail.startsWith(':')) return { ok: false, reason: 'invalid host' };
      port = parsePort(tail.slice(1)) ?? null;
      if (port === null) return { ok: false, reason: 'invalid port' };
    }
  } else {
    const first = rest.indexOf(':');
    if (first !== -1) {
      if (rest.indexOf(':', first + 1) === -1) {
        hostPart = rest.slice(0, first);
        port = parsePort(rest.slice(first + 1)) ?? null;
        if (port === null) return { ok: false, reason: 'invalid port' };
      } else {
        hostPart = rest; // bare IPv6 without port
      }
    }
  }
  const host = normalizeHost(hostPart);
  if (!host.ok) return { ok: false, reason: host.reason };
  if (wildcard) {
    if (host.kind !== 'name') return { ok: false, reason: 'wildcard requires a DNS name' };
    if (!host.host.includes('.'))
      return { ok: false, reason: 'wildcard must have at least two labels' };
  }
  return { ok: true, rule: { host: host.host, kind: host.kind, port, wildcard, entry } };
}

/**
 * Compile allowlist entries. Throws on the first invalid entry (callers that need
 * error lists use `validateProxyConfig`).
 * @param {readonly string[]} entries
 * @returns {AllowRule[]}
 */
export function compileAllowlist(entries) {
  return entries.map((entry) => {
    const r = compileAllowEntry(entry);
    if (!r.ok) throw new Error(`invalid allow entry "${entry}": ${r.reason}`);
    return r.rule;
  });
}

/**
 * Match a destination against the allowlist.
 *
 * Semantics (contract): exact host or `*.suffix` (subdomains only, any depth, never
 * the apex); case-insensitive on the IDNA form; trailing dot ignored; entries without
 * port allow 80 and 443 only, entries with `:port` allow exactly that port; IP
 * literals only match an entry with the identical literal.
 *
 * @param {readonly string[] | readonly AllowRule[]} allow entries or compiled rules
 * @param {string} host destination host as received (any case, optional trailing dot)
 * @param {number} port destination port
 * @returns {{ allowed: true, host: string } | { allowed: false, reason: string }}
 */
export function matchAllowlist(allow, host, port) {
  const target = normalizeHost(host);
  if (!target.ok) return { allowed: false, reason: `invalid host: ${target.reason}` };
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    return { allowed: false, reason: 'invalid port' };
  const rules = allow.map((r) => {
    if (typeof r !== 'string') return r;
    const c = compileAllowEntry(r);
    return c.ok ? c.rule : undefined; // invalid entries never match
  });
  let hostMatched = false;
  for (const rule of rules) {
    if (!rule) continue;
    let hit;
    if (target.kind === 'name') {
      hit =
        rule.kind === 'name' &&
        (rule.wildcard ? target.host.endsWith(`.${rule.host}`) : target.host === rule.host);
    } else {
      hit = !rule.wildcard && rule.kind === target.kind && rule.host === target.host;
    }
    if (!hit) continue;
    hostMatched = true;
    const portOk = rule.port === null ? DEFAULT_PORTS.includes(port) : rule.port === port;
    if (portOk) return { allowed: true, host: target.host };
  }
  if (hostMatched) return { allowed: false, reason: 'port not allowed' };
  return {
    allowed: false,
    reason: target.kind === 'name' ? 'not in allowlist' : 'ip literal not allowed',
  };
}

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

const TOP_LEVEL_KEYS = new Set([
  'listen',
  'allow',
  'blockPrivate',
  'privateExceptions',
  'injections',
  'stateDir',
  'upstreamCaFile',
  'dnsOverrides',
  'maxConnections',
  'connectTimeoutMs',
  'idleTimeoutMs',
]);

const HEADER_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
// Headers the proxy itself controls (framing, routing, hop-by-hop). Injecting them
// would break message framing or the Host rewrite.
const FORBIDDEN_INJECT_HEADERS = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'proxy-authorization',
  'proxy-authenticate',
  'proxy-connection',
  'te',
  'trailer',
  'upgrade',
  'expect',
]);

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Strictly validate a parsed config object and apply defaults.
 *
 * Error messages name the offending key but NEVER echo values: the config can contain
 * secret header values.
 *
 * @param {unknown} input
 * @returns {{ ok: true, config: object } | { ok: false, errors: string[] }}
 */
export function validateProxyConfig(input) {
  /** @type {string[]} */
  const errors = [];
  if (!isObject(input)) return { ok: false, errors: ['config must be a JSON object'] };
  const cfg = /** @type {Record<string, unknown>} */ (input);
  for (const key of Object.keys(cfg))
    if (!TOP_LEVEL_KEYS.has(key)) errors.push(`unknown key "${key}"`);

  // listen
  const listen = { host: '0.0.0.0', port: 3128 };
  if (cfg.listen !== undefined) {
    if (!isObject(cfg.listen)) {
      errors.push('listen: must be an object');
    } else {
      const l = /** @type {Record<string, unknown>} */ (cfg.listen);
      for (const key of Object.keys(l))
        if (key !== 'host' && key !== 'port') errors.push(`listen: unknown key "${key}"`);
      if (l.host !== undefined) {
        if (
          typeof l.host !== 'string' ||
          l.host === '' ||
          l.host.length > 255 ||
          /\s/.test(l.host)
        ) {
          errors.push('listen.host: must be a non-empty string without whitespace');
        } else {
          listen.host = l.host;
        }
      }
      if (l.port !== undefined) {
        if (
          !Number.isInteger(l.port) ||
          /** @type {number} */ (l.port) < 0 ||
          /** @type {number} */ (l.port) > 65535
        ) {
          errors.push('listen.port: must be an integer 0..65535');
        } else {
          listen.port = /** @type {number} */ (l.port);
        }
      }
    }
  }

  // allow
  /** @type {string[]} */
  const allow = [];
  if (!Array.isArray(cfg.allow)) {
    errors.push('allow: required, must be an array of strings');
  } else if (cfg.allow.length > 2000) {
    errors.push('allow: too many entries (max 2000)');
  } else {
    cfg.allow.forEach((entry, i) => {
      const r = compileAllowEntry(entry);
      if (!r.ok) errors.push(`allow[${i}]: ${r.reason}`);
      else allow.push(entry);
    });
  }

  // blockPrivate
  let blockPrivate = true;
  if (cfg.blockPrivate !== undefined) {
    if (typeof cfg.blockPrivate !== 'boolean') errors.push('blockPrivate: must be a boolean');
    else blockPrivate = cfg.blockPrivate;
  }

  // privateExceptions
  /** @type {string[]} */
  const privateExceptions = [];
  if (cfg.privateExceptions !== undefined) {
    if (!Array.isArray(cfg.privateExceptions)) {
      errors.push('privateExceptions: must be an array of CIDR strings');
    } else {
      cfg.privateExceptions.forEach((c, i) => {
        if (typeof c !== 'string' || parseCidr(c) === undefined)
          errors.push(`privateExceptions[${i}]: invalid CIDR`);
        else privateExceptions.push(c);
      });
    }
  }

  // injections
  /** @type {{ host: string, header: string, value: string }[]} */
  const injections = [];
  if (cfg.injections !== undefined) {
    if (!Array.isArray(cfg.injections)) {
      errors.push('injections: must be an array');
    } else if (cfg.injections.length > 256) {
      errors.push('injections: too many entries (max 256)');
    } else {
      const seen = new Set();
      cfg.injections.forEach((item, i) => {
        if (!isObject(item)) {
          errors.push(`injections[${i}]: must be an object`);
          return;
        }
        const inj = /** @type {Record<string, unknown>} */ (item);
        for (const key of Object.keys(inj)) {
          if (key !== 'host' && key !== 'header' && key !== 'value')
            errors.push(`injections[${i}]: unknown key "${key}"`);
        }
        let ok = true;
        const host =
          typeof inj.host === 'string'
            ? normalizeHost(inj.host)
            : { ok: false, reason: 'must be a string' };
        if (
          !host.ok ||
          host.kind !== 'name' ||
          (typeof inj.host === 'string' && /[*:]/.test(inj.host))
        ) {
          errors.push(`injections[${i}].host: must be a plain DNS name (no wildcard, port or IP)`);
          ok = false;
        }
        if (
          typeof inj.header !== 'string' ||
          !HEADER_TOKEN.test(inj.header) ||
          inj.header.length > 128
        ) {
          errors.push(`injections[${i}].header: invalid header name`);
          ok = false;
        } else if (FORBIDDEN_INJECT_HEADERS.has(inj.header.toLowerCase())) {
          errors.push(`injections[${i}].header: header is controlled by the proxy`);
          ok = false;
        }
        if (
          typeof inj.value !== 'string' ||
          inj.value === '' ||
          inj.value.length > 8192 ||
          !/^[\t\x20-\x7e]+$/.test(inj.value)
        ) {
          errors.push(`injections[${i}].value: must be 1..8192 printable ASCII characters`);
          ok = false;
        }
        if (!ok) return;
        const key = `${/** @type {{host: string}} */ (host).host}\n${/** @type {string} */ (inj.header).toLowerCase()}`;
        if (seen.has(key)) {
          errors.push(`injections[${i}]: duplicate host/header combination`);
          return;
        }
        seen.add(key);
        injections.push({
          host: /** @type {{host: string}} */ (host).host,
          header: /** @type {string} */ (inj.header),
          value: /** @type {string} */ (inj.value),
        });
      });
    }
  }

  // optional strings
  const optionalString = (key) => {
    if (cfg[key] === undefined) return undefined;
    if (
      typeof cfg[key] !== 'string' ||
      cfg[key] === '' ||
      /** @type {string} */ (cfg[key]).includes('\0')
    ) {
      errors.push(`${key}: must be a non-empty string`);
      return undefined;
    }
    return /** @type {string} */ (cfg[key]);
  };
  const stateDir = optionalString('stateDir');
  const upstreamCaFile = optionalString('upstreamCaFile');

  // dnsOverrides (test only)
  /** @type {Record<string, string[]> | undefined} */
  let dnsOverrides;
  if (cfg.dnsOverrides !== undefined) {
    if (!isObject(cfg.dnsOverrides)) {
      errors.push('dnsOverrides: must be an object of host -> address[]');
    } else {
      dnsOverrides = {};
      for (const [name, addrs] of Object.entries(
        /** @type {Record<string, unknown>} */ (cfg.dnsOverrides),
      )) {
        const h = normalizeHost(name);
        if (!h.ok || h.kind !== 'name') {
          errors.push('dnsOverrides: invalid host key');
        } else if (
          !Array.isArray(addrs) ||
          addrs.length === 0 ||
          !addrs.every((a) => typeof a === 'string' && parseIp(a))
        ) {
          errors.push(`dnsOverrides.${name}: must be a non-empty array of IP literals`);
        } else {
          dnsOverrides[h.host] = addrs;
        }
      }
    }
  }

  // numeric tunables
  const intOption = (key, min, max) => {
    if (cfg[key] === undefined) return undefined;
    const v = cfg[key];
    if (
      !Number.isInteger(v) ||
      /** @type {number} */ (v) < min ||
      /** @type {number} */ (v) > max
    ) {
      errors.push(`${key}: must be an integer ${min}..${max}`);
      return undefined;
    }
    return /** @type {number} */ (v);
  };
  const maxConnections = intOption('maxConnections', 1, 65535);
  const connectTimeoutMs = intOption('connectTimeoutMs', 100, 600_000);
  const idleTimeoutMs = intOption('idleTimeoutMs', 100, 86_400_000);

  if (errors.length > 0) return { ok: false, errors };

  const config = { listen, allow, blockPrivate, privateExceptions, injections };
  if (stateDir !== undefined) config.stateDir = stateDir;
  if (upstreamCaFile !== undefined) config.upstreamCaFile = upstreamCaFile;
  if (dnsOverrides !== undefined) config.dnsOverrides = dnsOverrides;
  if (maxConnections !== undefined) config.maxConnections = maxConnections;
  if (connectTimeoutMs !== undefined) config.connectTimeoutMs = connectTimeoutMs;
  if (idleTimeoutMs !== undefined) config.idleTimeoutMs = idleTimeoutMs;
  return { ok: true, config };
}
