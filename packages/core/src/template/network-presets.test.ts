import { describe, expect, it } from 'vitest';
import { NETWORK_PRESETS, expandNetworkPresets, isNetworkPreset } from './network-presets.js';
import { DOMAIN_PATTERN_RE } from './schema.js';

describe('network presets', () => {
  it('every destination is a valid, lower-case domain pattern without wildcards', () => {
    for (const [name, domains] of Object.entries(NETWORK_PRESETS)) {
      expect(domains.length, name).toBeGreaterThan(0);
      for (const d of domains) {
        expect(DOMAIN_PATTERN_RE.test(d), `${name}: ${d}`).toBe(true);
        expect(d, name).toBe(d.toLowerCase());
        expect(d.startsWith('*'), `${name}: ${d}`).toBe(false);
      }
    }
  });

  it('knows the stack presets', () => {
    expect(isNetworkPreset('pub')).toBe(true);
    expect(isNetworkPreset('packagist')).toBe(true);
    expect(isNetworkPreset('nope')).toBe(false);
    expect(isNetworkPreset('toString')).toBe(false);
    expect(expandNetworkPresets(['pub'])).toContain('pub.dev');
    expect(expandNetworkPresets(['packagist'])).toEqual(
      expect.arrayContaining(['packagist.org', 'repo.packagist.org']),
    );
  });

  it('expands to a de-duplicated, sorted list and rejects unknown names', () => {
    const out = expandNetworkPresets(['packagist', 'github', 'pub', 'github']);
    expect(out).toEqual([...new Set(out)].sort());
    expect(() => expandNetworkPresets(['nope'])).toThrow(/unknown network preset "nope"/);
  });
});
