import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEnv, run, writeScript, type TestEnv } from './harness.js';

let t: TestEnv;
let bin: string;
beforeEach(() => {
  t = makeEnv();
  // a PATH of our own: the real machine's agents (and a real `claude`) must never be reached
  bin = join(t.root, 'bin');
  mkdirSync(bin, { recursive: true });
  writeScript(t, 'bin/abox', 'exit 0');
  t.env['PATH'] = bin;
});
afterEach(() => t.cleanup());

const codexToml = (): string => join(t.home, '.codex', 'config.toml');
const cursorJson = (): string => join(t.home, '.cursor', 'mcp.json');

describe('abox setup --list', () => {
  it('shows what is on the machine, as a table and as JSON', async () => {
    t.write('home/.codex/config.toml', '# mine\n');
    t.write(
      'home/.cursor/mcp.json',
      '{"mcpServers":{"abox":{"command":"abox","args":["mcp","serve","--agent","cursor"]}}}',
    );
    const text = await run(t, ['setup', '--list']);
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout).toMatch(/codex\s+found/);
    expect(text.stdout).toMatch(/cursor\s+abox registered/);
    expect(text.stdout).toMatch(/orca\s+not supported by setup/);
    const json = await run(t, ['setup', '--list', '--json']);
    const byId = Object.fromEntries(json.json.data.clients.map((c: { id: string }) => [c.id, c]));
    expect(byId['cursor']).toMatchObject({ registered: true, preselected: true });
    expect(byId['codex']).toMatchObject({ detected: true, registered: false, preselected: false });
  });
});

describe('abox setup: preview and confirmation', () => {
  it('without a terminal and without --client it says what to do', async () => {
    const r = await run(t, ['setup', '--json']);
    expect(r.code).toBe(2);
    expect(r.json.code).toBe('invalid_input');
    expect(r.json.hint).toContain('--client');
  });

  it('--dry-run prints the diff and changes nothing', async () => {
    t.write('home/.codex/config.toml', '# mine\nmodel = "x"\n');
    const r = await run(t, ['setup', '--client', 'codex', '--dry-run']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('Preview - nothing has been changed yet');
    expect(r.stdout).toContain('~/.codex/config.toml');
    expect(r.stdout).toContain('+[mcp_servers.abox]');
    expect(r.stdout).toContain('a backup of the original is kept');
    expect(readFileSync(codexToml(), 'utf8')).toBe('# mine\nmodel = "x"\n');
    expect(existsSync(join(t.aboxHome, 'data', 'setup-backups'))).toBe(false);
  });

  it('without --yes and without a terminal it refuses (exit 3) and writes nothing', async () => {
    const r = await run(t, ['setup', '--client', 'codex', '--json']);
    expect(r.code).toBe(3);
    expect(r.json).toMatchObject({ ok: false, code: 'approval_required' });
    expect(r.json.details.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(join(t.home, '.codex'))).toBe(false);
  });

  it('a terminal asks, and "n" leaves everything alone', async () => {
    const r = await run(t, ['setup', '--client', 'cursor'], { tty: true, stdin: 'n\n' });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('Apply these changes?');
    expect(existsSync(cursorJson())).toBe(false);
    const yes = await run(t, ['setup', '--client', 'cursor'], { tty: true, stdin: 'y\n' });
    expect(yes.code, yes.stderr).toBe(0);
    expect(JSON.parse(readFileSync(cursorJson(), 'utf8')).mcpServers.abox.command).toBe('abox');
  });

  it('the multi-select preselects registered agents; Enter keeps them', async () => {
    t.write(
      'home/.cursor/mcp.json',
      '{"mcpServers":{"abox":{"command":"abox","args":["mcp","serve","--agent","cursor"]}}}',
    );
    t.write('home/.codex/config.toml', '# codex, not registered\n');
    const keep = await run(t, ['setup', '--dry-run'], { tty: true, stdin: '\n' });
    expect(keep.code, keep.stderr).toBe(0);
    expect(keep.stderr).toMatch(/\[x\] Cursor/);
    expect(keep.stderr).toMatch(/\[ \] Codex/);
    expect(keep.stderr).toMatch(/\[-\] Orca/);
    expect(keep.stdout).toContain('Nothing to change.'); // cursor is registered already
    const pick = await run(t, ['setup', '--dry-run'], { tty: true, stdin: '3\n' });
    expect(pick.stdout).toContain('~/.codex/config.toml');
    expect(pick.stdout).not.toContain('~/.cursor');
    const none = await run(t, ['setup', '--dry-run'], { tty: true, stdin: 'q\n' });
    expect(none.code).toBe(0);
    expect(none.stdout).toBe('');
  });

  it('Orca is explained, not written', async () => {
    const r = await run(t, ['setup', '--client', 'orca', '--yes', '--json']);
    expect(r.code).toBe(2);
    expect(r.json.code).toBe('unsupported');
    expect(r.json.hint).toContain('abox init --agent orca');
  });
});

describe('abox setup --client ... --yes --json', () => {
  it('registers several agents, writes the rules, keeps backups, and --uninstall reverts', async () => {
    const codexBefore = '# my config\nmodel = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n';
    const cursorBefore = '{\n  // keep me\n  "mcpServers": {}\n}\n';
    t.write('home/.codex/config.toml', codexBefore);
    t.write('home/.cursor/mcp.json', cursorBefore);
    const r = await run(t, [
      'setup',
      '--client',
      'codex',
      '--client',
      'cursor,gemini-cli',
      '--yes',
      '--json',
    ]);
    expect(r.code, r.stderr + r.stdout).toBe(0);
    expect(r.json.ok).toBe(true);
    expect(r.json.data.applied).toBe(true);
    expect(r.json.data.result.steps.every((s: { status: string }) => s.status === 'applied')).toBe(
      true,
    );
    expect(readFileSync(codexToml(), 'utf8')).toContain('[mcp_servers.abox]');
    expect(readFileSync(cursorJson(), 'utf8')).toContain('// keep me');
    expect(readFileSync(join(t.home, '.gemini', 'settings.json'), 'utf8')).toContain(
      '"gemini-cli"',
    );
    expect(readFileSync(join(t.home, '.codex', 'AGENTS.md'), 'utf8')).toContain('<!-- abox:begin');
    expect(readFileSync(join(t.home, '.gemini', 'GEMINI.md'), 'utf8')).toContain('<!-- abox:begin');
    // the two existing files were backed up (first snapshot), the new ones were not
    const backups = readdirSync(join(t.aboxHome, 'data', 'setup-backups'));
    expect(backups.filter((f) => f.endsWith('config.toml') || f.endsWith('mcp.json'))).toHaveLength(
      2,
    );

    const again = await run(t, ['setup', '--client', 'codex', '--dry-run', '--json']);
    expect(again.json.data.plan.empty).toBe(true);

    const un = await run(t, [
      'setup',
      '--uninstall',
      '--client',
      'codex,cursor,gemini-cli',
      '--yes',
      '--json',
    ]);
    expect(un.code, un.stderr + un.stdout).toBe(0);
    expect(readFileSync(codexToml(), 'utf8')).toBe(codexBefore);
    expect(readFileSync(cursorJson(), 'utf8')).toBe(cursorBefore);
    expect(existsSync(join(t.home, '.gemini', 'settings.json'))).toBe(false);
    expect(existsSync(join(t.home, '.codex', 'AGENTS.md'))).toBe(false);
  });

  it('the setup is in the audit log', async () => {
    const r = await run(t, ['setup', '--client', 'cursor', '--yes', '--json']);
    expect(r.code, r.stderr).toBe(0);
    const audit = await run(t, ['audit', '--json']);
    const actions = JSON.stringify(audit.json);
    expect(actions).toContain('setup.apply');
  });

  it('--command and --no-rules are honoured', async () => {
    const r = await run(t, [
      'setup',
      '--client',
      'codex',
      '--command',
      '/opt/abox/bin/abox',
      '--no-rules',
      '--yes',
      '--json',
    ]);
    expect(r.code, r.stderr).toBe(0);
    expect(readFileSync(codexToml(), 'utf8')).toContain('command = "/opt/abox/bin/abox"');
    expect(existsSync(join(t.home, '.codex', 'AGENTS.md'))).toBe(false);
  });

  it('the dry run exposes the exact path and the digest of the plan', async () => {
    t.write('home/.cursor/mcp.json', '{}');
    const dry = await run(t, ['setup', '--client', 'cursor', '--dry-run', '--json']);
    expect(dry.json.data.plan.steps[0].path).toBe(cursorJson());
    expect(dry.json.data.plan.digest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('abox setup: Claude Code', () => {
  beforeEach(() => {
    writeScript(
      t,
      'bin/claude',
      `echo "$@" >> "${join(t.root, 'claude.log')}"
if [ "$1 $2" = "plugin install" ]; then
  /bin/mkdir -p "$HOME/.claude"
  echo '{"enabledPlugins":{"abox@agent-box":true}}' > "$HOME/.claude/settings.json"
fi`,
    );
  });

  it('installs the plugin through the claude CLI (argv), not an MCP entry', async () => {
    const r = await run(t, ['setup', '--client', 'claude-code', '--yes', '--json']);
    expect(r.code, r.stderr + r.stdout).toBe(0);
    const log = readFileSync(join(t.root, 'claude.log'), 'utf8').trim().split('\n');
    expect(log).toEqual([
      'plugin marketplace add spacy-cloud/agent-box',
      'plugin install abox@agent-box --scope user',
    ]);
    expect(existsSync(join(t.home, '.claude.json'))).toBe(false);
    expect(r.json.data.result.steps.map((s: { verified?: boolean }) => s.verified)).toEqual([
      undefined,
      true,
    ]);
  });

  it('the preview shows the command line', async () => {
    const r = await run(t, [
      'setup',
      '--client',
      'claude-code',
      '--claude-code-method',
      'mcp',
      '--dry-run',
    ]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('mcp add --scope user abox -- abox mcp serve --agent claude-code');
    expect(r.stdout).toContain('~/.claude/CLAUDE.md');
  });
});

describe('abox init --agent', () => {
  it('knows the new agents', async () => {
    for (const agent of ['claude-desktop', 'gemini-cli']) {
      const r = await run(t, ['init', '--agent', agent, '--json']);
      expect(r.code, r.stderr).toBe(0);
      expect(r.json.data.mcp.mcpServers.abox.args).toEqual(['mcp', 'serve', '--agent', agent]);
      expect(r.json.data.contextDefined).toBe(true);
    }
  });
});
