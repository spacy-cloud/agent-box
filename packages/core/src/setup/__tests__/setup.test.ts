import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applySetup, detectSetupClients, planSetup } from '../index.js';
import type { SetupRequest } from '../types.js';
import { makeFixture, type SetupFixture } from './helpers.js';

let fx: SetupFixture;
beforeEach(() => {
  fx = makeFixture();
});
afterEach(() => fx.cleanup());

async function plan(req: SetupRequest) {
  return planSetup(fx.env, req);
}
async function apply(req: SetupRequest) {
  const p = await plan(req);
  const r = await applySetup(fx.env, req, p.digest);
  return { p, r };
}

const CODEX_FIXTURE = `# Codex config
model = "gpt-5"

[mcp_servers.other]
command = "other"
args = ["--x"]
`;
const CURSOR_FIXTURE = `{
  // my servers
  "mcpServers": {
    "other": { "command": "node", "args": ["server.js"] }, // keep
  }
}
`;

describe('detect', () => {
  it('finds nothing on a bare machine and preselects nothing', async () => {
    const s = await detectSetupClients(fx.env);
    expect(s.map((c) => c.id)).toEqual([
      'claude-code',
      'claude-desktop',
      'codex',
      'cursor',
      'gemini-cli',
      'orca',
    ]);
    expect(s.every((c) => !c.detected && !c.registered && !c.preselected)).toBe(true);
    expect(s.find((c) => c.id === 'orca')!.supported).toBe(false);
  });

  it('detects installed clients, preselects only existing abox registrations', async () => {
    fx.write('.codex/config.toml', CODEX_FIXTURE);
    fx.write(
      '.cursor/mcp.json',
      '{"mcpServers":{"abox":{"command":"abox","args":["mcp","serve","--agent","cursor"]}}}',
    );
    fx.write('.gemini/settings.json', '{}');
    const s = await detectSetupClients(fx.env);
    const by = Object.fromEntries(s.map((c) => [c.id, c]));
    expect(by['codex']).toMatchObject({ detected: true, registered: false, preselected: false });
    expect(by['cursor']).toMatchObject({ detected: true, registered: true, preselected: true });
    expect(by['gemini-cli']).toMatchObject({
      detected: true,
      registered: false,
      preselected: false,
    });
    expect(by['cursor']!.configPaths).toEqual([join(fx.home, '.cursor', 'mcp.json')]);
  });

  it('reports another entry that starts abox mcp serve', async () => {
    fx.write(
      '.cursor/mcp.json',
      '{"mcpServers":{"sandbox":{"command":"/usr/bin/abox","args":["mcp","serve"]}}}',
    );
    const c = (await detectSetupClients(fx.env)).find((x) => x.id === 'cursor')!;
    expect(c.registered).toBe(false);
    expect(c.otherEntries).toEqual(['sandbox']);
    const p = await plan({ clients: ['cursor'] });
    expect(p.warnings.join('\n')).toContain('"sandbox" also starts "abox mcp serve"');
  });

  it('honours CODEX_HOME and CLAUDE_CONFIG_DIR', async () => {
    fx.env.env['CODEX_HOME'] = join(fx.root, 'codex-home');
    fx.env.env['CLAUDE_CONFIG_DIR'] = join(fx.root, 'claude-home');
    const s = await detectSetupClients(fx.env);
    expect(s.find((c) => c.id === 'codex')!.configPaths[0]).toBe(
      join(fx.root, 'codex-home', 'config.toml'),
    );
    expect(s.find((c) => c.id === 'claude-code')!.configPaths[0]).toBe(
      join(fx.root, 'claude-home', '.claude.json'),
    );
  });

  it('puts Claude Desktop where the platform keeps it', async () => {
    for (const [platform, tail] of [
      ['linux', '.config/Claude/claude_desktop_config.json'],
      ['darwin', 'Library/Application Support/Claude/claude_desktop_config.json'],
    ] as const) {
      const s = await detectSetupClients({ ...fx.env, platform });
      expect(s.find((c) => c.id === 'claude-desktop')!.configPaths[0]).toBe(join(fx.home, tail));
    }
  });
});

describe('plan and apply: TOML (Codex)', () => {
  it('previews the exact diff and writes nothing', async () => {
    const path = fx.write('.codex/config.toml', CODEX_FIXTURE);
    const p = await plan({ clients: ['codex'] });
    const file = p.steps.find((s) => s.type === 'file' && s.purpose === 'mcp')!;
    expect(file).toMatchObject({ path, action: 'update', backup: true });
    expect((file as { diff: string }).diff).toContain('+[mcp_servers.abox]');
    expect((file as { diff: string }).diff).toContain(
      '+args = ["mcp", "serve", "--agent", "codex"]',
    );
    expect(readFileSync(path, 'utf8')).toBe(CODEX_FIXTURE);
    expect(existsSync(fx.env.backupDir)).toBe(false);
  });

  it('registers the server and the rules, keeps the rest, backs up the original once', async () => {
    const path = fx.write('.codex/config.toml', CODEX_FIXTURE);
    fx.write('.codex/AGENTS.md', '# My agents file\n');
    const { r } = await apply({ clients: ['codex'] });
    expect(r.ok).toBe(true);
    expect(r.steps.every((s) => s.status === 'applied' && s.verified)).toBe(true);
    const text = readFileSync(path, 'utf8');
    expect(text.startsWith(CODEX_FIXTURE)).toBe(true);
    expect(text).toContain('[mcp_servers.abox]');
    expect(readFileSync(join(fx.home, '.codex', 'AGENTS.md'), 'utf8')).toContain('<!-- abox:begin');
    expect(r.backups).toHaveLength(2);
    const backup = r.backups.find((b) => b.path === path)!.backup;
    expect(readFileSync(backup, 'utf8')).toBe(CODEX_FIXTURE);
    expect(statSync(backup).mode & 0o777).toBe(0o600);
    expect(statSync(fx.env.backupDir).mode & 0o777).toBe(0o700);
    // staging leaves nothing behind
    expect(readdirSync(fx.env.stagingDir)).toEqual([]);
    // no temp files left next to the config
    expect(readdirSync(join(fx.home, '.codex')).sort()).toEqual(['AGENTS.md', 'config.toml']);

    // a second run changes nothing; the first snapshot stays the original
    const again = await plan({ clients: ['codex'] });
    expect(again.empty).toBe(true);
    const b2 = await apply({ clients: ['codex'] });
    expect(b2.r.backups).toEqual([]);
    expect(readFileSync(backup, 'utf8')).toBe(CODEX_FIXTURE);
  });

  it('uninstall restores the original bytes', async () => {
    const path = fx.write('.codex/config.toml', CODEX_FIXTURE);
    const rules = fx.write('.codex/AGENTS.md', '# My agents file\n\nmore\n');
    await apply({ clients: ['codex'] });
    const { r } = await apply({ clients: ['codex'], uninstall: true });
    expect(r.ok).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(CODEX_FIXTURE);
    expect(readFileSync(rules, 'utf8')).toBe('# My agents file\n\nmore\n');
  });

  it('uninstall removes files that setup created, but keeps edited ones', async () => {
    await apply({ clients: ['codex'] });
    const cfg = join(fx.home, '.codex', 'config.toml');
    const agents = join(fx.home, '.codex', 'AGENTS.md');
    expect(existsSync(cfg)).toBe(true);
    // the user adds something of their own to the rules file in the meantime
    writeFileSync(agents, `${readFileSync(agents, 'utf8')}\nMy own rule.\n`);
    const { r } = await apply({ clients: ['codex'], uninstall: true });
    expect(r.ok).toBe(true);
    expect(existsSync(cfg)).toBe(false);
    expect(readFileSync(agents, 'utf8').trim()).toBe('My own rule.');
  });

  it('a file the user creates after an uninstall gets its own first-snapshot backup', async () => {
    await apply({ clients: ['codex'], rules: false });
    await apply({ clients: ['codex'], rules: false, uninstall: true });
    expect(existsSync(join(fx.home, '.codex', 'config.toml'))).toBe(false);
    const mine = '# written by me\nmodel = "y"\n';
    fx.write('.codex/config.toml', mine);
    const { r } = await apply({ clients: ['codex'], rules: false });
    expect(r.backups).toHaveLength(1);
    expect(readFileSync(r.backups[0]!.backup, 'utf8')).toBe(mine);
  });

  it('--no-rules writes only the MCP entry', async () => {
    const { r } = await apply({ clients: ['codex'], rules: false });
    expect(r.steps).toHaveLength(1);
    expect(existsSync(join(fx.home, '.codex', 'AGENTS.md'))).toBe(false);
  });

  it('writes a custom command', async () => {
    await apply({ clients: ['codex'], command: '/opt/abox/bin/abox', rules: false });
    expect(fx.read('.codex/config.toml')).toContain('command = "/opt/abox/bin/abox"');
  });
});

describe('plan and apply: JSONC (Cursor, Gemini CLI) and JSON (Claude Desktop)', () => {
  it('keeps comments and trailing commas in Cursor mcp.json', async () => {
    const path = fx.write('.cursor/mcp.json', CURSOR_FIXTURE);
    const { r } = await apply({ clients: ['cursor'] });
    expect(r.ok).toBe(true);
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('// my servers');
    expect(text).toContain('{ "command": "node", "args": ["server.js"] }, // keep');
    expect(text).toContain('"abox": {');
    // no rules file for Cursor
    expect(r.steps.map((s) => s.purpose)).toEqual(['mcp']);
    await apply({ clients: ['cursor'], uninstall: true });
    expect(readFileSync(path, 'utf8')).toBe(CURSOR_FIXTURE);
  });

  it('Gemini CLI: settings.json with comments plus GEMINI.md', async () => {
    const path = fx.write('.gemini/settings.json', '{\n  // theme\n  "theme": "Default"\n}\n');
    const { r } = await apply({ clients: ['gemini-cli'] });
    expect(r.ok).toBe(true);
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('// theme');
    expect(JSON.parse(text.replace('// theme', '')).mcpServers.abox).toEqual({
      command: 'abox',
      args: ['mcp', 'serve', '--agent', 'gemini-cli'],
    });
    expect(fx.read('.gemini/GEMINI.md')).toContain('abox sandboxes');
  });

  it('Claude Desktop: creates the config where the platform keeps it', async () => {
    const { r } = await apply({ clients: ['claude-desktop'], command: '/opt/abox' });
    expect(r.ok).toBe(true);
    const doc = JSON.parse(fx.read('.config/Claude/claude_desktop_config.json'));
    expect(doc).toEqual({
      mcpServers: {
        abox: { command: '/opt/abox', args: ['mcp', 'serve', '--agent', 'claude-desktop'] },
      },
    });
    expect(statSync(join(fx.home, '.config/Claude/claude_desktop_config.json')).mode & 0o777).toBe(
      0o600,
    );
  });

  it('refuses a file it cannot parse and leaves it alone', async () => {
    const path = fx.write('.cursor/mcp.json', '{"mcpServers": {');
    await expect(plan({ clients: ['cursor'] })).rejects.toThrow(/not valid JSON/);
    expect(readFileSync(path, 'utf8')).toBe('{"mcpServers": {');
  });

  it('keeps the file mode of an existing config', async () => {
    const path = fx.write('.cursor/mcp.json', '{}');
    chmodSync(path, 0o640);
    await apply({ clients: ['cursor'] });
    expect(statSync(path).mode & 0o777).toBe(0o640);
  });

  it('does not replace an HTTP entry named abox', async () => {
    fx.write('.cursor/mcp.json', '{"mcpServers":{"abox":{"url":"http://127.0.0.1:8765/mcp"}}}');
    await expect(plan({ clients: ['cursor'] })).rejects.toThrow(/remote \(URL\) server/);
  });
});

describe('safety of the write', () => {
  it('refuses when the file changed between preview and apply, writing nothing', async () => {
    const path = fx.write('.cursor/mcp.json', '{}');
    const req: SetupRequest = { clients: ['cursor'] };
    const p = await plan(req);
    writeFileSync(path, '{"changed": true}');
    await expect(applySetup(fx.env, req, p.digest)).rejects.toThrow(
      /changed since the preview|configuration changed/,
    );
    expect(readFileSync(path, 'utf8')).toBe('{"changed": true}');
    expect(existsSync(fx.env.backupDir)).toBe(false);
  });

  it('refuses a plan whose digest does not match (different request, other state)', async () => {
    fx.write('.cursor/mcp.json', '{}');
    const p = await plan({ clients: ['cursor'] });
    await expect(
      applySetup(fx.env, { clients: ['cursor'], command: '/x/abox' }, p.digest),
    ).rejects.toThrow(/changed since the preview/);
  });

  it('notices a change of mtime alone', async () => {
    const path = fx.write('.cursor/mcp.json', '{}');
    const req: SetupRequest = { clients: ['cursor'] };
    const p = await plan(req);
    // same bytes, other mtime: the preview's fingerprint no longer matches the file, so no digest check fails,
    // but the guarded write compares mtime as well
    const { writeGuarded } = await import('../fsafe.js');
    const step = p.steps[0]!;
    if (step.type !== 'file') throw new Error('file step expected');
    utimesSync(path, new Date(1_000_000), new Date(1_000_000));
    await expect(
      writeGuarded({
        path,
        text: '{"x":1}',
        bom: false,
        expected: step.before,
        stagingDir: fx.env.stagingDir,
        verify: () => undefined,
      }),
    ).rejects.toThrow(/changed since the preview/);
    expect(readFileSync(path, 'utf8')).toBe('{}');
  });

  it('never writes through a symbolic link', async () => {
    const real = fx.write('dotfiles/mcp.json', '{}');
    fx.write('.cursor/placeholder', '');
    const link = join(fx.home, '.cursor', 'mcp.json');
    symlinkSync(real, link);
    await expect(plan({ clients: ['cursor'] })).rejects.toThrow(/symbolic link/);
    expect(readFileSync(real, 'utf8')).toBe('{}');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it('a link swapped in after the preview is not followed', async () => {
    const path = fx.write('.cursor/mcp.json', '{}');
    const victim = fx.write('victim.json', 'precious');
    const req: SetupRequest = { clients: ['cursor'] };
    const p = await plan(req);
    const { unlinkSync } = await import('node:fs');
    unlinkSync(path);
    symlinkSync(victim, path);
    await expect(applySetup(fx.env, req, p.digest)).rejects.toThrow();
    expect(readFileSync(victim, 'utf8')).toBe('precious');
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
  });

  it('a file that appears after the preview is not overwritten', async () => {
    const req: SetupRequest = { clients: ['cursor'] };
    const p = await plan(req);
    fx.write('.cursor/mcp.json', '{"mine": true}');
    await expect(applySetup(fx.env, req, p.digest)).rejects.toThrow(
      /changed since the preview|configuration changed/,
    );
    expect(fx.read('.cursor/mcp.json')).toBe('{"mine": true}');
  });

  it('refuses a directory or an oversized file', async () => {
    fx.write('.cursor/mcp.json/inner', 'x');
    await expect(plan({ clients: ['cursor'] })).rejects.toThrow(/not a regular file/);
  });

  it('keeps a byte order mark and invalid UTF-8 is refused', async () => {
    const path = fx.write('.cursor/mcp.json', '\uFEFF{}');
    await apply({ clients: ['cursor'] });
    expect(readFileSync(path, 'utf8').startsWith('\uFEFF{')).toBe(true);
    writeFileSync(path, Buffer.from([0xff, 0xfe, 0x00]));
    await expect(plan({ clients: ['cursor'] })).rejects.toThrow(/UTF-8/);
  });

  it('refuses unknown clients, bad options and Orca', async () => {
    await expect(plan({ clients: ['vim' as never] })).rejects.toThrow(/unknown client/);
    await expect(plan({ clients: [] })).rejects.toThrow(/no client/);
    await expect(plan({ clients: ['codex', 'codex'] })).rejects.toThrow(/twice/);
    await expect(plan({ clients: ['codex'], command: '--evil' })).rejects.toThrow(
      /invalid command/,
    );
    await expect(plan({ clients: ['codex'], command: 'a\nb' })).rejects.toThrow(/invalid command/);
    await expect(plan({ clients: ['orca'] })).rejects.toThrow(/bearer token/);
    expect((await plan({ clients: ['orca'], uninstall: true })).empty).toBe(true);
  });
});

describe('Claude Code', () => {
  beforeEach(() => {
    fx.cleanup();
    fx = makeFixture({ claude: true });
  });

  const argvOf = (p: Awaited<ReturnType<typeof plan>>): string[] =>
    p.steps
      .filter((s) => s.type === 'command')
      .map((s) => (s as { argv: string[] }).argv.slice(1).join(' '));

  it('prefers the plugin: marketplace add + install, no MCP entry, no rules', async () => {
    const p = await plan({ clients: ['claude-code'] });
    expect(argvOf(p)).toEqual([
      'plugin marketplace add spacy-cloud/agent-box',
      'plugin install abox@agent-box --scope user',
    ]);
    expect(p.steps.every((s) => s.type === 'command')).toBe(true);
    const { r } = await apply({ clients: ['claude-code'] });
    expect(r.ok).toBe(true);
    expect(fx.claudeLog()).toEqual([
      'plugin marketplace add spacy-cloud/agent-box',
      'plugin install abox@agent-box --scope user',
    ]);
    expect(r.steps.every((s) => s.verified !== false)).toBe(true);
    const st = (await detectSetupClients(fx.env)).find((c) => c.id === 'claude-code')!;
    expect(st).toMatchObject({ registered: true, registeredVia: 'plugin', preselected: true });
    expect(existsSync(join(fx.home, '.claude.json'))).toBe(false);
    expect(existsSync(join(fx.home, '.claude', 'CLAUDE.md'))).toBe(false);
    // already installed: nothing to do
    expect((await plan({ clients: ['claude-code'] })).empty).toBe(true);
  });

  it('manual MCP entry through the claude CLI (argv, user scope), plus the rules', async () => {
    const p = await plan({ clients: ['claude-code'], claudeCodeMethod: 'mcp' });
    expect(argvOf(p)).toEqual(['mcp add --scope user abox -- abox mcp serve --agent claude-code']);
    const { r } = await apply({ clients: ['claude-code'], claudeCodeMethod: 'mcp' });
    expect(r.ok).toBe(true);
    const claudeJson = JSON.parse(fx.read('.claude.json'));
    expect(claudeJson.mcpServers.abox.args).toEqual(['mcp', 'serve', '--agent', 'claude-code']);
    expect(fx.read('.claude/CLAUDE.md')).toContain('<!-- abox:begin');
    expect((await plan({ clients: ['claude-code'] })).empty).toBe(true);
  });

  it('backs up ~/.claude.json before the CLI changes it', async () => {
    const original = '{"numStartups": 7, "mcpServers": {"x": {"command": "y"}}}';
    fx.write('.claude.json', original);
    const { r } = await apply({ clients: ['claude-code'], claudeCodeMethod: 'mcp', rules: false });
    expect(r.backups).toHaveLength(1);
    expect(readFileSync(r.backups[0]!.backup, 'utf8')).toBe(original);
    expect(JSON.parse(fx.read('.claude.json')).mcpServers.x).toEqual({ command: 'y' });
  });

  it('never registers both: switching method replaces the other', async () => {
    await apply({ clients: ['claude-code'], claudeCodeMethod: 'mcp' });
    let p = await plan({ clients: ['claude-code'], claudeCodeMethod: 'plugin' });
    expect(argvOf(p)).toContain('mcp remove --scope user abox');
    expect(p.warnings.join('\n')).toContain('registers the server itself');
    await apply({ clients: ['claude-code'], claudeCodeMethod: 'plugin' });
    expect(JSON.parse(fx.read('.claude.json')).mcpServers).toEqual({});
    let st = (await detectSetupClients(fx.env)).find((c) => c.id === 'claude-code')!;
    expect(st.registeredVia).toBe('plugin');

    p = await plan({ clients: ['claude-code'], claudeCodeMethod: 'mcp' });
    expect(argvOf(p)).toContain('plugin uninstall abox@agent-box --scope user');
    expect(p.warnings.join('\n')).toContain('twice');
    await apply({ clients: ['claude-code'], claudeCodeMethod: 'mcp' });
    st = (await detectSetupClients(fx.env)).find((c) => c.id === 'claude-code')!;
    expect(st.registeredVia).toBe('mcp');
    expect(JSON.parse(fx.read('.claude/settings.json')).enabledPlugins).toEqual({});
  });

  it('without the claude CLI: the plugin is impossible, the MCP entry is edited in ~/.claude.json', async () => {
    fx.cleanup();
    fx = makeFixture();
    await expect(plan({ clients: ['claude-code'], claudeCodeMethod: 'plugin' })).rejects.toThrow(
      /claude command was not found/,
    );
    fx.write('.claude.json', '{\n  "numStartups": 3\n}\n');
    const p = await plan({ clients: ['claude-code'] });
    expect(p.warnings.join('\n')).toContain('close Claude Code');
    const f = p.steps.find((s) => s.type === 'file' && s.purpose === 'mcp')!;
    expect(f).toMatchObject({ action: 'update' });
    const { r } = await apply({ clients: ['claude-code'] });
    expect(r.ok).toBe(true);
    expect(JSON.parse(fx.read('.claude.json'))).toMatchObject({
      numStartups: 3,
      mcpServers: { abox: { command: 'abox' } },
    });
  });

  it('uninstall removes plugin, marketplace, MCP entry and rules', async () => {
    await apply({ clients: ['claude-code'] });
    await apply({ clients: ['claude-code'], uninstall: true });
    expect(fx.claudeLog().slice(-2)).toEqual([
      'plugin uninstall abox@agent-box --scope user',
      'plugin marketplace remove agent-box',
    ]);
    const st = (await detectSetupClients(fx.env)).find((c) => c.id === 'claude-code')!;
    expect(st.registered).toBe(false);
  });

  it('a failing command stops the run and reports what happened', async () => {
    fx.env.env['FAKE_CLAUDE_FAIL'] = 'plugin install';
    const { r } = await apply({ clients: ['claude-code'] });
    expect(r.ok).toBe(false);
    expect(r.steps.map((s) => s.status)).toEqual(['applied', 'failed']);
    expect(r.steps[1]!.message).toContain('boom');
  });

  it('plugin marketplace source can be chosen; a flag-looking one is refused', async () => {
    const p = await plan({ clients: ['claude-code'], marketplace: 'my-org/agent-box' });
    expect(argvOf(p)[0]).toBe('plugin marketplace add my-org/agent-box');
    await expect(plan({ clients: ['claude-code'], marketplace: '--scope' })).rejects.toThrow(
      /invalid marketplace/,
    );
  });
});

describe('rules text', () => {
  it('is the text of the agent-kit templates (they must not drift apart)', async () => {
    const { AGENTS_RULES, CLAUDE_RULES } = await import('../rules.js');
    const dir = new URL('../../../../agent-kit/templates/', import.meta.url);
    expect(AGENTS_RULES).toBe(readFileSync(new URL('AGENTS.md.snippet', dir), 'utf8'));
    expect(CLAUDE_RULES).toBe(readFileSync(new URL('CLAUDE.md.snippet', dir), 'utf8'));
  });
});
