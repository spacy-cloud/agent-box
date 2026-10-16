import { describe, expect, it } from 'vitest';
import { applyConfig, configPath, defaultConfig, loadConfig } from '../plugin/lib/config.mjs';
import {
  fitNotification,
  formatDuration,
  isTypableLine,
  sanitizeInline,
  shellLine,
  shellQuote,
} from '../plugin/lib/format.mjs';
import { MESSAGES, createTranslator, detectLanguage } from '../plugin/lib/i18n.mjs';
import {
  createWorktreeCache,
  findLinked,
  requestIdFor,
  sandboxNameFor,
  slugify,
} from '../plugin/lib/worktree.mjs';

describe('format', () => {
  it('sanitizeInline removes control, bidi and zero-width characters and bounds the length', () => {
    const esc = String.fromCharCode(0x1b);
    const rlo = String.fromCharCode(0x202e);
    const zwsp = String.fromCharCode(0x200b);
    expect(sanitizeInline(`a${esc}[31mb${rlo}c${zwsp}d\ne\tf`)).toBe('a [31mb c d e f');
    expect(sanitizeInline('x'.repeat(500), 10)).toBe('xxxxxxxxx…');
    expect(sanitizeInline(undefined)).toBe('');
  });

  it('fitNotification respects Orca limits (title 120, body 1000)', () => {
    const n = fitNotification('t'.repeat(300), ['b'.repeat(2000)]);
    expect(n.title.length).toBeLessThanOrEqual(120);
    expect(n.body.length).toBe(1000);
  });

  it('shellQuote quotes like a POSIX shell and refuses line breaks', () => {
    expect(shellQuote('abc-1.2/x')).toBe('abc-1.2/x');
    expect(shellQuote('a b')).toBe("'a b'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote('$(id)')).toBe("'$(id)'");
    expect(shellQuote('')).toBe("''");
    expect(() => shellQuote('a\nb')).toThrow();
    expect(() => shellQuote('a\rb')).toThrow();
    expect(shellLine(['abox', 'create', 'x y', { raw: '"$PWD"' }])).toBe(
      `abox create 'x y' "$PWD"`,
    );
  });

  it('isTypableLine allows exactly one printable line', () => {
    expect(isTypableLine('abox ls')).toBe(true);
    for (const bad of [
      '',
      'a\nb',
      'a\rb',
      `a${String.fromCharCode(0x1b)}[2J`,
      'a\u0000b',
      'x'.repeat(5000),
      `a${String.fromCharCode(0x2028)}b`,
    ]) {
      expect(isTypableLine(bad)).toBe(false);
    }
  });

  it('formatDuration', () => {
    expect(formatDuration(null)).toBe('?');
    expect(formatDuration(0)).toBe('0m');
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(41 * 60_000)).toBe('41m');
    expect(formatDuration(3 * 3_600_000 + 5 * 60_000)).toBe('3h 05m');
    expect(formatDuration(50 * 3_600_000)).toBe('2d 2h');
  });
});

describe('i18n', () => {
  it('has the same keys in German and English and the same placeholders', () => {
    expect(Object.keys(MESSAGES.de).sort()).toEqual(Object.keys(MESSAGES.en).sort());
    const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of Object.keys(MESSAGES.en)) {
      expect(placeholders(MESSAGES.de[key]!), key).toEqual(placeholders(MESSAGES.en[key]!));
    }
  });

  it('detects the language from the variables Orca passes to workers', () => {
    expect(detectLanguage('auto', { LANG: 'de_DE.UTF-8' })).toBe('de');
    expect(detectLanguage('auto', { LC_ALL: 'de_AT.UTF-8', LANG: 'en_US.UTF-8' })).toBe('de');
    expect(detectLanguage('auto', { LANG: 'en_US.UTF-8' })).toBe('en');
    expect(detectLanguage('auto', {})).toBe('en');
    expect(detectLanguage('en', { LANG: 'de_DE.UTF-8' })).toBe('en');
    expect(detectLanguage('de', {})).toBe('de');
  });

  it('interpolates, keeps unknown placeholders and falls back to the key', () => {
    const t = createTranslator('de');
    expect(t('list.title', { count: 2, running: 1 })).toBe('Sandboxes: 2 (1 laufen)');
    expect(t('list.title')).toBe('Sandboxes: {count} ({running} laufen)');
    expect(t('does.not.exist')).toBe('does.not.exist');
  });
});

describe('config', () => {
  it('uses XDG_CONFIG_HOME when absolute, else ~/.config', () => {
    expect(configPath({ XDG_CONFIG_HOME: '/x/cfg', HOME: '/h' })).toBe(
      '/x/cfg/abox/orca-plugin.json',
    );
    expect(configPath({ XDG_CONFIG_HOME: 'relative', HOME: '/h' })).toBe(
      '/h/.config/abox/orca-plugin.json',
    );
    expect(configPath({ HOME: '/h' })).toBe('/h/.config/abox/orca-plugin.json');
  });

  it('accepts valid values and rejects the dangerous ones with warnings', () => {
    const good = applyConfig({
      aboxPath: '/opt/abox/bin/abox',
      defaultTemplate: 'node',
      ttl: '2h',
      timeoutMs: 10_000,
      language: 'de',
      mcp: { url: 'http://127.0.0.1:8765/mcp', tokenEnv: 'MY_TOKEN' },
    });
    expect(good.warnings).toEqual([]);
    expect(good.config).toMatchObject({
      aboxPath: '/opt/abox/bin/abox',
      defaultTemplate: 'node',
      ttl: '2h',
      timeoutMs: 10_000,
      language: 'de',
    });
    expect(good.config.mcp).toEqual({ url: 'http://127.0.0.1:8765/mcp', tokenEnv: 'MY_TOKEN' });

    const bad = applyConfig({
      aboxPath: './abox; rm -rf /',
      defaultTemplate: '--yes',
      ttl: '2h; ls',
      timeoutMs: 600_000,
      language: 'fr',
      mcp: { url: 'https://evil.example/mcp', tokenEnv: 'a b' },
    });
    expect(bad.warnings).toHaveLength(7);
    expect(bad.config).toEqual(defaultConfig());
    expect(applyConfig([]).warnings).toHaveLength(1);
    expect(applyConfig(undefined).warnings).toEqual([]);
  });

  it('loads the file, tolerating absence, junk and unreadable files', async () => {
    const env = { HOME: '/h' };
    const missing = await loadConfig({
      env,
      readFile: async () => Promise.reject(Object.assign(new Error('x'), { code: 'ENOENT' })),
    });
    expect(missing.warnings).toEqual([]);
    expect(missing.config).toEqual(defaultConfig());
    const junk = await loadConfig({ env, readFile: async () => '{not json' });
    expect(junk.warnings[0]).toContain('not valid JSON');
    const denied = await loadConfig({
      env,
      readFile: async () => Promise.reject(Object.assign(new Error('x'), { code: 'EACCES' })),
    });
    expect(denied.warnings[0]).toContain('cannot read');
    const ok = await loadConfig({ env, readFile: async () => '{"defaultTemplate":"py"}' });
    expect(ok.config.defaultTemplate).toBe('py');
    expect(ok.path).toBe('/h/.config/abox/orca-plugin.json');
  });
});

describe('worktree linkage', () => {
  it('slugifies branch names into safe sandbox names', () => {
    expect(sandboxNameFor('feat/Login Page!')).toBe('wt-feat-login-page');
    expect(sandboxNameFor('')).toBe('wt-worktree');
    expect(sandboxNameFor('ÄÖÜ')).toBe('wt-aou');
    expect(slugify('a'.repeat(50))).toBe('a'.repeat(32));
    expect(slugify('a'.repeat(31) + '-b')).toBe('a'.repeat(31));
    expect(sandboxNameFor('--force')).toBe('wt-force');
  });

  it('derives a stable idempotency key per worktree', () => {
    expect(requestIdFor('/a')).toBe(requestIdFor('/a'));
    expect(requestIdFor('/a')).not.toBe(requestIdFor('/b'));
    expect(requestIdFor('/a')).toMatch(/^orca-wt-[0-9a-f]{12}$/);
  });

  it('finds linked sandboxes by workspace source or name and ignores removed ones', () => {
    const mk = (over: object) => ({
      id: 'local/x',
      name: 'n',
      template: 't',
      state: 'running',
      host: 'local',
      owner: 'human',
      ttlRemainingMs: 1,
      expiresAt: 1,
      expired: false,
      stale: false,
      workspace: null,
      ...over,
    });
    const list = [
      mk({ id: 'local/1', name: 'wt-feat-a' }),
      mk({
        id: 'local/2',
        name: 'x',
        workspace: { mode: 'worktree', source: '/w/a/', branch: null },
      }),
      mk({ id: 'local/3', name: 'wt-feat-a', state: 'removed' }),
      mk({ id: 'local/4', name: 'wt-other' }),
    ];
    const ids = (r: Array<{ id: string }>) => r.map((s) => s.id);
    expect(ids(findLinked(list, { path: '/w/a', branch: 'feat/a' }))).toEqual([
      'local/1',
      'local/2',
    ]);
    expect(ids(findLinked(list, { path: null, branch: 'feat/a' }))).toEqual(['local/1']);
  });

  it('caches worktree paths in storage and bounds the cache', async () => {
    const mem = new Map<string, unknown>();
    const cache = createWorktreeCache({
      get: async (k) => mem.get(k) ?? null,
      set: async (k, v) => void mem.set(k, v),
    });
    for (let i = 0; i < 520; i++)
      await cache.add({ worktreeId: `w${i}`, path: `/p/${i}`, branch: `b${i}` });
    expect(Object.keys(mem.get('worktrees') as object)).toHaveLength(500);
    expect(await cache.resolvePath('b519')).toBe('/p/519');
    expect(await cache.resolvePath('b0')).toBeNull();
    await cache.remove('w519');
    expect(await cache.resolvePath('b519')).toBeNull();
    expect(await createWorktreeCache(null).resolvePath('x')).toBeNull();
  });
});
