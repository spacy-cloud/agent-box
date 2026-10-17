import { describe, expect, it } from 'vitest';
import {
  blockedReason,
  compileAllowEntry,
  formatIp,
  isBlockedAddress,
  matchAllowlist,
  normalizeHost,
  parseAuthority,
  parseCidr,
  parseIp,
  parseProxyRequestUrl,
  validateProxyConfig,
} from './index.js';

describe('normalizeHost', () => {
  const ok: [string, string, string][] = [
    ['example.com', 'example.com', 'name'],
    ['EXAMPLE.Com', 'example.com', 'name'],
    ['example.com.', 'example.com', 'name'],
    ['localhost', 'localhost', 'name'],
    ['bücher.de', 'xn--bcher-kva.de', 'name'],
    ['BÜCHER.DE.', 'xn--bcher-kva.de', 'name'],
    ['xn--bcher-kva.de', 'xn--bcher-kva.de', 'name'],
    ['ＥＸＡＭＰＬＥ。ｃｏｍ', 'example.com', 'name'],
    ['1.2.3.4', '1.2.3.4', 'ipv4'],
    ['[::1]', '::1', 'ipv6'],
    ['[2001:DB8:0:0:0:0:0:1]', '2001:db8::1', 'ipv6'],
    ['::ffff:127.0.0.1', '::ffff:7f00:1', 'ipv6'],
    ['a-b.c-d.example', 'a-b.c-d.example', 'name'],
  ];
  it.each(ok)('accepts %s', (raw, host, kind) => {
    expect(normalizeHost(raw)).toEqual({ ok: true, host, kind });
  });

  const bad = [
    '',
    '.',
    '..',
    'a..b',
    '-a.com',
    'a-.com',
    'a b.com',
    'a\tb.com',
    'a\r\nb.com',
    'user@example.com',
    'user:pw@example.com',
    'example.com/path',
    'example.com?x',
    'example.com#x',
    'exa%6dple.com',
    'a_b.com',
    '127.1',
    '127.0.1',
    '0x7f.0.0.1',
    '0x7f000001',
    '2130706433',
    '017700000001',
    '010.1.1.1',
    '1.2.3.256',
    '1.2.3.4.5',
    'example.0x1',
    'example.123',
    '[::1',
    '::1]',
    '[fe80::1%eth0]',
    '[1:2:3:4:5:6:7:8:9]',
    '[:::]',
    `${'a'.repeat(64)}.com`,
    `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.com`,
  ];
  it.each(bad)('rejects %j', (raw) => {
    expect(normalizeHost(raw).ok).toBe(false);
  });

  it('rejects hosts over 253 characters but accepts exactly 253', () => {
    const label = 'a'.repeat(61);
    const h253 = `${label}.${label}.${label}.${label}.${'b'.repeat(253 - 4 * 62)}`;
    expect(h253).toHaveLength(253);
    expect(normalizeHost(h253).ok).toBe(true);
    expect(normalizeHost(`${h253}x`).ok).toBe(false);
  });
});

describe('parseAuthority / parseProxyRequestUrl', () => {
  it('parses CONNECT authorities', () => {
    expect(parseAuthority('Example.com:443')).toEqual({
      ok: true,
      host: 'example.com',
      port: 443,
      kind: 'name',
    });
    expect(parseAuthority('[::1]:8443')).toEqual({
      ok: true,
      host: '::1',
      port: 8443,
      kind: 'ipv6',
    });
    expect(parseAuthority('1.2.3.4:80')).toEqual({
      ok: true,
      host: '1.2.3.4',
      port: 80,
      kind: 'ipv4',
    });
    expect(parseAuthority('example.com', 80)).toEqual({
      ok: true,
      host: 'example.com',
      port: 80,
      kind: 'name',
    });
  });
  it.each([
    'example.com',
    'example.com:',
    'example.com:0',
    'example.com:65536',
    'example.com:0443',
    'example.com:-1',
    'example.com:44a',
    'a:b:c',
    'u@example.com:443',
    '::1:443',
    ':443',
    '[::1]x:443',
  ])('rejects authority %j', (a) => {
    expect(parseAuthority(a).ok).toBe(false);
  });

  it('parses absolute-form http targets', () => {
    expect(parseProxyRequestUrl('http://Example.com/a/b?c=d')).toEqual({
      ok: true,
      host: 'example.com',
      port: 80,
      kind: 'name',
      path: '/a/b?c=d',
    });
    expect(parseProxyRequestUrl('HTTP://example.com:8080')).toMatchObject({
      ok: true,
      port: 8080,
      path: '/',
    });
    expect(parseProxyRequestUrl('http://example.com?x=1')).toMatchObject({
      ok: true,
      path: '/?x=1',
    });
    expect(parseProxyRequestUrl('http://[::1]:81/x')).toMatchObject({
      ok: true,
      host: '::1',
      port: 81,
    });
  });
  it.each([
    '/path',
    '*',
    'https://example.com/',
    'ftp://example.com/',
    'example.com/',
    'http://u:p@example.com/',
    'http://example.com#frag',
    'http:///x',
    'http://exa mple.com/',
    'http://127.1/',
  ])('rejects target %j', (t) => {
    expect(parseProxyRequestUrl(t).ok).toBe(false);
  });
});

describe('matchAllowlist', () => {
  type Row = [name: string, allow: string[], host: string, port: number, allowed: boolean];
  const table: Row[] = [
    ['exact', ['example.com'], 'example.com', 443, true],
    ['exact default port 80', ['example.com'], 'example.com', 80, true],
    ['exact non-default port denied', ['example.com'], 'example.com', 8443, false],
    ['case-insensitive host', ['example.com'], 'EXAMPLE.com', 443, true],
    ['case-insensitive entry', ['Example.COM'], 'example.com', 443, true],
    ['trailing dot on host', ['example.com'], 'example.com.', 443, true],
    ['trailing dot on entry', ['example.com.'], 'example.com', 443, true],
    ['other host', ['example.com'], 'evil.com', 443, false],
    ['suffix is not a match', ['example.com'], 'notexample.com', 443, false],
    ['prefix attack', ['example.com'], 'example.com.evil.com', 443, false],
    ['subdomain of exact entry denied', ['example.com'], 'www.example.com', 443, false],
    ['wildcard subdomain', ['*.example.org'], 'a.example.org', 443, true],
    ['wildcard deep subdomain', ['*.example.org'], 'a.b.example.org', 443, true],
    ['wildcard apex denied', ['*.example.org'], 'example.org', 443, false],
    ['wildcard no dot boundary', ['*.example.org'], 'badexample.org', 443, false],
    ['wildcard + case + trailing dot', ['*.Example.ORG'], 'A.EXAMPLE.org.', 443, true],
    ['wildcard + apex both listed', ['*.example.org', 'example.org'], 'example.org', 443, true],
    ['wildcard with port', ['*.example.org:8443'], 'a.example.org', 8443, true],
    ['wildcard with port, wrong port', ['*.example.org:8443'], 'a.example.org', 443, false],
    ['explicit port', ['example.com:8443'], 'example.com', 8443, true],
    ['explicit port excludes defaults', ['example.com:8443'], 'example.com', 443, false],
    ['explicit port 443 only', ['example.com:443'], 'example.com', 80, false],
    ['both ports via two entries', ['example.com:8443', 'example.com'], 'example.com', 443, true],
    ['IDNA unicode host vs punycode entry', ['xn--bcher-kva.de'], 'bücher.de', 443, true],
    ['IDNA punycode host vs unicode entry', ['bücher.de'], 'xn--bcher-kva.de', 443, true],
    ['IDNA wildcard', ['*.bücher.de'], 'shop.xn--bcher-kva.de', 443, true],
    ['IDNA uppercase', ['BÜCHER.de'], 'bücher.DE', 443, true],
    ['fullwidth lookalike normalises', ['example.com'], 'ｅｘａｍｐｌｅ。ｃｏｍ', 443, true],
    ['IP literal not listed', ['example.com'], '93.184.216.34', 443, false],
    ['IP literal listed', ['93.184.216.34'], '93.184.216.34', 443, true],
    ['IP literal listed with port', ['93.184.216.34:8443'], '93.184.216.34', 8443, true],
    ['different IP literal', ['93.184.216.34'], '93.184.216.35', 443, false],
    ['IPv6 literal listed (brackets)', ['[2001:db8::1]'], '2001:db8::1', 443, true],
    ['IPv6 literal listed (bare)', ['2001:db8::1'], '[2001:0db8:0:0:0:0:0:1]', 443, true],
    ['IPv6 literal with port', ['[2001:db8::1]:8443'], '2001:db8::1', 8443, true],
    ['IP literal never matches wildcard', ['*.example.com'], '1.2.3.4', 443, false],
    ['hex IP not normalised into a match', ['127.0.0.1'], '0x7f.0.0.1', 80, false],
    ['short IP not normalised into a match', ['127.0.0.1'], '127.1', 80, false],
    ['decimal IP not normalised into a match', ['127.0.0.1'], '2130706433', 80, false],
    ['userinfo smuggling', ['example.com'], 'example.com@evil.com', 443, false],
    ['userinfo smuggling (reverse)', ['evil.com'], 'example.com@evil.com', 443, false],
    ['percent-encoded dot', ['example.com'], 'example%2ecom', 443, false],
    ['backslash trick', ['example.com'], 'evil.com\\@example.com', 443, false],
    ['overlong host', ['example.com'], `${'a'.repeat(250)}.example.com`, 443, false],
    ['empty allowlist', [], 'example.com', 443, false],
    ['invalid port', ['example.com'], 'example.com', 0, false],
  ];
  it.each(table)('%s', (_name, allow, host, port, allowed) => {
    expect(matchAllowlist(allow, host, port).allowed).toBe(allowed);
  });

  it('reports a reason', () => {
    expect(matchAllowlist(['example.com'], 'evil.com', 443)).toEqual({
      allowed: false,
      reason: 'not in allowlist',
    });
    expect(matchAllowlist(['example.com'], 'example.com', 22)).toEqual({
      allowed: false,
      reason: 'port not allowed',
    });
    expect(matchAllowlist(['example.com'], '1.2.3.4', 443)).toEqual({
      allowed: false,
      reason: 'ip literal not allowed',
    });
    expect(matchAllowlist(['example.com'], 'a@b', 443).allowed).toBe(false);
  });

  it('returns the normalised host on allow', () => {
    expect(matchAllowlist(['*.example.org'], 'WWW.Example.ORG.', 443)).toEqual({
      allowed: true,
      host: 'www.example.org',
    });
  });

  it('compileAllowEntry validates entries', () => {
    for (const entry of [
      '',
      '*',
      '*.com',
      '*.1.2.3.4',
      '*.[::1]',
      'a b',
      'example.com:0',
      'example.com:99999',
      '[::1',
      'ex*.com',
      '**.example.com',
      'example.com/x',
      'user@example.com',
    ]) {
      expect(compileAllowEntry(entry).ok, entry).toBe(false);
    }
    expect(compileAllowEntry('*.co.uk').ok).toBe(true);
  });
});

describe('isBlockedAddress', () => {
  const blocked = [
    // IPv4 ranges (and their edges)
    '0.0.0.0',
    '0.255.255.255',
    '10.0.0.1',
    '10.255.255.255',
    '100.64.0.0',
    '100.127.255.255',
    '127.0.0.1',
    '127.255.255.254',
    '169.254.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.1',
    '192.168.0.1',
    '192.168.255.255',
    '198.18.0.1',
    '198.19.255.255',
    '224.0.0.1',
    '239.255.255.255',
    '240.0.0.1',
    '255.255.255.255',
    // IPv6
    '::',
    '::1',
    'fc00::1',
    'fd12:3456::1',
    'fdff:ffff::1',
    'fe80::1',
    'febf::1',
    'fec0::1',
    'ff02::1',
    'ff00::',
    // IPv4-mapped (dotted + hex forms, mixed case)
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::FFFF:7F00:0001',
    '0:0:0:0:0:ffff:127.0.0.1',
    '::ffff:10.1.2.3',
    '::ffff:169.254.169.254',
    '::ffff:a9fe:a9fe',
    '::ffff:192.168.1.1',
    '::ffff:0.0.0.0',
    '::ffff:100.64.0.1',
    // IPv4-translated (SIIT)
    '::ffff:0:127.0.0.1',
    '::ffff:0:a00:1',
    // IPv4-compatible (deprecated): blocked as a whole
    '::127.0.0.1',
    '::7f00:1',
    '::10.0.0.1',
    '::8.8.8.8',
    '::808:808',
    // NAT64 well-known prefix embedding private v4
    '64:ff9b::7f00:1',
    '64:ff9b::127.0.0.1',
    '64:ff9b::a9fe:a9fe',
    '64:ff9b::192.168.0.1',
    '64:ff9b::a00:1',
    // local-use NAT64
    '64:ff9b:1::1',
    '64:ff9b:1:ffff::1',
    // 6to4 embedding private v4
    '2002:7f00:1::',
    '2002:7f00:1::1',
    '2002:a00:1::1',
    '2002:a9fe:a9fe::1',
    '2002:c0a8:101::1',
    '2002:ac10:1::1',
    // Teredo
    '2001::',
    '2001:0:4136:e378:8000:63bf:3fff:fdd2',
    '2001:0:ffff:ffff:ffff:ffff:ffff:ffff',
    // unparseable -> fail closed
    'not-an-ip',
    '',
    '1.2.3',
    '1.2.3.4.5',
    '256.1.1.1',
    '127.1',
    '::1%eth0',
  ];
  it.each(blocked)('blocks %j', (addr) => {
    expect(isBlockedAddress(addr), blockedReason(addr) ?? 'allowed').toBe(true);
  });

  const allowed = [
    '1.1.1.1',
    '8.8.8.8',
    '93.184.216.34',
    '100.63.255.255',
    '100.128.0.0',
    '126.255.255.255',
    '128.0.0.1',
    '169.253.255.255',
    '169.255.0.0',
    '172.15.255.255',
    '172.32.0.0',
    '192.0.1.1',
    '192.167.255.255',
    '192.169.0.0',
    '198.17.255.255',
    '198.20.0.0',
    '223.255.255.255',
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
    '2a00:1450:4001::200e',
    '2001:db9::1',
    '2001:1::1',
    '2000::1',
    'fbff::1',
    'fe00::1',
    // public v4 embedded in v6 forms is routed like that v4
    '::ffff:8.8.8.8',
    '::ffff:808:808',
    '64:ff9b::808:808',
    '64:ff9b::8.8.8.8',
    '2002:808:808::1',
    '2002:5db8:d822::1',
  ];
  it.each(allowed)('allows %j', (addr) => {
    expect(isBlockedAddress(addr), blockedReason(addr) ?? '').toBe(false);
  });

  describe('privateExceptions', () => {
    it('re-allows an exact host route', () => {
      expect(isBlockedAddress('127.0.0.1', ['127.0.0.1/32'])).toBe(false);
      expect(isBlockedAddress('127.0.0.2', ['127.0.0.1/32'])).toBe(true);
    });
    it('re-allows a bare address', () => {
      expect(isBlockedAddress('10.0.0.5', ['10.0.0.5'])).toBe(false);
    });
    it('re-allows a range', () => {
      expect(isBlockedAddress('192.168.1.50', ['192.168.1.0/24'])).toBe(false);
      expect(isBlockedAddress('192.168.2.50', ['192.168.1.0/24'])).toBe(true);
      expect(isBlockedAddress('10.1.2.3', ['10.0.0.0/8'])).toBe(false);
    });
    it('does not leak to unrelated blocked ranges', () => {
      expect(isBlockedAddress('169.254.169.254', ['10.0.0.0/8', '192.168.0.0/16'])).toBe(true);
    });
    it('applies to v4-in-v6 forms through the embedded address', () => {
      expect(isBlockedAddress('::ffff:10.1.2.3', ['10.1.2.0/24'])).toBe(false);
      expect(isBlockedAddress('::ffff:10.1.3.3', ['10.1.2.0/24'])).toBe(true);
      expect(isBlockedAddress('64:ff9b::a01:203', ['10.1.2.0/24'])).toBe(false);
      expect(isBlockedAddress('2002:a01:203::1', ['10.1.2.0/24'])).toBe(false);
    });
    it('IPv6 exceptions', () => {
      expect(isBlockedAddress('::1', ['::1/128'])).toBe(false);
      expect(isBlockedAddress('fd00::5', ['fd00::/8'])).toBe(false);
      expect(isBlockedAddress('fd00::5', ['fe80::/10'])).toBe(true);
    });
    it('an IPv4 exception does not cover native IPv6 addresses', () => {
      expect(isBlockedAddress('::1', ['127.0.0.0/8'])).toBe(true);
    });
    it('ignores invalid exception entries (never widens)', () => {
      expect(isBlockedAddress('10.0.0.1', ['garbage', '10.0.0.0/33', '::/129'])).toBe(true);
    });
  });
});

describe('ip + cidr helpers', () => {
  it('formats canonical IPv6 (RFC 5952)', () => {
    const fmt = (s: string) => formatIp(parseIp(s)!);
    expect(fmt('2001:0db8:0000:0000:0000:0000:0000:0001')).toBe('2001:db8::1');
    expect(fmt('0:0:0:0:0:0:0:0')).toBe('::');
    expect(fmt('0:0:0:0:0:0:0:1')).toBe('::1');
    expect(fmt('1:0:0:2:0:0:0:3')).toBe('1:0:0:2::3');
    expect(fmt('1:0:2:3:4:5:6:7')).toBe('1:0:2:3:4:5:6:7');
    expect(fmt('::ffff:1.2.3.4')).toBe('::ffff:102:304');
    expect(fmt('1.2.3.4')).toBe('1.2.3.4');
  });
  it('parses CIDRs and masks host bits', () => {
    expect(parseCidr('10.1.2.3/8')).toEqual({ family: 4, base: 10n << 24n, prefix: 8 });
    expect(parseCidr('0.0.0.0/0')).toEqual({ family: 4, base: 0n, prefix: 0 });
    expect(parseCidr('::1')).toEqual({ family: 6, base: 1n, prefix: 128 });
    for (const bad of [
      '10.0.0.0/33',
      '::/129',
      '10.0.0.0/',
      '10.0.0.0/-1',
      '10.0.0.0/08',
      '10.0.0/8',
      'x/8',
      '10.0.0.0/8/8',
    ]) {
      expect(parseCidr(bad), bad).toBeUndefined();
    }
  });
  it('parseIp rejects ambiguous forms', () => {
    for (const bad of [
      '127.1',
      '0177.0.0.1',
      '1.2.3',
      '::g',
      '1::2::3',
      '12345::',
      ':1',
      '1:',
      '::1.2.3',
      'fe80::1%1',
    ]) {
      expect(parseIp(bad), bad).toBeUndefined();
    }
  });
});

describe('validateProxyConfig', () => {
  const minimal = { allow: ['example.com'] };

  it('applies defaults', () => {
    const r = validateProxyConfig(minimal);
    expect(r).toEqual({
      ok: true,
      config: {
        listen: { host: '0.0.0.0', port: 3128 },
        allow: ['example.com'],
        blockPrivate: true,
        privateExceptions: [],
        injections: [],
      },
    });
  });

  it('accepts the contract example', () => {
    const r = validateProxyConfig({
      listen: { host: '0.0.0.0', port: 3128 },
      allow: ['registry.npmjs.org', '*.githubusercontent.com'],
      blockPrivate: true,
      privateExceptions: [],
      injections: [{ host: 'github.com', header: 'Authorization', value: 'Basic abc=' }],
    });
    expect(r.ok).toBe(true);
  });

  const invalid: [string, unknown][] = [
    ['not an object', 'x'],
    ['array', []],
    ['null', null],
    ['missing allow', {}],
    ['allow not array', { allow: 'example.com' }],
    ['bad allow entry', { allow: ['*.com'] }],
    ['non-string allow entry', { allow: [1] }],
    ['unknown key', { allow: [], extra: true }],
    ['unknown listen key', { allow: [], listen: { hots: 'x' } }],
    ['bad port', { allow: [], listen: { port: 70000 } }],
    ['port string', { allow: [], listen: { port: '3128' } }],
    ['blockPrivate not boolean', { allow: [], blockPrivate: 'yes' }],
    ['bad CIDR', { allow: [], privateExceptions: ['10.0.0.0/40'] }],
    ['injection missing fields', { allow: [], injections: [{ host: 'a.com' }] }],
    [
      'injection wildcard host',
      { allow: [], injections: [{ host: '*.a.com', header: 'X', value: 'y' }] },
    ],
    [
      'injection ip host',
      { allow: [], injections: [{ host: '1.2.3.4', header: 'X', value: 'y' }] },
    ],
    [
      'injection host with port',
      { allow: [], injections: [{ host: 'a.com:443', header: 'X', value: 'y' }] },
    ],
    [
      'injection bad header name',
      { allow: [], injections: [{ host: 'a.com', header: 'X Y', value: 'y' }] },
    ],
    [
      'injection CRLF header name',
      { allow: [], injections: [{ host: 'a.com', header: 'X\r\nY', value: 'y' }] },
    ],
    [
      'injection CRLF value',
      { allow: [], injections: [{ host: 'a.com', header: 'X', value: 'y\r\nZ: 1' }] },
    ],
    [
      'injection NUL value',
      { allow: [], injections: [{ host: 'a.com', header: 'X', value: 'y\0' }] },
    ],
    [
      'injection non-ASCII value',
      { allow: [], injections: [{ host: 'a.com', header: 'X', value: 'ü' }] },
    ],
    [
      'injection empty value',
      { allow: [], injections: [{ host: 'a.com', header: 'X', value: '' }] },
    ],
    [
      'injection host header',
      { allow: [], injections: [{ host: 'a.com', header: 'Host', value: 'y' }] },
    ],
    [
      'injection content-length',
      { allow: [], injections: [{ host: 'a.com', header: 'content-length', value: '1' }] },
    ],
    [
      'injection duplicate',
      {
        allow: [],
        injections: [
          { host: 'a.com', header: 'X', value: '1' },
          { host: 'A.com.', header: 'x', value: '2' },
        ],
      },
    ],
    [
      'injection unknown key',
      { allow: [], injections: [{ host: 'a.com', header: 'X', value: '1', extra: 1 }] },
    ],
    ['bad dnsOverrides', { allow: [], dnsOverrides: { 'a.com': ['not-an-ip'] } }],
    ['maxConnections zero', { allow: [], maxConnections: 0 }],
    ['timeout float', { allow: [], idleTimeoutMs: 1.5 }],
  ];
  it.each(invalid)('rejects: %s', (_name, input) => {
    expect(validateProxyConfig(input).ok).toBe(false);
  });

  it('normalises injection hosts', () => {
    const r = validateProxyConfig({
      allow: [],
      injections: [{ host: 'GitHub.COM.', header: 'Authorization', value: 'x' }],
    });
    expect(r.ok && r.config.injections[0]?.host).toBe('github.com');
  });

  it('never echoes secret values in errors', () => {
    const secret = 'TOPSECRET-VALUE-123';
    const r = validateProxyConfig({
      allow: [],
      bogus: secret,
      injections: [{ host: '*.bad', header: 'Bad Header', value: `${secret}\r\n`, extra: secret }],
    });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(secret);
  });
});
