import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import de from '../../src/renderer/i18n/de.json';
import en from '../../src/renderer/i18n/en.json';
import { translate } from '../../src/renderer/i18n';

const SRC = join(import.meta.dirname, '../../src');

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(f)) out.push(p);
  }
  return out;
}

describe('i18n catalogs', () => {
  it('German and English define exactly the same keys, all non-empty', () => {
    expect(Object.keys(de).sort()).toEqual(Object.keys(en).sort());
    for (const [k, v] of Object.entries({ ...de, ...en })) expect(v.trim(), k).not.toBe('');
  });

  it('placeholders match between languages', () => {
    const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const k of Object.keys(de))
      expect(ph((en as Record<string, string>)[k]!), k).toEqual(
        ph((de as Record<string, string>)[k]!),
      );
  });

  it('every literal key used with t() / mt() exists, and dynamic key prefixes have entries', () => {
    const keys = new Set(Object.keys(de));
    const files = [...walk(join(SRC, 'renderer')), ...walk(join(SRC, 'main'))];
    const missing: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/\bt\(\s*'([a-z][A-Za-z0-9_.]*)'/g)) {
        const k = m[1]!;
        if (!keys.has(k) && !keys.has(k + '_one')) missing.push(`${f}: ${k}`);
      }
      for (const m of text.matchAll(/\bmt\([^,]+,\s*'([a-z][A-Za-z0-9_.]*)'/g)) {
        if (!keys.has(m[1]!)) missing.push(`${f}: ${m[1]}`);
      }
      for (const m of text.matchAll(/\bt\(\s*`([a-z][A-Za-z0-9_.]*)\.\$\{/g)) {
        const prefix = m[1]! + '.';
        if (![...keys].some((k) => k.startsWith(prefix))) missing.push(`${f}: ${prefix}*`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('has an entry for every value of the enumerations that are rendered through dynamic keys', async () => {
    const c = await import('../../src/shared/constants');
    const keys = new Set(Object.keys(de));
    for (const s of c.SANDBOX_STATES) expect(keys.has(`state.${s}`), s).toBe(true);
    for (const s of c.ISOLATION_LEVELS) expect(keys.has(`isolation.${s}`), s).toBe(true);
    for (const s of c.NETWORK_MODES) expect(keys.has(`network.${s}`), s).toBe(true);
    for (const s of c.WORKSPACE_MODES) expect(keys.has(`workspace.${s}`), s).toBe(true);
    for (const s of c.AUDIT_DECISIONS) expect(keys.has(`decision.${s}`), s).toBe(true);
    for (const s of c.APPROVAL_STATUSES) expect(keys.has(`approvals.status.${s}`), s).toBe(true);
  });

  it('translate substitutes params, picks plural forms and falls back to German', () => {
    expect(translate('de', 'approvals.pending', { count: 1 })).toBe('1 offene Anfrage');
    expect(translate('de', 'approvals.pending', { count: 3 })).toBe('3 offene Anfragen');
    expect(translate('en', 'approvals.pending', { count: 1 })).toBe('1 pending request');
    expect(translate('en', 'sandboxes.removed', { name: 'x' })).toBe('x deleted');
    expect(translate('en', 'no.such.key')).toBe('no.such.key');
  });
});
