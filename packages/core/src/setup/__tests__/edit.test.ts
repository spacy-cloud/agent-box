import { describe, expect, it } from 'vitest';
import { parse as parseToml } from 'smol-toml';
import { parse as parseJsonc } from 'jsonc-parser';
import { jsonIsEmptySkeleton, jsonRemoveServer, jsonSetServer, runsAboxMcp } from '../edit-json.js';
import { hasRulesBlock, removeRulesBlock, upsertRulesBlock } from '../edit-markdown.js';
import { tomlRemoveTable, tomlUpsertTable } from '../edit-toml.js';

const ENTRY = { command: 'abox', args: ['mcp', 'serve', '--agent', 'cursor'] };
const F = 'test.json';

describe('JSON / JSONC editing', () => {
  it('creates a file from nothing', () => {
    const out = jsonSetServer('', 'mcpServers', 'abox', ENTRY, F);
    expect(JSON.parse(out)).toEqual({ mcpServers: { abox: ENTRY } });
    expect(out.endsWith('\n')).toBe(true);
    expect(out).toContain('"args": ["mcp", "serve", "--agent", "cursor"]');
  });

  it('keeps comments, unrelated entries and the formatting of everything else byte for byte', () => {
    const before = `// my cursor config
{
  /* keep */ "theme": "dark", // trailing
  "mcpServers": {
    // the other server
    "other": {"command":"x","args":["a"]}
  },
  "last": [1,2,3]
}
`;
    const out = jsonSetServer(before, 'mcpServers', 'abox', ENTRY, F);
    expect(parseJsonc(out)).toEqual({
      theme: 'dark',
      mcpServers: { other: { command: 'x', args: ['a'] }, abox: ENTRY },
      last: [1, 2, 3],
    });
    // everything before and after the inserted property is untouched
    expect(out).toContain('// my cursor config');
    expect(out).toContain('/* keep */ "theme": "dark", // trailing');
    expect(out).toContain('    // the other server\n    "other": {"command":"x","args":["a"]}');
    expect(out).toContain('  "last": [1,2,3]\n}\n');
    // and removing the entry gives the original text back
    expect(jsonRemoveServer(out, 'mcpServers', 'abox', F)).toBe(before);
  });

  it('strict JSON stays strict: no trailing comma is left behind when the last entry goes', () => {
    const before =
      '{\n  "preferences": { "a": 1 },\n  "mcpServers": {\n    "other": { "command": "x" }\n  }\n}\n';
    const out = jsonSetServer(before, 'mcpServers', 'abox', ENTRY, F);
    expect(JSON.parse(out).mcpServers.abox).toEqual(ENTRY);
    const back = jsonRemoveServer(out, 'mcpServers', 'abox', F);
    expect(back).toBe(before);
    expect(() => JSON.parse(back)).not.toThrow();
  });

  it('removes an entry that shares its line with others (compact file)', () => {
    const before =
      '{"mcpServers":{"a":{"command":"x"},"abox":{"command":"abox","args":["mcp","serve"]}},"z":1}';
    const out = jsonRemoveServer(before, 'mcpServers', 'abox', F);
    expect(JSON.parse(out)).toEqual({ mcpServers: { a: { command: 'x' } }, z: 1 });
  });

  it('adds the container when only other keys exist, and handles an empty object', () => {
    const a = jsonSetServer('{\n  "a": 1\n}\n', 'mcpServers', 'abox', ENTRY, F);
    expect(parseJsonc(a)).toEqual({ a: 1, mcpServers: { abox: ENTRY } });
    const b = jsonSetServer('{}', 'mcpServers', 'abox', ENTRY, F);
    expect(parseJsonc(b)).toEqual({ mcpServers: { abox: ENTRY } });
    const c = jsonSetServer('{ "mcpServers": {} }', 'mcpServers', 'abox', ENTRY, F);
    expect(parseJsonc(c)).toEqual({ mcpServers: { abox: ENTRY } });
  });

  it('keeps tabs, CRLF and trailing commas', () => {
    const before = '{\r\n\t"mcpServers": {\r\n\t\t"x": {},\r\n\t},\r\n}\r\n';
    const out = jsonSetServer(before, 'mcpServers', 'abox', ENTRY, F);
    expect(parseJsonc(out)).toEqual({ mcpServers: { x: {}, abox: ENTRY } });
    expect(out).not.toMatch(/[^\r]\n/);
    expect(out).toContain('\t\t"abox": {');
  });

  it('updates an existing entry and keeps its extra fields', () => {
    const before = `{"mcpServers":{"abox":{"command":"old","args":["x"],"env":{"A":"1"},"timeout":5}}}`;
    const out = jsonSetServer(before, 'mcpServers', 'abox', ENTRY, F);
    expect(JSON.parse(out)).toEqual({
      mcpServers: { abox: { command: 'abox', args: ENTRY.args, env: { A: '1' }, timeout: 5 } },
    });
    // nothing to do when it is right already
    expect(jsonSetServer(out, 'mcpServers', 'abox', ENTRY, F)).toBe(out);
  });

  it('refuses broken files and wrong shapes', () => {
    expect(() => jsonSetServer('{"a":', 'mcpServers', 'abox', ENTRY, F)).toThrow(/not valid JSON/);
    expect(() => jsonSetServer('[1]', 'mcpServers', 'abox', ENTRY, F)).toThrow(/top level/);
    expect(() => jsonSetServer('{"mcpServers": []}', 'mcpServers', 'abox', ENTRY, F)).toThrow(
      /not an object/,
    );
  });

  it('recognises abox servers under other names and empty skeletons', () => {
    expect(runsAboxMcp({ command: '/opt/abox', args: ['mcp', 'serve'] }, 'abox')).toBe(true);
    expect(runsAboxMcp({ command: 'node', args: ['x'] }, 'abox')).toBe(false);
    expect(jsonIsEmptySkeleton('{"mcpServers":{}}', 'mcpServers', F)).toBe(true);
    expect(jsonIsEmptySkeleton('{"mcpServers":{},"a":1}', 'mcpServers', F)).toBe(false);
  });
});

describe('TOML editing', () => {
  const T = 'config.toml';
  const wanted = { command: 'abox', args: ['mcp', 'serve', '--agent', 'codex'] };

  it('appends a table to a file with comments and other tables', () => {
    const before = `# my codex config
model = "gpt-5"   # keep this

[mcp_servers.other]
command = "x"
args = ["a", "b"]

[profiles.fast]
model = "mini"
`;
    const out = tomlUpsertTable(before, ['mcp_servers', 'abox'], wanted, T);
    expect(out.startsWith(before)).toBe(true);
    const doc = parseToml(out) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(doc['mcp_servers']).toEqual({ other: { command: 'x', args: ['a', 'b'] }, abox: wanted });
    expect(doc['profiles']).toEqual({ fast: { model: 'mini' } });
    expect(tomlRemoveTable(out, ['mcp_servers', 'abox'], T)).toBe(before);
  });

  it('creates the file content from nothing and removes it again', () => {
    const out = tomlUpsertTable('', ['mcp_servers', 'abox'], wanted, T);
    expect(parseToml(out)).toEqual({ mcp_servers: { abox: wanted } });
    expect(tomlRemoveTable(out, ['mcp_servers', 'abox'], T).trim()).toBe('');
  });

  it('updates command and args of an existing table, keeping other keys and sub-tables', () => {
    const before = `[mcp_servers.abox]
command = "old" # was this
args = [
  "mcp", # multi-line
  "serve",
]
startup_timeout_sec = 20

[mcp_servers.abox.env]
FOO = "bar"

[next]
a = 1
`;
    const out = tomlUpsertTable(before, ['mcp_servers', 'abox'], wanted, T);
    expect(parseToml(out)).toEqual({
      mcp_servers: {
        abox: { ...wanted, startup_timeout_sec: 20, env: { FOO: 'bar' } },
      },
      next: { a: 1 },
    });
    expect(out).toContain('startup_timeout_sec = 20');
    // removing takes the sub-table with it
    const gone = tomlRemoveTable(out, ['mcp_servers', 'abox'], T);
    expect(parseToml(gone)).toEqual({ next: { a: 1 } });
  });

  it('is not fooled by header-looking text in strings and arrays', () => {
    const before = `note = """
[mcp_servers.abox]
command = "fake"
"""
list = [
  [1, 2],
  ["[mcp_servers.abox]"],
]
"quoted key" = 'single # not a comment'
`;
    const out = tomlUpsertTable(before, ['mcp_servers', 'abox'], wanted, T);
    expect(out.startsWith(before)).toBe(true);
    const doc = parseToml(out) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(doc['note']).toContain('fake');
    expect(doc['mcp_servers']).toEqual({ abox: wanted });
    expect(tomlRemoveTable(out, ['mcp_servers', 'abox'], T)).toBe(before);
  });

  it('refuses an entry written as an inline table or with dotted keys', () => {
    expect(() =>
      tomlUpsertTable(
        '[mcp_servers]\nabox = { command = "x" }\n',
        ['mcp_servers', 'abox'],
        wanted,
        T,
      ),
    ).toThrow(/inline table or with dotted keys/);
    expect(() =>
      tomlUpsertTable('mcp_servers.abox.command = "x"\n', ['mcp_servers', 'abox'], wanted, T),
    ).toThrow(/inline table or with dotted keys/);
    expect(() =>
      tomlUpsertTable('a = "unterminated\n', ['mcp_servers', 'abox'], wanted, T),
    ).toThrow(/unterminated/);
  });

  it('keeps CRLF files CRLF', () => {
    const before = 'a = 1\r\n';
    const out = tomlUpsertTable(before, ['mcp_servers', 'abox'], wanted, T);
    expect(out).not.toMatch(/[^\r]\n/);
    expect(parseToml(out)).toEqual({ a: 1, mcp_servers: { abox: wanted } });
  });
});

describe('rules block', () => {
  const R = 'AGENTS.md';
  it('adds, updates in place and removes only its own text', () => {
    const before = '# My rules\n\nBe nice.\n';
    const a = upsertRulesBlock(before, 'rule one\n', R);
    expect(a).toContain('rule one');
    expect(hasRulesBlock(a, R)).toBe(true);
    expect(a.startsWith(before)).toBe(true);
    const b = upsertRulesBlock(a + '\nafter\n', 'rule two\n', R);
    expect(b).toContain('rule two');
    expect(b).not.toContain('rule one');
    expect(b.endsWith('\nafter\n')).toBe(true);
    expect(removeRulesBlock(a, R)).toBe(before);
    expect(removeRulesBlock(before, R)).toBe(before);
    expect(removeRulesBlock(upsertRulesBlock('', 'x\n', R), R)).toBe('');
  });

  it('refuses a damaged block', () => {
    expect(() => removeRulesBlock('<!-- abox:begin -->\nx\n', R)).toThrow(/damaged/);
    expect(() => removeRulesBlock('x\n<!-- abox:end -->\n', R)).toThrow(/damaged/);
  });
});
