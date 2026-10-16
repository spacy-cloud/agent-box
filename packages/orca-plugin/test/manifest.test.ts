import { lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMAND_IDS } from '../plugin/lib/commands.mjs';
import { METHOD_CAPABILITY } from '../plugin/lib/host.mjs';
import {
  HOST_METHOD_CAPABILITY,
  PANEL_ACTIONS,
  PLUGIN_MANIFEST_MAX_BYTES,
  PLUGIN_PANEL_ENTRY_MAX_BYTES,
  PLUGIN_TREE_MAX_BYTES,
  PLUGIN_TREE_MAX_ENTRIES,
  PLUGIN_WORKER_ENTRY_MAX_BYTES,
  isReservedPluginIdentity,
  pluginManifestSchema,
  pluginPathSegmentError,
  qualifiedPluginKey,
  satisfiesOrcaEngineRange,
} from '../src/orca-manifest-schema.js';
import { PLUGIN_DIR } from './helpers.js';

const manifestPath = join(PLUGIN_DIR, 'orca-plugin.json');
// The manifest is untyped JSON here on purpose: the tests poke at it and mutate copies.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as Json;

const parse = (m: unknown) => pluginManifestSchema.safeParse(m);
const mutate = (fn: (m: Json) => void) => {
  const copy = structuredClone(raw);
  fn(copy);
  return copy;
};
const issues = (m: unknown) => {
  const r = parse(m);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
};

describe('orca-plugin.json against the schema derived from Orca 1.4.224', () => {
  it('is valid', () => {
    const r = parse(raw);
    expect(r.error?.issues).toBeUndefined();
    expect(r.success).toBe(true);
  });

  it('has every required top-level field', () => {
    for (const key of [
      'manifestVersion',
      'id',
      'publisher',
      'name',
      'version',
      'engines',
      'pluginApi',
      'contributes',
      'capabilities',
    ]) {
      expect(raw, key).toHaveProperty(key);
    }
    expect(raw['manifestVersion']).toBe(1);
    expect(raw['pluginApi']).toBe(1);
    expect(raw['engines']).toEqual({ orca: expect.stringMatching(/^>=\d+\.\d+\.\d+$/) });
    expect(raw['name']).toBe('Agent Sandboxes');
  });

  it('uses an id that Orca does not reserve (no "orca-" prefix, not publisher stablyai)', () => {
    expect(raw['id']).toBe('agent-sandboxes');
    expect(raw['id'].startsWith('orca-')).toBe(false);
    expect(raw['publisher']).toBe('spacy-cloud');
    expect(isReservedPluginIdentity(raw['publisher'], raw['id'])).toBe(false);
    expect(qualifiedPluginKey(raw as { publisher: string; id: string })).toBe(
      'spacy-cloud.agent-sandboxes',
    );
    // the rule really bites: the example from the project notes would not install
    expect(isReservedPluginIdentity('spacy-cloud', 'orca-sandbox')).toBe(true);
    expect(isReservedPluginIdentity('stablyai', 'anything')).toBe(true);
  });

  it('does not contain personal data', () => {
    const text = readFileSync(manifestPath, 'utf8');
    expect(text).not.toMatch(/jojo|joern|gmail|@[a-z0-9-]+\.[a-z]{2,}/i);
  });

  it('is installable on the Orca version it was derived from, and not on older ones', () => {
    expect(satisfiesOrcaEngineRange('1.4.224', raw['engines'].orca)).toBe(true);
    expect(satisfiesOrcaEngineRange('1.4.223', raw['engines'].orca)).toBe(false);
    expect(satisfiesOrcaEngineRange('2.0.0', raw['engines'].orca)).toBe(true);
  });

  it('rejects what Orca rejects', () => {
    const cases: Array<[string, (m: Json) => void, RegExp]> = [
      ['manifestVersion 2', (m) => (m['manifestVersion'] = 2), /manifestVersion/],
      ['pluginApi 2', (m) => (m['pluginApi'] = 2), /pluginApi/],
      ['upper-case id', (m) => (m['id'] = 'Agent-Sandboxes'), /id: must be kebab-case/],
      ['id with underscore', (m) => (m['id'] = 'agent_sandboxes'), /kebab-case/],
      ['id too long', (m) => (m['id'] = 'a'.repeat(65)), /kebab-case/],
      ['dangerous id', (m) => (m['id'] = 'constructor'), /kebab-case/],
      ['bad semver', (m) => (m['version'] = '1.0'), /semver/],
      ['caret engine range', (m) => (m['engines'].orca = '^1.4.0'), /version range/],
      [
        'unknown capability (process spawn does not exist in v0)',
        (m) => m['capabilities'].push({ kind: 'process:exec' }),
        /capabilities/,
      ],
      [
        'scoped capability field',
        (m) => m['capabilities'].push({ kind: 'storage', hosts: ['x'] }),
        /capabilities/,
      ],
      ['unknown contributes key', (m) => (m['contributes'].mcpServers = []), /contributes/],
      [
        'duplicate command id',
        (m) => m['contributes'].commands.push({ ...m['contributes'].commands[0] }),
        /duplicate commands id/,
      ],
      ['bad command id', (m) => (m['contributes'].commands[0].id = 'has space'), /command id/],
      [
        'unknown built-in action',
        (m) => (m['contributes'].commands[0].action = 'nope'),
        /unknown built-in action/,
      ],
      [
        'panel entry escapes the plugin',
        (m) => (m['contributes'].panels[0].entry = '../panel.html'),
        /relative path/,
      ],
      [
        'absolute panel entry',
        (m) => (m['contributes'].panels[0].entry = '/etc/passwd'),
        /relative path/,
      ],
      [
        'worker command without main',
        (m) => delete m['main'],
        /main: required when contributes.commands/,
      ],
      [
        'events without capability',
        (m) =>
          (m['capabilities'] = m['capabilities'].filter(
            (c: { kind: string }) => c.kind !== 'events:subscribe',
          )),
        /events:subscribe capability required/,
      ],
      ['unknown event', (m) => (m['contributes'].events = [{ on: 'terminal.output' }]), /events/],
      [
        'keybinding for an unknown command',
        (m) => (m['contributes'].keybindings = [{ command: 'ghost', key: 'Mod+K' }]),
        /unknown contributed command/,
      ],
    ];
    for (const [label, change, expected] of cases) {
      const found = issues(mutate(change));
      expect(found.length, `${label} should be rejected`).toBeGreaterThan(0);
      expect(found.join('\n'), label).toMatch(expected);
    }
  });
});

describe('manifest <-> code consistency', () => {
  it('declares exactly the commands the worker registers', () => {
    const declared = raw['contributes'].commands.map((c: { id: string }) => c.id).sort();
    expect(declared).toEqual([...COMMAND_IDS].sort());
    for (const c of raw['contributes'].commands) {
      expect(c.action, `${c.id} is a worker command, not a built-in alias`).toBeUndefined();
      expect(c.title).toMatch(/ \/ /); // "English / Deutsch"
    }
  });

  it('declares least-privilege capabilities: exactly what the code uses', () => {
    const declared = new Set<string>(raw['capabilities'].map((c: { kind: string }) => c.kind));
    expect(declared).toEqual(
      new Set([
        'workspace:read',
        'terminal:send',
        'notifications:show',
        'storage',
        'events:subscribe',
      ]),
    );
    // the plugin's method table agrees with Orca's host API table
    for (const [method, cap] of Object.entries(METHOD_CAPABILITY))
      expect(HOST_METHOD_CAPABILITY[method], method).toBe(cap);
    // every host call found in the sources is in the table and covered by a declared capability
    const used = new Set<string>();
    for (const file of listFiles(PLUGIN_DIR).filter((f) => /\.(mjs|html)$/.test(f))) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/\bcall\(\s*['"]([a-z]+\.[A-Za-z]+)['"]/g)) used.add(m[1]!);
    }
    expect(used.size).toBeGreaterThan(0);
    for (const method of used) {
      const cap = HOST_METHOD_CAPABILITY[method];
      expect(cap, `${method} is not a host API v0 method`).toBeDefined();
      expect(declared.has(cap!), `${method} needs ${cap}`).toBe(true);
    }
    // events: the manifest subscribes to what the worker listens to
    const events = raw['contributes'].events.map((e: { on: string }) => e.on).sort();
    const worker = readFileSync(join(PLUGIN_DIR, 'worker.mjs'), 'utf8');
    expect([...worker.matchAll(/events\.on\('([a-z.]+)'/g)].map((m) => m[1]).sort()).toEqual(
      events,
    );
  });

  it('only uses panel actions that sandboxed panels may call', () => {
    const html = readFileSync(join(PLUGIN_DIR, raw['contributes'].panels[0].entry), 'utf8');
    const calls = [...html.matchAll(/call\('([A-Za-z.]+)'/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThan(0);
    for (const action of calls) expect(PANEL_ACTIONS as readonly string[]).toContain(action);
  });

  it('keeps module boundaries: only the adapter spawns processes; nothing opens the network', () => {
    const files = listFiles(PLUGIN_DIR).filter((f) => f.endsWith('.mjs'));
    for (const file of files) {
      const rel = relative(PLUGIN_DIR, file);
      const text = readFileSync(file, 'utf8');
      const importsOf = [...text.matchAll(/from '(node:[a-z/_]+|[^'.][^']*)'/g)].map((m) => m[1]);
      expect(
        importsOf.filter((i) => /child_process/.test(i!)),
        rel,
      ).toEqual(rel === 'lib/abox-cli.mjs' ? ['node:child_process'] : []);
      expect(
        importsOf.filter((i) => /^node:(http|https|net|dgram|tls|dns|worker_threads|vm)$/.test(i!)),
        rel,
      ).toEqual([]);
      expect(text, rel).not.toMatch(
        /\bshell:\s*true\b|\bexecSync\b|\bexec\(|\beval\(|new Function\(|\bfetch\(/,
      );
      if (rel !== 'lib/abox-cli.mjs') expect(text, rel).not.toMatch(/\bspawn\(/);
    }
  });

  it('panel markup stays inside the sandbox CSP (no network, no external resources, no innerHTML)', () => {
    const html = readFileSync(join(PLUGIN_DIR, 'panel', 'index.html'), 'utf8');
    expect(html).not.toMatch(
      /<script[^>]+src=|<link\b|<iframe|<img\b|<object|<embed|@import|url\(/i,
    );
    expect(html).not.toMatch(
      /\bfetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|localStorage|sessionStorage|indexedDB|window\.open/,
    );
    expect(html).not.toMatch(/\son[a-z]+\s*=/i); // no inline event handler attributes
    expect(html).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/); // only the loopback example URL appears
  });
});

describe('plugin directory follows the installer rules (main/index.js opi/Kfi/Jfi)', () => {
  const files = listFiles(PLUGIN_DIR);

  it('has no symlinks, no unsafe path segments, no .git, bounded size and entry count', () => {
    let bytes = 0;
    let entries = 0;
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        expect(pluginPathSegmentError(name), name).toBeNull();
        entries++;
        const path = join(dir, name);
        const st = lstatSync(path);
        expect(st.isSymbolicLink(), `${path} must not be a symlink`).toBe(false);
        if (st.isDirectory()) walk(path);
        else {
          expect(st.isFile()).toBe(true);
          bytes += st.size;
        }
      }
    };
    walk(PLUGIN_DIR);
    expect(entries).toBeLessThanOrEqual(PLUGIN_TREE_MAX_ENTRIES);
    expect(bytes).toBeLessThanOrEqual(PLUGIN_TREE_MAX_BYTES);
    expect(files.some((f) => /node_modules|\.git(\/|$)/.test(relative(PLUGIN_DIR, f)))).toBe(false);
  });

  it('declared artifacts exist and fit their size limits', () => {
    const size = (rel: string) => statSync(join(PLUGIN_DIR, rel)).size;
    expect(statSync(manifestPath).size).toBeLessThanOrEqual(PLUGIN_MANIFEST_MAX_BYTES);
    expect(size(raw['main'])).toBeLessThanOrEqual(PLUGIN_WORKER_ENTRY_MAX_BYTES);
    expect(size(raw['contributes'].panels[0].entry)).toBeLessThanOrEqual(
      PLUGIN_PANEL_ENTRY_MAX_BYTES,
    );
  });

  it('ships a worker with a default-exported activate function (host requirement)', async () => {
    const mod = await import(join(PLUGIN_DIR, raw['main']));
    expect(typeof mod.default).toBe('function');
    expect(['undefined', 'function']).toContain(typeof mod.deactivate);
  });
});

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(join(dir, e.name)) : [join(dir, e.name)],
  );
}
