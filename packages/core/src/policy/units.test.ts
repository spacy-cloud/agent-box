import { describe, expect, it } from 'vitest';
import { domainCovered, normalizeDomainPattern } from './domains.js';
import {
  formatDuration,
  formatSize,
  parseDuration,
  parseSize,
  tryParseDuration,
  tryParseSize,
} from './units.js';

describe('units', () => {
  it('parses sizes', () => {
    expect(parseSize('512m')).toBe(512 * 1024 ** 2);
    expect(parseSize('8g')).toBe(8 * 1024 ** 3);
    expect(parseSize('8GiB')).toBe(8 * 1024 ** 3);
    expect(parseSize('1.5g')).toBe(1.5 * 1024 ** 3);
    expect(parseSize(4096)).toBe(4096);
    expect(parseSize('100')).toBe(100);
  });
  it.each(['', 'g', '-1g', '8x', '0', '8 gigs', '1e3g'])('rejects size %j', (s) => {
    expect(tryParseSize(s)).toBeUndefined();
    expect(() => parseSize(s)).toThrow(RangeError);
  });
  it('parses durations', () => {
    expect(parseDuration('4h')).toBe(4 * 3_600_000);
    expect(parseDuration('30m')).toBe(1_800_000);
    expect(parseDuration('1h30m')).toBe(5_400_000);
    expect(parseDuration('2d')).toBe(172_800_000);
    expect(parseDuration('500ms')).toBe(500);
  });
  it.each(['', 'h', '4', '4x', '-1h', '0h', '1h 30m x', 'abc'])('rejects duration %j', (s) => {
    expect(tryParseDuration(s)).toBeUndefined();
  });
  it('formats', () => {
    expect(formatSize(8 * 1024 ** 3)).toBe('8g');
    expect(formatSize(512 * 1024 ** 2)).toBe('512m');
    expect(formatSize(1000)).toBe('1000b');
    expect(formatDuration(4 * 3_600_000)).toBe('4h');
    expect(formatDuration(90 * 60_000)).toBe('90m');
    expect(formatDuration(1500)).toBe('1500ms');
  });
});

describe('domain patterns', () => {
  it('normalizes', () => {
    expect(normalizeDomainPattern(' PyPI.org. ')).toBe('pypi.org');
    expect(normalizeDomainPattern('*.Example.ORG')).toBe('*.example.org');
    expect(normalizeDomainPattern('m\u00fcnchen.de')).toBe('xn--mnchen-3ya.de');
  });
  it.each([
    '',
    '*',
    '*.com',
    'com',
    'localhost',
    'a b.org',
    'http://x.org',
    'x.org/path',
    'x.org:443',
    'a*.org',
    '*.*.org',
    '-a.org',
    'a..org',
  ])('rejects %j', (s) => {
    expect(normalizeDomainPattern(s)).toBeUndefined();
  });
  it('covers exact, wildcard and nested wildcard', () => {
    expect(domainCovered('pypi.org', ['pypi.org'])).toBe(true);
    expect(domainCovered('evil-pypi.org', ['pypi.org'])).toBe(false);
    expect(domainCovered('x.pypi.org', ['pypi.org'])).toBe(false);
    expect(domainCovered('x.cdn.example.org', ['*.cdn.example.org'])).toBe(true);
    expect(domainCovered('cdn.example.org', ['*.cdn.example.org'])).toBe(false);
    expect(domainCovered('evilcdn.example.org', ['*.cdn.example.org'])).toBe(false);
    expect(domainCovered('*.a.cdn.example.org', ['*.cdn.example.org'])).toBe(true);
    expect(domainCovered('*.cdn.example.org', ['cdn.example.org'])).toBe(false);
    expect(domainCovered('*.example.org', ['*.cdn.example.org'])).toBe(false);
    expect(domainCovered('anything.org', ['*'])).toBe(true);
    expect(domainCovered('anything.org', [])).toBe(false);
  });
});
